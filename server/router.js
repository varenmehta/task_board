import { HttpError } from './util.js';

const MAX_BODY = 1_000_000;
export const MAX_RAW = 16 * 1024 * 1024;

export class Router {
  routes = [];
  add(method, path, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get = (p, h, o) => this.add('GET', p, h, o);
  post = (p, h, o) => this.add('POST', p, h, o);
  patch = (p, h, o) => this.add('PATCH', p, h, o);
  put = (p, h, o) => this.add('PUT', p, h, o);
  del = (p, h, o) => this.add('DELETE', p, h, o);

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { route: r, params };
      }
    }
    return null;
  }
}

export function readBody(req, { raw = false } = {}) {
  const limit = raw ? MAX_RAW : MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { const buf = Buffer.concat(chunks); resolve(raw ? buf : buf.toString('utf8')); });
    req.on('error', reject);
  });
}

export function send(res, status, data, headers = {}) {
  if (res.headersSent) return;
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p[0]));
