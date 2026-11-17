import {
  chunkText, daysBetween, fuzzyMatch, isLastDayOfMonthPKT, pktDate, pktMonth, prettyMonth, rs, sortStudents, toJid,
} from './utils.js';

const HELP = `🤖 *Owner commands*
• Send a payment screenshot with the student's name / roll no. as caption
• *report* — fee report for this month
• *remind* — send fee reminders now
• *paid <student name or id>* — mark a month's fee as paid manually`;

export class FeeManager {
  constructor({ sheets, gemini, queue, config, logger, notifyOwner }) {
    Object.assign(this, { sheets, gemini, queue, cfg: config, log: logger, notifyOwner });
  }

  /* ------------------------------------------------- owner: payment photo */
  async handleOwnerImage({ buffer, mimeType, caption, reply }) {
    const students = await this.sheets.getStudents();
    let p;
    try { p = await this.gemini.parsePayment({ imageBuffer: buffer, mimeType, caption, students }); }
    catch (e) {
      this.log?.error('fees: vision failed', e);
      return reply('⚠️ I could not read that screenshot right now (AI service busy/quota). Please resend in a few minutes.');
    }

    if (!p.isPayment) return reply('🤔 That image does not look like a payment receipt, so I ignored it.');
    if (p.status === 'failed') return reply('❌ That screenshot shows a *failed/pending* transaction. Nothing was recorded.');
    if (!p.amount) return reply('⚠️ I could not read the amount clearly. Please send a sharper screenshot.');
    if (p.confidence < this.cfg.paymentMinConfidence) {
      return reply(`⚠️ I am only ${Math.round(p.confidence * 100)}% sure about this screenshot (read: ${rs(p.amount)}). Please resend a clearer one — nothing was recorded.`);
    }
    if (!p.student) {
      const hint = p.candidates.length ? `\nPossible students:\n${p.candidates.map((s) => `• ${s.name} (${s.cls}, roll ${s.roll || '-'})`).join('\n')}` : '';
      return reply(`❓ Received ${rs(p.amount)} but I could not tell *which student* it is for. Please resend with the name / roll number in the caption.${hint}`);
    }

    const student = p.student;
    const month = p.forMonth || pktMonth();

    if (p.txId) {
      const dup = await this.sheets.findFeeByTxId(p.txId);
      if (dup) {
        const same = dup.studentId === student.id && dup.month === month;
        return reply(same
          ? `ℹ️ Transaction ${p.txId} is already recorded for ${student.name} (${prettyMonth(month)}). No change.`
          : `🚨 *Duplicate transaction!* ID ${p.txId} was already used for ${dup.name} (${prettyMonth(dup.month)}). Nothing recorded for ${student.name}.`);
      }
    }

    await this.sheets.ensureFeeRows(month);
    const fee = await this.sheets.getFee(month, student.id);
    if (!fee) return reply(`⚠️ ${student.name} has no monthly fee set in the Students sheet, so nothing was recorded.`);
    if (fee.status === 'Paid') return reply(`ℹ️ ${student.name}'s ${prettyMonth(month)} fee is already marked *Paid*. Nothing changed. (Received ${rs(p.amount)} — check manually if this is an advance.)`);

    const totalPaid = fee.paidAmount + p.amount;
    const paid = totalPaid >= fee.expected;
    await this.sheets.updateFee(month, student.id, {
      status: paid ? 'Paid' : 'Partial', paidAmount: totalPaid, paidDate: pktDate(), method: p.platform || '', txId: p.txId || '',
      notes: [fee.notes, p.senderName ? `from ${p.senderName}` : ''].filter(Boolean).join(' | '),
    });

    const lines = [paid ? '✅ *Payment recorded — PAID*' : '🟡 *Partial payment recorded*',
      `👤 ${student.name} (${student.cls})`, `💰 ${rs(p.amount)}${p.platform ? ` via ${p.platform}` : ''}`,
      p.txId ? `🧾 TxID: ${p.txId}` : null, `📆 ${prettyMonth(month)}`];
    if (paid) {
      lines.push(totalPaid > fee.expected ? `ℹ️ Excess of ${rs(totalPaid - fee.expected)} over the fee of ${rs(fee.expected)}.` : `Fee: ${rs(fee.expected)} — reminders stopped.`);
    } else {
      lines.push(`Paid so far ${rs(totalPaid)} of ${rs(fee.expected)} — *${rs(fee.expected - totalPaid)} remaining*. Reminders continue.`);
    }
    await reply(lines.filter(Boolean).join('\n'));

    if (paid && this.cfg.sendParentReceipt && student.parentPhone) {
      this.queue.enqueue({ kind: 'parent', to: toJid(student.parentPhone), dedupeKey: `receipt:${month}:${student.id}:${p.txId || totalPaid}`,
        text: `Assalam-o-Alaikum ${student.parentName || 'Parent'},\n✅ We received ${rs(p.amount)} for *${student.name}*'s ${prettyMonth(month)} fee. JazakAllah!\n— ${this.cfg.academyName}` });
    }
  }

  /* --------------------------------------------------- owner: text commands */
  async handleOwnerText(text, reply) {
    const t = String(text || '').trim();
    const lower = t.toLowerCase();
    if (/^(help|\?|commands)$/.test(lower)) return reply(HELP);
    if (/^(report|fee report|fees)$/.test(lower)) return this.sendMonthEndReport({ reply });
    if (/^(remind|reminders|remind now)$/.test(lower)) {
      const r = await this.runReminders({ force: true });
      return reply(`🔔 Queued ${r.queued} fee reminder(s).`);
    }
    const m = lower.match(/^paid\s+(.+)$/);
    if (m) return this._manualPaid(t.slice(t.toLowerCase().indexOf('paid') + 4).trim(), reply);
    // Anything else: stay silent — the owner may simply be chatting with this number.
  }

  async _manualPaid(query, reply) {
    const students = await this.sheets.getStudents();
    const byId = students.find((s) => s.id.toLowerCase() === query.toLowerCase());
    const f = byId ? { student: byId } : fuzzyMatch(query, students);
    if (f?.ambiguous) return reply(`❓ Which one?\n${f.ambiguous.map((s) => `• ${s.name} (${s.cls}) — id ${s.id}`).join('\n')}\nReply: paid <id>`);
    if (!f?.student) return reply(`❓ No student matches "${query}".`);
    const month = pktMonth();
    await this.sheets.ensureFeeRows(month);
    const fee = await this.sheets.getFee(month, f.student.id);
    if (!fee) return reply(`⚠️ ${f.student.name} has no fee configured.`);
    await this.sheets.updateFee(month, f.student.id, { status: 'Paid', paidAmount: fee.expected, paidDate: pktDate(), method: 'Manual', notes: [fee.notes, 'marked manually by owner'].filter(Boolean).join(' | ') });
    return reply(`✅ ${f.student.name} (${f.student.cls}) marked *Paid* for ${prettyMonth(month)}. Reminders stopped.`);
  }

  /* --------------------------------------------------------------- reminders */
  async runReminders({ force = false } = {}) {
    const month = pktMonth(), today = pktDate();
    if (!force && Number(today.slice(8)) < this.cfg.reminder.startDay) return { queued: 0, skipped: 'before start day' };
    await this.sheets.ensureFeeRows(month);
    const students = new Map((await this.sheets.getStudents()).map((s) => [s.id, s]));
    let queued = 0;
    const noPhone = [];
    for (const f of await this.sheets.listFees(month)) {
      if (!['Unpaid', 'Partial'].includes(f.status)) continue;
      if (f.reminders >= this.cfg.reminder.max) continue;
      if (!force && f.lastReminder && daysBetween(f.lastReminder, today) < this.cfg.reminder.intervalDays) continue;
      const st = students.get(f.studentId);
      if (!st) continue;
      if (!st.parentPhone) { noPhone.push(st.name); continue; }
      const due = f.expected - f.paidAmount;
      const r = this.queue.enqueue({
        kind: 'parent', to: toJid(st.parentPhone), dedupeKey: `fee:${month}:${f.studentId}:${today}`,
        meta: { kind: 'fee_reminder', month, studentId: f.studentId },
        text: [`Assalam-o-Alaikum ${st.parentName || 'Parent'},`, '',
          `🔔 *Fee reminder* — ${this.cfg.academyName}`, `Student: *${st.name}* (${st.cls})`,
          `${prettyMonth(month)} fee pending: *${rs(due)}*${f.status === 'Partial' ? ` (received ${rs(f.paidAmount)} of ${rs(f.expected)})` : ''}`,
          '', 'If you have already paid, please send us the payment screenshot. JazakAllah! 🙏'].join('\n'),
      });
      if (r.status === 'queued') queued++;
    }
    if (noPhone.length) this.notifyOwner?.(`⚠️ Fee reminder skipped (no valid phone): ${noPhone.join(', ')}`, `fee-nophone:${month}:${today}`);
    return { queued };
  }

  /** Queue guard: a reminder queued earlier must NOT go out if the fee was paid in the meantime. */
  async shouldDeliver(item) {
    if (item.meta?.kind !== 'fee_reminder') return true;
    const f = await this.sheets.getFee(item.meta.month, item.meta.studentId);
    return !!f && ['Unpaid', 'Partial'].includes(f.status);
  }
  async markReminderSent({ month, studentId }) {
    const f = await this.sheets.getFee(month, studentId);
    if (f) await this.sheets.updateFee(month, studentId, { reminders: f.reminders + 1, lastReminder: pktDate() });
  }

  /* ------------------------------------------------------------------ report */
  async buildMonthEndReport(month = pktMonth()) {
    await this.sheets.ensureFeeRows(month);
    const rows = await this.sheets.listFees(month);
    const byCls = (a, b) => a.cls.localeCompare(b.cls) || a.name.localeCompare(b.name);
    const paid = rows.filter((r) => r.status === 'Paid').sort(byCls);
    const part = rows.filter((r) => r.status === 'Partial').sort(byCls);
    const unpaid = rows.filter((r) => r.status === 'Unpaid').sort(byCls);
    const expected = rows.reduce((a, r) => a + r.expected, 0);
    const got = rows.reduce((a, r) => a + r.paidAmount, 0);
    const rem = (r) => `${r.reminders} reminder${r.reminders === 1 ? '' : 's'}`;

    const L = [`📊 *Fee Report — ${prettyMonth(month)}*`, `${this.cfg.academyName}`, '',
      `👥 ${rows.length} students  |  ✅ ${paid.length} paid  |  🟡 ${part.length} partial  |  ❌ ${unpaid.length} unpaid`,
      `💰 Collected ${rs(got)} of ${rs(expected)}${expected ? ` (${Math.round((got / expected) * 100)}%)` : ''}`, ''];
    L.push(`✅ *PAID (${paid.length})*`);
    paid.forEach((r) => L.push(`• ${r.name} (${r.cls}) — ${rs(r.paidAmount)} — ${rem(r)}`));
    if (part.length) { L.push('', `🟡 *PARTIAL (${part.length})*`); part.forEach((r) => L.push(`• ${r.name} (${r.cls}) — ${rs(r.paidAmount)}/${rs(r.expected)} — ${rem(r)}`)); }
    L.push('', `❌ *UNPAID DEFAULTERS (${unpaid.length})*`);
    unpaid.forEach((r) => L.push(`• ${r.name} (${r.cls}) — ${rs(r.expected)} due — ${rem(r)}`));
    return L.join('\n');
  }

  async sendMonthEndReport({ reply } = {}) {
    const month = pktMonth();
    const parts = chunkText(await this.buildMonthEndReport(month));
    parts.forEach((text, i) => {
      if (reply) reply(text);
      else this.notifyOwner?.(text, `fee-report:${month}:${pktDate()}:${i}`);
    });
  }
  isMonthEnd() { return isLastDayOfMonthPKT(); }
}
