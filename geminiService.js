import { fuzzyMatch, nameScore, normClass, normName, parseJsonLoose, sanitizeInput, sleep as realSleep } from './utils.js';

const rosterBlock = (code, roster) =>
  `[${code}]\n${roster.map((s) => `${s.id} | ${s.name} | roll ${s.roll || '-'}`).join('\n')}`;

/* ------------------------------------------------------------------ prompts */
function buildGroupPrompt({ text, classCodes, rosters }) {
  return `You are the message parser for a coaching academy's WhatsApp CLASS GROUPS in Pakistan.
Messages mix English, Urdu script and Roman Urdu. Names are often misspelled.

Classify the MESSAGE into exactly ONE intent:
- "attendance": a teacher lists students who are present / late / absent for a class (usually a class code followed by names).
- "test": a teacher posts test / quiz / exam marks for a class (names with numeric marks).
- "ignore": EVERYTHING else — study material, notes, PDFs, links, homework, syllabus, announcements, greetings, jokes, questions, chat.
When unsure choose "ignore". Never invent names or marks.

Class codes found in the message: ${classCodes.join(', ')}
Rosters (StudentID | Name | roll):
${classCodes.map((c) => rosterBlock(c, rosters.get(c) || [])).join('\n\n')}

Rules for names:
- For every person mentioned return the StudentID of the best-matching student in that class's roster. Fix spelling mistakes,
  Roman-Urdu/Urdu-script variants and first-name-only mentions. Roll numbers may be used instead of names.
- If a name could be two or more students, or matches nobody, return studentId null. Do NOT guess.
- In an "attendance" message an unlabeled list means PRESENT. "late", "deri", "لیٹ" = late. "absent", "gair hazir", "ghair hazir", "chutti", "leave" = absent.
- If several class codes appear, use the one the message is mainly about (normally the first).

Reply with ONLY this JSON (no prose, no markdown):
{"intent":"attendance"|"test"|"ignore","classCode":string|null,
 "present":[{"written":string,"studentId":string|null}],
 "late":[{"written":string,"studentId":string|null}],
 "absent":[{"written":string,"studentId":string|null}],
 "test":{"subject":string|null,"totalMarks":number|null,"scores":[{"written":string,"studentId":string|null,"marks":number}]}|null}

MESSAGE:
"""
${sanitizeInput(text)}
"""`;
}

function buildPaymentPrompt({ caption, students }) {
  const roster = students.map((s) => `${s.id} | ${s.name} | class ${s.cls} | roll ${s.roll || '-'}`).join('\n');
  return `You read mobile-payment screenshots (Easypaisa, JazzCash, SadaPay, NayaPay, bank apps, Raast, 1Link) for a coaching academy in Pakistan.

1. Decide whether the image is a payment confirmation / receipt.
2. Extract the amount actually transferred (PKR), platform, transaction id, sender name, date/time, and whether it succeeded.
3. Using ONLY the caption written by the academy owner, identify which student this payment is for (name, roll number, class, or id).
   Return the StudentID from the roster. If the caption is missing, ambiguous, or matches several students, return studentId null and list up to 3 candidate ids.
4. If the caption names a month (e.g. "Oct fee", "for February") return it as "forMonth" in YYYY-MM using the academy's current year unless stated; else null.
Never invent values. Use null for anything you cannot read clearly.

Student roster (StudentID | Name | class | roll):
${roster}

Reply with ONLY this JSON:
{"isPaymentScreenshot":boolean,"status":"success"|"failed"|"unknown","amount":number|null,"currency":"PKR"|string|null,
 "platform":"Easypaisa"|"JazzCash"|"Bank"|"Other"|null,"transactionId":string|null,"senderName":string|null,"dateTime":string|null,
 "studentId":string|null,"candidateIds":[string],"forMonth":string|null,"confidence":number}

CAPTION:
"""
${sanitizeInput(caption || '(none)', 500)}
"""`;
}

/* ------------------------------------------------------------------ service */
export class GeminiService {
  /**
   * @param {object} o
   * @param {{generateContent:Function}} o.model  Gemini model object (or a fake in tests)
   * @param {number} [o.rpm]  max requests/minute (0 = unlimited). Free tier is tight — keep it ≤ 8-10.
   */
  constructor({ model, logger, rpm = 8, maxRetries = 3, retryBaseMs = 4000, sleep = realSleep }) {
    Object.assign(this, { model, log: logger, maxRetries, retryBaseMs, sleep });
    this.minIntervalMs = rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
    this.lastCall = 0;
    this.chain = Promise.resolve();
    this.callCount = 0;
  }

  static async create({ apiKey, modelName = 'gemini-2.5-flash', ...rest }) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai'); // lazy: tests never need the package
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        // 2.5 Flash "thinks" by default (slower + eats quota). Parsing/OCR doesn't need it.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return new GeminiService({ model, ...rest });
  }

  _throttle() {
    const run = async () => {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = Date.now();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async _generate(parts) {
    for (let attempt = 1; ; attempt++) {
      await this._throttle();
      try {
        this.callCount++;
        const res = await this.model.generateContent(parts);
        return res.response.text();
      } catch (err) {
        const msg = String(err?.message || err);
        const retryable = /\b(429|500|502|503|504)\b|quota|overload|unavailable|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
        if (!retryable || attempt >= this.maxRetries) throw err;
        const wait = Math.min(60_000, this.retryBaseMs * 2 ** (attempt - 1));
        this.log?.warn(`gemini: ${msg.slice(0, 120)} — retry ${attempt}/${this.maxRetries - 1} in ${wait} ms`);
        await this.sleep(wait);
      }
    }
  }

  /* --------------------------------------------------------- name resolution */
  /** Never trusts the model blindly: ids must exist in the roster and look like the written name; else local fuzzy match. */
  _resolve(entries, roster, { marks = false, total = null } = {}) {
    const byId = new Map(roster.map((s) => [s.id, s]));
    const matched = [], unmatched = [], seen = new Set();
    for (const e of Array.isArray(entries) ? entries : []) {
      const written = String(e?.written ?? e?.name ?? '').trim().slice(0, 60);
      if (!written) continue;
      let student = null, candidates;
      const cand = e?.studentId != null ? byId.get(String(e.studentId)) : null;
      if (cand && (/^\d{1,4}$/.test(written) || nameScore(written, cand.name) >= 0.35)) student = cand;
      if (!student) {
        const f = fuzzyMatch(written, roster);
        if (f?.student) student = f.student; else candidates = f?.ambiguous?.map((s) => s.name);
      }
      let value;
      if (marks) {
        value = Number(e?.marks);
        if (!Number.isFinite(value) || value < 0) { unmatched.push({ written, reason: 'invalid marks' }); continue; }
        if (total && value > total) { unmatched.push({ written, reason: `marks ${value} exceed total ${total}` }); continue; }
      }
      if (!student) { unmatched.push({ written, candidates }); continue; }
      if (seen.has(student.id)) continue;
      seen.add(student.id);
      matched.push(marks ? { student, written, marks: value } : { student, written });
    }
    return { matched, unmatched };
  }

  /* -------------------------------------------------------- group messages */
  /**
   * @returns {Promise<{intent:'ignore'}|{intent:'attendance',cls,present,late,absent}|{intent:'test',cls,subject,total,scores}>}
   *          `.degraded` is set when Gemini was unreachable and the local fallback was used; `.error` when nothing could be done.
   */
  async parseGroupMessage({ text, classCodes, rosters }) {
    let data = null;
    try {
      data = parseJsonLoose(await this._generate([buildGroupPrompt({ text, classCodes, rosters })]));
    } catch (err) {
      this.log?.error('gemini: group parse failed, trying local fallback:', String(err?.message || err).slice(0, 200));
      const fb = localAttendanceFallback(text, classCodes[0], rosters.get(classCodes[0]) || [], this);
      return fb ? { ...fb, degraded: true } : { intent: 'ignore', error: true };
    }
    if (!data || typeof data !== 'object') return { intent: 'ignore' };

    const intent = String(data.intent || '').toLowerCase();
    if (intent !== 'attendance' && intent !== 'test') return { intent: 'ignore' };

    let cls = normClass(data.classCode);
    if (!classCodes.includes(cls)) {
      if (classCodes.length === 1) cls = classCodes[0]; else return { intent: 'ignore' };
    }
    const roster = rosters.get(cls) || [];
    if (!roster.length) return { intent: 'ignore' };

    if (intent === 'attendance') {
      const present = this._resolve(data.present, roster);
      const late = this._resolve(data.late, roster);
      const absent = this._resolve(data.absent, roster);
      const n = [present, late, absent].reduce((a, r) => a + r.matched.length + r.unmatched.length, 0);
      return n ? { intent, cls, present, late, absent } : { intent: 'ignore' };
    }

    const t = Number(data.test?.totalMarks);
    const total = Number.isFinite(t) && t > 0 ? t : null;
    const scores = this._resolve(data.test?.scores, roster, { marks: true, total });
    if (!scores.matched.length && !scores.unmatched.length) return { intent: 'ignore' };
    return { intent, cls, subject: String(data.test?.subject || '').trim().slice(0, 40) || null, total, scores };
  }

  /* ------------------------------------------------------ payment screenshot */
  async parsePayment({ imageBuffer, mimeType, caption, students }) {
    const raw = await this._generate([
      buildPaymentPrompt({ caption, students }),
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: Buffer.from(imageBuffer).toString('base64') } },
    ]);
    const d = parseJsonLoose(raw) || {};
    const byId = new Map(students.map((s) => [s.id, s]));
    const amount = Number(String(d.amount ?? '').replace(/[^\d.]/g, ''));
    let student = d.studentId != null ? byId.get(String(d.studentId)) || null : null;
    if (!student) student = matchCaptionLocally(caption, students);
    const candidates = (Array.isArray(d.candidateIds) ? d.candidateIds : []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 3);
    return {
      isPayment: d.isPaymentScreenshot === true,
      status: ['success', 'failed'].includes(d.status) ? d.status : 'unknown',
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      platform: d.platform || null,
      txId: d.transactionId ? String(d.transactionId).trim() : null,
      senderName: d.senderName || null,
      paidAt: d.dateTime || null,
      forMonth: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(d.forMonth || '')) ? d.forMonth : null,
      confidence: Math.min(1, Math.max(0, Number(d.confidence) || 0)),
      student, candidates,
    };
  }
}

/* ---------------------------------------------------------- local fallbacks */
/** Caption → student without AI: exact StudentID token, or a full roster name contained in the caption. */
export function matchCaptionLocally(caption, students) {
  const cap = String(caption || '');
  if (!cap.trim()) return null;
  const idHit = students.filter((s) => new RegExp(`(?<![A-Za-z0-9])${s.id}(?![A-Za-z0-9])`, 'i').test(cap));
  if (idHit.length === 1) return idHit[0];
  const n = ` ${normName(cap)} `;
  const nameHit = students.filter((s) => n.includes(` ${normName(s.name)} `));
  return nameHit.length === 1 ? nameHit[0] : null;
}

/**
 * Degraded mode (Gemini quota exhausted / outage): handle only the simplest case — a class code followed by a list of names.
 * Conservative on purpose: if fewer than 60 % of the lines look like roster names, it refuses (chat / study material).
 */
export function localAttendanceFallback(text, cls, roster, svc) {
  if (!cls || !roster.length) return null;
  const NOISE = /\b(present|absent|late|attendance|today|aaj|hazir|hazri|list|students?)\b/gi;
  const parts = String(text)
    .replace(new RegExp(`${cls.match(/\d+|[A-Za-z]+/g).join('[\\s\\-_]*')}`, 'i'), ' ')
    .replace(NOISE, ' ')
    .split(/[\n,;،]+/)
    .map((p) => p.replace(/^[\s\-•*\d.)(:]+/, '').trim())
    .filter((p) => p.length >= 2 && p.length <= 40);
  if (parts.length < 2) return null;
  const r = svc._resolve(parts.map((w) => ({ written: w })), roster);
  if (r.matched.length / parts.length < 0.6) return null;
  const empty = { matched: [], unmatched: [] };
  return { intent: 'attendance', cls, present: r, late: empty, absent: empty };
}
