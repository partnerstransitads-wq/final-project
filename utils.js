import crypto from 'node:crypto';

export const TZ = 'Asia/Karachi';

/* ------------------------------------------------------------------ basics */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randInt = (min, max) => (max <= min ? min : crypto.randomInt(min, max + 1));
export const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

export function createLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const min = order[level] ?? 20;
  const make = (lvl) => (...a) => {
    if (order[lvl] >= min) console[lvl === 'debug' ? 'log' : lvl](`[${new Date().toISOString()}] ${lvl.toUpperCase()}`, ...a);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

/** Serialises async work per key (prevents read-modify-write races on the same class/day). */
export class KeyedMutex {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/* ------------------------------------------------------------------- dates */
const fmt = (opts) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...opts });
export const pktDate = (d = new Date()) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
export const pktMonth = (d = new Date()) => pktDate(d).slice(0, 7);
export const pktTime = (d = new Date()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
export const isLastDayOfMonthPKT = (d = new Date()) => pktMonth(new Date(d.getTime() + 86_400_000)) !== pktMonth(d);
export const nextPktMidnightMs = (d = new Date()) => new Date(`${pktDate(d)}T00:00:00+05:00`).getTime() + 86_400_000;

export function prettyDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
export function prettyMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 15)));
}
export function daysBetween(ymdA, ymdB) {
  const t = (s) => Date.UTC(...s.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((t(ymdB) - t(ymdA)) / 86_400_000);
}

/* ------------------------------------------------------------------ phones */
/** Normalises Pakistani (and other) numbers to digits-only international format, or null. */
export function normalizePkPhone(raw) {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('92') && d.length === 12) { /* already international */ }
  else if (d.startsWith('0') && d.length === 11) d = `92${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith('3')) d = `92${d}`; // Sheets ate the leading zero
  else if (d.length < 11 || d.length > 15) return null;
  return d;
}
export const toJid = (phone) => `${phone}@s.whatsapp.net`;
export const jidToPhone = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
export const samePhone = (a, b) => {
  const x = String(a || '').replace(/\D/g, ''), y = String(b || '').replace(/\D/g, '');
  return x.length >= 7 && y.length >= 7 && x.slice(-10) === y.slice(-10);
};

/* ------------------------------------------------------------- class codes */
export const normClass = (s) => String(s ?? '').toUpperCase().replace(/[\s\-_]+/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds known class codes (10A, "10 a", 9-B …) in free text. Returns them in order of appearance. */
export function detectClassCodes(text, knownClasses) {
  const found = [];
  for (const cls of knownClasses) {
    const toks = String(cls).match(/\d+|[A-Za-z]+/g);
    if (!toks) continue;
    const ordinal = toks.length === 1 && /^\d+$/.test(toks[0]) ? '(?:th|st|nd|rd)?' : '';   // numeric classes: "9th", "Class 10"
    const re = new RegExp(`(?<![A-Za-z0-9])${toks.map(escapeRe).join('[\\s\\-_]*')}${ordinal}(?![A-Za-z0-9])`, 'i');
    const m = re.exec(text);
    if (m) found.push({ cls, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.cls);
}

/* ------------------------------------------------------- fuzzy name match */
export const normName = (s) =>
  String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
export const similarity = (a, b) => (!a.length && !b.length ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/** Collapses common South-Asian romanisation variants: Ayesha/Ayisha/Aisha, Mohammad/Muhammad, Hina/Hena … */
const phon = (t) => t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/[eyi]/g, 'i').replace(/[ou]/g, 'u').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');
const tokSim = (a, b) => (a === b ? 1 : Math.max(similarity(a, b), similarity(phon(a), phon(b)) * 0.97));

export function nameScore(written, canonical) {
  const w = normName(written), c = normName(canonical);
  if (!w || !c) return 0;
  if (w === c) return 1;
  const wt = w.split(' '), ct = c.split(' ');
  const [small, big] = wt.length <= ct.length ? [wt, ct] : [ct, wt];
  const tok = small.reduce((s, t) => s + Math.max(...big.map((b) => tokSim(t, b))), 0) / small.length;
  return 0.9 * tok + 0.1 * similarity(w, c);
}

/**
 * Local (non-AI) matcher used as a safety net behind Gemini.
 * Returns {student,score} | {ambiguous:[students]} | null. Never guesses between near-equal candidates.
 */
export function fuzzyMatch(written, roster, { threshold = 0.75, margin = 0.08 } = {}) {
  const w = String(written ?? '').trim();
  if (!w) return null;
  if (/^\d{1,4}$/.test(w)) {
    const hit = roster.filter((s) => s.roll === w);
    if (hit.length === 1) return { student: hit[0], score: 1 };
    if (hit.length > 1) return { ambiguous: hit };
  }
  const scored = roster.map((s) => ({ s, score: nameScore(w, s.name) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < threshold) return null;
  const rivals = scored.filter((x) => x !== best && x.score >= best.score - margin);
  if (rivals.length) return { ambiguous: [best, ...rivals].map((x) => x.s) };
  return { student: best.s, score: best.score };
}

/* ------------------------------------------------------------- formatting */
export const rs = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export const listNames = (arr) => arr.map((s) => s.name).join(', ');
export function sortStudents(arr) {
  return [...arr].sort((a, b) => (Number(a.roll) || 1e9) - (Number(b.roll) || 1e9) || a.name.localeCompare(b.name));
}
export function chunkText(text, max = 3500) {
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
export function parseJsonLoose(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
/** Strips control chars + our prompt delimiter, caps length (cheap prompt-injection hygiene). */
export const sanitizeInput = (t, max = 3000) =>
  String(t ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/"""/g, "'''").trim().slice(0, max);
