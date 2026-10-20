import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

const t = await boot();
const { admin, member, viewer, manager, ids, Client, base } = t;
test.after(() => t.server.close());
const mk = (c, pid, body) => c.post(`/api/projects/${pid}/tasks`, body).then(r => r.body);
const raw = (path, { method = 'POST', headers = {}, body } = {}) => fetch(base + path, { method, headers, body: method === 'GET' ? undefined : (body ?? ''), redirect: 'manual' });

function listen(handler) {
  return new Promise(res => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` })); });
}

test('API tokens: bearer auth, read-only scope, revoke, no token-from-token', async () => {
  const w = (await member.post('/api/tokens', { name: 'ci', scope: 'write' })).body;
  assert.match(w.token, /^tb_/);
  const bearer = new Client(); bearer.headers = { Authorization: `Bearer ${w.token}` };
  assert.equal((await bearer.get('/api/me')).body.email, 'marcus@demo.taskboard.dev');
  assert.equal((await bearer.post(`/api/projects/${ids.api}/tasks`, { title: 'via API' })).status, 200);
  assert.equal((await bearer.post('/api/tokens', { name: 'nested' })).status, 403);
  const r = (await member.post('/api/tokens', { name: 'ro', scope: 'read' })).body;
  const ro = new Client(); ro.headers = { Authorization: `Bearer ${r.token}` };
  assert.equal((await ro.get('/api/projects')).status, 200);
  assert.equal((await ro.post(`/api/projects/${ids.api}/tasks`, { title: 'nope' })).status, 403);
  // tokens inherit the user's permissions (Marcus can't see WEB)
  assert.equal((await bearer.get(`/api/projects/${ids.web}/board`)).status, 404);
  // viewers can only mint read tokens
  assert.equal((await viewer.post('/api/tokens', { name: 'v', scope: 'write' })).body.scope, 'read');
  const bad = new Client(); bad.headers = { Authorization: 'Bearer tb_' + 'x'.repeat(30) };
  assert.equal((await bad.get('/api/me')).status, 401);
  assert.equal((await member.get('/api/tokens')).body.every(x => !x.token && !x.hash), true);
  await member.del(`/api/tokens/${w.id}`);
  assert.equal((await bearer.get('/api/me')).status, 401);
});

test('outgoing webhooks: signed JSON delivery, Slack format, SSRF block, delivery log', async () => {
  const got = [];
  const recv = await listen((req, res) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { got.push({ headers: req.headers, body: b, url: req.url }); res.end('ok'); }); });
  const wh = (await manager.post(`/api/projects/${ids.api}/webhooks`, { name: 'ci', url: recv.url + '/hook', events: ['task.created', 'task.completed'], format: 'json' })).body;
  assert.ok(wh.secret);
  assert.equal((await member.post(`/api/projects/${ids.api}/webhooks`, { url: recv.url, events: ['task.created'] })).status, 403);
  const task = await mk(admin, ids.api, { title: 'Hook me' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 1);
  const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(got[0].body).digest('hex');
  assert.equal(got[0].headers['x-taskboard-signature'], sig);
  assert.equal(JSON.parse(got[0].body).task.key, task.key);
  await admin.patch(`/api/tasks/${task.id}`, { status: 'done' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.at(-1).headers['x-taskboard-event'], 'task.completed');
  // slack format
  const sl = (await manager.post(`/api/projects/${ids.api}/webhooks`, { url: recv.url + '/slack', events: ['comment.added'], format: 'slack' })).body;
  await admin.post(`/api/tasks/${task.id}/comments`, { body: 'hello team' });
  await new Promise(r => setTimeout(r, 300));
  const sb = JSON.parse(got.find(g => g.url === '/slack').body);
  assert.match(sb.text, /hello team/); assert.ok(sb.blocks);
  const dl = (await manager.get(`/api/webhooks/${wh.id}/deliveries`)).body;
  assert.ok(dl.length >= 2 && dl.every(d => d.status === 'ok'));
  assert.equal((await manager.post(`/api/webhooks/${sl.id}/test`)).body.status, 'ok');
  // SSRF guard (enforced when ALLOW_PRIVATE_URLS is off)
  process.env.ALLOW_PRIVATE_URLS = '0';
  for (const u of ['http://127.0.0.1:9/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://[::1]/x', 'https://10.0.0.5/x', 'https://u:p@example.com/x']) {
    assert.equal((await manager.post(`/api/projects/${ids.api}/webhooks`, { url: u, events: ['task.created'] })).status, 400, u);
  }
  const { safeRequest } = await import('../server/safehttp.js');
  await assert.rejects(() => safeRequest('https://localtest.me/', { method: 'GET', timeout: 3000 }), /Blocked|ENOTFOUND|EAI_AGAIN|ECONN/); // resolves to 127.0.0.1 or fails offline — never connects
  process.env.ALLOW_PRIVATE_URLS = '1';
  recv.s.close();
});

test('incident hooks: create, dedupe, acknowledge, resolve (Sentry/PagerDuty/Datadog/generic)', async () => {
  const h = (await manager.post(`/api/projects/${ids.ops}/hooks`, { kind: 'sentry', name: 'Sentry prod' })).body;
  assert.match(h.url, /\/api\/hooks\/in\/\d+\./);
  assert.equal((await member.post(`/api/projects/${ids.ops}/hooks`, { kind: 'sentry' })).status, 403);
  const send = (b, path = h.path) => new Client().post(path, b);
  const issue = { action: 'created', data: { issue: { id: '99', title: 'TypeError in checkout', level: 'error', culprit: 'cart.js', permalink: 'https://sentry.io/x' } } };
  const a = (await send(issue)).body;
  assert.equal(a.action, 'created');
  const second = (await send(issue)).body;
  assert.equal(second.action, 'deduplicated'); assert.equal(second.task, a.task);
  const detail = (await admin.get(`/api/tasks/${(await admin.get('/api/search?q=checkout')).body[0].id}`)).body;
  assert.equal(detail.priority, 'high'); assert.equal(detail.type, 'bug'); assert.ok(detail.labels.includes('sentry'));
  assert.ok(detail.comments.some(c => /Occurred again/.test(c.body)));
  assert.equal((await send({ action: 'resolved', data: { issue: { id: '99', title: 'x' } } })).body.action, 'resolved');
  assert.equal((await admin.get(`/api/tasks/${detail.id}`)).body.status, 'done');
  assert.equal((await new Client().post('/api/hooks/in/1.wrongtokenwrongtokenwrong', {})).status, 404);
  // PagerDuty ack/resolve
  const pd = (await manager.post(`/api/projects/${ids.ops}/hooks`, { kind: 'pagerduty' })).body;
  const trig = (await send({ event: { event_type: 'incident.triggered', data: { id: 'P1', title: 'DB down', urgency: 'high' } } }, pd.path)).body;
  assert.equal(trig.action, 'created');
  assert.equal((await send({ event: { event_type: 'incident.acknowledged', data: { id: 'P1' } } }, pd.path)).body.action, 'acknowledged');
  assert.equal((await send({ event: { event_type: 'incident.resolved', data: { id: 'P1' } } }, pd.path)).body.action, 'resolved');
  // Datadog + generic
  const dd = (await manager.post(`/api/projects/${ids.ops}/hooks`, { kind: 'datadog' })).body;
  assert.equal((await send({ title: 'High CPU', alert_id: 7, priority: 'P2', alert_transition: 'Triggered' }, dd.path)).body.action, 'created');
  assert.equal((await send({ title: 'High CPU', alert_id: 7, alert_transition: 'Recovered' }, dd.path)).body.action, 'resolved');
  const gen = (await manager.post(`/api/projects/${ids.ops}/hooks`, { kind: 'generic' })).body;
  assert.equal((await send({ title: 'Cron failed', severity: 'critical' }, gen.path)).body.action, 'created');
});

test('GitHub: signature check, PR opened → review, merged → done, commit comments', async () => {
  const gh = (await manager.post(`/api/projects/${ids.api}/hooks`, { kind: 'github' })).body;
  assert.ok(gh.secret);
  const task = await mk(admin, ids.api, { title: 'Implement widget', status: 'in_progress' });
  const send = (event, payload, secret = gh.secret) => {
    const body = JSON.stringify(payload);
    return raw(gh.path, { headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') }, body });
  };
  assert.equal((await send('ping', {}, 'wrong')).status, 401);
  assert.equal((await send('ping', {})).status, 200);
  const pr = (state, extra = {}) => ({ action: state === 'open' ? 'opened' : 'closed', repository: { full_name: 'acme/api' }, pull_request: { number: 7, title: `Add widget (${task.key})`, body: '', html_url: 'https://github.com/acme/api/pull/7', head: { ref: 'feature/x' }, draft: false, state: state === 'open' ? 'open' : 'closed', merged: state === 'merged', ...extra } });
  await send('pull_request', pr('open'));
  let d = (await admin.get(`/api/tasks/${task.id}`)).body;
  assert.equal(d.status, 'review'); assert.equal(d.prs[0].state, 'open'); assert.ok(d.comments.some(c => /PR #7 opened/.test(c.body)));
  await send('pull_request', pr('open')); // idempotent
  assert.equal((await admin.get(`/api/tasks/${task.id}`)).body.comments.filter(c => /opened/.test(c.body)).length, 1);
  await send('push', { repository: { full_name: 'acme/api' }, commits: [{ id: 'abcdef1234', message: `wip ${task.key}`, url: 'https://github.com/acme/api/commit/abcdef1' }] });
  await send('pull_request', pr('merged'));
  d = (await admin.get(`/api/tasks/${task.id}`)).body;
  assert.equal(d.status, 'done'); assert.equal(d.prs[0].state, 'merged'); assert.ok(d.comments.some(c => /merged/.test(c.body)) && d.comments.some(c => /Commit/.test(c.body)));
  // tasks from other projects are never touched
  const other = await mk(admin, ids.ops, { title: 'other', status: 'todo' });
  await send('pull_request', { ...pr('open'), pull_request: { ...pr('open').pull_request, number: 8, title: `touch ${other.key}` } });
  assert.equal((await admin.get(`/api/tasks/${other.id}`)).body.status, 'todo');
  // branch-name matching (lowercase key)
  const t2 = await mk(admin, ids.api, { title: 'by branch', status: 'todo' });
  await send('pull_request', { ...pr('open'), pull_request: { ...pr('open').pull_request, number: 9, title: 'No key here', head: { ref: `${t2.key.toLowerCase()}-by-branch` } } });
  assert.equal((await admin.get(`/api/tasks/${t2.id}`)).body.status, 'review');
});

test('GitLab merge request hook with token', async () => {
  const gl = (await manager.post(`/api/projects/${ids.api}/hooks`, { kind: 'gitlab' })).body;
  const task = await mk(admin, ids.api, { title: 'gl task', status: 'todo' });
  const body = JSON.stringify({ object_kind: 'merge_request', project: { path_with_namespace: 'acme/api' }, object_attributes: { iid: 3, title: `Fix ${task.key}`, description: '', source_branch: 'fix', state: 'opened', url: 'https://gitlab.com/acme/api/-/merge_requests/3', draft: false } });
  assert.equal((await raw(gl.path, { headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'nope' }, body })).status, 401);
  assert.equal((await raw(gl.path, { headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': gl.secret }, body })).status, 200);
  assert.equal((await admin.get(`/api/tasks/${task.id}`)).body.status, 'review');
});

test('Slack slash command: signature, user linking, commands', async () => {
  await admin.put('/api/settings', { slack_signing_secret: 'sshh' });
  const text = 'user_id=U123&text=list&command=%2Ftaskboard';
  const ts = Math.floor(Date.now() / 1000);
  const sig = 'v0=' + crypto.createHmac('sha256', 'sshh').update(`v0:${ts}:${text}`).digest('hex');
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sig };
  assert.equal((await raw('/api/hooks/slack', { headers: { ...headers, 'X-Slack-Signature': 'v0=bad' }, body: text })).status, 401);
  assert.equal((await raw('/api/hooks/slack', { headers: { ...headers, 'X-Slack-Request-Timestamp': String(ts - 4000) }, body: text })).status, 401);
  let r = await (await raw('/api/hooks/slack', { headers, body: text })).json();
  assert.match(r.text, /don't know who you are/);
  await member.patch('/api/me', { slack_id: 'u123' });
  r = await (await raw('/api/hooks/slack', { headers, body: text })).json();
  assert.match(r.text, /open task|no open tasks/i);
});

test('iCalendar feed: token-protected, valid, escaped, rotating', async () => {
  const { url } = (await member.get('/api/me/calendar')).body;
  const path = new URL(url).pathname;
  const t1 = await mk(member, ids.api, { title: 'Ship it, now; really', due_date: '2030-05-01', assignee_id: (await member.get('/api/me')).body.id });
  const res = await raw(path, { method: 'GET' });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = await res.text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20300501'));
  assert.ok(ics.includes('Ship it\\, now\; really'));
  assert.ok(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75));
  assert.equal((await raw('/api/calendar/nope.ics', { method: 'GET' })).status, 404);
  const rotated = (await member.post('/api/me/calendar/rotate')).body.url;
  assert.notEqual(rotated, url);
  assert.equal((await raw(path, { method: 'GET' })).status, 404);
  void t1;
});

test('OIDC SSO: login for existing user, auto-provision by domain, rejects bad nonce/audience', async () => {
  let nextClaims = {};
  const idp = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: idp.url, authorization_endpoint: idp.url + '/authorize', token_endpoint: idp.url + '/token' }));
    if (u.pathname === '/token') { const body = Buffer.from(JSON.stringify({ iss: idp.url, aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, ...nextClaims })).toString('base64url'); return res.end(JSON.stringify({ id_token: `x.${body}.y` })); }
    res.statusCode = 404; res.end('{}');
  });
  assert.equal((await new Client().get('/api/auth/sso/start')).status, 404); // not configured yet
  await admin.put('/api/settings', { oidc_issuer: idp.url, oidc_client_id: 'cid', oidc_client_secret: 'csecret', sso_allowed_domains: 'newco.io', sso_default_role: 'viewer', sso_label: 'Okta' });
  assert.equal((await new Client().get('/api/bootstrap')).body.sso.label, 'Okta');
  const attempt = async claims => {
    const c = new Client();
    const start = await c.req('GET', '/api/auth/sso/start');
    const loc = new URL(start.headers.get('location'));
    nextClaims = { nonce: loc.searchParams.get('nonce'), ...claims };
    const cb = await c.req('GET', `/api/auth/sso/callback?code=abc&state=${encodeURIComponent(loc.searchParams.get('state'))}`);
    return { c, loc: cb.headers.get('location') || '' };
  };
  let r = await attempt({ email: 'ada@example.com' });
  assert.equal(r.loc, '/'); assert.equal((await r.c.get('/api/me')).body.email, 'ada@example.com');
  r = await attempt({ email: 'fresh@newco.io', name: 'Fresh Person' });
  assert.equal(r.loc, '/'); const me = (await r.c.get('/api/me')).body; assert.equal(me.role, 'viewer'); assert.equal(me.name, 'Fresh Person');
  r = await attempt({ email: 'stranger@evil.com' });
  assert.match(r.loc, /sso_error/); assert.equal((await r.c.get('/api/me')).status, 401);
  r = await attempt({ email: 'ada@example.com', nonce: 'forged' });
  assert.match(r.loc, /sso_error/);
  r = await attempt({ email: 'ada@example.com', aud: 'someone-else' });
  assert.match(r.loc, /sso_error/);
  r = await attempt({ email: 'ada@example.com', email_verified: false });
  assert.match(r.loc, /sso_error/);
  idp.s.close();
});

test('Web Push: RFC 8291 test vector, subscription validation, delivery + cleanup of dead endpoints', async () => {
  const { encryptPayload } = await import('../server/channels/webpush.js');
  const b = s => Buffer.from(s, 'base64url');
  const as = crypto.createECDH('prime256v1'); as.setPrivateKey(b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const out = encryptPayload('When I grow up, I want to be a watermelon', 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', { ephemeral: as, salt: b('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');

  assert.match((await member.get('/api/push/key')).body.key, /^[A-Za-z0-9_-]{87}$/);
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const seen = [];
  let status = 201;
  const push = await listen((req, res) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => { seen.push({ h: req.headers, body: Buffer.concat(ch) }); res.statusCode = status; res.end(); }); });
  assert.equal((await member.post('/api/push/subscribe', { endpoint: push.url + '/s/1', keys: { p256dh: 'short', auth: 'x' } })).status, 400);
  assert.equal((await member.post('/api/push/subscribe', { endpoint: push.url + '/s/1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } })).status, 200);
  assert.equal((await member.post('/api/push/test')).body.sent, 1);
  assert.match(seen[0].h.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(seen[0].h['content-encoding'], 'aes128gcm');
  // decrypt as the browser would (independent receiver implementation)
  const body = seen[0].body, salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = ua.computeSecret(asPub);
  const hk = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hk(auth, ecdh, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(JSON.parse(plain.subarray(0, plain.length - 1).toString()).title, 'TaskBoard');
  // a notification triggers a push to subscribed users
  const before = seen.length;
  const me = (await member.get('/api/me')).body;
  await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'push me', assignee_id: me.id });
  await new Promise(r => setTimeout(r, 400));
  assert.ok(seen.length > before);
  // gone endpoints are removed
  status = 410;
  await member.post('/api/push/test');
  status = 201;
  assert.equal((await member.post('/api/push/test')).body.sent, 0);
  push.s.close();
});

test('email replies become comments (auth + sender checks, quoted text stripped)', async () => {
  const { applyReply, stripQuoted, extractKey } = await import('../server/emailreply.js');
  const task = await mk(member, ids.api, { title: 'reply target' });
  const auth = 'mx.google.com; dkim=pass header.i=@demo.taskboard.dev; spf=pass';
  assert.equal(extractKey(`Re: [${task.key}] Marcus assigned you`), task.key);
  assert.equal(stripQuoted('Looks good!\n\nOn Tue, Oct 20, Ada wrote:\n> old stuff'), 'Looks good!');
  const mail = { subject: `Re: [${task.key}] update`, from: 'Marcus Lee <marcus@demo.taskboard.dev>', body: 'Shipping tomorrow.\n\n> quoted', auth };
  assert.equal(applyReply({ ...mail, auth: '' }).reason, 'sender not authenticated'); // forged From: rejected
  assert.equal(applyReply({ ...mail, from: 'x@evil.com' }).reason, 'unknown sender');
  assert.equal(applyReply({ ...mail, from: 'dana@demo.taskboard.dev' }).reason, 'no access'); // viewer on another team
  assert.equal(applyReply({ ...mail, subject: 'no key' }).reason, 'no task key');
  assert.equal(applyReply(mail).ok, true);
  const c = (await admin.get(`/api/tasks/${task.id}`)).body.comments;
  assert.match(c[0].body, /Shipping tomorrow\./); assert.ok(!/quoted/.test(c[0].body)); assert.equal(c[0].user_name, 'Marcus Lee');
});

test('audit log records sensitive actions (admin only)', async () => {
  assert.equal((await member.get('/api/audit')).status, 403);
  const log = (await admin.get('/api/audit?limit=200')).body;
  const actions = new Set(log.map(l => l.action));
  for (const a of ['token.created', 'webhook.created', 'hook.created', 'settings.updated', 'auth.login']) assert.ok(actions.has(a), a);
  assert.ok(!JSON.stringify(log).includes('supersecret1'));
  const settings = log.find(l => l.action === 'settings.updated');
  assert.ok(Array.isArray(settings.detail.keys) && !JSON.stringify(settings).includes('csecret'));
});
