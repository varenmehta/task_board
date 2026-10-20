import crypto from 'node:crypto';
import { SECRET } from './config.js';
import { get, run, all } from './db.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

const b64 = b => Buffer.from(b).toString('base64url');
export function sign(payload, ttlSec) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
export function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

export const SESSION_TTL = 60 * 60 * 24 * 30;
export const clearCookie = 'tb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
const isSecure = req => req?.headers?.['x-forwarded-proto'] === 'https';
const clientIp = req => req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;

// Each login creates a server-side session row, so it can be listed and revoked ("sign out everywhere").
export function startSession(userId, req) {
  const sid = crypto.randomBytes(16).toString('hex');
  run('INSERT INTO sessions(id,user_id,ua,ip) VALUES(?,?,?,?)', sid, userId, String(req?.headers?.['user-agent'] || '').slice(0, 200), clientIp(req));
  run("DELETE FROM sessions WHERE (revoked=1 OR created_at < ?) AND user_id=?", new Date(Date.now() - (SESSION_TTL + 86400) * 1000).toISOString(), userId);
  return `tb_session=${sign({ uid: userId, sid }, SESSION_TTL)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${isSecure(req) ? '; Secure' : ''}`;
}

export const sidFromToken = token => verify(token)?.sid || null;
export function revokeSession(userId, sid) { return run('UPDATE sessions SET revoked=1 WHERE id=? AND user_id=?', sid, userId).changes; }
export function revokeOtherSessions(userId, keepSid) { return run('UPDATE sessions SET revoked=1 WHERE user_id=? AND id<>? AND revoked=0', userId, keepSid || '').changes; }
export const listSessions = (userId, currentSid) => all('SELECT id, ua, ip, created_at, last_seen FROM sessions WHERE user_id=? AND revoked=0 ORDER BY last_seen DESC', userId).map(s => ({ ...s, current: s.id === currentSid }));

export function userFromToken(token) {
  const p = verify(token);
  if (!p?.uid || !p.sid) return null;
  const sess = get('SELECT * FROM sessions WHERE id=? AND user_id=? AND revoked=0', p.sid, p.uid);
  if (!sess) return null;
  const user = get('SELECT * FROM users WHERE id=? AND active=1', p.uid);
  if (!user) return null;
  if (Date.now() - new Date(sess.last_seen).getTime() > 5 * 60_000) run("UPDATE sessions SET last_seen=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", sess.id);
  user._sid = p.sid;
  return user;
}

// Tiny in-memory limiter for credential endpoints.
const hits = new Map();
export function rateLimit(key, max = 10, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}
