import { EventEmitter } from 'node:events';
import { jidToPhone, randInt, sleep } from './utils.js';

/**
 * Thin Baileys adapter: connection + QR + reconnect, message normalisation, human-like sending.
 * Written to work with Baileys 6.x (CJS) and 7.x (ESM) — hence the defensive import resolution.
 */
export class WhatsAppClient extends EventEmitter {
  constructor({ config, logger }) {
    super();
    Object.assign(this, { cfg: config, log: logger });
    this.sock = null;
    this.connected = false;
    this.qr = null;
    this.stopping = false;
    this.onEvent = null;
    this.B = null;
  }

  async start() {
    const mod = await import('@whiskeysockets/baileys');
    const d = mod.default;
    this.B = {
      makeWASocket: typeof d === 'function' ? d : d?.default ?? mod.makeWASocket ?? d?.makeWASocket,
      useMultiFileAuthState: mod.useMultiFileAuthState ?? d?.useMultiFileAuthState,
      DisconnectReason: mod.DisconnectReason ?? d?.DisconnectReason,
      fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion ?? d?.fetchLatestBaileysVersion,
      downloadMediaMessage: mod.downloadMediaMessage ?? d?.downloadMediaMessage,
      Browsers: mod.Browsers ?? d?.Browsers,
    };
    const { default: pino } = await import('pino');
    this.pino = pino({ level: 'silent' });
    await this._connect();
  }

  async _connect() {
    const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = this.B;
    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.authDir);
    this.log?.info(state.creds?.registered || state.creds?.me ? `WhatsApp: reusing saved session from ${this.cfg.authDir} (no QR needed)` : `WhatsApp: no saved session in ${this.cfg.authDir} — QR pairing required once`);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* fall back to library default */ }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state, logger: this.pino, browser: Browsers?.ubuntu ? Browsers.ubuntu('Academy Bot') : ['Academy Bot', 'Chrome', '1.0'],
      syncFullHistory: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) { this.qr = qr; this.log?.info('WhatsApp QR ready — open /qr?token=… in a browser or scan the terminal output'); this.emit('qr', qr); }
      if (connection === 'open') {
        this.connected = true; this.qr = null;
        this.log?.info(`WhatsApp connected as ${sock.user?.id}`);
        this.emit('open');
      }
      if (connection === 'close') {
        this.connected = false;
        this.emit('close');
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.log?.error('WhatsApp logged out (session revoked). Delete the auth/ folder and restart to scan a new QR.');
          return;
        }
        if (this.stopping) return;
        const wait = code === DisconnectReason.restartRequired ? 500 : randInt(3000, 8000);
        this.log?.warn(`WhatsApp disconnected (code ${code}); reconnecting in ${wait} ms`);
        setTimeout(() => this._connect().catch((e) => this.log?.error('reconnect failed', e)), wait);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;                       // ignore history sync / appends
      for (const m of messages) {
        const evt = this._normalise(m);
        if (evt && this.onEvent) Promise.resolve(this.onEvent(evt)).catch((e) => this.log?.error('onEvent error', e));
      }
    });
  }

  /** Baileys message → router event. Own outgoing messages are dropped (prevents bot loops) except the self-chat. */
  _normalise(m) {
    if (!m?.message || !m.key) return null;
    const chatId = m.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) return null;
    const isGroup = chatId.endsWith('@g.us');
    const selfPhone = jidToPhone(this.sock?.user?.id);
    const selfChat = !isGroup && !!m.key.fromMe && !!selfPhone && (jidToPhone(chatId) === selfPhone || jidToPhone(m.key.remoteJidAlt) === selfPhone);
    if (m.key.fromMe && !selfChat) return null;

    let c = m.message;
    for (let i = 0; i < 3; i++) c = c.ephemeralMessage?.message ?? c.viewOnceMessage?.message ?? c.viewOnceMessageV2?.message ?? c.documentWithCaptionMessage?.message ?? c;

    const ids = [m.key.participant, m.key.participantAlt, m.key.remoteJidAlt, isGroup ? null : chatId].filter(Boolean);
    const evt = {
      id: m.key.id, isGroup, chatId, selfChat,
      senderIds: ids, senderPhones: ids.filter((j) => j.endsWith('@s.whatsapp.net')).map(jidToPhone),
      text: c.conversation ?? c.extendedTextMessage?.text ?? null,
    };
    if (c.imageMessage && !isGroup) {
      evt.image = {
        mimeType: c.imageMessage.mimetype, caption: c.imageMessage.caption || '',
        getBuffer: () => this.B.downloadMediaMessage(m, 'buffer', {}, { logger: this.pino, reuploadRequest: this.sock.updateMediaMessage }),
      };
    }
    return evt;
  }

  /** Used by the queue. Parent DMs get typing simulation + a "is this number on WhatsApp?" pre-check. */
  async send({ to, text, kind }) {
    if (!this.connected || !this.sock) throw new Error('WhatsApp not connected');
    if (kind === 'parent') {
      const [r] = (await this.sock.onWhatsApp(to.split('@')[0])) || [];
      if (!r?.exists) { const e = new Error(`${to} is not on WhatsApp`); e.permanent = true; throw e; }
      try {
        await this.sock.presenceSubscribe(to);
        await this.sock.sendPresenceUpdate('composing', to);
        await sleep(randInt(1500, 3500));
        await this.sock.sendPresenceUpdate('paused', to);
      } catch { /* presence is cosmetic */ }
    }
    return this.sock.sendMessage(to, { text });
  }

  async stop() { this.stopping = true; try { this.sock?.end?.(undefined); } catch { /* noop */ } }
}
