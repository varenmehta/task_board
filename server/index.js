import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, PUBLIC_DIR } from './config.js';
import { router } from './routes.js';
import { readBody, send, parseCookies } from './router.js';
import { userFromToken, rateLimit } from './auth.js';
import { authenticateBearer } from './tokens.js';
import { HttpError } from './util.js';
import './notifications.js';
import './automations.js';
import { startScheduler } from './scheduler.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  const ext = path.extname(file);
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const hit = router.match(req.method, pathname);
    if (!hit) throw new HttpError(404, 'Not found');
    const { route, params } = hit;
    const cookies = parseCookies(req.headers.cookie);
    // API clients authenticate with "Authorization: Bearer tb_…"; browsers use the session cookie
    let user = null, viaToken = null;
    if (req.headers.authorization) {
      viaToken = authenticateBearer(req.headers.authorization);
      if (!viaToken) throw new HttpError(401, 'Invalid or expired API token');
      user = viaToken.user;
      if (!rateLimit('tok:' + viaToken.tokenId, 600)) throw new HttpError(429, 'API rate limit exceeded (600 requests/minute)');
      if (viaToken.scope === 'read' && !['GET', 'HEAD'].includes(req.method)) throw new HttpError(403, 'This token is read-only');
    } else user = userFromToken(cookies.tb_session);
    if (!route.opts.public && !user) throw new HttpError(401, 'Please sign in');

    let body = {}, rawBody = null, rawText = '';
    if (route.opts.raw) {
      // binary upload: the custom header forces a CORS preflight, so cross-site pages can't forge it
      if (!req.headers['x-filename']) throw new HttpError(400, 'Missing X-Filename header');
      rawBody = await readBody(req, { raw: true });
    } else if (!['GET', 'HEAD'].includes(req.method)) {
      rawText = await readBody(req);
      const type = req.headers['content-type'] || '';
      if (route.opts.webhook) {
        // third-party callers (Twilio, Slack, GitHub…): authenticated by signature/token inside the handler
        if (type.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(rawText));
        else { try { body = rawText ? JSON.parse(rawText) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); } }
        if (body.payload && typeof body.payload === 'string') { try { body = JSON.parse(body.payload); } catch { /* keep form body */ } }
      } else {
        // JSON-only for browser-driven writes also blocks cross-site form posts (CSRF).
        if (rawText && !type.includes('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
        try { body = rawText ? JSON.parse(rawText) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
      }
    }
    const result = await route.handler({ req, res, params, query: Object.fromEntries(url.searchParams), body, user, raw: rawBody, rawText, via: viaToken ? 'token' : 'session' });
    if (route.opts.stream || res.writableEnded) return;
    if (result?.__raw) { res.writeHead(result.__raw.status || 200, result.__raw.headers); return res.end(result.__raw.body); }
    if (result?.__xml) { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(result.__xml); }
    send(res, 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on our side' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  server.listen(PORT, () => {
    console.log(`\n  TaskBoard running → http://localhost:${PORT}\n`);
    startScheduler();
  });
}
