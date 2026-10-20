// Encrypts secrets at rest (OAuth refresh tokens, API keys) with AES-256-GCM.
// The key is derived from the instance secret, so a copied database file alone is not enough to read them.
import crypto from 'node:crypto';
import { SECRET } from './config.js';

const KEY = crypto.createHash('sha256').update('taskboard-at-rest:' + SECRET).digest();
const PREFIX = 'enc:v1:';

export function seal(plain) {
  if (plain == null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function open(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored; // legacy / plaintext
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
