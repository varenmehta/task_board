// Outbound HTTP to user-supplied URLs (webhooks, push endpoints) with SSRF protection.
// The address check happens inside the socket `lookup`, so the IP we validate is the IP we connect to
// (no DNS-rebinding gap between "check" and "use").
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { HttpError } from './util.js';

const allowPrivate = () => process.env.ALLOW_PRIVATE_URLS === '1';

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true;
}

export function assertUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Enter a valid URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowPrivate())) throw new HttpError(400, 'URL must start with https://');
  if (u.username || u.password) throw new HttpError(400, 'URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, ''); // URL keeps the brackets around IPv6 literals
  if (!allowPrivate() && (net.isIP(host) ? isPrivateAddress(host) : /^(localhost|.*\.local|.*\.internal)$/i.test(host))) throw new HttpError(400, 'That address is not allowed');
  return u;
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter(a => allowPrivate() || !isPrivateAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error('Blocked: address is not public'), { code: 'EBLOCKED' }));
    if (options?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export function safeRequest(rawUrl, { method = 'POST', headers = {}, body, timeout = 8000, maxBytes = 65536 } = {}) {
  const u = assertUrl(rawUrl);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: { ...headers, ...(body != null ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, lookup: guardedLookup, timeout }, res => {
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= maxBytes) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
