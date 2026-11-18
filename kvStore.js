import fs from 'node:fs';
import path from 'node:path';
/**
 * Write-behind key/value store on top of the Google Sheet "Session" tab.
 * Reads are served from memory; writes are batched (default every 4 s) so Baileys' bursts of key updates
 * cost 3 Sheets API calls instead of hundreds. Failed flushes are retried automatically.
 * Used when SESSION_STORE=sheets (Render free tier: ephemeral disk, restarts at any time).
 */
export class SheetsKv {
 constructor({ sheets, logger, flushMs = 4000 }) {
 Object.assign(this, { sheets, log: logger, flushMs });
 this.map = new Map();
 this.dirty = new Map();
 this.timer = null;
 this.inflight = Promise.resolve();
 }
 async load() { this.map = await this.sheets.kvReadAll(); this.log?.info(`session store: loaded ${this.map.size} key(s) from Google Sheets`); return this; }
 get(k) { return this.map.get(k) ?? null; }
 set(k, v) {
 if (v === null || v === undefined) this.map.delete(k); else this.map.set(k, v);
 this.dirty.set(k, v ?? null);
 if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.flushMs); }
 }
 clearPrefix(prefix) { for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.set(k, null); }
 /** Pushes everything pending. Safe to call concurrently; always resolves after the data is written (or throws). */
 flush() {
 if (this.timer) { clearTimeout(this.timer); this.timer = null; }
 this.inflight = this.inflight.catch(() => {}).then(async () => {
 if (!this.dirty.size) return;
 const batch = new Map(this.dirty);
 this.dirty.clear();
 try { await this.sheets.kvWrite([...batch]); }
 catch (e) {
 for (const [k, v] of batch) if (!this.dirty.has(k)) this.dirty.set(k, v); // keep newer values, re-queue the rest
 this.log?.error('session store: flush failed, will retry in 15 s:', String(e.message).slice(0, 160));
 if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, 15_000);
 throw e;
 }
 });
 return this.inflight;
 }
 /** Restores queue/session JSON files from the sheet before the app reads them at boot. */
 hydrateFiles(dir, mapping) {
 fs.mkdirSync(dir, { recursive: true });
 let n = 0;
 for (const [key, file] of Object.entries(mapping)) {
 const v = this.get(key);
 if (v) { fs.writeFileSync(path.join(dir, file), v); n++; }
 }
 if (n) this.log?.info(`session store: restored ${n} state file(s) from Google Sheets`);
 }
}
