/** In-memory stand-ins for Google Sheets, Gemini and WhatsApp. The REAL service classes run on top of these. */
import { TABS } from '../src/sheetsService.js';

/* ------------------------------------------------- fake googleapis Sheets v4 */
export class FakeSheetsApi {
  constructor() {
    this.data = new Map();           // tab -> array of rows (array of cells)
    this.calls = { get: 0, update: 0, batchUpdate: 0, append: 0 };
    const tabOf = (range) => range.split('!')[0];
    const rowOf = (range) => Number(range.match(/!A(\d+)/)?.[1] || 1);
    const strRow = (r) => r.map((c) => (c === undefined || c === null ? '' : String(c)));
    this.spreadsheets = {
      get: async () => ({ data: { sheets: [...this.data.keys()].map((title) => ({ properties: { title } })) } }),
      batchUpdate: async ({ requestBody }) => {
        for (const r of requestBody.requests) if (r.addSheet) this.data.set(r.addSheet.properties.title, []);
        return { data: {} };
      },
      values: {
        get: async ({ range }) => {
          this.calls.get++;
          let rows = (this.data.get(tabOf(range)) || []).map(strRow);
          if (/!A1:[A-Z]+1$/.test(range)) rows = rows.slice(0, 1);
          // The real API trims trailing empty cells — emulate it, our parser must cope.
          rows = rows.map((r) => { const c = [...r]; while (c.length && c[c.length - 1] === '') c.pop(); return c; });
          return { data: { values: rows } };
        },
        update: async ({ range, requestBody }) => { this.calls.update++; const t = this.data.get(tabOf(range)); t[rowOf(range) - 1] = strRow(requestBody.values[0]); return { data: {} }; },
        batchUpdate: async ({ requestBody }) => {
          this.calls.batchUpdate++;
          for (const d of requestBody.data) { const t = this.data.get(tabOf(d.range)); t[rowOf(d.range) - 1] = strRow(d.values[0]); }
          return { data: {} };
        },
        append: async ({ range, requestBody }) => {
          this.calls.append++;
          const t = this.data.get(tabOf(range));
          for (const r of requestBody.values) t.push(strRow(r));
          return { data: {} };
        },
      },
    };
  }
  seed(tab, rows) { this.data.set(tab, rows.map((r) => [...r])); }
  /** Rows as objects (using the canonical headers). */
  table(tab) {
    const h = TABS[tab];
    return (this.data.get(tab) || []).slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
  }
}

/* ------------------------------------------------------------ fake Gemini model */
const wrap = (obj) => ({ response: { text: () => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`` } });

export class FakeGeminiModel {
  constructor() { this.calls = []; this.groupScripts = []; this.paymentScripts = []; this.failOn = []; }
  onGroup(substr, json) { this.groupScripts.push([substr, json]); }
  onPayment(captionSubstr, json) { this.paymentScripts.push([captionSubstr, json]); }
  failWhen(substr) { this.failOn.push(substr); }
  get groupCalls() { return this.calls.filter((c) => !c.vision); }

  async generateContent(parts) {
    const prompt = typeof parts[0] === 'string' ? parts[0] : '';
    const vision = parts.length > 1;
    this.calls.push({ prompt, vision });
    if (vision) {
      const caption = prompt.match(/CAPTION:\n"""\n([\s\S]*?)\n"""/)?.[1] ?? '';
      for (const [k, v] of this.paymentScripts) if (caption.includes(k)) return wrap(v);
      return wrap({ isPaymentScreenshot: false, status: 'unknown', amount: null, confidence: 0.9 });
    }
    const msg = prompt.match(/MESSAGE:\n"""\n([\s\S]*?)\n"""/)?.[1] ?? '';
    for (const k of this.failOn) if (msg.includes(k)) throw new Error('[503 Service Unavailable] The model is overloaded');
    for (const [k, v] of this.groupScripts) if (msg.includes(k)) return wrap(v);
    return wrap({ intent: 'ignore' });
  }
}

/* ---------------------------------------------------------- fake WhatsApp sender */
export class FakeWhatsApp {
  constructor() { this.log = []; this.failNext = 0; }
  send = async (item) => {
    if (this.failNext > 0) { this.failNext--; throw new Error('simulated socket error'); }
    this.log.push({ to: item.to, kind: item.kind, text: item.text, t: Date.now() });
  };
  to(jid) { return this.log.filter((m) => m.to === jid); }
  kind(k) { return this.log.filter((m) => m.kind === k); }
}
