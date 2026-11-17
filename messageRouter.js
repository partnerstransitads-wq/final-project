import { KeyedMutex, samePhone } from './utils.js';

/**
 * Platform-agnostic router. The WhatsApp adapter (or the mock test) hands it normalised events:
 *   { id, isGroup, chatId, senderPhones:[…], senderIds:[…], selfChat?, text?, image?:{mimeType, caption, getBuffer()} }
 * All access-control decisions live HERE, not in the adapter.
 */
export class MessageRouter {
  constructor({ config, attendance, fees, queue, logger }) {
    Object.assign(this, { cfg: config, attendance, fees, queue, log: logger });
    this.seen = new Set();
    this.knownChats = new Set();
    this.ownerLock = new KeyedMutex();
  }

  async handle(evt) {
    try { await this._handle(evt); } catch (e) { this.log?.error('router: unhandled error', e); }
  }

  _isOwner(evt) {
    if (evt.selfChat) return true;
    if ((evt.senderPhones || []).some((p) => this.cfg.ownerPhones.some((o) => samePhone(p, o)))) return true;
    return (evt.senderIds || []).some((id) => this.cfg.ownerLids.includes(id));
  }

  _isTeacher(evt) {
    const { teacherPhones, teacherLids } = this.cfg;
    if (!teacherPhones.length && !teacherLids.length) return false;   // fail closed: no teachers configured → nobody is trusted
    return (evt.senderPhones || []).some((p) => teacherPhones.some((t) => samePhone(p, t)))
      || (evt.senderIds || []).some((id) => teacherLids.includes(id));
  }

  async _handle(evt) {
    if (evt.id) {                                   // Baileys can redeliver the same message after reconnects
      if (this.seen.has(evt.id)) return;
      this.seen.add(evt.id);
      if (this.seen.size > 3000) this.seen.delete(this.seen.values().next().value);
    }

    /* ------------------------------ groups: attendance / test marks only ---- */
    if (evt.isGroup) {
      if (!this.knownChats.has(evt.chatId)) {
        this.knownChats.add(evt.chatId);
        this.log?.info(`group seen: ${evt.chatId} (listening: ${this.cfg.allowedGroupJids.length ? 'whitelist' : 'all groups, teachers only'})`);
      }
      const allow = this.cfg.allowedGroupJids;
      if (allow.length && !allow.includes(evt.chatId)) return;
      if (!evt.text) return;                         // media/documents in groups = study material → never processed
      if (!this._isTeacher(evt)) return;          // multi-group: ANY group is fine, but only authorised teachers can trigger the bot
      return this.attendance.handleGroupText({ groupJid: evt.chatId, text: evt.text });
    }

    /* ------------------------------ private chats: owner only --------------- */
    if (!this._isOwner(evt)) {
      if (!this.knownChats.has(evt.chatId)) {
        this.knownChats.add(evt.chatId);
        this.log?.info(`private message from ${evt.chatId} ignored (not owner). If this IS the owner on a "@lid" id, add it to OWNER_LIDS.`);
      }
      return;
    }
    const reply = (text) => this.queue.enqueue({ kind: 'owner', to: evt.chatId, text });
    return this.ownerLock.run('owner', async () => {
      if (evt.image) {
        let buffer;
        try { buffer = await evt.image.getBuffer(); } catch (e) { return reply('⚠️ Could not download that image. Please resend it.'); }
        return this.fees.handleOwnerImage({ buffer, mimeType: evt.image.mimeType, caption: evt.image.caption || evt.text || '', reply });
      }
      if (evt.text) return this.fees.handleOwnerText(evt.text, reply);
    });
  }
}
