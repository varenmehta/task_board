// Sprints (with burndown/velocity), releases (with notes), epic roadmap.
import { all, get, run, insert } from './db.js';
import { bus } from './events.js';
import { bad, notFound, forbidden, isDate, todayStr, addDays } from './util.js';
import { canManageProject, canViewProject } from './access.js';
import { getProject, getTask, updateTask } from './tasks.js';
import { parseJSON } from './db.js';

function loadSprint(id) { const s = get('SELECT * FROM sprints WHERE id=?', id); if (!s) throw notFound('Sprint not found'); return s; }
function managed(actor, projectId) {
  const p = getProject(projectId);
  if (!p) throw notFound('Project not found');
  if (!canManageProject(actor, p)) throw forbidden('Only project managers can plan sprints');
  return p;
}

// ---------- sprints ----------
export function sprintScope(sprintId) {
  const rows = all(`SELECT id, status, estimate FROM tasks WHERE sprint_id=? AND parent_id IS NULL`, sprintId);
  const sum = list => list.reduce((a, t) => a + (t.estimate || 0), 0);
  const done = rows.filter(t => t.status === 'done');
  return { total_tasks: rows.length, done_tasks: done.length, total: sum(rows), remaining: sum(rows) - sum(done) };
}

export function snapshotSprint(sprintId, day = todayStr()) {
  const s = get('SELECT * FROM sprints WHERE id=?', sprintId);
  if (!s || s.state === 'planned') return;
  const sc = sprintScope(sprintId);
  run(`INSERT INTO sprint_snapshots(sprint_id,day,remaining,total,done_tasks,total_tasks) VALUES(?,?,?,?,?,?)
    ON CONFLICT(sprint_id,day) DO UPDATE SET remaining=excluded.remaining,total=excluded.total,done_tasks=excluded.done_tasks,total_tasks=excluded.total_tasks`,
  sprintId, day, sc.remaining, sc.total, sc.done_tasks, sc.total_tasks);
}

export function sprintDetail(s) {
  const sc = sprintScope(s.id);
  const snaps = all('SELECT * FROM sprint_snapshots WHERE sprint_id=? ORDER BY day', s.id);
  const start = s.start_date, end = s.end_date;
  const burndown = [];
  if (start && end && s.state !== 'planned') {
    const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000));
    const first = snaps[0]?.total ?? sc.total;
    const useHours = (snaps.at(-1)?.total ?? sc.total) > 0;
    let last = snaps[0];
    for (let i = 0; i <= days; i++) {
      const day = addDays(start, i);
      const snap = snaps.find(x => x.day === day);
      if (snap) last = snap;
      const future = day > todayStr();
      burndown.push({
        day, ideal: Math.max(0, first - (first / days) * i),
        actual: future ? null : (day === todayStr() ? (useHours ? sc.remaining : sc.total_tasks - sc.done_tasks) : last ? (useHours ? last.remaining : last.total_tasks - last.done_tasks) : null),
      });
    }
  }
  return { ...s, ...sc, burndown, unit: sc.total > 0 ? 'hours' : 'tasks' };
}

export function listSprints(projectId) {
  const sprints = all('SELECT * FROM sprints WHERE project_id=? ORDER BY id', projectId).map(sprintDetail);
  const closed = sprints.filter(s => s.state === 'closed').slice(-3);
  const velocity = closed.length ? closed.reduce((a, s) => a + (s.total > 0 ? s.total - s.remaining : s.done_tasks), 0) / closed.length : null;
  return { sprints, velocity, velocity_unit: closed.some(s => s.total > 0) ? 'hours' : 'tasks' };
}

const cleanSprint = (d, cur = {}) => {
  const name = String(d.name ?? cur.name ?? '').trim().slice(0, 60);
  if (!name) throw bad('Name your sprint');
  const start = d.start_date !== undefined ? d.start_date || null : cur.start_date ?? null;
  const end = d.end_date !== undefined ? d.end_date || null : cur.end_date ?? null;
  for (const x of [start, end]) if (x && !isDate(x)) throw bad('Invalid date');
  if (start && end && start > end) throw bad('Sprint ends before it starts');
  return { name, goal: String(d.goal ?? cur.goal ?? '').slice(0, 300), start_date: start, end_date: end };
};

export function createSprint(actor, projectId, data) {
  managed(actor, projectId);
  const c = cleanSprint(data);
  return insert('INSERT INTO sprints(project_id,name,goal,start_date,end_date) VALUES(?,?,?,?,?)', projectId, c.name, c.goal, c.start_date, c.end_date);
}
export function updateSprint(actor, id, data) {
  const s = loadSprint(id); managed(actor, s.project_id);
  const c = cleanSprint(data, s);
  run('UPDATE sprints SET name=?, goal=?, start_date=?, end_date=? WHERE id=?', c.name, c.goal, c.start_date, c.end_date, id);
  snapshotSprint(id);
}
export function deleteSprint(actor, id) {
  const s = loadSprint(id); managed(actor, s.project_id);
  run('UPDATE tasks SET sprint_id=NULL WHERE sprint_id=?', id);
  run('DELETE FROM sprints WHERE id=?', id);
}
export function startSprint(actor, id) {
  const s = loadSprint(id); managed(actor, s.project_id);
  if (s.state !== 'planned') throw bad('This sprint has already started');
  if (get("SELECT 1 FROM sprints WHERE project_id=? AND state='active'", s.project_id)) throw bad('Another sprint is already active — complete it first');
  const start = s.start_date || todayStr();
  const end = s.end_date || addDays(start, 14);
  run("UPDATE sprints SET state='active', start_date=?, end_date=? WHERE id=?", start, end, id);
  snapshotSprint(id);
}
export function closeSprint(actor, id, { move_to } = {}) {
  const s = loadSprint(id); managed(actor, s.project_id);
  if (s.state !== 'active') throw bad('Only an active sprint can be completed');
  snapshotSprint(id);
  let target = null;
  if (move_to && move_to !== 'backlog') {
    target = get("SELECT id FROM sprints WHERE id=? AND project_id=? AND state<>'closed' AND id<>?", Number(move_to), s.project_id, id)?.id;
    if (!target) throw bad('Choose a planned sprint or the backlog');
  }
  const open = all("SELECT id FROM tasks WHERE sprint_id=? AND status<>'done'", id);
  for (const t of open) run('UPDATE tasks SET sprint_id=? WHERE id=?', target, t.id);
  const sc = sprintScope(id);
  run("UPDATE sprints SET state='closed', closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), end_date=COALESCE(end_date,?) WHERE id=?", todayStr(), id);
  return { moved: open.length, completed: sc.done_tasks };
}

for (const ev of ['task.created', 'task.updated', 'task.deleted']) {
  bus.on(ev, ({ task, changes, before }) => {
    if (ev === 'task.updated' && !(changes.status || changes.sprint_id || changes.estimate)) return;
    for (const sid of new Set([task?.sprint_id, before?.sprint_id].filter(Boolean))) snapshotSprint(sid);
  });
}

export function snapshotActiveSprints() {
  for (const s of all("SELECT id FROM sprints WHERE state='active'")) snapshotSprint(s.id);
}

// ---------- releases ----------
function loadRelease(id) { const r = get('SELECT * FROM releases WHERE id=?', id); if (!r) throw notFound('Release not found'); return r; }
export function listReleases(projectId) {
  return all('SELECT * FROM releases WHERE project_id=? ORDER BY COALESCE(date,\'9999\'), id', projectId).map(r => {
    const c = get("SELECT COUNT(*) total, SUM(status='done') done FROM tasks WHERE release_id=? AND parent_id IS NULL", r.id);
    return { ...r, total: c.total, done: c.done || 0 };
  });
}
export function saveRelease(actor, projectId, d, id = null) {
  managed(actor, projectId);
  const name = String(d.name || '').trim().slice(0, 60);
  if (!name) throw bad('Name your release');
  if (d.date && !isDate(d.date)) throw bad('Invalid date');
  if (id) {
    const cur = loadRelease(id);
    run('UPDATE releases SET name=?, version=?, date=?, notes=?, state=? WHERE id=?', name, String(d.version ?? cur.version).slice(0, 30), d.date ?? cur.date, String(d.notes ?? cur.notes).slice(0, 20000), ['planned', 'released'].includes(d.state) ? d.state : cur.state, id);
    return id;
  }
  return insert('INSERT INTO releases(project_id,name,version,date) VALUES(?,?,?,?)', projectId, name, String(d.version || '').slice(0, 30), d.date || null);
}
export function deleteRelease(actor, id) {
  const r = loadRelease(id); managed(actor, r.project_id);
  run('UPDATE tasks SET release_id=NULL WHERE release_id=?', id);
  run('DELETE FROM releases WHERE id=?', id);
}
export function releaseTasks(id) {
  return all(`SELECT t.id, t.number, t.title, t.type, t.status, t.labels, t.assignee_id, p.key, u.name AS assignee FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.release_id=? AND t.parent_id IS NULL ORDER BY t.type, t.number`, id).map(t => ({ ...t, label_list: parseJSON(t.labels, []), ref: `${t.key}-${t.number}` }));
}
export function localReleaseNotes(release, tasks) {
  const done = tasks.filter(t => t.status === 'done');
  const group = (title, list) => list.length ? [`### ${title}`, ...list.map(t => `- ${t.title} (${t.ref}${t.assignee ? `, ${t.assignee}` : ''})`), ''] : [];
  const lines = [`## ${release.name}${release.version ? ` — ${release.version}` : ''}`, release.date ? `_${release.date}_` : '', '',
    ...group('✨ New', done.filter(t => ['story', 'task'].includes(t.type) && !t.label_list.includes('chore'))),
    ...group('🐛 Fixes', done.filter(t => t.type === 'bug')), ...group('🧹 Maintenance', done.filter(t => t.label_list.includes('chore'))),
    ...(tasks.length > done.length ? [`> ${tasks.length - done.length} planned item(s) are not finished yet.`] : [])];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function markReleased(actor, id) {
  const r = loadRelease(id); managed(actor, r.project_id);
  run("UPDATE releases SET state='released', date=COALESCE(date,?) WHERE id=?", todayStr(), id);
}

// ---------- roadmap (epics) ----------
export function roadmap(projectId) {
  return all("SELECT * FROM tasks WHERE project_id=? AND type='epic' AND parent_id IS NULL ORDER BY COALESCE(start_date, due_date, '9999'), id", projectId).map(e => {
    const kids = all('SELECT status, start_date, due_date FROM tasks WHERE epic_id=?', e.id);
    const dates = [e.start_date, e.due_date, ...kids.flatMap(k => [k.start_date, k.due_date])].filter(Boolean).sort();
    return { id: e.id, title: e.title, status: e.status, start: e.start_date || dates[0] || null, end: e.due_date || dates.at(-1) || null,
      total: kids.length, done: kids.filter(k => k.status === 'done').length, number: e.number };
  });
}
void canViewProject; void getTask; void updateTask;
