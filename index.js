import 'dotenv/config';
import express from 'express';
import { loadConfig } from './config.js';
import { createLogger, isLastDayOfMonthPKT, TZ } from './utils.js';
import { SheetsService } from './sheetsService.js';
import { GeminiService } from './geminiService.js';
import { WhatsAppClient } from './whatsapp.js';
import { createApp } from './app.js';

const config = loadConfig();
const log = createLogger(config.logLevel);

function assertConfig() {
  const missing = [];
  if (!config.gemini.apiKey) missing.push('GEMINI_API_KEY');
  if (!config.sheets.spreadsheetId) missing.push('GOOGLE_SHEET_ID');
  if (!config.sheets.credentials) missing.push('GOOGLE_SERVICE_ACCOUNT_FILE (service-account JSON is required to WRITE to the sheet; share the sheet with its client_email as Editor)');
  if (!config.ownerPhones.length) missing.push('OWNER_PHONES');
  if (!config.teacherPhones.length && !config.teacherLids.length) missing.push('TEACHER_PHONES');
  if (missing.length) { log.error(`Missing configuration: ${missing.join(', ')} (see .env.example)`); process.exit(1); }
  if (!config.allowedGroupJids.length) log.info('ALLOWED_GROUP_JIDS empty → listening in every group; only TEACHER_PHONES senders can trigger actions.');
}

async function main() {
  assertConfig();

  const sheets = new SheetsService({ spreadsheetId: config.sheets.spreadsheetId, credentials: config.sheets.credentials, logger: log });
  await sheets.init();
  const gemini = await GeminiService.create({ apiKey: config.gemini.apiKey, modelName: config.gemini.model, rpm: config.gemini.rpm, logger: log });

  const wa = new WhatsAppClient({ config, logger: log });
  const app = createApp({ config, sheets, gemini, sendFn: (item) => wa.send(item), logger: log });

  wa.onEvent = (evt) => app.router.handle(evt);
  wa.on('open', () => app.queue.setPaused(false));
  wa.on('close', () => app.queue.setPaused(true));   // don't burn retry attempts while offline
  app.queue.setPaused(true);

  await app.start();
  await wa.start();

  /* ---------------------------------------------------------- schedules */
  const { default: cron } = await import('node-cron');
  // Daily 10:00 PKT — reminders only go out from FEE_REMINDER_START_DAY, every FEE_REMINDER_INTERVAL_DAYS, max FEE_MAX_REMINDERS.
  cron.schedule('0 10 * * *', () => app.fees.runReminders().then((r) => log.info('fee reminders:', r)).catch((e) => log.error('reminders failed', e)), { timezone: TZ });
  // 20:00 PKT on the last day of every month — one summary to the owner.
  cron.schedule('0 20 28-31 * *', () => { if (isLastDayOfMonthPKT()) app.fees.sendMonthEndReport().catch((e) => log.error('report failed', e)); }, { timezone: TZ });

  /* ------------------------------------------------------- health + QR  */
  const web = express();
  const authed = (req, res, next) => (!config.adminToken || req.query.token === config.adminToken ? next() : res.status(401).send('unauthorized'));
  web.get('/health', (_req, res) => res.json({ ok: true, whatsapp: wa.connected }));            // for uptime pingers
  web.get('/status', authed, (_req, res) => res.json({ whatsapp: wa.connected, queue: app.queue.snapshot(), openSessions: [...app.attendance.sessions.values()].filter((s) => !s.finalized).map((s) => s.key) }));
  web.get('/qr', authed, async (_req, res) => {
    if (wa.connected) return res.send('✅ WhatsApp is already connected.');
    if (!wa.qr) return res.send('No QR yet — refresh in a few seconds.');
    const QR = (await import('qrcode')).default;
    res.send(`<meta http-equiv="refresh" content="20"><body style="font-family:sans-serif;text-align:center"><h3>WhatsApp → Linked devices → Link a device</h3><img src="${await QR.toDataURL(wa.qr, { width: 320 })}"></body>`);
  });
  web.listen(config.port, () => log.info(`HTTP on :${config.port}  (/health, /status, /qr)`));

  /* ------------------------------------------------------------ shutdown */
  const bye = async (sig) => { log.info(`${sig}: shutting down`); await app.stop(); await wa.stop(); process.exit(0); };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
}

main().catch((e) => { log.error('fatal', e); process.exit(1); });
