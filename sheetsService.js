import { KeyedMutex, normalizePkPhone, normClass, pktDate, pktTime } from './utils.js';

/** Exact tab layouts. The service creates missing tabs / header rows automatically. */
export const TABS = {
  Students: ['StudentID', 'Name', 'Class', 'ParentName', 'ParentPhone', 'MonthlyFee', 'RollNo', 'Active'],
  Attendance: ['Date', 'Class', 'StudentID', 'Name', 'Status', 'Time', 'UpdatedAt'],
  Tests: ['Date', 'Class', 'Subject', 'TestKey', 'StudentID', 'Name', 'Marks', 'TotalMarks', 'Percentage'],
  Fees: ['Month', 'StudentID', 'Name', 'Class', 'ParentPhone', 'ExpectedAmount', 'Status', 'PaidAmount', 'PaidDate',
    'PaymentMethod', 'TransactionID', 'RemindersSent', 'LastReminderDate', 'Notes'],
};

const colLetter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const money = (v) => Number(String(v ?? '').replace(/[^\d.]/g, '')) || 0;

export class SheetsService {
  /**
   * @param {object} o
   * @param {string} o.spreadsheetId
   * @param {object} [o.credentials]  service-account JSON (ignored when `api` is injected)
   * @param {object} [o.api]          googleapis `sheets_v4.Sheets` instance (or a fake, in tests)
   */
  constructor({ spreadsheetId, credentials, api = null, logger, cacheTtlMs = 60_000, retries = 5, retryBaseMs = 1000 }) {
    Object.assign(this, { spreadsheetId, credentials, api, log: logger, cacheTtlMs, retries, retryBaseMs });
    this.cache = { at: 0, students: null };
    this.writeLock = new KeyedMutex();
  }

  async init() {
    if (!this.api) {
      const { google } = await import('googleapis'); // lazy: tests never need the package
      const auth = new google.auth.GoogleAuth({ credentials: this.credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
      this.api = google.sheets({ version: 'v4', auth });
    }
    const meta = await this._retry(() => this.api.spreadsheets.get({ spreadsheetId: this.spreadsheetId, fields: 'sheets.properties.title' }));
    const existing = new Set((meta.data.sheets || []).map((s) => s.properties.title));
    const missing = Object.keys(TABS).filter((t) => !existing.has(t));
    if (missing.length) {
      await this._retry(() => this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
      }));
      this.log?.info(`sheets: created tab(s): ${missing.join(', ')}`);
    }
    for (const [tab, headers] of Object.entries(TABS)) {
      const r = await this._retry(() => this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${tab}!A1:${colLetter(headers.length)}1` }));
      if (!r.data.values?.[0]?.length) {
        await this._retry(() => this.api.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId, range: `${tab}!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] },
        }));
      }
    }
  }

  /* --------------------------------------------------------- low-level I/O */
  async _retry(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (err) {
        const code = Number(err?.code || err?.response?.status || err?.status);
        const transient = [429, 500, 502, 503, 504].includes(code) || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(String(err?.message));
        if (!transient || attempt >= this.retries) throw err;
        const wait = this.retryBaseMs * 2 ** attempt;
        this.log?.warn(`sheets: transient error (${code || err.message}); retry in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async _readTable(tab) {
    const headers = TABS[tab];
    const res = await this._retry(() => this.api.spreadsheets.values.get({ spreadsheetId: this.spreadsheetId, range: `${tab}!A:${colLetter(headers.length)}` }));
    const values = res.data.values || [];
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const raw = values[i] || [];
      if (!raw.some((c) => str(c))) continue;
      const o = { _row: i + 1 };
      headers.forEach((h, c) => { o[h] = raw[c] === undefined ? '' : raw[c]; });
      rows.push(o);
    }
    return rows;
  }

  /** Insert-or-update by composite key. One batchUpdate + one append per call. Serialised to avoid duplicate rows. */
  async _upsert(tab, keyFields, objs) {
    if (!objs.length) return;
    const headers = TABS[tab];
    const keyOf = (o) => keyFields.map((f) => str(o[f])).join('|');
    return this.writeLock.run(tab, async () => {
      const existing = new Map((await this._readTable(tab)).map((r) => [keyOf(r), r]));
      const updates = [], appends = [];
      for (const o of objs) {
        const ex = existing.get(keyOf(o));
        if (ex) {
          updates.push({ range: `${tab}!A${ex._row}`, values: [headers.map((h) => (h in o ? o[h] : ex[h]))] });
          Object.assign(ex, o);
        } else {
          appends.push(headers.map((h) => (o[h] === undefined ? '' : o[h])));
        }
      }
      if (updates.length) {
        await this._retry(() => this.api.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates },
        }));
      }
      if (appends.length) {
        await this._retry(() => this.api.spreadsheets.values.append({
          spreadsheetId: this.spreadsheetId, range: `${tab}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
          requestBody: { values: appends },
        }));
      }
    });
  }

  /* -------------------------------------------------------------- Students */
  async getStudents({ force = false } = {}) {
    if (!force && this.cache.students && Date.now() - this.cache.at < this.cacheTtlMs) return this.cache.students;
    const rows = await this._readTable('Students');
    const students = rows
      .filter((r) => str(r.Name) && str(r.Class))
      .map((r) => ({
        id: str(r.StudentID) || `R${r._row}`,
        name: str(r.Name),
        cls: normClass(r.Class),
        parentName: str(r.ParentName),
        parentPhone: normalizePkPhone(r.ParentPhone),
        monthlyFee: money(r.MonthlyFee),
        roll: str(r.RollNo),
        active: !/^(no|false|0|left|inactive|n)$/i.test(str(r.Active) || 'yes'),
      }))
      .filter((s) => s.active);
    this.cache = { at: Date.now(), students };
    return students;
  }
  async getClasses() { return [...new Set((await this.getStudents()).map((s) => s.cls))]; }
  async getRoster(cls) { const c = normClass(cls); return (await this.getStudents()).filter((s) => s.cls === c); }

  /* ------------------------------------------------------------ Attendance */
  /** records: [{student, status, time}] — idempotent per (Date, StudentID). */
  async upsertAttendance(date, cls, records) {
    const now = `${pktDate()} ${pktTime()}`;
    await this._upsert('Attendance', ['Date', 'StudentID'], records.map((r) => ({
      Date: date, Class: cls, StudentID: r.student.id, Name: r.student.name, Status: r.status, Time: r.time || '', UpdatedAt: now,
    })));
  }
  async getAttendance(date, cls) {
    const c = normClass(cls);
    const map = new Map();
    for (const r of await this._readTable('Attendance')) if (str(r.Date) === date && normClass(r.Class) === c) map.set(str(r.StudentID), str(r.Status));
    return map;
  }

  /* ----------------------------------------------------------------- Tests */
  /** scores: [{student, marks}] — idempotent per (TestKey, StudentID), so re-posting corrected marks overwrites. */
  async saveTest({ date, cls, subject, testKey, total, scores }) {
    await this._upsert('Tests', ['TestKey', 'StudentID'], scores.map((s) => ({
      Date: date, Class: cls, Subject: subject || '', TestKey: testKey, StudentID: s.student.id, Name: s.student.name,
      Marks: s.marks, TotalMarks: total ?? '', Percentage: total ? Math.round((s.marks / total) * 1000) / 10 : '',
    })));
  }

  /* ------------------------------------------------------------------ Fees */
  _toFee(r) {
    return {
      month: str(r.Month), studentId: str(r.StudentID), name: str(r.Name), cls: normClass(r.Class), parentPhone: str(r.ParentPhone),
      expected: money(r.ExpectedAmount), status: str(r.Status) || 'Unpaid', paidAmount: money(r.PaidAmount), paidDate: str(r.PaidDate),
      method: str(r.PaymentMethod), txId: str(r.TransactionID), reminders: Number(r.RemindersSent) || 0,
      lastReminder: str(r.LastReminderDate), notes: str(r.Notes),
    };
  }
  _fromFee(f) {
    const m = { month: 'Month', studentId: 'StudentID', name: 'Name', cls: 'Class', parentPhone: 'ParentPhone', expected: 'ExpectedAmount',
      status: 'Status', paidAmount: 'PaidAmount', paidDate: 'PaidDate', method: 'PaymentMethod', txId: 'TransactionID',
      reminders: 'RemindersSent', lastReminder: 'LastReminderDate', notes: 'Notes' };
    const o = {};
    for (const [k, v] of Object.entries(f)) if (m[k]) o[m[k]] = v;
    return o;
  }

  /** Creates an `Unpaid` row for every active student (with a fee) that has none for `month`. */
  async ensureFeeRows(month) {
    const students = await this.getStudents();
    const have = new Set((await this._readTable('Fees')).filter((r) => str(r.Month) === month).map((r) => str(r.StudentID)));
    const fresh = students.filter((s) => s.monthlyFee > 0 && !have.has(s.id)).map((s) => this._fromFee({
      month, studentId: s.id, name: s.name, cls: s.cls, parentPhone: s.parentPhone || '', expected: s.monthlyFee,
      status: 'Unpaid', paidAmount: 0, reminders: 0,
    }));
    await this._upsert('Fees', ['Month', 'StudentID'], fresh);
    return fresh.length;
  }
  async listFees(month) { return (await this._readTable('Fees')).filter((r) => str(r.Month) === month).map((r) => this._toFee(r)); }
  async getFee(month, studentId) { return (await this.listFees(month)).find((f) => f.studentId === studentId) || null; }
  async updateFee(month, studentId, patch) {
    await this._upsert('Fees', ['Month', 'StudentID'], [this._fromFee({ ...patch, month, studentId })]);
  }
  async findFeeByTxId(txId) {
    const t = str(txId).toLowerCase();
    if (!t) return null;
    const r = (await this._readTable('Fees')).find((x) => str(x.TransactionID).toLowerCase() === t);
    return r ? this._toFee(r) : null;
  }
}
