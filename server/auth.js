import crypto from 'node:crypto';
import { SECRET } from './config.js';
import { get } from './db.js';

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
export const sessionCookie = (uid, secure) =>
  `tb_session=${sign({ uid }, SESSION_TTL)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`;
export const clearCookie = 'tb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';

export function userFromToken(token) {
  const p = verify(token);
  if (!p?.uid) return null;
  return get('SELECT * FROM users WHERE id=? AND active=1', p.uid) || null;
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
