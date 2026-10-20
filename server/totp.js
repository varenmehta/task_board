// RFC 6238 time-based one-time passwords (Google Authenticator, 1Password, Authy…) + single-use recovery codes.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function fromBase32(str) {
  let bits = '';
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export const newSecret = () => base32(crypto.randomBytes(20));

export function hotp(secretB32, counter, digits = 6) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}
export const totp = (secret, t = Date.now()) => hotp(secret, Math.floor(t / 30000));

// returns the matching 30s step (or 0). Accepts ±1 step of clock drift.
export function verifyTotp(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const expected = hotp(secret, step + d), a = Buffer.from(expected), b = Buffer.from(c);
    if (crypto.timingSafeEqual(a, b)) return step + d;
  }
  return 0;
}

export const otpauthUri = (secret, email, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const hashCode = c => crypto.createHash('sha256').update(c.replace(/[^a-z0-9]/gi, '').toLowerCase()).digest('hex');
export function newRecoveryCodes(n = 8) {
  const plain = Array.from({ length: n }, () => { const s = base32(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return `${s.slice(0, 5)}-${s.slice(5)}`; });
  return { plain, hashes: plain.map(hashCode) };
}
// returns remaining hashes if the code was valid (single use), otherwise null
export function consumeRecovery(hashes, code) {
  const h = hashCode(String(code || ''));
  return hashes.includes(h) ? hashes.filter(x => x !== h) : null;
}
