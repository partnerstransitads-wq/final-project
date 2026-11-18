/**
 * Baileys auth state backed by SheetsKv instead of ./auth_info_baileys.
 * Same contract as useMultiFileAuthState: returns { state, saveCreds }.
 * `B` = { BufferJSON, initAuthCreds, proto } from the Baileys module.
 */
export async function useSheetsAuthState(kv, { BufferJSON, initAuthCreds, proto }) {
 const P = 'auth:';
 const read = (k) => { const v = kv.get(P + k); return v ? JSON.parse(v, BufferJSON.reviver) : null; };
 const creds = read('creds') || initAuthCreds();
 return {
 state: {
 creds,
 keys: {
 get: async (type, ids) => {
 const out = {};
 for (const id of ids) {
 let v = read(`${type}-${id}`);
 if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
 out[id] = v;
 }
 return out;
 },
 set: async (data) => {
 for (const cat of Object.keys(data)) {
 for (const id of Object.keys(data[cat])) {
 const v = data[cat][id];
 kv.set(`${P}${cat}-${id}`, v ? JSON.stringify(v, BufferJSON.replacer) : null);
 }
 }
 },
 },
 },
 saveCreds: async () => { kv.set(`${P}creds`, JSON.stringify(creds, BufferJSON.replacer)); },
 };
}
