import path from 'node:path';
import { QueueManager } from './queueManager.js';
import { AttendanceManager } from './attendanceManager.js';
import { FeeManager } from './feeManager.js';
import { MessageRouter } from './messageRouter.js';
import { toJid } from './utils.js';

/** Composition root — used by index.js (real services) and by the mock test (fakes). */
export function createApp({ config, sheets, gemini, sendFn, logger }) {
  const queue = new QueueManager({
    send: sendFn, logger,
    persistPath: path.join(config.stateDir, 'queue.json'),
    parentDelayMs: config.parentDelayMs, systemDelayMs: config.systemDelayMs, maxParentPerDay: config.maxParentPerDay,
    retryBackoffMs: config.retryBackoffMs ?? 30_000,
  });

  const notifyOwner = (text, dedupeKey) => config.ownerPhones.forEach((p) =>
    queue.enqueue({ kind: 'owner', to: toJid(p), text, dedupeKey: dedupeKey ? `${dedupeKey}:${p}` : undefined }));

  const attendance = new AttendanceManager({ sheets, gemini, queue, config, logger, notifyOwner });
  const fees = new FeeManager({ sheets, gemini, queue, config, logger, notifyOwner });
  const router = new MessageRouter({ config, attendance, fees, queue, logger });

  queue.setGuard((item) => fees.shouldDeliver(item));
  queue.on('sent', (item) => {
    if (item.meta?.kind === 'fee_reminder') fees.markReminderSent(item.meta).catch((e) => logger?.error('markReminderSent failed', e));
  });

  return {
    queue, attendance, fees, router, notifyOwner,
    async start() { await attendance.start(); queue.start(); },
    async stop() { attendance.stop(); queue.stop(); },
  };
}
