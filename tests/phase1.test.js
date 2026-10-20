import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const t = await boot();
const { admin, member, viewer, manager, ids, Client, base } = t;
test.after(() => t.server.close());
const mk = (c, pid, body) => c.post(`/api/projects/${pid}/tasks`, body);

test('custom columns: rename/add/WIP, validation and task migration on removal', async () => {
  const p = (await admin.get(`/api/projects/${ids.api}/board`)).body.project;
  const cols = p.statuses.map(s => s.id === 'review' ? { ...s, label: 'QA', wip: 2 } : s);
  cols.splice(3, 0, { id: 'c_blocked', label: 'Blocked', category: 'doing' });
  const r = await admin.patch(`/api/projects/${ids.api}`, { statuses: cols });
  assert.equal(r.status, 200);
  assert.equal(r.body.statuses.find(s => s.id === 'review').label, 'QA');
  assert.equal(r.body.statuses.find(s => s.id === 'review').wip, 2);
  // task can use the new column; label is resolved server-side
  const task = (await mk(admin, ids.api, { title: 'Stuck', status: 'c_blocked' })).body;
  assert.equal(task.status_label, 'Blocked');
  assert.equal((await mk(admin, ids.api, { title: 'x', status: 'nope' })).status, 400);
  // can't drop a column that has tasks, unless tasks are moved
  const without = cols.filter(s => s.id !== 'c_blocked');
  assert.equal((await admin.patch(`/api/projects/${ids.api}`, { statuses: without })).status, 400);
  assert.equal((await admin.patch(`/api/projects/${ids.api}`, { statuses: without, move_tasks_to: 'todo' })).status, 200);
  assert.equal((await admin.get(`/api/tasks/${task.id}`)).body.status, 'todo');
  // Done must remain
  assert.equal((await admin.patch(`/api/projects/${ids.api}`, { statuses: cols.filter(s => s.id !== 'done') })).status, 400);
  // members can't change columns
  assert.equal((await member.patch(`/api/projects/${ids.api}`, { statuses: cols })).status, 403);
});

test('per-project roles and guest access', async () => {
  const web = ids.web;
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  assert.equal((await member.get(`/api/projects/${web}/board`)).status, 404);
  // grant Marcus viewer on WEB (outside his team)
  assert.equal((await manager.put(`/api/projects/${web}/members/${marcus.id}`, { role: 'viewer' })).status, 200);
  assert.equal((await member.get(`/api/projects/${web}/board`)).status, 200);
  assert.equal((await mk(member, web, { title: 'nope' })).status, 403);
  await manager.put(`/api/projects/${web}/members/${marcus.id}`, { role: 'editor' });
  assert.equal((await mk(member, web, { title: 'now allowed' })).status, 200);
  // restricting a team member: Priya's team member Sofia -> viewer on WEB
  const sofia = (await admin.get('/api/users')).body.find(u => u.name === 'Sofia Alvarez');
  await manager.put(`/api/projects/${web}/members/${sofia.id}`, { role: 'viewer' });
  const sofiaC = new Client(); await sofiaC.post('/api/login', { email: 'sofia@demo.taskboard.dev', password: 'demo1234' });
  assert.equal((await mk(sofiaC, web, { title: 'blocked' })).status, 403);
  // member cannot manage access
  assert.equal((await member.put(`/api/projects/${web}/members/${sofia.id}`, { role: 'editor' })).status, 403);

  // guest (client): invited with project access only
  const inv = await admin.post('/api/users', { name: 'Client Co', email: 'client@acme.io', role: 'guest', project_ids: [web] });
  assert.equal(inv.status, 200);
  const guest = new Client();
  await guest.post(`/api/invite/${inv.body.invite_link.split('/invite/')[1]}`, { password: 'clientpass1' });
  const gp = (await guest.get('/api/projects')).body;
  assert.deepEqual(gp.map(p => p.key), ['WEB']);
  assert.equal((await guest.get('/api/teams')).body.length, 0);
  const task = (await admin.get(`/api/projects/${web}/board`)).body.tasks[0];
  assert.equal((await guest.post(`/api/tasks/${task.id}/comments`, { body: 'Looks good!' })).status, 200);
  assert.equal((await guest.patch(`/api/tasks/${task.id}`, { title: 'edit' })).status, 403);
  assert.equal((await mk(guest, web, { title: 'req' })).status, 403);
  assert.equal((await guest.get(`/api/projects/${ids.api}/board`)).status, 404);
  assert.ok((await guest.get('/api/users')).body.length < (await admin.get('/api/users')).body.length);
});

test('custom fields: typed validation', async () => {
  const f = await admin.patch(`/api/projects/${ids.ops}`, { fields: [
    { label: 'Story points', type: 'number' }, { label: 'Env', type: 'select', options: ['prod', 'staging'] }, { label: 'Needs QA', type: 'checkbox' }] });
  assert.deepEqual(f.body.fields.map(x => x.id), ['story_points', 'env', 'needs_qa']);
  const task = (await mk(admin, ids.ops, { title: 'cf', custom: { story_points: 5, env: 'prod' } })).body;
  assert.equal(task.custom.story_points, 5);
  assert.equal((await admin.patch(`/api/tasks/${task.id}`, { custom: { env: 'moon' } })).status, 400);
  assert.equal((await admin.patch(`/api/tasks/${task.id}`, { custom: { story_points: 'abc' } })).status, 400);
  const u = await admin.patch(`/api/tasks/${task.id}`, { custom: { needs_qa: true, story_points: null } });
  assert.deepEqual(u.body.custom, { env: 'prod', needs_qa: true });
  // unknown keys are ignored, not stored
  assert.deepEqual((await admin.patch(`/api/tasks/${task.id}`, { custom: { hacker: 1 } })).body.custom, { env: 'prod', needs_qa: true });
});

test('bulk update/delete respects per-task permissions', async () => {
  const a = (await mk(member, ids.api, { title: 'b1' })).body, b = (await mk(member, ids.api, { title: 'b2' })).body;
  const r = await member.post('/api/tasks/bulk', { ids: [a.id, b.id], patch: { priority: 'urgent', labels: ['bulk'] } });
  assert.equal(r.body.ok, 2);
  assert.equal((await admin.get(`/api/tasks/${a.id}`)).body.priority, 'urgent');
  // viewer cannot
  const webTask = (await admin.get(`/api/projects/${ids.web}/board`)).body.tasks[0];
  const vr = await viewer.post('/api/tasks/bulk', { ids: [webTask.id], patch: { priority: 'low' } });
  assert.equal(vr.body.ok, 0); assert.equal(vr.body.failed.length, 1);
  const d = await member.post('/api/tasks/bulk', { ids: [a.id, b.id], delete: true });
  assert.equal(d.body.ok, 2);
});

test('dependencies: blocked flag, cycle prevention, removal', async () => {
  const a = (await mk(admin, ids.api, { title: 'A' })).body, b = (await mk(admin, ids.api, { title: 'B' })).body, c = (await mk(admin, ids.api, { title: 'C' })).body;
  assert.equal((await admin.post(`/api/tasks/${b.id}/blockers`, { blocker_id: a.id })).status, 200); // A blocks B
  assert.equal((await admin.post(`/api/tasks/${c.id}/blockers`, { blocker_id: b.id })).status, 200); // B blocks C
  assert.equal((await admin.post(`/api/tasks/${a.id}/blockers`, { blocker_id: c.id })).status, 400); // C blocks A -> cycle
  assert.equal((await admin.post(`/api/tasks/${a.id}/blockers`, { blocker_id: a.id })).status, 400);
  const bd = (await admin.get(`/api/tasks/${b.id}`)).body;
  assert.equal(bd.links.blocked_by[0].id, a.id); assert.equal(bd.links.blocks[0].id, c.id);
  assert.equal(bd.blocked_by_open, 1);
  await admin.patch(`/api/tasks/${a.id}`, { status: 'done' });
  assert.equal((await admin.get(`/api/tasks/${b.id}`)).body.blocked_by_open, 0);
  assert.equal((await admin.del(`/api/tasks/${b.id}/blockers/${a.id}`)).body.blocked_by.length, 0);
});

test('time tracking: manual log, timer start/stop, one running timer', async () => {
  const a = (await mk(member, ids.api, { title: 'T1' })).body, b = (await mk(member, ids.api, { title: 'T2' })).body;
  assert.equal((await member.post(`/api/tasks/${a.id}/time`, { minutes: 90, note: 'pairing' })).status, 200);
  assert.equal((await member.post(`/api/tasks/${a.id}/time`, { minutes: 0 })).status, 400);
  await member.post(`/api/tasks/${a.id}/timer/start`);
  assert.equal((await member.get('/api/timer')).body.task_id, a.id);
  await member.post(`/api/tasks/${b.id}/timer/start`); // stops first
  assert.equal((await member.get('/api/timer')).body.task_id, b.id);
  const ta = (await member.get(`/api/tasks/${a.id}/time`)).body;
  assert.equal(ta.entries.filter(e => e.running).length, 0);
  assert.ok(ta.total >= 5400);
  assert.equal((await member.post('/api/timer/stop')).body.stopped, 1);
  assert.ok([403, 404].includes((await viewer.post(`/api/tasks/${a.id}/time`, { minutes: 5 })).status));
  assert.ok((await admin.get(`/api/tasks/${a.id}`)).body.time_spent >= 5400);
});

test('attachments: upload, download with safe headers, permissions, delete', async () => {
  const task = (await mk(member, ids.api, { title: 'with files' })).body;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await member.req('POST', `/api/tasks/${task.id}/attachments`, png, { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('shot ../x.png') });
  assert.equal(up.status, 200);
  assert.ok(!up.body.name.includes('/'));
  const dl = await member.get(`/api/attachments/${up.body.id}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.deepEqual(dl.body, png);
  // html is forced to download, never rendered
  const html = (await member.req('POST', `/api/tasks/${task.id}/attachments`, Buffer.from('<script>alert(1)</script>'), { 'Content-Type': 'text/html', 'X-Filename': 'x.html' })).body;
  const hd = await member.get(`/api/attachments/${html.id}`);
  assert.equal(hd.headers.get('content-type'), 'application/octet-stream');
  assert.match(hd.headers.get('content-disposition'), /^attachment/);
  // missing header (CSRF-style simple request) rejected; outsiders can't read
  const noHdr = await fetch(base + `/api/tasks/${task.id}/attachments`, { method: 'POST', headers: { cookie: member.cookie, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(noHdr.status, 400);
  assert.equal((await viewer.get(`/api/attachments/${up.body.id}`)).status, 403);
  assert.equal((await admin.get(`/api/tasks/${task.id}`)).body.attachments.length, 2);
  assert.equal((await member.del(`/api/attachments/${up.body.id}`)).status, 200);
});

test('templates + recurring tasks + saved views', async () => {
  const tpl = await manager.post(`/api/projects/${ids.api}/templates`, { name: 'Release checklist', data: { title: 'Cut release', priority: 'high', labels: ['release'], subtasks: ['Tag', 'Deploy', 'Announce'], due_in_days: 2 } });
  assert.equal(tpl.status, 200);
  const made = (await member.post(`/api/projects/${ids.api}/templates/${tpl.body.id}/use`, {})).body;
  assert.equal(made.title, 'Cut release'); assert.equal(made.priority, 'high'); assert.ok(made.due_date);
  assert.equal((await admin.get(`/api/tasks/${made.id}`)).body.subtasks.length, 3);

  assert.equal((await manager.post(`/api/projects/${ids.api}/recurrences`, { data: { title: 'x' }, schedule: 'yearly' })).status, 400);
  const rec = await manager.post(`/api/projects/${ids.api}/recurrences`, { name: 'Weekly sync notes', data: { title: 'Sync notes' }, schedule: 'daily', start: '2020-01-01' });
  assert.equal(rec.status, 200);
  const { runRecurrences, nextRun } = await import('../server/recurring.js');
  assert.equal(runRecurrences(), 1);
  assert.equal(runRecurrences(), 0); // next_run moved forward
  assert.equal(nextRun('weekly:1', '2026-10-20'), '2026-10-26'); // next Monday after a Tuesday
  assert.equal(nextRun('monthly:15', '2026-10-20'), '2026-11-15');
  assert.equal(nextRun('weekdays', '2026-10-23'), '2026-10-26'); // Fri -> Mon

  const v = await member.post(`/api/projects/${ids.api}/views`, { name: 'My urgent', filters: { assignee: 'me', priority: 'urgent' } });
  assert.equal(v.status, 200);
  const board = (await member.get(`/api/projects/${ids.api}/board`)).body;
  assert.equal(board.views[0].name, 'My urgent'); assert.equal(board.views[0].mine, true);
  assert.equal((await manager.get(`/api/projects/${ids.api}/board`)).body.views.length, 0); // private
  assert.equal((await manager.del(`/api/views/${v.body.id}`)).status, 404);
});

test('epics, sprint/release validation', async () => {
  const epic = (await mk(admin, ids.api, { title: 'Big epic', type: 'epic' })).body;
  const child = (await mk(admin, ids.api, { title: 'child', epic_id: epic.id })).body;
  assert.equal((await mk(admin, ids.api, { title: 'bad', epic_id: child.id })).status, 400); // only epics
  assert.equal((await admin.get(`/api/tasks/${epic.id}`)).body.children.length, 1);
  assert.equal((await admin.patch(`/api/tasks/${child.id}`, { sprint_id: 9999 })).status, 400);
  assert.equal((await admin.patch(`/api/tasks/${child.id}`, { start_date: '2026-10-10', due_date: '2026-10-01' })).status, 400);
});
