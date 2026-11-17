import fs from 'node:fs';
import path from 'node:path';
import {
  KeyedMutex, detectClassCodes, listNames, pktDate, pktTime, prettyDate, sanitizeInput, sha, sortStudents, toJid,
} from './utils.js';

const STATUS_ICON = { Present: '✅', Late: '⏰', Absent: '❌' };

/**
 * Owns the whole "teacher posts in a class group" pipeline:
 *   text → class-code pre-filter (no AI call if absent) → Gemini intent + names → roster validation →
 *   5-minute buffer session → Sheets + group summary + throttled parent DMs.
 */
export class AttendanceManager {
  constructor({ sheets, gemini, queue, config, logger, notifyOwner, now = () => new Date() }) {
    Object.assign(this, { sheets, gemini, queue, cfg: config, log: logger, notifyOwner, now });
    this.sessions = new Map(); // key `${date}|${cls}` -> session
    this.timers = new Map();
    this.mutex = new KeyedMutex();
    this.statePath = path.join(config.stateDir, 'sessions.json');
    this.lastGeminiAlert = 0;
  }

  /* ------------------------------------------------------------ lifecycle */
  async start() {
    this._restore();
    for (const s of this.sessions.values()) if (!s.finalized) this._schedule(s);
  }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); this._persist(); }

  /* ------------------------------------------------------------ entrypoint */
  async handleGroupText({ groupJid, text }) {
    const clean = sanitizeInput(text);
    if (clean.length < 3) return;

    // Cheap local gate: no known class code → ignore without spending a Gemini request.
    const classes = await this.sheets.getClasses();
    const codes = detectClassCodes(clean, classes);
    if (!codes.length) return;

    const rosters = new Map();
    for (const c of codes) rosters.set(c, await this.sheets.getRoster(c));

    const parsed = await this.gemini.parseGroupMessage({ text: clean, classCodes: codes, rosters });
    if (parsed.error) return this._alertGeminiDown(groupJid);
    if (parsed.degraded) this._alertGeminiDown(groupJid, true);

    if (parsed.intent === 'attendance') return this.mutex.run(parsed.cls, () => this._applyAttendance(parsed, groupJid));
    if (parsed.intent === 'test') return this.mutex.run(parsed.cls, () => this._applyTest(parsed, groupJid));
    // intent === 'ignore' → absolute silence
  }

  _alertGeminiDown(groupJid, degraded = false) {
    if (Date.now() - this.lastGeminiAlert < 3_600_000) return;
    this.lastGeminiAlert = Date.now();
    this.notifyOwner?.(degraded
      ? `⚠️ Gemini is unavailable (quota/outage). Attendance from ${groupJid} was processed in *basic mode* (exact names only). Test marks are paused until AI is back.`
      : `⚠️ Gemini is unavailable (quota/outage). A message in ${groupJid} could not be processed. Please check the AI key/quota.`);
  }

  /* ------------------------------------------------------------ attendance */
  async _applyAttendance(parsed, groupJid) {
    const date = pktDate(this.now());
    const key = `${date}|${parsed.cls}`;
    let s = this.sessions.get(key);
    if (s?.finalized) return this._applyCorrection(s, parsed);

    const at = pktTime(this.now());
    if (!s) {
      s = { key, date, cls: parsed.cls, groupJid, startedAt: this.now().getTime(), deadline: this.now().getTime() + this.cfg.bufferMs,
        marks: {}, unmatched: [], messageCount: 0, finalized: false };
      this.sessions.set(key, s);
      this._schedule(s);
      this.log?.info(`attendance: opened ${parsed.cls} (${date}); finalises in ${Math.round(this.cfg.bufferMs / 1000)}s`);
    }

    // Names that arrive after the grace window (a split list is still "the initial list") are the late arrivals.
    const afterGrace = this.now().getTime() - s.startedAt > this.cfg.graceMs;
    const extra = this.cfg.additionalStatus === 'present' ? 'Present' : 'Late';
    for (const { student } of parsed.present.matched) {
      if (!s.marks[student.id]) s.marks[student.id] = { status: afterGrace ? extra : 'Present', at };
    }
    for (const { student } of parsed.late.matched) s.marks[student.id] = { status: 'Late', at: s.marks[student.id]?.at || at };
    for (const { student } of parsed.absent.matched) delete s.marks[student.id];
    for (const u of [...parsed.present.unmatched, ...parsed.late.unmatched, ...parsed.absent.unmatched]) {
      const label = u.candidates?.length ? `${u.written} (could be: ${u.candidates.join(' / ')})` : u.written;
      if (!s.unmatched.includes(label)) s.unmatched.push(label);
    }
    s.messageCount++;
    this._persist();
  }

  _schedule(s) {
    clearTimeout(this.timers.get(s.key));
    const wait = Math.max(0, s.deadline - this.now().getTime());
    this.timers.set(s.key, setTimeout(() => this.mutex.run(s.cls, () => this._finalize(s.key)).catch((e) => this.log?.error('finalize failed:', e)), wait));
  }

  async _finalize(key) {
    const s = this.sessions.get(key);
    if (!s || s.finalized) return;
    s.finalized = true;                       // flip first: a crash mid-way must not re-send everything
    this.timers.delete(key);
    this._persist();

    const roster = sortStudents(await this.sheets.getRoster(s.cls));
    const records = roster.map((st) => ({ student: st, status: s.marks[st.id]?.status || 'Absent', time: s.marks[st.id]?.at || '' }));

    try { await this.sheets.upsertAttendance(s.date, s.cls, records); }
    catch (e) {
      this.log?.error('attendance: sheet write failed', e);
      this.notifyOwner?.(`⚠️ Could not save ${s.cls} attendance (${s.date}) to Google Sheets: ${String(e.message).slice(0, 150)}. Parents were still notified.`);
    }

    const by = (st) => records.filter((r) => r.status === st).map((r) => r.student);
    const present = by('Present'), late = by('Late'), absent = by('Absent');

    const lines = [`📋 *Attendance — ${s.cls}*`, `📅 ${prettyDate(s.date)}`, '',
      `✅ Present: ${present.length}/${roster.length}`];
    if (late.length) lines.push(`⏰ Late (${late.length}): ${listNames(late)}`);
    lines.push(absent.length ? `❌ Absent (${absent.length}): ${listNames(absent)}` : '🎉 No absentees today!');
    if (s.unmatched.length) lines.push('', `⚠️ Could not match: ${s.unmatched.join('; ')}`, '_Reply with the correct names to fix — parents are notified only after a short hold._');
    this.queue.enqueue({ kind: 'group', to: s.groupJid, text: lines.join('\n'), dedupeKey: `att-summary:${s.key}` });

    const hold = s.unmatched.length ? this.cfg.parentHoldUnmatchedMs : this.cfg.parentHoldMs;
    const missing = [];
    for (const st of [...absent, ...late]) {
      const status = absent.includes(st) ? 'Absent' : 'Late';
      if (!this._dmParent(st, this._parentAttendanceText(st, status, s), `att:${s.date}:${st.id}:${status}`, hold)) missing.push(st.name);
    }
    if (missing.length) this.notifyOwner?.(`⚠️ No valid parent phone for: ${missing.join(', ')} (${s.cls}). Please fix in the Students sheet.`);
    this.log?.info(`attendance: finalised ${s.cls}: ${present.length} present, ${late.length} late, ${absent.length} absent`);
  }

  /** After finalisation, extra names flip Absent → Late/Present, cancel the pending DM, and the group is told. */
  async _applyCorrection(s, parsed) {
    const current = await this.sheets.getAttendance(s.date, s.cls);
    const extra = this.cfg.additionalStatus === 'present' ? 'Present' : 'Late';
    const flips = [];
    const consider = (list, forced) => {
      for (const { student } of list) {
        if (current.get(student.id) === 'Absent' && !flips.some((f) => f.student.id === student.id)) flips.push({ student, status: forced || extra });
      }
    };
    consider(parsed.late.matched, 'Late');
    consider(parsed.present.matched);
    if (!flips.length) return;

    const at = pktTime(this.now());
    await this.sheets.upsertAttendance(s.date, s.cls, flips.map((f) => ({ student: f.student, status: f.status, time: at })));
    const notes = [];
    const missing = [];
    for (const f of flips) {
      const verdict = this.queue.cancel(`att:${s.date}:${f.student.id}:Absent`);
      notes.push(`${f.student.name}: Absent → ${f.status}${verdict === 'already-sent' ? ' (parent had already been notified)' : ''}`);
      if (f.status === 'Late' && !this._dmParent(f.student, this._parentAttendanceText(f.student, 'Late', s), `att:${s.date}:${f.student.id}:Late`, this.cfg.parentHoldMs)) missing.push(f.student.name);
    }
    this.queue.enqueue({ kind: 'group', to: s.groupJid,
      text: `✏️ *Attendance updated — ${s.cls}*\n${notes.join('\n')}`, dedupeKey: `att-fix:${s.key}:${sha(notes.join('|'))}` });
    if (missing.length) this.notifyOwner?.(`⚠️ No valid parent phone for: ${missing.join(', ')} (${s.cls}).`);
  }

  /* ----------------------------------------------------------------- tests */
  async _applyTest(parsed, groupJid) {
    const { cls, subject, total, scores } = parsed;
    if (!scores.matched.length) { this.log?.warn(`tests: nothing matched for ${cls}`); return; }
    const date = pktDate(this.now());
    const testKey = sha(`${date}|${cls}|${(subject || 'general').toLowerCase()}|${total ?? ''}`);

    await this.sheets.saveTest({ date, cls, subject, testKey, total, scores: scores.matched.map((m) => ({ student: m.student, marks: m.marks })) });

    const ranked = [...scores.matched].sort((a, b) => b.marks - a.marks);
    const avg = ranked.reduce((a, m) => a + m.marks, 0) / ranked.length;
    const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const lines = [`📝 *Test Results — ${cls}*`, `📅 ${prettyDate(date)}${subject ? `  |  📚 ${subject}` : ''}${total ? `  |  Total: ${total}` : ''}`, ''];
    if (this.cfg.showScoresInGroup) {
      ranked.forEach((m, i) => lines.push(`${i + 1}. ${m.student.name} — *${fmt(m.marks)}${total ? `/${total}` : ''}*`));
      lines.push('');
    }
    lines.push(`📊 Average: ${fmt(Math.round(avg * 10) / 10)}${total ? ` (${Math.round((avg / total) * 100)}%)` : ''}  |  🏆 Top: ${ranked[0].student.name} (${fmt(ranked[0].marks)})  |  Appeared: ${ranked.length}`);
    if (scores.unmatched.length) {
      lines.push('', `⚠️ Not recorded: ${scores.unmatched.map((u) => `${u.written}${u.reason ? ` (${u.reason})` : u.candidates?.length ? ` (could be: ${u.candidates.join(' / ')})` : ''}`).join('; ')}`);
    }
    lines.push('', '_Individual results have been sent to parents._');
    const fingerprint = sha(ranked.map((m) => `${m.student.id}:${m.marks}`).sort().join(','));
    this.queue.enqueue({ kind: 'group', to: groupJid, text: lines.join('\n'), dedupeKey: `test-summary:${testKey}:${fingerprint}` });

    const hold = scores.unmatched.length ? this.cfg.parentHoldUnmatchedMs : this.cfg.parentHoldMs;
    const missing = [];
    for (const m of ranked) {
      const pct = total ? ` (${Math.round((m.marks / total) * 100)}%)` : '';
      const text = [`Assalam-o-Alaikum ${m.student.parentName || 'Parent'},`, '',
        `📝 *Test result* — ${this.cfg.academyName}`, `Student: *${m.student.name}* (${cls})`,
        subject ? `Subject: ${subject}` : null, `Marks: *${fmt(m.marks)}${total ? `/${total}` : ''}*${pct}`,
        `Class average: ${fmt(Math.round(avg * 10) / 10)}`, '', 'Keep up the effort! 🌟'].filter((l) => l !== null).join('\n');
      if (!this._dmParent(m.student, text, `test:${testKey}:${m.student.id}:${m.marks}`, hold)) missing.push(m.student.name);
    }
    if (missing.length) this.notifyOwner?.(`⚠️ No valid parent phone for: ${missing.join(', ')} (${cls}) — test result not delivered.`);
  }

  /* --------------------------------------------------------------- helpers */
  _dmParent(student, text, dedupeKey, holdMs) {
    if (!student.parentPhone) return false;
    this.queue.enqueue({ kind: 'parent', to: toJid(student.parentPhone), text, dedupeKey, notBefore: Date.now() + holdMs,
      meta: { kind: 'attendance_dm', studentId: student.id } });
    return true;
  }
  _parentAttendanceText(student, status, s) {
    const what = status === 'Absent' ? 'was marked *ABSENT*' : 'arrived *LATE*';
    return [`Assalam-o-Alaikum ${student.parentName || 'Parent'},`, '',
      `${STATUS_ICON[status]} *${student.name}* (${s.cls}) ${what} today, ${prettyDate(s.date)}.`, '',
      status === 'Absent' ? 'If there is a reason, please let us know. Regular attendance is key to steady progress.' : 'Please help your child reach on time so no lesson is missed.',
      '', `— ${this.cfg.academyName}`].join('\n');
  }

  /* ----------------------------------------------------------- persistence */
  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const cutoff = Date.now() - 2 * 86_400_000;
      for (const [k, s] of this.sessions) if (s.finalized && s.deadline < cutoff) this.sessions.delete(k);
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.sessions.values()]));
      fs.renameSync(tmp, this.statePath);
    } catch (e) { this.log?.error('sessions persist failed:', e.message); }
  }
  _restore() {
    if (!fs.existsSync(this.statePath)) return;
    try {
      for (const s of JSON.parse(fs.readFileSync(this.statePath, 'utf8'))) this.sessions.set(s.key, s);
      const open = [...this.sessions.values()].filter((s) => !s.finalized).length;
      if (open) this.log?.info(`attendance: restored ${open} open session(s); overdue ones finalise immediately`);
    } catch (e) { this.log?.error('sessions restore failed (starting empty):', e.message); }
  }
}
