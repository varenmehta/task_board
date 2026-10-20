import crypto from 'node:crypto';
import { Router } from './router.js';
import { all, get, run, insert, tx, parseJSON, getSetting, setSetting, SETTING_KEYS, SECRET_KEYS, INTERNAL_KEYS } from './db.js';
import { ORG_ROLES, PROJECT_ROLES, DEFAULT_STATUSES, TASK_TYPES } from './config.js';
import { bad, forbidden, notFound, handleOf, pickColor, todayStr, addDays, HttpError, clip } from './util.js';
import { hashPassword, verifyPassword, sessionCookie, clearCookie, rateLimit, sign, verify } from './auth.js';
import { teamRole, canViewProject, canEditProject, canManageTeam, canManageProject, projectRole, visibleProjects, projectMembers } from './access.js';
import { projectStatuses, validateStatuses, statusIds } from './statuses.js';
import * as TIME from './time.js';
import * as ATT from './attachments.js';
import * as REC from './recurring.js';
import * as PLAN from './planning.js';
import { report, exportCsv } from './reports.js';
import * as TOK from './tokens.js';
import * as WH from './webhooks.js';
import * as HOOKS from './hooks.js';
import * as ICS from './ics.js';
import * as SSO from './sso.js';
import * as SLACK from './slack.js';
import * as PUSH from './channels/webpush.js';
import { audit, listAudit } from './audit.js';
import * as T from './tasks.js';
import { addClient, pushTo } from './events.js';
import { usersWhoCanView } from './access.js';
import { getPrefs, DEFAULT_PREFS, EVENTS, unreadCount, markAllRead } from './notifications.js';
import { TRIGGERS, ACTIONS, validateRule, seedDefaultRules } from './automations.js';
import * as AI from './ai.js';
import * as G from './channels/google.js';
import { twilioConfigured, normalizePhone, validSignature } from './channels/twilio.js';
import { sendEmail, sendPhone, emailMode, phoneMode, emailHtml } from './delivery.js';
import { handleCommand } from './commands.js';
import { runReminders, runDigests, pollInbox, buildDigest } from './scheduler.js';
import { seedDemo } from './seed.js';

export const router = new Router();
const R = router;

const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, title: u.title, handle: handleOf(u.name),
});
const baseUrl = req => getSetting('base_url') || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
const needAdmin = u => { if (u.role !== 'admin') throw forbidden('Admins only'); };
const needNotViewer = u => { if (u.role === 'viewer') throw forbidden('Viewers have read-only access'); };
const hasUsers = () => !!get('SELECT 1 FROM users LIMIT 1');

function me(u) {
  const phoneSet = !!u.phone;
  return {
    ...publicUser(u), slack_id: u.slack_id, phone: u.phone, phone_verified: !!u.phone_verified, prefs: getPrefs(u),
    unread: unreadCount(u.id), phoneSet,
    teams: all('SELECT t.id, t.name, tm.role FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.name', u.id),
  };
}

function loadProject(user, id, { edit = false, manage = false } = {}) {
  const p = T.getProject(Number(id));
  if (!p || !canViewProject(user, p)) throw notFound('Project not found');
  if (edit && !canEditProject(user, p)) throw forbidden();
  if (manage && !canManageProject(user, p)) throw forbidden('Only project managers can do that');
  return p;
}
const projectOut = (user, p) => ({
  ...p, statuses: projectStatuses(p), fields: parseJSON(p.fields, []), digest_emails: parseJSON(p.digest_emails, []), auto_triage: !!p.auto_triage,
  role: projectRole(user, p), can_edit: canEditProject(user, p), can_manage: canManageProject(user, p),
});

// ============ session / auth ============
R.get('/api/health', () => ({ ok: true }), { public: true });

R.get('/api/bootstrap', ({ user }) => ({
  needs_setup: !hasUsers(),
  workspace: getSetting('workspace_name') || 'TaskBoard',
  me: user ? me(user) : null,
  statuses: DEFAULT_STATUSES, task_types: TASK_TYPES,
  ai_mode: AI.aiMode(),
  sso: (() => { const c = SSO.ssoConfig(''); return c ? { label: c.label } : null; })(),
  demo: !!get("SELECT 1 FROM users WHERE email LIKE '%@demo.taskboard.dev' AND active=1"),
}), { public: true });

R.post('/api/setup', ({ body, req, res }) => {
  if (hasUsers()) throw forbidden('Workspace is already set up');
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || !name || String(body.password || '').length < 8) throw bad('Name, a valid email and a password of 8+ characters are required');
  const id = insert('INSERT INTO users(email,name,password_hash,role,color,title) VALUES(?,?,?,?,?,?)', email, name, hashPassword(body.password), 'admin', pickColor(1), 'Workspace admin');
  setSetting('workspace_name', String(body.workspace || 'TaskBoard').slice(0, 60));
  const user = get('SELECT * FROM users WHERE id=?', id);
  if (body.demo) seedDemo(user);
  else {
    const team = insert('INSERT INTO teams(name,color,description) VALUES(?,?,?)', 'My team', pickColor(0), '');
    run('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?)', team, id, 'lead');
    insert('INSERT INTO projects(team_id,key,name,description,color) VALUES(?,?,?,?,?)', team, 'TB', 'First project', 'Your first board — rename or replace it any time.', pickColor(0));
  }
  seedDefaultRules(id);
  res.setHeader('Set-Cookie', sessionCookie(id, req.headers['x-forwarded-proto'] === 'https'));
  return me(user);
}, { public: true });

R.post('/api/login', ({ body, req, res }) => {
  const email = String(body.email || '').trim().toLowerCase();
  if (!rateLimit('login:' + (req.socket.remoteAddress || '') + email, 8)) throw new HttpError(429, 'Too many attempts — try again in a minute');
  const u = get('SELECT * FROM users WHERE email=? AND active=1', email);
  if (!u || !verifyPassword(String(body.password || ''), u.password_hash)) { audit(u || null, 'auth.login_failed', email, {}, req); throw new HttpError(401, 'Incorrect email or password'); }
  res.setHeader('Set-Cookie', sessionCookie(u.id, req.headers['x-forwarded-proto'] === 'https'));
  audit(u, 'auth.login', u.email, {}, req);
  return me(u);
}, { public: true });

R.post('/api/logout', ({ res }) => { res.setHeader('Set-Cookie', clearCookie); return { ok: true }; }, { public: true });

R.get('/api/invite/:token', ({ params }) => {
  const u = get('SELECT name,email FROM users WHERE invite_token=? AND active=1', params.token);
  if (!u) throw notFound('This invitation is no longer valid');
  return u;
}, { public: true });

R.post('/api/invite/:token', ({ params, body, req, res }) => {
  const u = get('SELECT * FROM users WHERE invite_token=? AND active=1', params.token);
  if (!u) throw notFound('This invitation is no longer valid');
  if (String(body.password || '').length < 8) throw bad('Password must be at least 8 characters');
  run('UPDATE users SET password_hash=?, invite_token=NULL, name=? WHERE id=?', hashPassword(body.password), String(body.name || u.name).trim() || u.name, u.id);
  res.setHeader('Set-Cookie', sessionCookie(u.id, req.headers['x-forwarded-proto'] === 'https'));
  return me(get('SELECT * FROM users WHERE id=?', u.id));
}, { public: true });

R.get('/api/events', ({ req, res, user }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  addClient(user.id, res);
  return undefined;
}, { stream: true });

// ============ me & preferences ============
R.get('/api/me', ({ user }) => me(user));

R.patch('/api/me', ({ user, body }) => {
  const name = body.name != null ? String(body.name).trim() : user.name;
  if (!name) throw bad('Name cannot be empty');
  const title = body.title != null ? String(body.title).slice(0, 80) : user.title;
  run('UPDATE users SET name=?, title=? WHERE id=?', name.slice(0, 80), title, user.id);
  if ('slack_id' in body) SLACK.linkSlack(user.id, String(body.slack_id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || null);
  if (body.password) {
    if (String(body.password).length < 8) throw bad('Password must be at least 8 characters');
    if (!verifyPassword(String(body.current_password || ''), user.password_hash)) throw bad('Current password is incorrect');
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(body.password), user.id);
  }
  return me(get('SELECT * FROM users WHERE id=?', user.id));
});

R.put('/api/me/prefs', ({ user, body }) => {
  const cur = getPrefs(user);
  const next = { ...cur };
  for (const k of ['phone_channel', 'phone_urgent_only', 'digest_hour', 'digest_weekdays_only', 'tz_offset', 'email_to_task', 'default_project_id']) if (k in body) next[k] = body[k];
  if (!['sms', 'whatsapp'].includes(next.phone_channel)) next.phone_channel = 'sms';
  next.digest_hour = Math.max(0, Math.min(23, Number(next.digest_hour) || 9));
  next.tz_offset = Math.max(-840, Math.min(840, Number(next.tz_offset) || 0));
  if (body.matrix) for (const ev of Object.keys(EVENTS)) if (body.matrix[ev]) {
    next.matrix[ev] = { app: !!body.matrix[ev].app, email: !!body.matrix[ev].email, phone: !!body.matrix[ev].phone };
  }
  run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify(next), user.id);
  return me(get('SELECT * FROM users WHERE id=?', user.id));
});

R.get('/api/notification-events', () => EVENTS);

// ---- phone verification ----
R.post('/api/me/phone', async ({ user, body }) => {
  const phone = normalizePhone(body.phone);
  if (!phone) throw bad('Enter your number with country code, e.g. +14155550123');
  const taken = get('SELECT 1 FROM users WHERE phone=? AND phone_verified=1 AND id<>?', phone, user.id);
  if (taken) throw bad('That number is already linked to another account');
  const code = String(crypto.randomInt(100000, 999999));
  run('UPDATE users SET phone=?, phone_verified=0, phone_code=?, phone_code_exp=? WHERE id=?', phone, code, Date.now() + 10 * 60_000, user.id);
  const status = await sendPhone({ userId: user.id, to: phone, kind: getPrefs(user).phone_channel, text: `TaskBoard verification code: ${code}` });
  return { sent: true, simulated: status === 'simulated', status };
});

R.post('/api/me/phone/verify', ({ user, body }) => {
  const fresh = get('SELECT * FROM users WHERE id=?', user.id);
  if (!rateLimit('phone:' + user.id, 6)) throw new HttpError(429, 'Too many attempts');
  if (!fresh.phone_code || fresh.phone_code_exp < Date.now() || String(body.code).trim() !== fresh.phone_code) throw bad('That code is incorrect or expired');
  run('UPDATE users SET phone_verified=1, phone_code=NULL WHERE id=?', user.id);
  return me(get('SELECT * FROM users WHERE id=?', user.id));
});

R.del('/api/me/phone', ({ user }) => {
  run('UPDATE users SET phone=NULL, phone_verified=0, phone_code=NULL WHERE id=?', user.id);
  return me(get('SELECT * FROM users WHERE id=?', user.id));
});

// ============ integrations ============
R.get('/api/integrations', ({ user }) => {
  const g = G.getIntegration(user.id);
  return {
    google: { configured: G.googleConfigured(), connected: !!g?.refresh_token, email: g?.email || null, label: G.LABEL, sender: G.senderUserId() === user.id },
    email_mode: emailMode(), phone_mode: phoneMode(), twilio_configured: twilioConfigured(),
    ai_mode: AI.aiMode(), workspace_has_sender: !!G.senderUserId(),
    webhook_path: '/api/webhooks/twilio',
  };
});

R.get('/api/integrations/google/start', ({ user, req, res }) => {
  if (!G.googleConfigured()) throw bad('Ask a workspace admin to add Google OAuth credentials in Settings → Workspace');
  res.writeHead(302, { Location: G.authUrl(baseUrl(req), sign({ uid: user.id, n: 'g' }, 600)) });
  res.end();
  return undefined;
}, { stream: true });

R.get('/api/integrations/google/callback', async ({ user, query, req, res }) => {
  const done = q => { res.writeHead(302, { Location: `/#/settings/integrations?${q}` }); res.end(); };
  const st = verify(query.state);
  if (query.error || !st || st.uid !== user.id) return done('error=' + encodeURIComponent(query.error || 'invalid_state'));
  try {
    const t = await G.exchangeCode(query.code, baseUrl(req));
    if (!t.refresh_token) return done('error=' + encodeURIComponent('Google did not return offline access — remove the app in your Google account and retry'));
    G.saveIntegration(user.id, t);
    audit(user, 'integration.gmail_connected', t.email, {}, req);
    await G.ensureLabel(user.id).catch(() => {});
    return done('connected=gmail');
  } catch (e) { return done('error=' + encodeURIComponent(e.message)); }
}, { stream: true });

R.del('/api/integrations/google', async ({ user, req }) => { await G.revoke(user.id); audit(user, 'integration.gmail_disconnected', user.email, {}, req); return { ok: true }; });

R.post('/api/integrations/test', async ({ user, body }) => {
  const channel = body.channel;
  if (channel === 'email') {
    const status = await sendEmail({ userId: user.id, to: user.email, subject: 'TaskBoard test email ✅', text: 'Email notifications are working.',
      html: emailHtml({ heading: 'It works! ✅', body: 'This is a test email from your TaskBoard workspace.', ctaText: 'Open TaskBoard', ctaUrl: getSetting('base_url') || '' }) });
    return { status };
  }
  if (channel === 'phone') {
    if (!user.phone || !user.phone_verified) throw bad('Verify your phone number first');
    return { status: await sendPhone({ userId: user.id, to: user.phone, kind: getPrefs(user).phone_channel, text: 'TaskBoard test message ✅ — reply "list" to see your tasks.' }) };
  }
  if (channel === 'briefing') {
    const d = await buildDigest(user, todayStr());
    const status = await sendEmail({ userId: user.id, to: user.email, subject: 'Your TaskBoard briefing (preview)', text: d.text, html: emailHtml({ heading: 'Your briefing', body: d.html }) });
    return { status };
  }
  if (channel === 'inbox') return { created: await pollInbox() };
  throw bad('Unknown channel');
});

R.get('/api/outbox', ({ user }) => all(`SELECT id,channel,recipient,subject,body,status,error,created_at FROM outbox
  ${user.role === 'admin' ? '' : 'WHERE user_id=' + Number(user.id)} ORDER BY id DESC LIMIT 40`));

// Twilio inbound webhook (SMS / WhatsApp): authenticated by Twilio's request signature.
R.post('/api/webhooks/twilio', async ({ req, body }) => {
  const url = `${baseUrl(req)}/api/webhooks/twilio`;
  if (!validSignature(url, body, req.headers['x-twilio-signature'])) throw forbidden('Bad signature');
  const from = normalizePhone(String(body.From || '').replace('whatsapp:', ''));
  const user = from && get('SELECT * FROM users WHERE phone=? AND phone_verified=1 AND active=1', from);
  const reply = user ? await handleCommand(user, body.Body) : 'This number is not linked to a TaskBoard account. Add it in Settings → Integrations.';
  return { __xml: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</Message></Response>` };
}, { public: true, webhook: true });

// ============ admin settings ============
R.get('/api/settings', ({ user }) => {
  needAdmin(user);
  const out = {};
  for (const k of SETTING_KEYS) {
    const v = getSetting(k);
    out[k] = SECRET_KEYS.has(k) ? { set: !!v, from_env: !!process.env[k.toUpperCase()] } : v;
  }
  return { values: out, redirect_uri: G.redirectUri('') };
});

R.put('/api/settings', ({ user, body, req }) => {
  needAdmin(user);
  const changed = [];
  for (const k of SETTING_KEYS) {
    if (!(k in body) || INTERNAL_KEYS.has(k)) continue;
    const v = String(body[k] ?? '').trim();
    if (SECRET_KEYS.has(k) && v === '') continue; // blank = keep existing
    setSetting(k, v === '__clear__' ? '' : v); changed.push(k);
  }
  audit(user, 'settings.updated', null, { keys: changed }, req);
  return { ok: true };
});

// ============ users ============
R.get('/api/users', ({ user }) => {
  let rows = all('SELECT * FROM users WHERE active=1 ORDER BY name');
  if (user.role === 'guest') {
    const ids = new Set([user.id]);
    for (const p of visibleProjects(user)) for (const uid of usersWhoCanView(p)) ids.add(uid);
    rows = rows.filter(u => ids.has(u.id));
  }
  const tm = all('SELECT * FROM team_members');
  return rows.map(u => ({
    ...publicUser(u), pending: !!u.invite_token, phone_verified: !!u.phone_verified,
    teams: tm.filter(x => x.user_id === u.id).map(x => ({ team_id: x.team_id, role: x.role })),
  }));
});

R.post('/api/users', async ({ user, body, req }) => {
  needAdmin(user);
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || !name) throw bad('Name and a valid email are required');
  if (!ORG_ROLES.includes(body.role || 'member')) throw bad('Invalid role');
  if (get('SELECT 1 FROM users WHERE email=?', email)) throw bad('A user with that email already exists');
  const token = crypto.randomBytes(24).toString('base64url');
  const id = insert('INSERT INTO users(email,name,role,color,title,invite_token) VALUES(?,?,?,?,?,?)', email, name, body.role || 'member', pickColor(get('SELECT COUNT(*) n FROM users').n + 2), String(body.title || ''), token);
  for (const tid of body.team_ids || []) if (get('SELECT 1 FROM teams WHERE id=?', tid)) run('INSERT OR IGNORE INTO team_members(team_id,user_id,role) VALUES(?,?,?)', tid, id, 'member');
  for (const pid of body.project_ids || []) if (get('SELECT 1 FROM projects WHERE id=?', pid)) run('INSERT OR IGNORE INTO project_members(project_id,user_id,role) VALUES(?,?,?)', pid, id, body.role === 'guest' ? 'commenter' : 'editor');
  audit(user, 'user.invited', email, { role: body.role || 'member' }, req);
  const link = `${baseUrl(req)}/#/invite/${token}`;
  const status = await sendEmail({ userId: user.id, to: email, subject: `${user.name} invited you to ${getSetting('workspace_name') || 'TaskBoard'}`,
    text: `Join your team on TaskBoard: ${link}`, html: emailHtml({ heading: `You're invited to ${getSetting('workspace_name') || 'TaskBoard'}`, body: `${user.name} added you as <b>${body.role || 'member'}</b>. Set a password to get started.`, ctaText: 'Accept invitation', ctaUrl: link }) });
  return { id, invite_link: link, email_status: status };
});

R.patch('/api/users/:id', ({ user, params, body, req }) => {
  needAdmin(user);
  const u = get('SELECT * FROM users WHERE id=? AND active=1', params.id);
  if (!u) throw notFound('User not found');
  if (body.role) {
    if (!ORG_ROLES.includes(body.role)) throw bad('Invalid role');
    if (u.role === 'admin' && body.role !== 'admin' && get('SELECT COUNT(*) n FROM users WHERE role=? AND active=1', 'admin').n <= 1) throw bad('There must be at least one admin');
    run('UPDATE users SET role=? WHERE id=?', body.role, u.id);
    audit(user, 'user.role_changed', u.email, { from: u.role, to: body.role }, req);
  }
  if (body.title != null) run('UPDATE users SET title=? WHERE id=?', String(body.title).slice(0, 80), u.id);
  return publicUser(get('SELECT * FROM users WHERE id=?', u.id));
});

R.del('/api/users/:id', ({ user, params, req }) => {
  needAdmin(user);
  const u = get('SELECT * FROM users WHERE id=? AND active=1', params.id);
  if (!u) throw notFound('User not found');
  if (u.id === user.id) throw bad('You cannot remove yourself');
  run('UPDATE users SET active=0, invite_token=NULL WHERE id=?', u.id);
  audit(user, 'user.removed', u.email, {}, req);
  run('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?', u.id);
  run('DELETE FROM team_members WHERE user_id=?', u.id);
  return { ok: true };
});

// ============ teams ============
R.get('/api/teams', ({ user }) => {
  if (user.role === 'guest') return [];
  const teams = user.role === 'admin' ? all('SELECT * FROM teams ORDER BY name')
    : all('SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=? ORDER BY t.name', user.id);
  return teams.map(t => ({
    ...t, can_manage: canManageTeam(user, t.id),
    members: all(`SELECT u.id, u.name, u.color, u.email, u.role AS org_role, tm.role FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? AND u.active=1 ORDER BY (tm.role='lead') DESC, u.name`, t.id),
    projects: all('SELECT id, key, name, color FROM projects WHERE team_id=? AND archived=0 ORDER BY name', t.id),
  }));
});

R.post('/api/teams', ({ user, body }) => {
  if (!['admin', 'manager'].includes(user.role)) throw forbidden('Only admins and managers can create teams');
  const name = String(body.name || '').trim();
  if (!name) throw bad('Team name is required');
  const id = insert('INSERT INTO teams(name,color,description) VALUES(?,?,?)', name.slice(0, 60), body.color || pickColor(get('SELECT COUNT(*) n FROM teams').n), String(body.description || '').slice(0, 300));
  run('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?)', id, user.id, 'lead');
  return get('SELECT * FROM teams WHERE id=?', id);
});

R.patch('/api/teams/:id', ({ user, params, body }) => {
  if (!canManageTeam(user, Number(params.id))) throw forbidden();
  const t = get('SELECT * FROM teams WHERE id=?', params.id);
  if (!t) throw notFound();
  run('UPDATE teams SET name=?, description=?, color=? WHERE id=?', String(body.name ?? t.name).trim().slice(0, 60) || t.name, String(body.description ?? t.description).slice(0, 300), body.color ?? t.color, t.id);
  return get('SELECT * FROM teams WHERE id=?', t.id);
});

R.del('/api/teams/:id', ({ user, params, req }) => {
  needAdmin(user);
  audit(user, 'team.deleted', String(params.id), {}, req);
  run('DELETE FROM teams WHERE id=?', params.id);
  return { ok: true };
});

R.put('/api/teams/:id/members/:uid', ({ user, params, body }) => {
  const tid = Number(params.id);
  if (!canManageTeam(user, tid)) throw forbidden();
  if (!get('SELECT 1 FROM users WHERE id=? AND active=1', params.uid)) throw notFound('User not found');
  const role = body.role === 'lead' ? 'lead' : 'member';
  run('INSERT INTO team_members(team_id,user_id,role) VALUES(?,?,?) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role', tid, params.uid, role);
  return { ok: true };
});

R.del('/api/teams/:id/members/:uid', ({ user, params }) => {
  if (!canManageTeam(user, Number(params.id)) && Number(params.uid) !== user.id) throw forbidden();
  const leads = get(`SELECT COUNT(*) n FROM team_members WHERE team_id=? AND role='lead'`, params.id).n;
  if (teamRole({ id: Number(params.uid) }, Number(params.id)) === 'lead' && leads <= 1 && user.role !== 'admin') throw bad('A team needs at least one lead');
  run('DELETE FROM team_members WHERE team_id=? AND user_id=?', params.id, params.uid);
  run('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=? AND project_id IN (SELECT id FROM projects WHERE team_id=?)', params.uid, params.id);
  return { ok: true };
});

// ============ projects ============
R.get('/api/projects', ({ user }) => {
  const rows = visibleProjects(user, { archived: false });
  return rows.map(p => {
    const c = get(`SELECT COUNT(*) total, SUM(status='done') done, SUM(status<>'done' AND due_date<?) overdue FROM tasks WHERE project_id=? AND parent_id IS NULL`, todayStr(), p.id);
    return { ...projectOut(user, p), total: c.total, done: c.done || 0, overdue: c.overdue || 0, member_ids: projectMembers(p).map(m => m.id) };
  });
});

R.post('/api/projects', ({ user, body }) => {
  const teamId = Number(body.team_id);
  if (!get('SELECT 1 FROM teams WHERE id=?', teamId)) throw bad('Choose a team');
  if (!canManageTeam(user, teamId)) throw forbidden('Only team leads, managers and admins can create projects');
  const name = String(body.name || '').trim();
  const key = String(body.key || name.slice(0, 3)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (!name || key.length < 2) throw bad('Name and a 2–5 character key are required');
  if (get('SELECT 1 FROM projects WHERE key=?', key)) throw bad(`The key ${key} is already used`);
  const statuses = body.statuses ? JSON.stringify(validateStatuses(body.statuses)) : null;
  const id = insert('INSERT INTO projects(team_id,key,name,description,color,statuses) VALUES(?,?,?,?,?,?)', teamId, key, name.slice(0, 80), String(body.description || '').slice(0, 500), body.color || pickColor(get('SELECT COUNT(*) n FROM projects').n), statuses);
  return T.getProject(id);
});

R.patch('/api/projects/:id', ({ user, params, body }) => {
  const p = loadProject(user, params.id, { manage: true });
  const sets = { name: String(body.name ?? p.name).trim().slice(0, 80) || p.name, description: String(body.description ?? p.description).slice(0, 500), color: body.color ?? p.color, archived: body.archived ? 1 : 0 };
  if ('auto_triage' in body) sets.auto_triage = body.auto_triage ? 1 : 0;
  if ('digest_emails' in body) {
    const list = (Array.isArray(body.digest_emails) ? body.digest_emails : []).map(e => String(e).trim().toLowerCase()).filter(e => /^\S+@\S+\.\S+$/.test(e)).slice(0, 20);
    sets.digest_emails = JSON.stringify([...new Set(list)]);
  }
  if ('fields' in body) {
    const fields = (Array.isArray(body.fields) ? body.fields : []).slice(0, 12).map(f => ({
      id: String(f.id || f.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24),
      label: String(f.label || '').trim().slice(0, 30), type: ['text', 'number', 'select', 'date', 'checkbox'].includes(f.type) ? f.type : 'text',
      options: f.type === 'select' ? (Array.isArray(f.options) ? f.options : []).map(o => String(o).trim()).filter(Boolean).slice(0, 20) : undefined,
    })).filter(f => f.id && f.label);
    if (new Set(fields.map(f => f.id)).size !== fields.length) throw bad('Field names must be unique');
    sets.fields = JSON.stringify(fields);
  }
  if ('statuses' in body) {
    const next = validateStatuses(body.statuses);
    const removed = projectStatuses(p).filter(s => !next.some(n => n.id === s.id));
    for (const r of removed) {
      const used = get('SELECT COUNT(*) n FROM tasks WHERE project_id=? AND status=?', p.id, r.id).n;
      if (used) {
        const to = body.move_tasks_to && next.some(n => n.id === body.move_tasks_to) ? body.move_tasks_to : null;
        if (!to) throw bad(`“${r.label}” still has ${used} task(s) — choose where to move them first`);
        run('UPDATE tasks SET status=? WHERE project_id=? AND status=?', to, p.id, r.id);
      }
    }
    sets.statuses = JSON.stringify(next);
  }
  const cols = Object.keys(sets);
  run(`UPDATE projects SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, ...cols.map(c => sets[c]), p.id);
  pushTo(usersWhoCanView(p), 'task', { project_id: p.id, change: 'project' });
  return projectOut(user, T.getProject(p.id));
});

R.put('/api/projects/:id/members/:uid', ({ user, params, body }) => {
  const p = loadProject(user, params.id, { manage: true });
  const role = String(body.role || '');
  if (!PROJECT_ROLES.includes(role)) throw bad('Invalid project role');
  if (!get('SELECT 1 FROM users WHERE id=? AND active=1', params.uid)) throw notFound('User not found');
  run('INSERT INTO project_members(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role', p.id, params.uid, role);
  return { ok: true };
});
R.del('/api/projects/:id/members/:uid', ({ user, params }) => {
  const p = loadProject(user, params.id, { manage: true });
  run('DELETE FROM project_members WHERE project_id=? AND user_id=?', p.id, params.uid);
  return { ok: true };
});
R.get('/api/projects/:id/access', ({ user, params }) => {
  const p = loadProject(user, params.id, { manage: true });
  return {
    explicit: all(`SELECT pm.user_id, pm.role, u.name, u.email, u.role AS org_role FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=? AND u.active=1`, p.id),
    team: all(`SELECT u.id AS user_id, u.name, u.email, tm.role FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=? AND u.active=1`, p.team_id),
    roles: PROJECT_ROLES,
  };
});

R.get('/api/projects/:id/board', ({ user, params }) => {
  const p = loadProject(user, params.id);
  return {
    project: projectOut(user, p), tasks: T.listProjectTasks(p.id), members: projectMembers(p).map(u => ({ ...publicUser(u) })),
    sprints: PLAN.listSprints(p.id).sprints, releases: PLAN.listReleases(p.id),
    views: all('SELECT id,user_id,name,filters,shared FROM saved_views WHERE project_id=? AND (user_id=? OR shared=1) ORDER BY name', p.id, user.id).map(v => ({ ...v, filters: parseJSON(v.filters, {}), shared: !!v.shared, mine: v.user_id === user.id })),
    templates: REC.listTemplates(p.id),
  };
});

R.post('/api/projects/:id/tasks', ({ user, params, body }) => T.createTask(user, Number(params.id), body));

// ============ tasks ============
R.get('/api/tasks/:id', ({ user, params }) => T.taskDetail(user, Number(params.id)));
R.patch('/api/tasks/:id', ({ user, params, body }) => T.updateTask(user, Number(params.id), body));
R.del('/api/tasks/:id', ({ user, params }) => T.deleteTask(user, Number(params.id)));
R.post('/api/tasks/:id/move', ({ user, params, body }) => T.moveTask(user, Number(params.id), body.status, body.index));
R.post('/api/tasks/:id/comments', ({ user, params, body }) => T.addComment(user, Number(params.id), body.body));
R.post('/api/tasks/:id/subtasks', ({ user, params, body }) => {
  const parent = T.getTask(Number(params.id));
  if (!parent) throw notFound('Task not found');
  const titles = (Array.isArray(body.titles) ? body.titles : [body.title]).map(s => String(s || '').trim()).filter(Boolean).slice(0, 12);
  if (!titles.length) throw bad('Title is required');
  return tx(() => titles.map(title => T.createTask(user, parent.project_id, { title, parent_id: parent.id, assignee_id: parent.assignee_id })));
});

R.get('/api/my-tasks', ({ user }) => T.listAssigned(user.id));

R.get('/api/search', ({ user, query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 2) return [];
  const ids = visibleProjects(user).map(p => p.id);
  if (!ids.length) return [];
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const m = q.toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/);
  return all(`SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.project_id IN (${ids.join(',')})
    AND (t.title LIKE ? OR t.description LIKE ? OR t.labels LIKE ? OR (p.key=? AND t.number=?)) ORDER BY t.updated_at DESC LIMIT 15`, like, like, like, m?.[1] ?? '', m ? Number(m[2]) : -1)
    .map(r => T.getTask(r.id));
});


// ---- bulk, dependencies, time, attachments ----
R.post('/api/tasks/bulk', ({ user, body }) => T.bulkApply(user, body.ids, { patch: body.patch, remove: !!body.delete }));

R.get('/api/tasks/:id/links', ({ user, params }) => { T.taskDetail(user, Number(params.id)); return T.getLinks(Number(params.id)); });
R.post('/api/tasks/:id/blockers', ({ user, params, body }) => T.addBlocker(user, Number(params.id), Number(body.blocker_id)));
R.del('/api/tasks/:id/blockers/:bid', ({ user, params }) => T.removeBlocker(user, Number(params.id), Number(params.bid)));

R.get('/api/tasks/:id/time', ({ user, params }) => { T.taskDetail(user, Number(params.id)); return TIME.taskTime(Number(params.id)); });
R.post('/api/tasks/:id/time', ({ user, params, body }) => ({ id: TIME.logTime(user, Number(params.id), body) }));
R.post('/api/tasks/:id/timer/start', ({ user, params }) => { TIME.startTimer(user, Number(params.id)); return TIME.runningTimer(user.id); });
R.post('/api/timer/stop', ({ user }) => ({ stopped: TIME.stopTimer(user.id) }));
R.get('/api/timer', ({ user }) => TIME.runningTimer(user.id) || { none: true });
R.del('/api/time/:id', ({ user, params }) => { TIME.deleteEntry(user, Number(params.id)); return { ok: true }; });

R.post('/api/tasks/:id/attachments', ({ user, params, req, raw }) => ATT.saveAttachment(user, Number(params.id), raw, {
  name: decodeURIComponent(req.headers['x-filename'] || 'file'), mime: (req.headers['content-type'] || '').split(';')[0] }), { raw: true });
R.get('/api/attachments/:id', ({ user, params, res }) => {
  const { stream, headers } = ATT.openAttachment(user, Number(params.id));
  res.writeHead(200, headers);
  stream.pipe(res);
  return undefined;
}, { stream: true });
R.del('/api/attachments/:id', ({ user, params }) => { ATT.deleteAttachment(user, Number(params.id)); return { ok: true }; });

// ---- saved views, templates, recurring ----
R.post('/api/projects/:id/views', ({ user, params, body }) => {
  const p = loadProject(user, params.id);
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) throw bad('Name your view');
  const shared = body.shared && canManageProject(user, p) ? 1 : 0;
  return { id: insert('INSERT INTO saved_views(user_id,project_id,name,filters,shared) VALUES(?,?,?,?,?)', user.id, p.id, name, JSON.stringify(body.filters || {}), shared) };
});
R.del('/api/views/:id', ({ user, params }) => {
  const v = get('SELECT * FROM saved_views WHERE id=?', params.id);
  if (!v || (v.user_id !== user.id && user.role !== 'admin')) throw notFound('View not found');
  run('DELETE FROM saved_views WHERE id=?', v.id);
  return { ok: true };
});

R.get('/api/projects/:id/templates', ({ user, params }) => { loadProject(user, params.id); return REC.listTemplates(Number(params.id)); });
R.post('/api/projects/:id/templates', ({ user, params, body }) => ({ id: REC.saveTemplate(user, Number(params.id), body) }));
R.del('/api/projects/:id/templates/:tid', ({ user, params }) => { REC.deleteTemplate(user, Number(params.id), Number(params.tid)); return { ok: true }; });
R.post('/api/projects/:id/templates/:tid/use', ({ user, params, body }) => {
  const p = loadProject(user, params.id, { edit: true });
  const t = get('SELECT * FROM templates WHERE id=? AND project_id=?', params.tid, p.id);
  if (!t) throw notFound('Template not found');
  return REC.instantiate(user, p.id, parseJSON(t.data, {}), { assignee_id: body.assignee_id, status: body.status });
});
R.get('/api/projects/:id/recurrences', ({ user, params }) => { loadProject(user, params.id); return REC.listRecurrences(Number(params.id)); });
R.post('/api/projects/:id/recurrences', ({ user, params, body }) => ({ id: REC.saveRecurrence(user, Number(params.id), body) }));
R.put('/api/projects/:id/recurrences/:rid', ({ user, params, body }) => ({ id: REC.saveRecurrence(user, Number(params.id), { ...body, id: Number(params.rid) }) }));
R.del('/api/projects/:id/recurrences/:rid', ({ user, params }) => { REC.deleteRecurrence(user, Number(params.id), Number(params.rid)); return { ok: true }; });


// ============ planning: sprints, releases, roadmap ============
R.get('/api/projects/:id/sprints', ({ user, params }) => { loadProject(user, params.id); return PLAN.listSprints(Number(params.id)); });
R.post('/api/projects/:id/sprints', ({ user, params, body }) => ({ id: PLAN.createSprint(user, Number(params.id), body) }));
R.patch('/api/sprints/:id', ({ user, params, body }) => { PLAN.updateSprint(user, Number(params.id), body); return { ok: true }; });
R.del('/api/sprints/:id', ({ user, params }) => { PLAN.deleteSprint(user, Number(params.id)); return { ok: true }; });
R.post('/api/sprints/:id/start', ({ user, params }) => { PLAN.startSprint(user, Number(params.id)); return { ok: true }; });
R.post('/api/sprints/:id/close', ({ user, params, body }) => PLAN.closeSprint(user, Number(params.id), body));

R.get('/api/projects/:id/releases', ({ user, params }) => { loadProject(user, params.id); return PLAN.listReleases(Number(params.id)); });
R.post('/api/projects/:id/releases', ({ user, params, body }) => ({ id: PLAN.saveRelease(user, Number(params.id), body) }));
R.patch('/api/releases/:id', ({ user, params, body }) => {
  const r = get('SELECT * FROM releases WHERE id=?', params.id); if (!r) throw notFound('Release not found');
  PLAN.saveRelease(user, r.project_id, { ...r, ...body }, r.id); return { ok: true };
});
R.del('/api/releases/:id', ({ user, params }) => { PLAN.deleteRelease(user, Number(params.id)); return { ok: true }; });
R.post('/api/releases/:id/ship', ({ user, params }) => { PLAN.markReleased(user, Number(params.id)); return { ok: true }; });
R.post('/api/releases/:id/notes', async ({ user, params }) => {
  const r = get('SELECT * FROM releases WHERE id=?', params.id); if (!r) throw notFound('Release not found');
  loadProject(user, r.project_id);
  const tasks = PLAN.releaseTasks(r.id);
  return AI.releaseNotes(r, tasks, PLAN.localReleaseNotes(r, tasks));
});
R.get('/api/projects/:id/roadmap', ({ user, params }) => { loadProject(user, params.id); return PLAN.roadmap(Number(params.id)); });

// ============ reports ============
R.get('/api/reports', ({ user, query }) => { if (user.role === 'guest') throw forbidden(); return report(user, query); });
R.get('/api/reports/export', ({ user, query }) => {
  if (user.role === 'guest') throw forbidden();
  const csv = exportCsv(user, query);
  return { __raw: { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="taskboard-${query.type === 'time' ? 'time' : 'tasks'}.csv"`, 'Cache-Control': 'no-store' }, body: '﻿' + csv } };
});


// ============ API tokens, webhooks, integrations, calendar, SSO, push, audit ============
R.get('/api/tokens', ({ user }) => TOK.listTokens(user.id));
R.post('/api/tokens', ({ user, body, req, via }) => { if (via === 'token') throw forbidden('Create tokens from the web app'); return TOK.createToken(user, body, req); });
R.del('/api/tokens/:id', ({ user, params, req }) => { TOK.revokeToken(user, Number(params.id), req); return { ok: true }; });

R.get('/api/webhook-meta', () => ({ events: WH.EVENTS, formats: WH.FORMATS, hook_kinds: HOOKS.KINDS }));
R.get('/api/projects/:id/webhooks', ({ user, params }) => WH.listWebhooks(user, Number(params.id)));
R.post('/api/projects/:id/webhooks', ({ user, params, body, req }) => WH.saveWebhook(user, { ...body, project_id: Number(params.id) }, req));
R.get('/api/admin/webhooks', ({ user }) => WH.listWebhooks(user, null));
R.post('/api/admin/webhooks', ({ user, body, req }) => WH.saveWebhook(user, { ...body, project_id: null }, req));
R.del('/api/webhooks/:id', ({ user, params }) => { WH.deleteWebhook(user, Number(params.id)); return { ok: true }; });
R.post('/api/webhooks/:id/test', async ({ user, params }) => WH.sendTest(user, Number(params.id)));
R.get('/api/webhooks/:id/deliveries', ({ user, params }) => WH.deliveries(user, Number(params.id)));

R.get('/api/projects/:id/hooks', ({ user, params }) => HOOKS.listHooks(user, Number(params.id)));
R.post('/api/projects/:id/hooks', ({ user, params, body, req }) => { const r = HOOKS.createHook(user, Number(params.id), body, req); return { ...r, url: baseUrl(req) + r.path }; });
R.del('/api/hooks/:id', ({ user, params }) => { HOOKS.deleteHook(user, Number(params.id)); return { ok: true }; });
R.post('/api/hooks/in/:token', ({ req, params, body, rawText }) => HOOKS.handleIncoming(params.token, req.headers, rawText, body), { public: true, webhook: true });

R.post('/api/hooks/slack', async ({ req, body, rawText }) => { SLACK.verifySlack(req.headers, rawText); return SLACK.handleSlash(body); }, { public: true, webhook: true });

R.get('/api/me/calendar', ({ user, req }) => ({ url: `${baseUrl(req)}/api/calendar/${ICS.ensureToken(user.id)}.ics` }));
R.post('/api/me/calendar/rotate', ({ user, req }) => ({ url: `${baseUrl(req)}/api/calendar/${ICS.rotateToken(user.id)}.ics` }));
R.get('/api/calendar/:token', ({ params, req, res }) => {
  const ics = ICS.buildCalendar(params.token.replace(/\.ics$/, ''), req.headers.host);
  if (!ics) throw notFound('Calendar not found');
  return { __raw: { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline; filename="taskboard.ics"' }, body: ics } };
}, { public: true });

R.get('/api/auth/sso/start', async ({ req, res }) => {
  const cfg = SSO.ssoConfig(baseUrl(req));
  if (!cfg) throw notFound('Single sign-on is not configured');
  const { url } = await SSO.startUrl(cfg);
  res.writeHead(302, { Location: url }); res.end();
  return undefined;
}, { public: true, stream: true });
R.get('/api/auth/sso/callback', async ({ req, res, query }) => {
  const back = msg => { res.writeHead(302, { Location: `/#/login?sso_error=${encodeURIComponent(msg)}` }); res.end(); };
  try {
    const cfg = SSO.ssoConfig(baseUrl(req));
    if (!cfg || query.error || !query.code) return back(query.error_description || query.error || 'Sign-in was cancelled');
    const ident = await SSO.finish(cfg, query.code, query.state);
    const u = SSO.userForSso(ident);
    audit(u, 'auth.sso_login', u.email, {}, req);
    res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(u.id, req.headers['x-forwarded-proto'] === 'https') }); res.end();
  } catch (e) { back(e.message); }
  return undefined;
}, { public: true, stream: true });

R.get('/api/push/key', () => ({ key: PUSH.vapidKeys().pub }));
R.post('/api/push/subscribe', ({ user, body }) => { PUSH.subscribe(user.id, body); return { ok: true }; });
R.post('/api/push/unsubscribe', ({ user, body }) => { PUSH.unsubscribe(user.id, body.endpoint); return { ok: true }; });
R.post('/api/push/test', async ({ user }) => ({ sent: await PUSH.pushTo(user.id, { title: 'TaskBoard', body: 'Push notifications are working 🎉', url: '/#/inbox' }) }));

R.get('/api/audit', ({ user, query }) => { needAdmin(user); return listAudit(query); });

// ============ notifications ============
R.get('/api/notifications', ({ user }) => ({
  items: all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60', user.id),
  unread: unreadCount(user.id),
}));
R.post('/api/notifications/read', ({ user, body }) => {
  if (body.id) run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', body.id, user.id); else markAllRead(user.id);
  return { unread: unreadCount(user.id) };
});

// ============ dashboard ============
R.get('/api/dashboard', ({ user, query }) => {
  let projects = visibleProjects(user);
  if (query.team_id) projects = projects.filter(p => p.team_id === Number(query.team_id));
  const focusId = query.user_id ? Number(query.user_id) : user.id;
  const ids = projects.map(p => p.id);
  const today = todayStr();
  const empty = { projects: [], mine: [], workload: [], velocity: [], totals: { open: 0, overdue: 0, done_week: 0, unassigned: 0 } };
  if (!ids.length) return empty;
  const list = ids.join(',');
  const open = get(`SELECT COUNT(*) n, SUM(due_date<?) od, SUM(assignee_id IS NULL) un FROM tasks WHERE project_id IN (${list}) AND status<>'done' AND parent_id IS NULL`, today);
  const doneWeek = get(`SELECT COUNT(*) n FROM tasks WHERE project_id IN (${list}) AND status='done' AND completed_at>=? AND parent_id IS NULL`, addDays(today, -7)).n;
  const velocity = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    velocity.push({ date: d, done: get(`SELECT COUNT(*) n FROM tasks WHERE project_id IN (${list}) AND status='done' AND substr(completed_at,1,10)=?`, d).n, created: get(`SELECT COUNT(*) n FROM tasks WHERE project_id IN (${list}) AND substr(created_at,1,10)=?`, d).n });
  }
  const workload = all(`SELECT u.id, u.name, u.color, COUNT(t.id) open, SUM(t.due_date<?) overdue, COALESCE(SUM(t.estimate),0) hours
    FROM users u JOIN tasks t ON t.assignee_id=u.id AND t.status<>'done' AND t.project_id IN (${list}) AND t.parent_id IS NULL
    WHERE u.active=1 GROUP BY u.id ORDER BY open DESC LIMIT 12`, today);
  return {
    totals: { open: open.n, overdue: open.od || 0, unassigned: open.un || 0, done_week: doneWeek },
    projects: projects.map(p => {
      const c = get(`SELECT COUNT(*) total, SUM(status='done') done, SUM(status='in_progress') doing, SUM(status<>'done' AND due_date<?) overdue FROM tasks WHERE project_id=? AND parent_id IS NULL`, today, p.id);
      return { id: p.id, key: p.key, name: p.name, color: p.color, team_name: p.team_name, total: c.total, done: c.done || 0, doing: c.doing || 0, overdue: c.overdue || 0 };
    }),
    mine: T.listAssigned(focusId).filter(t => t.status !== 'done' && ids.includes(t.project_id)).slice(0, 8),
    workload, velocity,
  };
});

// ============ automations ============
R.get('/api/automations', ({ user }) => ({
  triggers: TRIGGERS, actions: ACTIONS,
  rules: all('SELECT a.*, p.name AS project_name FROM automations a LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.id')
    .filter(r => !r.project_id || visibleProjects(user).some(p => p.id === r.project_id))
    .map(r => ({ ...r, conditions: parseJSON(r.conditions, {}), actions: parseJSON(r.actions, []), enabled: !!r.enabled })),
}));

function ruleInput(user, body) {
  if (!['admin', 'manager'].includes(user.role)) throw forbidden('Only admins and managers can edit automations');
  try { validateRule(body); } catch (e) { throw bad(e.message); }
  if (body.project_id && !canManageTeam(user, loadProject(user, body.project_id).team_id)) throw forbidden();
  if (!body.project_id && user.role !== 'admin') throw forbidden('Workspace-wide rules need an admin — pick a project');
  return [String(body.name || TRIGGERS[body.trigger]).slice(0, 80), body.project_id || null, body.trigger, JSON.stringify(body.conditions || {}), JSON.stringify(body.actions)];
}
R.post('/api/automations', ({ user, body }) => {
  const [name, pid, trigger, cond, actions] = ruleInput(user, body);
  return { id: insert('INSERT INTO automations(name,project_id,trigger,conditions,actions,created_by) VALUES(?,?,?,?,?,?)', name, pid, trigger, cond, actions, user.id) };
});
R.put('/api/automations/:id', ({ user, params, body }) => {
  const [name, pid, trigger, cond, actions] = ruleInput(user, body);
  run('UPDATE automations SET name=?, project_id=?, trigger=?, conditions=?, actions=?, enabled=? WHERE id=?', name, pid, trigger, cond, actions, body.enabled === false ? 0 : 1, params.id);
  return { ok: true };
});
R.patch('/api/automations/:id', ({ user, params, body }) => {
  if (!['admin', 'manager'].includes(user.role)) throw forbidden();
  run('UPDATE automations SET enabled=? WHERE id=?', body.enabled ? 1 : 0, params.id);
  return { ok: true };
});
R.del('/api/automations/:id', ({ user, params }) => {
  if (!['admin', 'manager'].includes(user.role)) throw forbidden();
  run('DELETE FROM automations WHERE id=?', params.id);
  return { ok: true };
});

// ============ AI ============
async function aiContext(user, projectId, today) {
  today = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : todayStr();
  let project = null, tasks, members;
  if (projectId) {
    project = loadProject(user, projectId);
    tasks = T.listProjectTasks(project.id);
    members = projectMembers(project);
  } else {
    const ps = visibleProjects(user);
    tasks = ps.flatMap(p => T.listProjectTasks(p.id));
    const seen = new Map();
    for (const p of ps) for (const m of projectMembers(p)) seen.set(m.id, m);
    members = [...seen.values()];
  }
  return { project, tasks, members, today, me: publicUser(user) };
}

R.post('/api/ai/parse', async ({ user, body }) => {
  needNotViewer(user);
  const c = await aiContext(user, body.project_id, body.today);
  return AI.parseTask(String(body.text || '').slice(0, 2000), c);
});
R.post('/api/ai/breakdown', async ({ user, body }) => {
  const t = T.taskDetail(user, Number(body.task_id));
  return AI.breakdown(t);
});
R.post('/api/ai/improve', async ({ user, body }) => AI.improveDescription(T.taskDetail(user, Number(body.task_id))));
R.post('/api/ai/suggest', async ({ user, body }) => {
  const t = T.taskDetail(user, Number(body.task_id));
  const c = await aiContext(user, t.project_id, body.today);
  const workload = {};
  for (const x of all(`SELECT assignee_id a, COUNT(*) n FROM tasks WHERE status<>'done' AND assignee_id IS NOT NULL GROUP BY assignee_id`)) workload[x.a] = x.n;
  return AI.suggest({ task: t, members: c.members, workload, today: c.today });
});
R.post('/api/ai/risks', async ({ user, body }) => AI.risks(await aiContext(user, body.project_id, body.today)));
R.post('/api/ai/summary', async ({ user, body }) => AI.summary(await aiContext(user, body.project_id, body.today)));
R.post('/api/ai/chat', async ({ user, body }) => {
  const c = await aiContext(user, body.project_id, body.today);
  return AI.chat({ ...c, message: String(body.message || '').slice(0, 2000), history: Array.isArray(body.history) ? body.history : [] });
});

// ============ admin utilities ============
R.post('/api/admin/run-scheduler', async ({ user }) => {
  needAdmin(user);
  return { reminders: runReminders(), digests: await runDigests(new Date(Date.now() + 0)), inbox: await pollInbox() };
});
