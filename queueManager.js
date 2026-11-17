import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randInt, pktDate, nextPktMidnightMs } from './utils.js';

/**
 * Single outbound pipe for EVERYTHING the bot sends.
 *
 *  - kind "parent"  : private DMs to parents. Spaced by a random 15-25 s gap, capped per day.
 *  - kind "group" / "owner" / "system": quick (≈1-2 s apart) and never stuck behind parent DMs.
 *  - Persisted to disk, so a crash / redeploy never loses (or double-sends) pending messages.
 *  - dedupeKey: the same logical message is never queued/sent twice.
 *  - guard(): last-second veto (e.g. fee already paid since the reminder was queued).
 *  - notBefore: delayed delivery (used for the "typo-fix hold" before DM-ing parents).
 */
export class QueueManager extends EventEmitter {
  constructor({
    send, logger, persistPath = null,
    parentDelayMs = [15_000, 25_000], systemDelayMs = [800, 2000],
    maxParentPerDay = 150, maxAttempts = 3, retryBackoffMs = 30_000, rand = randInt,
  }) {
    super();
    Object.assign(this, { sendFn: send, log: logger, persistPath, parentDelayMs, systemDelayMs, maxParentPerDay, maxAttempts, retryBackoffMs, rand });
    this.items = [];
    this.failed = [];
    this.sentKeys = new Map(); // dedupeKey -> epoch ms (kept 3 days)
    this.stats = { date: pktDate(), parentSent: 0 };
    this.seq = 0;
    this.running = false;
    this.paused = false;
    this.delivering = false;
    this.nextParentAt = 0;
    this.nextSystemAt = 0;
    this.guard = null;
    this._wake = null;
    this._load();
  }

  setGuard(fn) { this.guard = fn; }

  /* ------------------------------------------------------------ public API */
  enqueue({ kind = 'system', to, text, dedupeKey = null, notBefore = 0, meta = {} }) {
    if (!to || !text) throw new Error('enqueue: "to" and "text" are required');
    if (dedupeKey && (this.sentKeys.has(dedupeKey) || this.items.some((i) => i.dedupeKey === dedupeKey))) {
      return { status: 'duplicate' };
    }
    const item = { id: `${Date.now().toString(36)}-${++this.seq}`, seq: ++this.seq, kind, to, text, dedupeKey, notBefore, meta, attempts: 0 };
    this.items.push(item);
    this._persist();
    this._poke();
    return { status: 'queued', id: item.id };
  }

  /** Removes a still-queued message. Returns 'cancelled' | 'already-sent' | 'none'. */
  cancel(dedupeKey) {
    const i = this.items.findIndex((x) => x.dedupeKey === dedupeKey);
    if (i >= 0) { this.items.splice(i, 1); this._persist(); return 'cancelled'; }
    return this.sentKeys.has(dedupeKey) ? 'already-sent' : 'none';
  }

  start() { if (this.running) return; this.running = true; this._loop(); }
  stop() { this.running = false; this._poke(); this._persist(); }
  setPaused(p) { this.paused = !!p; this._poke(); }
  snapshot() {
    return { pending: this.items.length, pendingParent: this.items.filter((i) => i.kind === 'parent').length,
      parentSentToday: this.stats.parentSent, failed: this.failed.length, paused: this.paused };
  }
  /** Resolves when nothing is pending or in flight (used by tests / graceful shutdown). */
  async drain(timeoutMs = 30_000) {
    const t0 = Date.now();
    while (this.items.length || this.delivering) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`queue drain timeout (${this.items.length} pending)`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /* ------------------------------------------------------------- internals */
  _poke() { if (this._wake) this._wake(); }
  _idle(ms) {
    return new Promise((resolve) => {
      let t = null;
      const done = () => { clearTimeout(t); this._wake = null; resolve(); };
      this._wake = done;
      if (ms) t = setTimeout(done, ms);
    });
  }

  _rollDay() {
    const today = pktDate();
    if (this.stats.date !== today) this.stats = { date: today, parentSent: 0 };
    const cutoff = Date.now() - 3 * 86_400_000;
    for (const [k, ts] of this.sentKeys) if (ts < cutoff) this.sentKeys.delete(k);
  }

  /** Earliest-ready item wins; ties go to non-parent traffic, then FIFO. */
  _pick() {
    this._rollDay();
    const now = Date.now();
    const capped = this.stats.parentSent >= this.maxParentPerDay;
    let best = null;
    for (const it of this.items) {
      const isParent = it.kind === 'parent';
      let readyAt = Math.max(it.notBefore || 0, isParent ? this.nextParentAt : this.nextSystemAt);
      if (isParent && capped) readyAt = Math.max(readyAt, nextPktMidnightMs());
      readyAt = Math.max(readyAt, now);
      const key = [readyAt, isParent ? 1 : 0, it.seq];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) {
        best = { it, key };
      }
    }
    return best ? { item: best.it, waitMs: best.key[0] - now } : null;
  }

  async _loop() {
    while (this.running) {
      if (this.paused || !this.items.length) { await this._idle(); continue; }
      const pick = this._pick();
      if (!pick) { await this._idle(); continue; }
      if (pick.waitMs > 0) { await this._idle(pick.waitMs); continue; } // interruptible: new urgent items re-pick
      await this._deliver(pick.item);
    }
  }

  _remove(item) { const i = this.items.indexOf(item); if (i >= 0) this.items.splice(i, 1); }

  async _deliver(item) {
    this.delivering = true;
    try {
      if (this.guard) {
        let ok = true;
        try { ok = await this.guard(item); } catch (e) { this.log?.warn('queue guard error (sending anyway):', e.message); }
        if (!ok) { this._remove(item); this._persist(); this.log?.info(`queue: dropped by guard → ${item.dedupeKey || item.id}`); this.emit('dropped', item); return; }
      }
      const isParent = item.kind === 'parent';
      try {
        await this.sendFn(item);
        this._remove(item);
        if (item.dedupeKey) this.sentKeys.set(item.dedupeKey, Date.now());
        if (isParent) { this.stats.parentSent++; this.nextParentAt = Date.now() + this.rand(...this.parentDelayMs); }
        else this.nextSystemAt = Date.now() + this.rand(...this.systemDelayMs);
        this._persist();
        this.emit('sent', item);
      } catch (err) {
        item.attempts++;
        if (isParent) this.nextParentAt = Date.now() + this.rand(...this.parentDelayMs);
        else this.nextSystemAt = Date.now() + this.rand(...this.systemDelayMs);
        if (err?.permanent || item.attempts >= this.maxAttempts) {
          this._remove(item);
          this.failed.push({ ...item, error: String(err?.message || err), failedAt: Date.now() });
          this.failed = this.failed.slice(-200);
          this.log?.error(`queue: giving up on ${item.kind} → ${item.to}: ${err?.message || err}`);
          this.emit('failed', item, err);
        } else {
          item.notBefore = Date.now() + this.retryBackoffMs * item.attempts;
          this.log?.warn(`queue: send failed (attempt ${item.attempts}/${this.maxAttempts}), retrying later: ${err?.message || err}`);
        }
        this._persist();
      }
    } finally {
      this.delivering = false;
    }
  }

  /* ----------------------------------------------------------- persistence */
  _persist() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items, sentKeys: [...this.sentKeys], stats: this.stats, seq: this.seq }));
      fs.renameSync(tmp, this.persistPath);
    } catch (e) { this.log?.error('queue persist failed:', e.message); }
  }
  _load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      this.items = d.items || [];
      this.sentKeys = new Map(d.sentKeys || []);
      this.stats = d.stats?.date === pktDate() ? d.stats : this.stats;
      this.seq = d.seq || this.items.length;
      if (this.items.length) this.log?.info(`queue: restored ${this.items.length} pending message(s) from disk`);
    } catch (e) { this.log?.error('queue load failed (starting empty):', e.message); }
  }
}
