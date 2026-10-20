process.env.DB_FILE = ':memory:';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync('/tmp/tb-test-');
import test from 'node:test';
import assert from 'node:assert/strict';

const { server } = await import('../server/index.js');
const { runReminders } = await import('../server/scheduler.js');
const { localParseTask } = await import('../server/ai.js');
const { handleCommand } = await import('../server/commands.js');
const { all, get } = await import('../server/db.js');

await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

class Client {
  cookie = '';
  async req(method, path, body) {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  }
  get = p => this.req('GET', p);
  post = (p, b) => this.req('POST', p, b || {});
  patch = (p, b) => this.req('PATCH', p, b);
  put = (p, b) => this.req('PUT', p, b);
  del = p => this.req('DELETE', p);
}

const admin = new Client(), member = new Client(), viewer = new Client(), outsider = new Client();
let ids = {};

test.after(() => server.close());

test('setup creates admin with demo data and refuses a second setup', async () => {
  const boot = await admin.get('/api/bootstrap');
  assert.equal(boot.body.needs_setup, true);
  const r = await admin.post('/api/setup', { name: 'Ada Admin', email: 'ada@example.com', password: 'supersecret1', workspace: 'Acme', demo: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'admin');
  assert.equal((await admin.post('/api/setup', { name: 'x', email: 'x@y.zz', password: 'password123' })).status, 403);
  assert.equal((await admin.get('/api/bootstrap')).body.workspace, 'Acme');
});

test('auth: bad password, session required', async () => {
  assert.equal((await new Client().get('/api/projects')).status, 401);
  assert.equal((await new Client().post('/api/login', { email: 'ada@example.com', password: 'nope' })).status, 401);
  assert.equal((await member.post('/api/login', { email: 'marcus@demo.taskboard.dev', password: 'demo1234' })).status, 200);
  assert.equal((await viewer.post('/api/login', { email: 'dana@demo.taskboard.dev', password: 'demo1234' })).status, 200);
});

test('CSRF: non-JSON writes are rejected', async () => {
  const r = await fetch(base + '/api/logout', { method: 'POST', headers: { 'Content-Type': 'text/plain', cookie: admin.cookie }, body: 'x' });
  assert.equal(r.status, 415);
});

test('team-based visibility of projects', async () => {
  const adminProjects = (await admin.get('/api/projects')).body;
  const memberProjects = (await member.get('/api/projects')).body;
  assert.equal(adminProjects.length, 4);
  assert.deepEqual(memberProjects.map(p => p.key).sort(), ['API', 'OPS']); // Marcus is only on Platform
  ids.web = adminProjects.find(p => p.key === 'WEB').id;
  ids.api = adminProjects.find(p => p.key === 'API').id;
  assert.equal((await member.get(`/api/projects/${ids.web}/board`)).status, 404);
});

test('create / edit / move / delete tasks with permissions', async () => {
  const created = await member.post(`/api/projects/${ids.api}/tasks`, { title: 'Test task', priority: 'high', labels: ['Backend Team'] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.labels, ['backend-team']);
  const id = created.body.id;
  assert.match(created.body.key, /^API-\d+$/);

  const upd = await member.patch(`/api/tasks/${id}`, { status: 'in_progress', due_date: '2030-01-02' });
  assert.equal(upd.body.status, 'in_progress');
  assert.equal((await member.patch(`/api/tasks/${id}`, { status: 'nonsense' })).status, 400);
  assert.equal((await member.patch(`/api/tasks/${id}`, { due_date: 'tomorrow' })).status, 400);

  const detail = await member.get(`/api/tasks/${id}`);
  assert.ok(detail.body.activity.some(a => a.action === 'changed_status'));

  // viewers are read-only; outsiders can't see it at all
  assert.equal((await viewer.get(`/api/tasks/${id}`)).status, 403); // viewer is not on the Platform team
  const vProj = (await viewer.get('/api/projects')).body.find(p => p.key === 'WEB');
  const vTask = (await viewer.post(`/api/projects/${vProj.id}/tasks`, { title: 'nope' }));
  assert.equal(vTask.status, 403);
  assert.equal((await member.get(`/api/tasks/${(await admin.get(`/api/projects/${ids.web}/board`)).body.tasks[0].id}`)).status, 403);

  const moved = await member.post(`/api/tasks/${id}/move`, { status: 'done', index: 0 });
  assert.equal(moved.body.status, 'done');
  assert.ok(moved.body.completed_at);
  const board = (await member.get(`/api/projects/${ids.api}/board`)).body;
  const done = board.tasks.filter(t => t.status === 'done');
  assert.equal(done[0].id, id); // dropped at index 0

  assert.equal((await member.del(`/api/tasks/${id}`)).status, 200);
  assert.equal((await member.get(`/api/tasks/${id}`)).status, 404);
});

test('assignee must belong to the project team', async () => {
  const board = (await admin.get(`/api/projects/${ids.api}/board`)).body;
  const sofia = (await admin.get('/api/users')).body.find(u => u.name === 'Sofia Alvarez');
  const r = await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'x', assignee_id: sofia.id });
  assert.equal(r.status, 400);
  assert.ok(board.members.length >= 3);
});

test('comments @mention notifies mentioned user', async () => {
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  const task = (await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'Mention me' })).body;
  const before = (await member.get('/api/notifications')).body.unread;
  await admin.post(`/api/tasks/${task.id}/comments`, { body: 'Hey @marcus.lee please look' });
  const after = (await member.get('/api/notifications')).body;
  assert.equal(after.unread, before + 1);
  assert.equal(after.items[0].type, 'mention');
  assert.ok(marcus);
});

test('assigning logs an in-app notification and default automation moves todo -> in_progress', async () => {
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  const task = (await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'Auto start', status: 'todo' })).body;
  const r = await admin.patch(`/api/tasks/${task.id}`, { assignee_id: marcus.id });
  assert.equal(r.body.status, 'in_progress'); // "Start work when assigned" rule
  const notes = (await member.get('/api/notifications')).body.items;
  assert.ok(notes.some(n => n.type === 'assigned' && n.task_id === task.id));
});

test('reminders fire once and trigger overdue automation (label + lead notification)', async () => {
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  const t = (await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'Late one', assignee_id: marcus.id, due_date: '2020-01-01', status: 'backlog' })).body;
  const n1 = runReminders();
  assert.ok(n1 >= 1);
  assert.equal(runReminders(), 0);
  const detail = (await admin.get(`/api/tasks/${t.id}`)).body;
  assert.ok(detail.labels.includes('overdue'));
  assert.ok(all('SELECT * FROM outbox').some(o => o.channel === 'email' && o.status === 'simulated'));
});

test('team & role management is admin/lead gated', async () => {
  assert.equal((await member.post('/api/users', { name: 'N', email: 'n@x.io' })).status, 403);
  const inv = await admin.post('/api/users', { name: 'New Hire', email: 'new@example.com', role: 'member' });
  assert.equal(inv.status, 200);
  const token = inv.body.invite_link.split('/invite/')[1];
  assert.equal((await new Client().get(`/api/invite/${token}`)).body.email, 'new@example.com');
  const nh = new Client();
  assert.equal((await nh.post(`/api/invite/${token}`, { password: 'welcome123' })).status, 200);
  assert.equal((await nh.get('/api/projects')).body.length, 0); // no team yet -> no projects
  const teams = (await admin.get('/api/teams')).body;
  assert.equal((await admin.put(`/api/teams/${teams[0].id}/members/${inv.body.id}`, { role: 'member' })).status, 200);
  assert.ok((await nh.get('/api/projects')).body.length > 0);
  assert.equal((await member.patch(`/api/users/${inv.body.id}`, { role: 'admin' })).status, 403);
  assert.equal((await admin.patch(`/api/users/${inv.body.id}`, { role: 'viewer' })).body.role, 'viewer');
  // last admin can't be demoted
  const me = (await admin.get('/api/me')).body;
  assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'member' })).status, 400);
  void outsider;
});

test('notification prefs persist; phone verify flow (simulated provider)', async () => {
  const r = await member.put('/api/me/prefs', { matrix: { comment: { app: true, email: true, phone: false } }, digest_hour: 7 });
  assert.equal(r.body.prefs.matrix.comment.email, true);
  assert.equal(r.body.prefs.digest_hour, 7);
  assert.equal((await member.post('/api/me/phone', { phone: 'abc' })).status, 400);
  const p = await member.post('/api/me/phone', { phone: '+1 (415) 555-0123' });
  assert.equal(p.body.simulated, true);
  const code = get('SELECT phone_code FROM users WHERE email=?', 'marcus@demo.taskboard.dev').phone_code;
  assert.equal((await member.post('/api/me/phone/verify', { code: '000000' })).status, 400);
  const v = await member.post('/api/me/phone/verify', { code });
  assert.equal(v.body.phone_verified, true);
});

test('twilio webhook rejects unsigned requests', async () => {
  const r = await fetch(base + '/api/webhooks/twilio', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'From=%2B14155550123&Body=list' });
  assert.equal(r.status, 403);
});

test('SMS commands: list / start / done / add', async () => {
  const marcus = get('SELECT * FROM users WHERE email=?', 'marcus@demo.taskboard.dev');
  assert.match(await handleCommand(marcus, 'list'), /Your open tasks/);
  const t = get(`SELECT t.number FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.key='API' AND t.assignee_id=? AND t.status='in_progress' LIMIT 1`, marcus.id);
  assert.match(await handleCommand(marcus, `done api-${t.number}`), /→ done/);
  assert.match(await handleCommand(marcus, 'add fix flaky login test tomorrow !high'), /Created API-\d+/);
  assert.match(await handleCommand(marcus, 'done nope-1'), /couldn't find/);
  assert.match(await handleCommand(marcus, 'gibberish'), /commands/);
});

test('AI (local mode): parse, breakdown, risks, summary, chat', async () => {
  const today = '2026-10-20'; // Tuesday
  const members = [{ id: 7, name: 'Priya Nair' }, { id: 8, name: 'Marcus Lee' }];
  const p = localParseTask('Fix login redirect bug by friday @marcus.lee #auth #bug urgent 3h', { members, today });
  assert.equal(p.title, 'Fix login redirect bug');
  assert.equal(p.priority, 'urgent');
  assert.equal(p.assignee_id, 8);
  assert.equal(p.due_date, '2026-10-23');
  assert.deepEqual(p.labels, ['auth', 'bug']);
  assert.equal(p.estimate, 3);
  assert.equal(localParseTask('write docs tomorrow', { members, today }).due_date, '2026-10-21');
  assert.equal(localParseTask('plan sprint in 2 weeks', { members, today }).due_date, '2026-11-03');

  const t = (await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'Big feature' })).body;
  assert.ok((await admin.post('/api/ai/breakdown', { task_id: t.id })).body.subtasks.length >= 3);
  const risks = (await admin.post('/api/ai/risks', { project_id: ids.api })).body;
  assert.ok(Array.isArray(risks.risks));
  assert.match((await admin.post('/api/ai/summary', { project_id: ids.api })).body.text, /status for/);
  const c = (await admin.post('/api/ai/chat', { message: 'create review pull requests tomorrow', project_id: ids.api })).body;
  assert.equal(c.type, 'create');
  assert.equal(c.draft.title, 'Review pull requests');
  const sg = (await admin.post('/api/ai/suggest', { task_id: t.id })).body;
  assert.ok(sg.assignee_id);
});

test('subtasks + dashboard + search', async () => {
  const t = (await admin.post(`/api/projects/${ids.api}/tasks`, { title: 'Parent' })).body;
  const subs = (await admin.post(`/api/tasks/${t.id}/subtasks`, { titles: ['a', 'b'] })).body;
  assert.equal(subs.length, 2);
  const d = (await admin.get(`/api/tasks/${t.id}`)).body;
  assert.equal(d.subtasks.length, 2);
  assert.equal((await admin.get(`/api/projects/${ids.api}/board`)).body.tasks.find(x => x.id === t.id).subtask_total, 2);
  const dash = (await admin.get('/api/dashboard')).body;
  assert.ok(dash.totals.open > 0 && dash.velocity.length === 14 && dash.projects.length === 4);
  const s = (await admin.get('/api/search?q=rate')).body;
  assert.ok(s.some(x => /rate limiting/i.test(x.title)));
  assert.ok((await admin.get(`/api/search?q=${encodeURIComponent(t.key)}`)).body.some(x => x.id === t.id));
});

test('admin settings mask secrets', async () => {
  assert.equal((await member.get('/api/settings')).status, 403);
  await admin.put('/api/settings', { anthropic_api_key: 'sk-ant-secret', google_client_id: 'abc' });
  const s = (await admin.get('/api/settings')).body.values;
  assert.deepEqual(s.anthropic_api_key, { set: true, from_env: false });
  assert.equal(s.google_client_id, 'abc');
  await admin.put('/api/settings', { anthropic_api_key: '__clear__' });
});
