/**
 * End-to-end mock test. No WhatsApp, no Google, no Gemini, no network.
 * The REAL SheetsService / GeminiService / QueueManager / AttendanceManager / FeeManager / MessageRouter run
 * against in-memory fakes. Timings are scaled down (5-min buffer → 0.7 s, 15-25 s delay → 25-40 ms).
 *
 *   node test/mockTest.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { GeminiService } from '../src/geminiService.js';
import { QueueManager } from '../src/queueManager.js';
import { SheetsService, TABS } from '../src/sheetsService.js';
import { detectClassCodes, fuzzyMatch, normalizePkPhone, pktMonth, toJid } from '../src/utils.js';
import { FakeGeminiModel, FakeSheetsApi, FakeWhatsApp } from './mocks.js';

/* ------------------------------------------------------------------ harness */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(10); }
  throw new Error(`timeout waiting for ${what}`);
};
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([name, false, e]); console.log(`  ✗ ${name}\n      ${String(e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
const silent = { debug() {}, info() {}, warn() {}, error: (...a) => console.log('      [logger.error]', ...a.map((x) => (x?.stack ? x.stack.split('\n').slice(0, 3).join(' | ') : x))) };

/* ------------------------------------------------------------------ fixtures */
const OWNER = '923001110000';
const TEACHER = '923001112222';
const G10A = '120363000000000010@g.us', G10B = '120363000000000011@g.us', G9B = '120363000000000090@g.us', G8C = '120363000000000080@g.us';
const jid = (p) => toJid(p);

const STUDENTS = [
  TABS.Students,
  ['S001', 'Ayesha Khan', '10A', 'Mr Khan', '0300-1000001', '5000', '1', 'yes'],
  ['S002', 'Bilal Ahmed', '10A', 'Mr Ahmed', '+92 300 1000002', '3000', '2', 'yes'],
  ['S003', 'Sara Malik', '10A', 'Mrs Malik', '3001000003', '5000', '3', 'yes'],       // Sheets dropped the leading 0
  ['S004', 'Hina Tariq', '10A', 'Mr Tariq', '923001000004', '3000', '4', 'yes'],
  ['S005', 'Usman Ghani', '10A', 'Mr Ghani', '03001000005', '5000', '5', 'yes'],
  ['S006', 'Zoya Sheikh', '10A', 'Mr Sheikh', '03001000006', '5000', '6', 'yes'],
  ['S900', 'Left Student', '10A', 'x', '03001000999', '5000', '9', 'no'],                // inactive → must be ignored
  ['S201', 'Ali Raza', '10B', 'Mr Raza', '03002000001', '4000', '1', 'yes'],
  ['S202', 'Ali Khan', '10B', 'Mr Khan', '03002000002', '4000', '2', 'yes'],
  ['S203', 'Noor Fatima', '10B', 'Mr Fatima', '03002000003', '4000', '3', 'yes'],
  ['S101', 'Zainab Fatima', '9B', 'Mr Fatima', '03003000001', '4000', '1', 'yes'],
  ['S102', 'Hamza Sheikh', '9B', 'Mr Sheikh', '03003000002', '4000', '2', 'yes'],
  ['S103', 'Rida Noor', '9B', 'Mr Noor', '', '4000', '3', 'yes'],                      // no parent phone
  ['S301', 'Maaz Ahmed', '8C', 'Mr Ahmed', '03004000001', '3000', '1', 'yes'],
  ['S302', 'Laiba Noor', '8C', 'Mr Noor', '03004000002', '3000', '2', 'yes'],
  ['S303', 'Taha Iqbal', '8C', 'Mr Iqbal', '03004000003', '3000', '3', 'yes'],
];

const baseConfig = (stateDir) => ({
  academyName: 'Test Academy', ownerPhones: [OWNER], ownerLids: [], teacherLids: [], allowedGroupJids: [G10A, G10B, G9B, G8C], teacherPhones: [TEACHER],
  bufferMs: 700, graceMs: 200, additionalStatus: 'late', parentHoldMs: 0, parentHoldUnmatchedMs: 500, showScoresInGroup: true,
  parentDelayMs: [25, 40], systemDelayMs: [2, 5], maxParentPerDay: 100, retryBackoffMs: 20,
  reminder: { startDay: 5, intervalDays: 5, max: 4 }, paymentMinConfidence: 0.6, sendParentReceipt: false, stateDir,
});

let gid = 0;
const groupMsg = (chatId, text, from = TEACHER) => ({ id: `m${++gid}`, isGroup: true, chatId, senderPhones: [from], senderIds: [], text });
const ownerImage = (caption, from = OWNER, chatId = jid(OWNER)) => ({
  id: `m${++gid}`, isGroup: false, chatId, senderPhones: [from], senderIds: [],
  image: { mimeType: 'image/jpeg', caption, getBuffer: async () => Buffer.from('fake-image-bytes') },
});
const ownerText = (text) => ({ id: `m${++gid}`, isGroup: false, chatId: jid(OWNER), senderPhones: [OWNER], senderIds: [], text });

async function buildWorld(stateDir, shared = {}) {
  const api = shared.api || new FakeSheetsApi();
  if (!shared.api) api.seed('Students', STUDENTS);
  const model = shared.model || new FakeGeminiModel();
  const wa = new FakeWhatsApp();
  const config = baseConfig(stateDir);
  const sheets = new SheetsService({ spreadsheetId: 'FAKE', api, logger: silent, cacheTtlMs: 0, retryBaseMs: 1 });
  await sheets.init();
  const gemini = new GeminiService({ model, logger: silent, rpm: 0, maxRetries: 2, retryBaseMs: 5 });
  const app = createApp({ config, sheets, gemini, sendFn: wa.send, logger: silent });
  await app.start();
  return { api, model, wa, sheets, gemini, app, config };
}

/* ============================================================== 1. unit-ish */
console.log('\n▶ Utilities');
await test('Pakistani phone normalisation (all formats Sheets may hold)', () => {
  assert.equal(normalizePkPhone('0300-1234567'), '923001234567');
  assert.equal(normalizePkPhone('+92 300 1234567'), '923001234567');
  assert.equal(normalizePkPhone('3001234567'), '923001234567');
  assert.equal(normalizePkPhone('00923001234567'), '923001234567');
  assert.equal(normalizePkPhone('12345'), null);
  assert.equal(normalizePkPhone(''), null);
});
await test('class-code detection: tolerant of spacing/case, strict on word boundaries', () => {
  const known = ['10A', '9B', '10B'];
  assert.deepEqual(detectClassCodes('10a present: Ali', known), ['10A']);
  assert.deepEqual(detectClassCodes('Class 10 A attendance', known), ['10A']);
  assert.deepEqual(detectClassCodes('9-B and 10B tomorrow', known), ['9B', '10B']);
  assert.deepEqual(detectClassCodes('10 Ahmed was here', known), []);     // "10 A" inside "10 Ahmed" is NOT a class
  assert.deepEqual(detectClassCodes('Good morning everyone', known), []);
});
await test('fuzzy matcher: fixes typos, refuses to guess between look-alikes', () => {
  const roster = [{ id: 1, name: 'Ayesha Khan', roll: '1' }, { id: 2, name: 'Ali Raza', roll: '2' }, { id: 3, name: 'Ali Khan', roll: '3' }, { id: 4, name: 'Sana Malik', roll: '4' }];
  assert.equal(fuzzyMatch('Ayisha', roster).student.id, 1);
  assert.equal(fuzzyMatch('ayesha khan', roster).student.id, 1);
  assert.ok(fuzzyMatch('Ali', roster).ambiguous, '"Ali" must be ambiguous');
  assert.equal(fuzzyMatch('Ali Raza', roster).student.id, 2);
  assert.equal(fuzzyMatch('2', roster).student.id, 2, 'roll number');
  assert.equal(fuzzyMatch('Xyz', roster), null);
  assert.equal(fuzzyMatch('Sona', roster), null, 'Sona ≠ Sana');
});

/* ============================================================ 2. queue only */
console.log('\n▶ QueueManager (anti-ban behaviour)');
await test('parent DMs are spaced by the random delay; group traffic is never stuck behind them', async () => {
  const sent = [];
  const q = new QueueManager({ send: async (i) => { sent.push({ ...i, t: Date.now() }); }, parentDelayMs: [60, 80], systemDelayMs: [1, 2], logger: silent });
  q.start();
  for (let i = 0; i < 4; i++) q.enqueue({ kind: 'parent', to: `p${i}`, text: `m${i}` });
  q.enqueue({ kind: 'group', to: 'g', text: 'summary' });
  await q.drain();
  const parents = sent.filter((s) => s.kind === 'parent');
  assert.equal(parents.length, 4);
  for (let i = 1; i < 4; i++) assert.ok(parents[i].t - parents[i - 1].t >= 55, `gap ${parents[i].t - parents[i - 1].t}ms too small`);
  assert.ok(sent.findIndex((s) => s.kind === 'group') <= 1, 'group summary should jump the parent line');
  q.stop();
});
await test('dedupeKey, cancel(), guard() and daily cap', async () => {
  const sent = [];
  const q = new QueueManager({ send: async (i) => { sent.push(i.text); }, parentDelayMs: [5, 6], systemDelayMs: [1, 2], maxParentPerDay: 2, logger: silent });
  assert.equal(q.enqueue({ kind: 'parent', to: 'a', text: 'A', dedupeKey: 'k1', notBefore: Date.now() + 10_000 }).status, 'queued');
  assert.equal(q.enqueue({ kind: 'parent', to: 'a', text: 'A', dedupeKey: 'k1' }).status, 'duplicate');
  assert.equal(q.cancel('k1'), 'cancelled');
  assert.equal(q.cancel('nope'), 'none');
  q.setGuard(async (i) => i.text !== 'DROPME');
  q.start();
  q.enqueue({ kind: 'parent', to: 'a', text: 'DROPME' });
  for (const t of ['P1', 'P2', 'P3']) q.enqueue({ kind: 'parent', to: 'a', text: t });
  await sleep(300);
  assert.deepEqual(sent, ['P1', 'P2'], 'guard dropped DROPME; daily cap (2) held P3 back');
  assert.equal(q.snapshot().pending, 1);
  q.stop();
});
await test('transient failures are retried; permanent ones are abandoned; queue survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q-'));
  const file = path.join(dir, 'queue.json');
  let fail = 2; const sent = [];
  const mk = (send) => new QueueManager({ send, persistPath: file, parentDelayMs: [2, 3], systemDelayMs: [1, 2], retryBackoffMs: 10, maxAttempts: 3, logger: silent });
  const q1 = mk(async (i) => { if (i.text === 'FLAKY' && fail-- > 0) throw new Error('boom'); if (i.text === 'GONE') { const e = new Error('not on WA'); e.permanent = true; throw e; } sent.push(i.text); });
  q1.start(); q1.enqueue({ kind: 'group', to: 'g', text: 'FLAKY' }); q1.enqueue({ kind: 'group', to: 'g', text: 'GONE' });
  await q1.drain();
  assert.deepEqual(sent, ['FLAKY']); assert.equal(q1.failed.length, 1); q1.stop();

  const q2 = mk(async () => {}); q2.setPaused(true);
  q2.enqueue({ kind: 'parent', to: 'a', text: 'x1' }); q2.enqueue({ kind: 'parent', to: 'a', text: 'x2' }); q2.stop();
  const got = []; const q3 = mk(async (i) => { got.push(i.text); });
  assert.equal(q3.snapshot().pending, 2, 'pending messages restored from disk'); q3.start(); await q3.drain(); q3.stop();
  assert.deepEqual(got, ['x1', 'x2']);
});

/* =========================================================== 3. full pipeline */
console.log('\n▶ Full pipeline (router → Gemini → buffer → Sheets → queue → WhatsApp)');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-'));
const W = await buildWorld(stateDir);
const { api, model, wa, app } = W;
const send = (evt) => app.router.handle(evt);

// Gemini "scripts": what a good model would answer for each teacher message.
model.onGroup('10A notes chapter 5', { intent: 'ignore', classCode: '10A' });
model.onGroup('Ayisha', { intent: 'attendance', classCode: '10A', present: [
  { written: 'Ayisha', studentId: 'S001' }, { written: 'Bilal Ahmad', studentId: 'S002' },
  { written: 'Sara', studentId: 'S003' }, { written: 'Hena', studentId: null }], late: [], absent: [], test: null });
model.onGroup('10A Usman', { intent: 'attendance', classCode: '10A', present: [{ written: 'Usman', studentId: 'S005' }], late: [], absent: [] });
model.onGroup('10B present: Ali', { intent: 'attendance', classCode: '10B', present: [
  { written: 'Ali', studentId: null }, { written: 'Noor Fatima', studentId: 'S203' }, { written: 'Xyz', studentId: null }], late: [], absent: [] });
model.onGroup('10B Ali Raza', { intent: 'attendance', classCode: '10B', present: [{ written: 'Ali Raza', studentId: 'S201' }], late: [], absent: [] });
model.onGroup('9B Maths test', { intent: 'test', classCode: '9B', test: { subject: 'Maths', totalMarks: 50, scores: [
  { written: 'Zainab', studentId: 'S101', marks: 45 }, { written: 'Hamza', studentId: 'S102', marks: 38 }, { written: 'Rida', studentId: 'S103', marks: 61 }] } });
model.failWhen('9B present\nZainab');

await test('Sheets bootstrap: missing tabs + headers are created automatically', () => {
  for (const tab of ['Students', 'Attendance', 'Tests', 'Fees']) assert.deepEqual(api.data.get(tab)[0], TABS[tab]);
});

await test('study material / chat / non-teachers / foreign groups → ZERO replies (and no wasted AI calls)', async () => {
  const before = model.groupCalls.length;
  await send(groupMsg(G10A, 'Good morning everyone 🌞'));                              // no class code → local gate
  await send(groupMsg(G10A, '10A notes chapter 5 pdf https://drive.example.com/x'));   // class code → Gemini says ignore
  await send(groupMsg(G10A, '10A present\nAyisha\nSara', '923009998888'));              // a student, not a teacher
  await send(groupMsg('120363999999999999@g.us', '10A present\nAyisha'));               // group not whitelisted
  await send({ id: 'media1', isGroup: true, chatId: G10A, senderPhones: [TEACHER], senderIds: [], text: null }); // PDF/image
  await sleep(150);
  assert.equal(model.groupCalls.length - before, 1, 'only the 10A notes message should have reached Gemini');
  assert.equal(wa.log.length, 0, 'bot must stay completely silent');
});

await test('prompt hygiene: roster of the right class only, inactive students excluded', () => {
  const p = model.groupCalls[0].prompt;
  assert.ok(p.includes('S001 | Ayesha Khan') && !p.includes('S900') && !p.includes('Zainab'));
});

let t0;
await test('attendance: typos auto-corrected, 5-minute buffer honoured, late arrivals, auto-absent', async () => {
  t0 = Date.now();
  await send(groupMsg(G10A, '10A present\nAyisha\nBilal Ahmad\nSara\nHena'));       // "Hena" → Gemini gives null → local fuzzy rescues it
  await sleep(380);                                                                   // > graceMs, < buffer
  assert.equal(wa.to(G10A).length, 0, 'nothing may be posted before the buffer ends');
  await send(groupMsg(G10A, '10A Usman'));                                            // follow-up inside the window
  await waitFor(() => wa.to(G10A).length === 1, 3000, 'group summary');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 650, `summary came too early (${elapsed}ms)`);

  const summary = wa.to(G10A)[0].text;
  assert.match(summary, /Attendance — 10A/);
  assert.match(summary, /Present: 4\/6/);                  // Ayesha, Bilal, Sara, Hina (inactive student not counted)
  assert.match(summary, /Late \(1\): Usman Ghani/);
  assert.match(summary, /Absent \(1\): Zoya Sheikh/);
  assert.doesNotMatch(summary, /Could not match/);

  const att = api.table('Attendance').filter((r) => r.Class === '10A');
  const st = Object.fromEntries(att.map((r) => [r.Name, r.Status]));
  assert.deepEqual(st, { 'Ayesha Khan': 'Present', 'Bilal Ahmed': 'Present', 'Sara Malik': 'Present', 'Hina Tariq': 'Present', 'Usman Ghani': 'Late', 'Zoya Sheikh': 'Absent' });
});

await test('group vs private split: parents of Absent + Late ONLY, spaced out, correct numbers', async () => {
  await waitFor(() => wa.kind('parent').length === 2, 3000, '2 parent DMs');
  const dms = wa.kind('parent');
  const zoya = wa.to(jid('923001000006')), usman = wa.to(jid('923001000005'));
  assert.equal(zoya.length, 1); assert.equal(usman.length, 1);
  assert.match(zoya[0].text, /Zoya Sheikh.*ABSENT/s); assert.match(usman[0].text, /Usman Ghani.*LATE/s);
  assert.ok(Math.abs(dms[1].t - dms[0].t) >= 20, 'parent DMs must be spaced');
  for (const present of ['923001000001', '923001000002', '923001000003', '923001000004']) assert.equal(wa.to(jid(present)).length, 0, 'present students get no DM');
});

await test('ambiguity/unknown names are flagged (never guessed); post-finalise correction cancels the wrong DM', async () => {
  await send(groupMsg(G10B, '10B present: Ali, Noor Fatima, Xyz'));
  await waitFor(() => wa.to(G10B).length === 1, 3000, '10B summary');
  const s = wa.to(G10B)[0].text;
  assert.match(s, /Could not match/); assert.match(s, /Xyz/); assert.match(s, /Ali \(could be: Ali Raza \/ Ali Khan\)/);
  assert.match(s, /Absent \(2\): Ali Raza, Ali Khan/);
  assert.equal(wa.to(jid('923002000001')).length, 0, 'parents are on HOLD while names are unresolved');

  await sleep(60);
  await send(groupMsg(G10B, '10B Ali Raza'));                                          // teacher fixes it during the hold
  await waitFor(() => wa.to(G10B).length === 2, 3000, 'correction note');
  assert.match(wa.to(G10B)[1].text, /Attendance updated.*Ali Raza: Absent → Late/s);

  await waitFor(() => wa.to(jid('923002000002')).length === 1 && wa.to(jid('923002000001')).length === 1, 4000, 'held DMs released');
  assert.match(wa.to(jid('923002000002'))[0].text, /ABSENT/);                          // Ali Khan: still absent
  assert.match(wa.to(jid('923002000001'))[0].text, /LATE/);                            // Ali Raza: corrected → LATE, absent DM cancelled
  assert.equal(wa.to(jid('923002000001')).filter((m) => /ABSENT/.test(m.text)).length, 0);
  const row = api.table('Attendance').find((r) => r.Name === 'Ali Raza');
  assert.equal(row.Status, 'Late');
  assert.equal(api.table('Attendance').filter((r) => r.Name === 'Ali Raza').length, 1, 'upsert, never duplicate rows');
});

await test('test marks: group summary + individual parent DMs; invalid marks rejected; re-post is idempotent', async () => {
  await send(groupMsg(G9B, '9B Maths test out of 50\nZainab 45\nHamza 38\nRida 61'));
  await waitFor(() => wa.to(G9B).length === 1, 3000, 'test summary');
  const s = wa.to(G9B)[0].text;
  assert.match(s, /Test Results — 9B/); assert.match(s, /Zainab Fatima — \*45\/50\*/); assert.match(s, /Hamza Sheikh — \*38\/50\*/);
  assert.match(s, /Average: 41\.5/); assert.match(s, /Not recorded: Rida \(marks 61 exceed total 50\)/);
  await waitFor(() => wa.to(jid('923003000001')).length === 1 && wa.to(jid('923003000002')).length === 1, 3000, 'score DMs');
  assert.match(wa.to(jid('923003000001'))[0].text, /Marks: \*45\/50\* \(90%\)/);
  const rows = api.table('Tests'); assert.equal(rows.length, 2); assert.equal(rows.find((r) => r.Name === 'Zainab Fatima').Percentage, '90');

  const n = wa.log.length;
  await send(groupMsg(G9B, '9B Maths test out of 50\nZainab 45\nHamza 38\nRida 61'));  // teacher double-posts / WhatsApp redelivers
  await sleep(250);
  assert.equal(wa.log.length, n, 'identical re-post must not spam group or parents');
  assert.equal(api.table('Tests').length, 2);
});

await test('Gemini outage → degraded local attendance + owner alert; missing parent phone reported', async () => {
  await send(groupMsg(G9B, '9B present\nZainab\nHamza'));            // model throws 503 twice → local fallback
  await waitFor(() => wa.to(G9B).length === 2, 3000, '9B fallback summary');
  const s = wa.to(G9B)[1].text;
  assert.match(s, /Attendance — 9B/); assert.match(s, /Present: 2\/3/); assert.match(s, /Absent \(1\): Rida Noor/);
  await waitFor(() => wa.to(jid(OWNER)).some((m) => /Gemini is unavailable/.test(m.text)), 3000, 'owner AI alert');
  await waitFor(() => wa.to(jid(OWNER)).some((m) => /No valid parent phone for: Rida Noor/.test(m.text)), 3000, 'owner phone alert');
  assert.equal(wa.to(jid('923003000001')).filter((m) => /ABSENT/.test(m.text)).length, 0);
});

/* ============================================================== 4. fees */
console.log('\n▶ Fees (Vision OCR, matching, reminders, report)');
const pay = (o) => ({ isPaymentScreenshot: true, status: 'success', currency: 'PKR', platform: 'Easypaisa', senderName: 'Parent', confidence: 0.95, candidateIds: [], forMonth: null, ...o });
model.onPayment('Ayesha 10A', pay({ amount: 5000, transactionId: 'EP100', studentId: 'S001' }));
model.onPayment('Bilal rest', pay({ amount: 2000, transactionId: 'JC201', studentId: 'S002', platform: 'JazzCash' }));
model.onPayment('Bilal', pay({ amount: 1000, transactionId: 'JC200', studentId: 'S002', platform: 'JazzCash' }));
model.onPayment('Sara dup', pay({ amount: 5000, transactionId: 'EP100', studentId: 'S003' }));
model.onPayment('Hina failed', pay({ amount: 3000, status: 'failed', studentId: 'S004' }));
model.onPayment('mystery', pay({ amount: 3000, studentId: null, candidateIds: ['S004', 'S005'] }));
model.onPayment('blurry', pay({ amount: 3000, studentId: 'S004', confidence: 0.3 }));
model.onPayment('selfie', { isPaymentScreenshot: false, status: 'unknown', amount: null, confidence: 0.9 });
model.onPayment('Sara paid', pay({ amount: 5000, transactionId: 'EP300', studentId: 'S003' }));

const ownerMsgs = () => wa.to(jid(OWNER));
const lastOwner = async (n) => { await waitFor(() => ownerMsgs().length > n, 3000, 'owner reply'); return ownerMsgs()[ownerMsgs().length - 1].text; };
const month = pktMonth();

await test('owner screenshot → amount + student read → Fees row Unpaid → Paid', async () => {
  const n = ownerMsgs().length;
  await send(ownerImage('Ayesha 10A'));
  const r = await lastOwner(n);
  assert.match(r, /Payment recorded — PAID/); assert.match(r, /Ayesha Khan/); assert.match(r, /Rs 5,000/); assert.match(r, /EP100/);
  const row = api.table('Fees').find((x) => x.StudentID === 'S001' && x.Month === month);
  assert.equal(row.Status, 'Paid'); assert.equal(row.PaidAmount, '5000'); assert.equal(row.TransactionID, 'EP100');
  assert.equal(api.table('Fees').filter((x) => x.Month === month).length, 15, 'one row per active student with a fee (Rida included, inactive excluded)');
});
await test('dynamic fees: partial payment is tracked (3000 fee, 1000 paid → 2000 left), second payment completes it', async () => {
  let n = ownerMsgs().length; await send(ownerImage('Bilal'));
  assert.match(await lastOwner(n), /Partial payment.*2,000 remaining/s);
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S002').Status, 'Partial');
  n = ownerMsgs().length; await send(ownerImage('Bilal rest'));
  assert.match(await lastOwner(n), /PAID/);
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S002').Status, 'Paid');
});
await test('guards: duplicate TxID, failed txn, unknown student, low confidence, non-receipt, non-owner sender', async () => {
  const expectReply = async (caption, re) => { const n = ownerMsgs().length; await send(ownerImage(caption)); assert.match(await lastOwner(n), re); };
  await expectReply('Sara dup', /Duplicate transaction/);
  await expectReply('Hina failed', /failed/i);
  await expectReply('mystery', /which student.*Hina Tariq.*Usman Ghani/s);
  await expectReply('blurry', /30% sure/);
  await expectReply('selfie', /does not look like a payment/);
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S003').Status, 'Unpaid');
  const n = wa.log.length;
  await send(ownerImage('Sara paid', '923215555555', jid('923215555555')));        // random parent sending an image
  await sleep(150); assert.equal(wa.log.length, n, 'non-owner private chats are ignored');
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S003').Status, 'Unpaid');
});

await test('reminders: only Unpaid/Partial; a reminder already queued is DROPPED if the fee is paid before it goes out', async () => {
  app.queue.setPaused(true);                                       // hold everything so we can pay "in between"
  const r = await app.fees.runReminders({ force: true });
  assert.equal(r.queued, 12, '15 fee rows − Ayesha − Bilal (paid) − Rida (no phone)');
  await send(ownerImage('Sara paid'));                              // Sara pays while her reminder is still in the queue
  await waitFor(() => api.table('Fees').find((x) => x.StudentID === 'S003').Status === 'Paid', 3000, 'Sara paid in sheet');
  app.queue.setPaused(false);
  await app.queue.drain();

  const reminders = wa.kind('parent').filter((m) => /Fee reminder/.test(m.text));
  assert.equal(reminders.length, 11, '12 queued − 1 dropped by the guard');
  assert.equal(wa.to(jid('923001000003')).filter((m) => /Fee reminder/.test(m.text)).length, 0, 'Sara must not be reminded');
  assert.equal(wa.to(jid('923001000001')).filter((m) => /Fee reminder/.test(m.text)).length, 0, 'Ayesha (paid) must not be reminded');
  assert.match(wa.to(jid('923001000005')).find((m) => /Fee reminder/.test(m.text)).text, /Usman Ghani.*Rs 5,000/s);
  assert.ok(ownerMsgs().some((m) => /no valid phone\): Rida Noor/.test(m.text)), 'owner told about the missing phone');

  await waitFor(() => api.table('Fees').find((x) => x.StudentID === 'S005').RemindersSent === '1', 3000, 'reminder counter');
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S003').RemindersSent, '0');
  assert.equal((await app.fees.runReminders({ force: true })).queued, 0, 'same-day duplicate suppressed');
  assert.equal((await app.fees.runReminders()).queued, 0, 'interval rule: nobody is due again yet');
});

await test('month-end report: paid / partial / defaulters, with reminder counts per student', async () => {
  const rep = await app.fees.buildMonthEndReport();
  assert.match(rep, /3 paid.*0 partial.*12 unpaid/s);
  assert.match(rep, /PAID \(3\)/); assert.match(rep, /UNPAID DEFAULTERS \(12\)/);
  assert.match(rep, /Usman Ghani \(10A\) — Rs 5,000 due — 1 reminder\b/);
  assert.match(rep, /Rida Noor \(9B\) — Rs 4,000 due — 0 reminders/);
  assert.match(rep, /Collected Rs 13,000 of Rs 59,000/);
  const n = ownerMsgs().length;
  await send(ownerText('report'));
  await waitFor(() => ownerMsgs().slice(n).some((m) => /Fee Report/.test(m.text)), 3000, 'report delivered to owner');
});

await test('owner text commands: manual "paid", ambiguity handling, silence on small talk', async () => {
  await app.queue.drain();
  let n = ownerMsgs().length; await send(ownerText('paid Zoya Sheikh'));
  assert.match(await lastOwner(n), /Zoya Sheikh.*marked \*Paid\*/s);
  assert.equal(api.table('Fees').find((x) => x.StudentID === 'S006').Status, 'Paid');
  n = ownerMsgs().length; await send(ownerText('paid ali'));
  assert.match(await lastOwner(n), /Which one\?.*Ali Raza.*Ali Khan/s);
  const before = wa.log.length; await send(ownerText('assalam o alaikum, kaise hain?')); await sleep(120);
  assert.equal(wa.log.length, before, 'no reply to casual chat');
});

/* ======================================================= 5. crash recovery */
console.log('\n▶ Crash / restart recovery');
await test('open attendance session survives a restart and still finalises on time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-'));
  const shared = { api: new FakeSheetsApi(), model: new FakeGeminiModel() };
  shared.api.seed('Students', STUDENTS);
  shared.model.onGroup('8C present', { intent: 'attendance', classCode: '8C', present: [{ written: 'Maaz', studentId: 'S301' }], late: [], absent: [] });

  const w1 = await buildWorld(dir, shared);
  await w1.app.router.handle(groupMsg(G8C, '8C present\nMaaz'));
  await sleep(150);
  await w1.app.stop();                                              // "process killed" mid-buffer
  assert.equal(w1.wa.to(G8C).length, 0);

  const w2 = await buildWorld(dir, shared);                         // fresh process, same disk state
  await waitFor(() => w2.wa.to(G8C).length === 1, 3000, 'summary after restart');
  assert.match(w2.wa.to(G8C)[0].text, /Present: 1\/3.*Absent \(2\): Laiba Noor, Taha Iqbal/s);
  assert.equal(shared.api.table('Attendance').filter((r) => r.Class === '8C').length, 3);
  await waitFor(() => w2.wa.kind('parent').length === 2, 3000, 'absent parents DM-ed');
  await w2.app.stop();
});

/* ================================================== 6. multi-group (Class 9-12) */
console.log('\n▶ Multi-group, numeric classes, teacher-only authorisation');
await test('Classes 9/10/11/12 in 4 groups, NO whitelist: each gets its own buffer + summary; non-teacher ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-'));
  const api = new FakeSheetsApi(); const model = new FakeGeminiModel();
  const rows = [TABS.Students];
  const names = { 9: ['Anas Ali', 'Zed One'], 10: ['Bina Shah', 'Yan Two'], 11: ['Cara Doe', 'Xia Three'], 12: ['Dan Moe', 'Wes Four'] };
  let k = 0;
  for (const [c, [a, b]] of Object.entries(names)) { rows.push([`M${++k}`, a, c, 'P', `0310000000${k}`, '1000', '1', 'yes'], [`M${++k}`, b, c, 'P', `0310000000${k}`, '1000', '2', 'yes']); }
  api.seed('Students', rows);
  const scripts = { Anas: ['9', 'M1'], Bina: ['10', 'M3'], Cara: ['11', 'M5'], Dan: ['12', 'M7'] };
  for (const [key, [cls, id]] of Object.entries(scripts)) model.onGroup(key, { intent: 'attendance', classCode: cls, present: [{ written: key, studentId: id }], late: [], absent: [] });
  const W2 = await buildWorld(dir, { api, model });
  W2.app.router.cfg.allowedGroupJids = [];                      // whitelist empty = dynamic
  const groups = { 9: 'g9@g.us', 10: 'g10@g.us', 11: 'g11@g.us', 12: 'g12@g.us' };
  const post = (g, t, from = TEACHER) => W2.app.router.handle(groupMsg(g, t, from));
  await Promise.all([post(groups[9], '9th present\nAnas'), post(groups[10], 'Class 10 present: Bina'), post(groups[11], '11 present Cara'), post(groups[12], '12 present Dan')]);
  await post(groups[12], '12 present Wes', '923215550000');     // not a teacher
  for (const [c, g] of Object.entries(groups)) {
    await waitFor(() => W2.wa.to(g).length === 1, 4000, `summary for class ${c}`);
    assert.match(W2.wa.to(g)[0].text, new RegExp(`Attendance — ${c}\\b`)); assert.match(W2.wa.to(g)[0].text, /Present: 1\/2/); assert.match(W2.wa.to(g)[0].text, /Absent \(1\)/);
  }
  assert.equal(W2.wa.kind('group').length, 4, 'exactly one summary per group, none for the non-teacher');
  await waitFor(() => W2.wa.kind('parent').length === 4, 4000, 'one absent DM per class');
  await W2.app.stop();
});
await test('fail-closed: with no teachers configured nobody can trigger the bot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
  const W3 = await buildWorld(dir); W3.app.router.cfg.teacherPhones = [];
  const n = W3.model.groupCalls.length;
  await W3.app.router.handle(groupMsg(G10A, '10A present\nAyisha')); await sleep(100);
  assert.equal(W3.model.groupCalls.length, n); await W3.app.stop();
});

/* ------------------------------------------------------------------ summary */
if (process.env.SHOW_TRANSCRIPT) {
  console.log('\n──────── WhatsApp transcript (everything the bot sent) ────────');
  const name = (to) => (to === G10A ? 'GROUP 10A' : to === G10B ? 'GROUP 10B' : to === G9B ? 'GROUP 9B' : to === jid(OWNER) ? 'OWNER' : `PARENT ${to.split('@')[0]}`);
  for (const m of wa.log) console.log(`\n» ${name(m.to)}\n${m.text}`);
}
await app.stop();
const failed = results.filter((r) => !r[1]);
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} tests passed`);
process.exit(failed.length ? 1 : 0);
