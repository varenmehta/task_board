import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

const t = await boot();
const { admin, member, ids, Client, base } = t;
test.after(() => t.server.close());
const { totp, hotp, base32, fromBase32, verifyTotp, consumeRecovery, newRecoveryCodes } = await import('../server/totp.js');

test('TOTP matches RFC 6238 test vectors and rejects wrong/replayed codes', () => {
  const secret = base32(Buffer.from('12345678901234567890')); // RFC 6238 SHA-1 seed
  assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(secret, Math.floor(20000000000 / 30), 8), '65353130');
  assert.equal(fromBase32(base32(Buffer.from('hello world'))).toString(), 'hello world');
  const now = 1_700_000_000_000, code = totp(secret, now);
  assert.ok(verifyTotp(secret, code, now));
  assert.ok(verifyTotp(secret, code, now + 30000));          // one step of drift allowed
  assert.equal(verifyTotp(secret, code, now + 120000), 0);   // but not two minutes
  assert.equal(verifyTotp(secret, '000000', now) === 0 || code === '000000', true);
  assert.equal(verifyTotp(secret, 'abcdef', now), 0);
  const rc = newRecoveryCodes(3);
  const left = consumeRecovery(rc.hashes, rc.plain[0].toUpperCase());
  assert.equal(left.length, 2); assert.equal(consumeRecovery(left, rc.plain[0]), null);
});

test('sessions: listing, revoke one, revoke others, logout kills the session', async () => {
  const a = new Client(), b = new Client();
  await a.post('/api/login', { email: 'priya@demo.taskboard.dev', password: 'demo1234' });
  await b.post('/api/login', { email: 'priya@demo.taskboard.dev', password: 'demo1234' });
  const list = (await a.get('/api/sessions')).body;
  assert.ok(list.length >= 2); assert.equal(list.filter(s => s.current).length, 1);
  const other = list.find(s => !s.current);
  assert.equal((await a.del(`/api/sessions/${other.id}`)).status, 200);
  const stillB = (await b.get('/api/me')).status; // b may or may not be the revoked one
  const c = new Client(); await c.post('/api/login', { email: 'priya@demo.taskboard.dev', password: 'demo1234' });
  assert.equal((await c.post('/api/sessions/revoke-others')).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await b.get('/api/me')).status, 401);
  void stillB;
  const old = c.cookie;
  await c.post('/api/logout');
  const replay = new Client(); replay.cookie = old;
  assert.equal((await replay.get('/api/me')).status, 401); // a stolen cookie is useless after logout
  // forged / legacy cookie without a session id
  const forged = new Client(); forged.cookie = 'tb_session=' + 'x'.repeat(30) + '.' + 'y'.repeat(43);
  assert.equal((await forged.get('/api/me')).status, 401);
});

test('changing password signs out other devices', async () => {
  const a = new Client(), b = new Client();
  await a.post('/api/login', { email: 'sofia@demo.taskboard.dev', password: 'demo1234' });
  await b.post('/api/login', { email: 'sofia@demo.taskboard.dev', password: 'demo1234' });
  assert.equal((await a.patch('/api/me', { password: 'newpassword99', current_password: 'demo1234' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
  assert.equal((await new Client().post('/api/login', { email: 'sofia@demo.taskboard.dev', password: 'newpassword99' })).status, 200);
});

test('two-factor auth: setup, enforced at login, recovery codes, disable, admin reset', async () => {
  const u = new Client();
  await u.post('/api/login', { email: 'ken@demo.taskboard.dev', password: 'demo1234' });
  const setup = (await u.post('/api/me/2fa/setup')).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]{32}/);
  assert.equal((await u.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
  const en = await u.post('/api/me/2fa/enable', { code: totp(setup.secret) });
  assert.equal(en.status, 200); assert.equal(en.body.recovery_codes.length, 8);
  assert.equal((await u.get('/api/me')).body.totp_enabled, true);
  // password alone no longer signs in
  const l = new Client();
  const step1 = (await l.post('/api/login', { email: 'ken@demo.taskboard.dev', password: 'demo1234' })).body;
  assert.equal(step1.needs_2fa, true); assert.ok(!l.cookie);
  assert.equal((await l.get('/api/me')).status, 401);
  assert.equal((await l.post('/api/login/2fa', { ticket: step1.ticket, code: '123456' })).status, 401);
  assert.equal((await l.post('/api/login/2fa', { ticket: 'forged', code: totp(setup.secret) })).status, 401);
  // the code used to enable can't be replayed (same 30s step)
  assert.equal((await l.post('/api/login/2fa', { ticket: step1.ticket, code: totp(setup.secret) })).status, 401);
  // a recovery code works exactly once
  const rc = en.body.recovery_codes[0];
  assert.equal((await l.post('/api/login/2fa', { ticket: step1.ticket, code: rc })).status, 200);
  assert.equal((await l.get('/api/me')).status, 200);
  const l2 = new Client(); const s2 = (await l2.post('/api/login', { email: 'ken@demo.taskboard.dev', password: 'demo1234' })).body;
  assert.equal((await l2.post('/api/login/2fa', { ticket: s2.ticket, code: rc })).status, 401);
  // disabling needs password AND a code
  assert.equal((await l.post('/api/me/2fa/disable', { password: 'wrong', code: en.body.recovery_codes[1] })).status, 400);
  assert.equal((await l.post('/api/me/2fa/disable', { password: 'demo1234', code: en.body.recovery_codes[1] })).status, 200);
  assert.equal((await new Client().post('/api/login', { email: 'ken@demo.taskboard.dev', password: 'demo1234' })).body.needs_2fa, undefined);
  // admin can reset a locked-out user
  const s3 = (await l.post('/api/me/2fa/setup')).body; await l.post('/api/me/2fa/enable', { code: totp(s3.secret) });
  const kenId = (await l.get('/api/me')).body.id;
  assert.equal((await member.post(`/api/users/${kenId}/2fa/reset`)).status, 403);
  assert.equal((await admin.post(`/api/users/${kenId}/2fa/reset`)).status, 200);
  assert.equal((await new Client().post('/api/login', { email: 'ken@demo.taskboard.dev', password: 'demo1234' })).status, 200);
  const log = (await admin.get('/api/audit?limit=200')).body.map(a => a.action);
  for (const a of ['auth.2fa_enabled', 'auth.2fa_disabled', 'user.2fa_reset', 'auth.recovery_code_used']) assert.ok(log.includes(a), a);
  // the TOTP secret is encrypted at rest
  const { get } = await import('../server/db.js');
  assert.ok(!/^[A-Z2-7]{32}$/.test(get('SELECT totp_secret s FROM users WHERE id=?', kenId).s || 'x'));
});

test('backups: admin-only, consistent copy, path traversal blocked, retention', async () => {
  assert.equal((await member.get('/api/admin/backups')).status, 403);
  const { name } = (await admin.post('/api/admin/backups')).body;
  assert.match(name, /^taskboard-\d{8}-\d{6}\.db$/);
  assert.ok((await admin.get('/api/admin/backups')).body.some(b => b.name === name));
  const dl = await admin.get(`/api/admin/backups/${name}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body.subarray(0, 15).toString(), 'SQLite format 3');
  for (const bad of ['../.secret', '..%2F..%2Fetc%2Fpasswd', 'x.db']) assert.ok([400, 404].includes((await admin.get(`/api/admin/backups/${bad}`)).status), bad);
  assert.equal((await member.get(`/api/admin/backups/${name}`)).status, 403);
  // the backup contains the data (open it read-only and look)
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(`${process.env.DATA_DIR}/backups/${name}`, { readOnly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) n FROM tasks').get().n > 10);
  copy.close();
  assert.ok(!fs.readdirSync(`${process.env.DATA_DIR}/backups`).includes('.secret'));
  void ids; void base; void crypto;
});
