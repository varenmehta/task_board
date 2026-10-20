import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const t = await boot();
const { admin, member, manager, viewer, ids } = t;
test.after(() => t.server.close());
const mk = (c, pid, body) => c.post(`/api/projects/${pid}/tasks`, body).then(r => r.body);

test('sprint lifecycle: plan → start → burndown → complete with carry-over', async () => {
  assert.equal((await member.post(`/api/projects/${ids.api}/sprints`, { name: 'S1' })).status, 403);
  const s1 = (await manager.post(`/api/projects/${ids.api}/sprints`, { name: 'Sprint 1', goal: 'Ship rate limits' })).body.id;
  const s2 = (await manager.post(`/api/projects/${ids.api}/sprints`, { name: 'Sprint 2' })).body.id;
  const a = await mk(admin, ids.api, { title: 'a', estimate: 4, sprint_id: s1 });
  const b = await mk(admin, ids.api, { title: 'b', estimate: 6, sprint_id: s1 });
  assert.equal((await manager.post(`/api/sprints/${s1}/start`)).status, 200);
  assert.equal((await manager.post(`/api/sprints/${s2}/start`)).status, 400); // only one active
  await admin.patch(`/api/tasks/${a.id}`, { status: 'done' });
  let sp = (await member.get(`/api/projects/${ids.api}/sprints`)).body.sprints.find(s => s.id === s1);
  assert.equal(sp.state, 'active'); assert.equal(sp.total, 10); assert.equal(sp.remaining, 6); assert.equal(sp.done_tasks, 1);
  assert.equal(sp.unit, 'hours');
  assert.ok(sp.burndown.length >= 15);
  assert.equal(sp.burndown.find(d => d.actual != null && d.day === new Date().toISOString().slice(0, 10)).actual, 6);
  // scope creep updates total
  await mk(admin, ids.api, { title: 'late add', estimate: 2, sprint_id: s1 });
  sp = (await admin.get(`/api/projects/${ids.api}/sprints`)).body.sprints.find(s => s.id === s1);
  assert.equal(sp.total, 12);
  // closed sprints can't receive tasks; incomplete tasks move to chosen sprint
  const closed = await manager.post(`/api/sprints/${s1}/close`, { move_to: String(s2) });
  assert.equal(closed.body.moved, 2); assert.equal(closed.body.completed, 1);
  assert.equal((await admin.get(`/api/tasks/${b.id}`)).body.sprint_id, s2);
  assert.equal((await admin.patch(`/api/tasks/${b.id}`, { sprint_id: s1 })).status, 400);
  const list = (await admin.get(`/api/projects/${ids.api}/sprints`)).body;
  assert.equal(list.velocity, 4); assert.equal(list.velocity_unit, 'hours');
});

test('releases: link tasks, generate notes, ship', async () => {
  const rel = (await manager.post(`/api/projects/${ids.api}/releases`, { name: 'Spring', version: 'v2.1', date: '2026-11-01' })).body.id;
  await mk(admin, ids.api, { title: 'Add rate limiting', type: 'story', status: 'done', release_id: rel });
  await mk(admin, ids.api, { title: 'Fix duplicate pagination rows', type: 'bug', status: 'done', release_id: rel });
  await mk(admin, ids.api, { title: 'Still open', type: 'task', release_id: rel });
  const n = (await member.post(`/api/releases/${rel}/notes`)).body;
  assert.match(n.notes, /## Spring — v2\.1/);
  assert.match(n.notes, /### 🐛 Fixes\n- Fix duplicate pagination rows/);
  assert.match(n.notes, /1 planned item/);
  assert.equal((await member.post(`/api/releases/${rel}/ship`)).status, 403);
  assert.equal((await manager.post(`/api/releases/${rel}/ship`)).status, 200);
  const rels = (await admin.get(`/api/projects/${ids.api}/releases`)).body;
  assert.equal(rels[0].state, 'released'); assert.equal(rels[0].total, 3); assert.equal(rels[0].done, 2);
  assert.equal((await manager.patch(`/api/releases/${rel}`, { notes: n.notes })).status, 200);
});

test('roadmap shows epic progress and spans', async () => {
  const epic = await mk(admin, ids.web, { title: 'Onboarding revamp', type: 'epic', start_date: '2026-10-01', due_date: '2026-11-30' });
  await mk(admin, ids.web, { title: 'k1', epic_id: epic.id, status: 'done' });
  await mk(admin, ids.web, { title: 'k2', epic_id: epic.id });
  const r = (await admin.get(`/api/projects/${ids.web}/roadmap`)).body;
  assert.deepEqual([r[0].total, r[0].done, r[0].start, r[0].end], [2, 1, '2026-10-01', '2026-11-30']);
  assert.equal((await admin.get(`/api/tasks/${epic.id}`)).body.epic_total, 2);
});

test('reports: aggregates, scoping, CSV export without formula injection', async () => {
  await member.post(`/api/tasks/${(await mk(member, ids.api, { title: '=HYPERLINK("http://evil","x")', status: 'done' })).id}/time`, { minutes: 30 });
  const r = (await admin.get('/api/reports')).body;
  assert.ok(r.summary.completed >= 3);
  assert.ok(r.people.some(p => p.name === 'Marcus Lee' || p.name === 'Unassigned'));
  assert.ok(r.summary.hours_logged >= 0.5);
  assert.ok(r.weekly.length >= 1);
  assert.equal((await viewer.get('/api/reports')).status, 200);
  // a member only sees their own projects' data
  const mine = (await member.get('/api/reports')).body;
  assert.ok(mine.project_ids.every(id => [ids.api, ids.ops].includes(id)));
  const csv = await admin.get('/api/reports/export?type=tasks');
  const text = csv.body.toString();
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(text.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), 'formula neutralised');
  assert.ok(!/^=HYPERLINK/m.test(text));
  const time = (await admin.get('/api/reports/export?type=time')).body.toString();
  assert.match(time, /Hours/);
});

test('dashboard can be scoped to a team and a person', async () => {
  const all = (await admin.get('/api/dashboard')).body;
  const teams = (await admin.get('/api/teams')).body;
  const platform = teams.find(x => x.name === 'Platform');
  const scoped = (await admin.get(`/api/dashboard?team_id=${platform.id}`)).body;
  assert.ok(scoped.projects.length < all.projects.length);
  assert.ok(scoped.projects.every(p => ['API', 'OPS'].includes(p.key)));
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  const person = (await admin.get(`/api/dashboard?user_id=${marcus.id}`)).body;
  assert.ok(person.mine.every(x => x.assignee_id === marcus.id));
});
