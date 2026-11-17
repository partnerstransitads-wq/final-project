import fs from 'node:fs';

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export function loadConfig(env = process.env) {
  let credentials = null;
  if (env.GOOGLE_SERVICE_ACCOUNT_B64) {
    credentials = JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
  } else if (env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.existsSync(env.GOOGLE_SERVICE_ACCOUNT_FILE)) {
    credentials = JSON.parse(fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  }

  return {
    academyName: env.ACADEMY_NAME || 'Our Academy',
    ownerPhones: list(env.OWNER_PHONES || env.OWNER_PHONE).map((p) => p.replace(/\D/g, '')).filter(Boolean),
    ownerLids: list(env.OWNER_LIDS),
    allowedGroupJids: list(env.ALLOWED_GROUP_JIDS),
    teacherPhones: list(env.TEACHER_PHONES),
    teacherLids: list(env.TEACHER_LIDS),

    gemini: {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      rpm: num(env.GEMINI_RPM, 8),
    },
    sheets: { spreadsheetId: env.GOOGLE_SHEET_ID, credentials },

    bufferMs: num(env.ATTENDANCE_BUFFER_MINUTES, 5) * 60_000,
    graceMs: num(env.BATCH_GRACE_SECONDS, 60) * 1000,
    additionalStatus: /^present$/i.test(env.ADDITIONAL_NAMES_STATUS || '') ? 'present' : 'late',
    parentHoldMs: num(env.PARENT_HOLD_SECONDS, 120) * 1000,
    parentHoldUnmatchedMs: num(env.PARENT_HOLD_UNMATCHED_SECONDS, 600) * 1000,
    showScoresInGroup: bool(env.SHOW_SCORES_IN_GROUP, true),

    parentDelayMs: [num(env.PARENT_DELAY_MIN_SEC, 15) * 1000, num(env.PARENT_DELAY_MAX_SEC, 25) * 1000],
    systemDelayMs: [800, 2000],
    maxParentPerDay: num(env.MAX_PARENT_MSGS_PER_DAY, 150),

    reminder: {
      startDay: num(env.FEE_REMINDER_START_DAY, 5),
      intervalDays: num(env.FEE_REMINDER_INTERVAL_DAYS, 5),
      max: num(env.FEE_MAX_REMINDERS, 4),
    },
    paymentMinConfidence: num(env.PAYMENT_MIN_CONFIDENCE, 0.6),
    sendParentReceipt: bool(env.SEND_PARENT_RECEIPT, false),

    port: num(env.PORT, 3000),
    adminToken: env.ADMIN_TOKEN || '',
    stateDir: env.STATE_DIR || './state',
    authDir: env.AUTH_DIR || './auth_info_baileys',
    logLevel: env.LOG_LEVEL || 'info',
  };
}
