// Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291 "aes128gcm") — no dependencies.
import crypto from 'node:crypto';
import { all, run, insert, get, getSetting, setSetting } from '../db.js';
import { safeRequest, assertUrl } from '../safehttp.js';
import { bad } from '../util.js';

const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(s, 'base64url');

// ---- VAPID keypair (generated once, private half encrypted at rest) ----
export function vapidKeys() {
  let pub = getSetting('vapid_public'), priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
    pub = b64u(ec.getPublicKey()); priv = b64u(ec.getPrivateKey());
    setSetting('vapid_public', pub); setSetting('vapid_private', priv);
  }
  return { pub, priv };
}

function vapidJwt(audience, privB64) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(fromB64u(privB64));
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(fromB64u(privB64)) };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${process.env.VAPID_CONTACT || 'admin@localhost.invalid'}` }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

// RFC 8291 §3.4. `ephemeral` and `salt` are injectable only so the RFC's test vector can verify this code.
export function encryptPayload(plaintext, uaPublicB64, authB64, { ephemeral, salt } = {}) {
  const uaPublic = fromB64u(uaPublicB64), authSecret = fromB64u(authB64);
  const as = ephemeral || (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; })();
  const asPublic = as.getPublicKey();
  const ecdh = as.computeSecret(uaPublic);
  const hk = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hk(authSecret, ecdh, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const sl = salt || crypto.randomBytes(16);
  const cek = hk(sl, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(sl, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([sl, rs, Buffer.from([asPublic.length]), asPublic, enc]);
}

export function subscribe(userId, sub) {
  const endpoint = String(sub?.endpoint || '');
  assertUrl(endpoint);
  if (!sub?.keys?.p256dh || !sub?.keys?.auth || fromB64u(sub.keys.p256dh).length !== 65 || fromB64u(sub.keys.auth).length < 8) throw bad('Invalid push subscription');
  run('INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth', userId, endpoint, sub.keys.p256dh, sub.keys.auth);
}
export const unsubscribe = (userId, endpoint) => run('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', userId, endpoint);
export const hasSubscription = userId => !!get('SELECT 1 FROM push_subscriptions WHERE user_id=?', userId);

export async function pushTo(userId, message) {
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id=?', userId);
  if (!subs.length) return 0;
  const { pub, priv } = vapidKeys();
  let sent = 0;
  for (const s of subs) {
    try {
      const body = encryptPayload(JSON.stringify(message), s.p256dh, s.auth);
      const aud = new URL(s.endpoint).origin;
      const r = await safeRequest(s.endpoint, { method: 'POST', body, headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: message.urgent ? 'high' : 'normal', Authorization: `vapid t=${vapidJwt(aud, priv)}, k=${pub}` }, timeout: 10000 });
      if (r.status === 404 || r.status === 410) run('DELETE FROM push_subscriptions WHERE id=?', s.id);
      else if (r.status >= 200 && r.status < 300) sent++;
    } catch (e) { console.error('[push]', e.message); }
  }
  return sent;
}
void insert;
