import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

const t = await boot();
const { admin, member, manager, viewer, ids } = t;
test.after(() => t.server.close());
const mk = (c, pid, body) => c.post(`/api/projects/${pid}/tasks`, body).then(r => r.body);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { all, get } = await import('../server/db.js');

test('auto-triage: only for opted-in projects and only when the author left defaults', async () => {
  await manager.patch(`/api/projects/${ids.api}`, { auto_triage: true });
  const bug = await mk(member, ids.api, { title: 'Checkout crashes with a 500 error for customers' });
  await sleep(250);
  const d = (await admin.get(`/api/tasks/${bug.id}`)).body;
  assert.equal(d.priority, 'high'); assert.ok(d.labels.includes('bug')); assert.equal(d.type, 'bug'); assert.ok(d.assignee_id);
  assert.ok(d.comments.some(c => /Auto-triage/.test(c.body) && /rule-based/.test(c.body)));
  // author already chose a priority → untouched
  const chosen = await mk(member, ids.api, { title: 'Crash in prod outage', priority: 'low' });
  await sleep(200);
  assert.equal((await admin.get(`/api/tasks/${chosen.id}`)).body.priority, 'low');
  // opted-out project → untouched
  const other = await mk(admin, ids.ops, { title: 'Checkout crashes with a 500 error' });
  await sleep(200);
  assert.equal((await admin.get(`/api/tasks/${other.id}`)).body.priority, 'medium');
});

test('duplicate detection ranks similar open tasks', async () => {
  await mk(admin, ids.web, { title: 'Fix Safari date picker misalignment bug' });
  const r = (await admin.post('/api/ai/duplicates', { project_id: ids.web, title: 'Safari date-picker is misaligned' })).body.matches;
  assert.ok(r.length >= 1 && /Safari/.test(r[0].title) && r[0].score >= 0.5, JSON.stringify(r));
  assert.equal((await admin.post('/api/ai/duplicates', { project_id: ids.web, title: 'Quarterly budget planning workshop' })).body.matches.length, 0);
});

test('meeting notes → tasks (offline extractor)', async () => {
  const notes = `Weekly sync\n- Discussed roadmap, nothing to do\n- TODO: Update the onboarding checklist by friday\nAction: @marcus.lee to fix pagination bug !high\n- [ ] Write release notes tomorrow\nPriya will review the OpenAPI spec\nRandom chatter about lunch`;
  const r = (await member.post('/api/ai/extract', { project_id: ids.api, text: notes, today: '2026-10-20' })).body;
  const titles = r.tasks.map(x => x.title);
  assert.equal(r.tasks.length, 4, JSON.stringify(titles));
  assert.ok(titles.some(x => /onboarding checklist/i.test(x)));
  const pag = r.tasks.find(x => /pagination/i.test(x.title));
  assert.equal(pag.priority, 'high'); assert.ok(pag.assignee_id);
  assert.equal(r.tasks.find(x => /release notes/i.test(x.title)).due_date, '2026-10-21');
  assert.equal((await viewer.post('/api/ai/extract', { project_id: ids.web, text: 'TODO: x' })).status, 403);
});

test('natural-language search across visible projects', async () => {
  const run = async q => (await member.post('/api/ai/search', { query: q, today: new Date().toISOString().slice(0, 10) })).body;
  const mine = await run('my open tasks');
  assert.ok(mine.tasks.length > 0 && mine.explain.includes('assigned to you'));
  const urgent = await run('urgent bugs that are not done');
  assert.ok(urgent.tasks.every(x => x.priority === 'urgent' && x.type === 'bug' && x.status !== 'done'));
  const done = await run('what did Marcus ship in the last 30 days');
  assert.ok(done.filter.assignee_ids?.length === 1);
  const overdue = await run('overdue tasks');
  assert.ok(overdue.tasks.every(x => x.due_date < new Date().toISOString().slice(0, 10)) && overdue.tasks.length >= 1);
  const text = await run('pagination');
  assert.ok(text.tasks.some(x => /pagination/i.test(x.title)));
  // never leaks projects the user can't see
  const web = await run('safari date picker');
  assert.equal(web.tasks.length, 0);
  assert.ok((await admin.post('/api/ai/search', { query: 'safari date picker' })).body.tasks.length >= 1);
  const { localFilter } = await import('../server/ai.js');
  const f = localFilter('high priority bugs unassigned due this week #payments', { members: [], me: { id: 1 }, today: '2026-10-21' }).filter;
  assert.deepEqual([f.priority, f.type, f.unassigned, f.due_from, f.due_to, f.labels], ['high', 'bug', true, '2026-10-21', '2026-10-25', ['payments']]);
});

test('capacity: time off reduces weekly capacity; sprint plan respects it', async () => {
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  const today = new Date().toISOString().slice(0, 10);
  const monday = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const rep0 = (await member.get(`/api/capacity?from=${monday}&weeks=2`)).body;
  const base = rep0.people.find(p => p.name === 'Marcus Lee').weeks[0].capacity;
  assert.equal(base, 30);
  assert.equal((await member.post('/api/time-off', { user_id: marcus.id, start_date: monday, end_date: monday, kind: 'vacation' })).status, 200);
  assert.equal((await member.post('/api/time-off', { user_id: marcus.id + 1, start_date: monday, end_date: monday })).status, 403); // can't book others' leave
  assert.equal((await member.post('/api/time-off', { start_date: monday, end_date: '2000-01-01' })).status, 400);
  const rep = (await member.get(`/api/capacity?from=${monday}&weeks=2`)).body;
  const cell = rep.people.find(p => p.name === 'Marcus Lee').weeks[0];
  assert.equal(cell.off_days, 1); assert.equal(cell.capacity, 24);
  assert.ok(rep.time_off.length >= 1);
  assert.equal((await t.viewer.get('/api/capacity')).status, 200);

  const sp = (await manager.post(`/api/projects/${ids.api}/sprints`, { name: 'Plan me', start_date: monday, end_date: (() => { const d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); })() })).body.id;
  for (const [title, est, pr] of [['A', 8, 'urgent'], ['B', 8, 'high'], ['C', 8, 'medium'], ['D', 40, 'low']]) await mk(admin, ids.api, { title: 'plan ' + title, estimate: est, priority: pr });
  const plan = (await manager.post('/api/ai/sprint-plan', { project_id: ids.api, sprint_id: sp })).body;
  assert.ok(plan.capacity > 0 && plan.planned <= plan.budget + 0.001);
  assert.ok(!plan.picks.some(p => p.title === 'plan D')); // doesn't fit
  assert.ok(plan.picks.findIndex(p => p.title === 'plan A') < plan.picks.findIndex(p => p.title === 'plan B') || !plan.picks.some(p => p.title === 'plan B'));
  assert.equal((await member.post('/api/ai/sprint-plan', { project_id: ids.api, sprint_id: sp })).status, 200);
  assert.equal((await viewer.post('/api/ai/sprint-plan', { project_id: ids.web, sprint_id: sp })).status, 403);
  // blocked tasks are never suggested
  const blocker = await mk(admin, ids.api, { title: 'plan blocker', estimate: 1 });
  const blocked = await mk(admin, ids.api, { title: 'plan blocked', estimate: 1, priority: 'urgent' });
  await admin.post(`/api/tasks/${blocked.id}/blockers`, { blocker_id: blocker.id });
  assert.ok(!(await manager.post('/api/ai/sprint-plan', { project_id: ids.api, sprint_id: sp })).body.picks.some(p => p.title === 'plan blocked'));
});

test('estimate calibration compares logged time with estimates', async () => {
  const marcus = (await admin.get('/api/users')).body.find(u => u.name === 'Marcus Lee');
  for (let i = 0; i < 3; i++) {
    const task = await mk(admin, ids.api, { title: 'cal ' + i, estimate: 2, assignee_id: marcus.id });
    await member.post(`/api/tasks/${task.id}/time`, { hours: 4 }); // 2× the estimate
    await admin.patch(`/api/tasks/${task.id}`, { status: 'done' });
  }
  const { calibration } = await import('../server/capacity.js');
  assert.deepEqual(calibration(marcus.id), { factor: 2, samples: 3 });
  const target = await mk(admin, ids.api, { title: 'needs estimate', assignee_id: marcus.id });
  const s = (await admin.post('/api/ai/suggest', { task_id: target.id })).body;
  assert.match(s.calibration || '', /2×/);
  assert.ok(s.calibrated_estimate >= 2);
});

test('stakeholder digest: sent to configured addresses, HTML-escaped', async () => {
  assert.equal((await member.patch(`/api/projects/${ids.api}`, { digest_emails: ['x@y.zz'] })).status, 403);
  const r = await manager.patch(`/api/projects/${ids.api}`, { digest_emails: ['ceo@acme.com', 'not-an-email', 'CLIENT@Partner.io'] });
  assert.deepEqual(r.body.digest_emails, ['ceo@acme.com', 'client@partner.io']);
  await mk(admin, ids.api, { title: '<img src=x onerror=alert(1)> shipped', status: 'done' });
  const before = all('SELECT * FROM outbox').length;
  const out = (await manager.post(`/api/projects/${ids.api}/digest/send`)).body;
  assert.equal(out.sent, 2);
  const mails = all('SELECT * FROM outbox ORDER BY id DESC LIMIT 2');
  assert.equal(all('SELECT * FROM outbox').length, before + 2);
  assert.ok(mails.every(m => /weekly update/.test(m.subject)));
  const { mdToHtml } = await import('../server/util.js');
  assert.ok(!mdToHtml('- <img src=x onerror=alert(1)>').includes('<img'));
  assert.ok(get('SELECT 1'));
});
