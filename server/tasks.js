import { all, get, run, insert, tx, parseJSON } from './db.js';
import { PRIORITIES, TASK_TYPES } from './config.js';
import { bad, notFound, forbidden, isDate, clip } from './util.js';
import { bus, pushTo } from './events.js';
import { canEditProject, canViewProject, canCommentProject, usersWhoCanView, projectMembers } from './access.js';
import { projectStatuses, statusIds, statusMeta, defaultStatus } from './statuses.js';

const TASK_SELECT = `SELECT t.*, p.key AS project_key, p.name AS project_name, p.color AS project_color, p.team_id, p.statuses AS project_statuses,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id=t.id) AS subtask_total,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id=t.id AND s.status='done') AS subtask_done,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id=t.id) AS comment_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.task_id=t.id) AS attachment_count,
  (SELECT COUNT(*) FROM tasks e WHERE e.epic_id=t.id) AS epic_total,
  (SELECT COUNT(*) FROM tasks e WHERE e.epic_id=t.id AND e.status='done') AS epic_done,
  (SELECT COUNT(*) FROM task_links l JOIN tasks b ON b.id=l.task_id WHERE l.other_id=t.id AND l.kind='blocks' AND b.status<>'done') AS blocked_by_open,
  (SELECT COALESCE(SUM(CASE WHEN r.running=1 THEN CAST((julianday('now')-julianday(r.started_at))*86400 AS INTEGER) ELSE 0 END + r.seconds),0) FROM time_entries r WHERE r.task_id=t.id) AS time_spent
  FROM tasks t JOIN projects p ON p.id=t.project_id`;

export function shape(t) {
  if (!t) return t;
  const meta = statusMeta({ id: t.project_id, statuses: t.project_statuses }, t.status);
  const { project_statuses, ...rest } = t;
  return { ...rest, key: `${t.project_key}-${t.number}`, labels: parseJSON(t.labels, []), custom: parseJSON(t.custom, {}), status_label: meta.label, status_category: meta.category };
}
export const getTask = id => shape(get(`${TASK_SELECT} WHERE t.id=?`, id));
export const listProjectTasks = pid => all(`${TASK_SELECT} WHERE t.project_id=? AND t.parent_id IS NULL ORDER BY t.position`, pid).map(shape);
export const listSubtasks = id => all(`${TASK_SELECT} WHERE t.parent_id=? ORDER BY t.position, t.id`, id).map(shape);
export const listAssigned = uid => all(`${TASK_SELECT} WHERE t.assignee_id=? AND p.archived=0 ORDER BY t.due_date IS NULL, t.due_date, t.id`, uid).map(shape);
export const getProject = id => get('SELECT * FROM projects WHERE id=?', id);
export const getTaskByKey = key => {
  const m = String(key || '').toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/);
  if (!m) return null;
  const row = get(`SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.key=? AND t.number=?`, m[1], Number(m[2]));
  return row ? getTask(row.id) : null;
};

export function logActivity(task, userId, action, detail = {}) {
  insert('INSERT INTO activity(task_id,project_id,user_id,action,detail) VALUES(?,?,?,?,?)', task.id, task.project_id, userId, action, JSON.stringify(detail));
}

function cleanLabels(v) {
  if (!Array.isArray(v)) throw bad('labels must be a list');
  return [...new Set(v.map(x => String(x).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24)).filter(Boolean))].slice(0, 8);
}

function validateAssignee(project, id) {
  if (id == null || id === '') return null;
  const ok = projectMembers(project).some(m => m.id === Number(id));
  if (!ok) throw bad('Assignee must be a member of this project');
  return Number(id);
}

export function cleanCustom(project, input, previous = {}) {
  const defs = parseJSON(project.fields, []);
  const out = { ...previous };
  if (input == null || typeof input !== 'object') throw bad('Invalid custom fields');
  for (const def of defs) {
    if (!(def.id in input)) continue;
    const v = input[def.id];
    if (v === null || v === '' || v === undefined) { delete out[def.id]; continue; }
    if (def.type === 'number') { const n = Number(v); if (!isFinite(n)) throw bad(`${def.label} must be a number`); out[def.id] = n; }
    else if (def.type === 'checkbox') out[def.id] = !!v;
    else if (def.type === 'date') { if (!isDate(v)) throw bad(`${def.label} must be a date`); out[def.id] = v; }
    else if (def.type === 'select') { if (!def.options?.includes(v)) throw bad(`Invalid option for ${def.label}`); out[def.id] = v; }
    else out[def.id] = String(v).slice(0, 500);
  }
  return out;
}

function notifyBoard(project, event, data) {
  pushTo(usersWhoCanView(project), event, { project_id: project.id, ...data });
}

function endPosition(projectId, status) {
  return (get('SELECT MAX(position) AS m FROM tasks WHERE project_id=? AND status=? AND parent_id IS NULL', projectId, status)?.m ?? 0) + 1024;
}

function refCheck(project, table, id, label, extra = '') {
  if (id == null || id === '') return null;
  const row = get(`SELECT * FROM ${table} WHERE id=? AND project_id=? ${extra}`, Number(id), project.id);
  if (!row) throw bad(`Invalid ${label}`);
  return row.id;
}

// actor === null means "the system" (automations, scheduler, inbound email/webhooks)
export function createTask(actor, projectId, data, { source = 'web', skipPermission = false } = {}) {
  const project = getProject(projectId);
  if (!project || project.archived) throw notFound('Project not found');
  if (actor && !skipPermission && !canEditProject(actor, project)) throw forbidden();
  const title = String(data.title ?? '').trim();
  if (!title) throw bad('Title is required');
  const status = data.status ?? defaultStatus(project);
  const priority = data.priority ?? 'medium';
  const type = data.type ?? 'task';
  if (!statusIds(project).includes(status)) throw bad('Invalid status');
  if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
  if (!TASK_TYPES.includes(type)) throw bad('Invalid type');
  if (data.due_date && !isDate(data.due_date)) throw bad('Invalid due date');
  if (data.start_date && !isDate(data.start_date)) throw bad('Invalid start date');
  if (data.start_date && data.due_date && data.start_date > data.due_date) throw bad('Start date is after the due date');
  const assignee = validateAssignee(project, data.assignee_id);
  const labels = cleanLabels(data.labels ?? []);
  let parent = null;
  if (data.parent_id) {
    parent = get('SELECT * FROM tasks WHERE id=? AND project_id=?', data.parent_id, projectId);
    if (!parent || parent.parent_id) throw bad('Invalid parent task');
  }
  const epic = refCheck(project, 'tasks', data.epic_id, 'epic', "AND type='epic'");
  const sprint = refCheck(project, 'sprints', data.sprint_id, 'sprint', "AND state<>'closed'");
  const release = refCheck(project, 'releases', data.release_id, 'release');
  const custom = cleanCustom(project, data.custom ?? {});
  const id = tx(() => {
    const number = project.next_number;
    run('UPDATE projects SET next_number=next_number+1 WHERE id=?', project.id);
    return insert(`INSERT INTO tasks(project_id,number,title,description,status,priority,assignee_id,reporter_id,due_date,start_date,estimate,labels,position,parent_id,source,completed_at,type,epic_id,sprint_id,release_id,custom)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      project.id, number, clip(title, 300), String(data.description ?? '').slice(0, 20000), status, priority, assignee,
      actor?.id ?? data.reporter_id ?? null, data.due_date || null, data.start_date || null, data.estimate ?? null, JSON.stringify(labels),
      endPosition(project.id, status), parent?.id ?? null, source, status === 'done' ? new Date().toISOString() : null,
      type, epic, sprint, release, JSON.stringify(custom));
  });
  const task = getTask(id);
  logActivity(task, actor?.id, 'created', { source });
  notifyBoard(project, 'task', { task_id: id, change: 'created' });
  bus.emit('task.created', { task, actor });
  return task;
}

const EDITABLE = ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date', 'start_date', 'estimate', 'labels', 'type', 'epic_id', 'sprint_id', 'release_id', 'custom'];

export function updateTask(actor, id, patch, { skipPermission = false } = {}) {
  const before = getTask(id);
  if (!before) throw notFound('Task not found');
  const project = getProject(before.project_id);
  if (actor && !skipPermission && !canEditProject(actor, project)) throw forbidden();

  const set = {};
  for (const f of EDITABLE) if (f in patch) set[f] = patch[f];
  if ('title' in set) { set.title = clip(String(set.title).trim(), 300); if (!set.title) throw bad('Title is required'); }
  if ('description' in set) set.description = String(set.description ?? '').slice(0, 20000);
  if ('status' in set && !statusIds(project).includes(set.status)) throw bad('Invalid status');
  if ('priority' in set && !PRIORITIES.includes(set.priority)) throw bad('Invalid priority');
  if ('type' in set && !TASK_TYPES.includes(set.type)) throw bad('Invalid type');
  for (const f of ['due_date', 'start_date']) if (f in set) { set[f] = set[f] || null; if (set[f] && !isDate(set[f])) throw bad(`Invalid ${f.replace('_', ' ')}`); }
  const start = 'start_date' in set ? set.start_date : before.start_date, due = 'due_date' in set ? set.due_date : before.due_date;
  if (start && due && start > due) throw bad('Start date is after the due date');
  if ('estimate' in set) {
    set.estimate = set.estimate === '' || set.estimate == null ? null : Number(set.estimate);
    if (set.estimate != null && (!isFinite(set.estimate) || set.estimate < 0)) throw bad('Invalid estimate');
  }
  if ('assignee_id' in set) set.assignee_id = validateAssignee(project, set.assignee_id);
  if ('labels' in set) set.labels = cleanLabels(set.labels);
  if ('epic_id' in set) { set.epic_id = refCheck(project, 'tasks', set.epic_id, 'epic', "AND type='epic'"); if (set.epic_id === id) throw bad('A task cannot be its own epic'); }
  if ('sprint_id' in set) set.sprint_id = refCheck(project, 'sprints', set.sprint_id, 'sprint', "AND state<>'closed'");
  if ('release_id' in set) set.release_id = refCheck(project, 'releases', set.release_id, 'release');
  if ('custom' in set) set.custom = cleanCustom(project, set.custom, before.custom);

  const changes = {};
  for (const [k, v] of Object.entries(set)) {
    const old = before[k];
    if (JSON.stringify(old ?? null) !== JSON.stringify(v ?? null)) changes[k] = [old ?? null, v ?? null];
  }
  if (!Object.keys(changes).length) return before;

  const cols = Object.keys(changes);
  const vals = cols.map(c => (c === 'labels' || c === 'custom' ? JSON.stringify(set[c]) : set[c]));
  let extra = '';
  if (changes.status) extra = changes.status[1] === 'done' ? ", completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ', completed_at=NULL';
  tx(() => {
    run(`UPDATE tasks SET ${cols.map(c => c + '=?').join(',')}${extra}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...vals, id);
    if (changes.status) run('UPDATE tasks SET position=? WHERE id=?', endPosition(project.id, changes.status[1]), id);
    for (const [field, [from, to]] of Object.entries(changes)) {
      logActivity(before, actor?.id, field === 'description' ? 'edited_description' : `changed_${field}`, field === 'description' || field === 'custom' ? {} : { from, to });
    }
  });
  const task = getTask(id);
  notifyBoard(project, 'task', { task_id: id, change: 'updated' });
  bus.emit('task.updated', { task, before, changes, actor });
  return getTask(id); // re-read: automations may have changed it
}

// Drag & drop: place task into `status` at `index` (0-based among the column without the task itself).
export function moveTask(actor, id, status, index) {
  const task = getTask(id);
  if (!task) throw notFound('Task not found');
  const project = getProject(task.project_id);
  if (!canEditProject(actor, project)) throw forbidden();
  if (!statusIds(project).includes(status)) throw bad('Invalid status');
  const col = all('SELECT id, position FROM tasks WHERE project_id=? AND status=? AND parent_id IS NULL AND id<>? ORDER BY position', task.project_id, status, id);
  const i = Math.max(0, Math.min(Number.isInteger(index) ? index : col.length, col.length));
  let pos;
  if (!col.length) pos = 1024;
  else if (i === 0) pos = col[0].position - 1024;
  else if (i >= col.length) pos = col[col.length - 1].position + 1024;
  else pos = (col[i - 1].position + col[i].position) / 2;
  if (task.status !== status) updateTask(actor, id, { status });
  run('UPDATE tasks SET position=? WHERE id=?', pos, id);
  notifyBoard(project, 'task', { task_id: id, change: 'moved' });
  return getTask(id);
}

export function deleteTask(actor, id) {
  const task = getTask(id);
  if (!task) throw notFound('Task not found');
  const project = getProject(task.project_id);
  if (!canEditProject(actor, project)) throw forbidden();
  if (actor.role === 'member' && task.reporter_id !== actor.id && task.assignee_id !== actor.id)
    throw forbidden('Only the reporter, assignee, or a manager can delete this task');
  run('DELETE FROM tasks WHERE id=?', id);
  notifyBoard(project, 'task', { task_id: id, change: 'deleted' });
  bus.emit('task.deleted', { task, actor });
  return { ok: true };
}

// Apply one patch (or delete) to many tasks; each task is permission-checked on its own.
export function bulkApply(actor, ids, { patch, remove }) {
  if (!Array.isArray(ids) || !ids.length) throw bad('Select at least one task');
  const result = { ok: 0, failed: [] };
  for (const id of ids.slice(0, 200)) {
    try { remove ? deleteTask(actor, Number(id)) : updateTask(actor, Number(id), patch || {}); result.ok++; }
    catch (e) { result.failed.push({ id, error: e.message }); }
  }
  return result;
}

export function addComment(actor, taskId, body) {
  const task = getTask(taskId);
  if (!task) throw notFound('Task not found');
  const project = getProject(task.project_id);
  if (actor && !canCommentProject(actor, project)) throw forbidden();
  const text = String(body ?? '').trim();
  if (!text) throw bad('Comment is empty');
  const id = insert('INSERT INTO comments(task_id,user_id,body) VALUES(?,?,?)', taskId, actor?.id ?? null, text.slice(0, 10000));
  logActivity(task, actor?.id, 'commented', { comment_id: id });
  notifyBoard(project, 'task', { task_id: taskId, change: 'commented' });
  const comment = get('SELECT * FROM comments WHERE id=?', id);
  bus.emit('comment.added', { task, comment, actor });
  return comment;
}

// ---- dependencies: (task_id BLOCKS other_id) ----
function reaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return all("SELECT other_id FROM task_links WHERE task_id=? AND kind='blocks'", from).some(r => reaches(r.other_id, target, seen));
}
export function addBlocker(actor, taskId, blockerId) {
  const task = getTask(taskId), blocker = getTask(blockerId);
  if (!task || !blocker) throw notFound('Task not found');
  if (taskId === blockerId) throw bad('A task cannot block itself');
  if (!canEditProject(actor, getProject(task.project_id)) || !canViewProject(actor, getProject(blocker.project_id))) throw forbidden();
  if (reaches(taskId, blockerId)) throw bad('That would create a circular dependency');
  run("INSERT OR IGNORE INTO task_links(task_id,other_id,kind) VALUES(?,?,'blocks')", blockerId, taskId);
  logActivity(task, actor.id, 'added_blocker', { key: blocker.key });
  notifyBoard(getProject(task.project_id), 'task', { task_id: taskId, change: 'updated' });
  return getLinks(taskId);
}
export function removeBlocker(actor, taskId, blockerId) {
  const task = getTask(taskId);
  if (!task) throw notFound('Task not found');
  if (!canEditProject(actor, getProject(task.project_id))) throw forbidden();
  run("DELETE FROM task_links WHERE task_id=? AND other_id=? AND kind='blocks'", blockerId, taskId);
  notifyBoard(getProject(task.project_id), 'task', { task_id: taskId, change: 'updated' });
  return getLinks(taskId);
}
export function getLinks(taskId) {
  const pick = rows => rows.map(r => shape(get(`${TASK_SELECT} WHERE t.id=?`, r.id))).map(t => ({ id: t.id, key: t.key, title: t.title, status: t.status, status_category: t.status_category }));
  return {
    blocked_by: pick(all("SELECT task_id AS id FROM task_links WHERE other_id=? AND kind='blocks'", taskId)),
    blocks: pick(all("SELECT other_id AS id FROM task_links WHERE task_id=? AND kind='blocks'", taskId)),
  };
}

export function taskDetail(actor, id) {
  const task = getTask(id);
  if (!task) throw notFound('Task not found');
  const project = getProject(task.project_id);
  if (!canViewProject(actor, project)) throw forbidden();
  return {
    ...task,
    subtasks: listSubtasks(id),
    comments: all(`SELECT c.*, u.name AS user_name, u.color AS user_color FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id`, id),
    activity: all(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.task_id=? ORDER BY a.id DESC LIMIT 60`, id)
      .map(a => ({ ...a, detail: parseJSON(a.detail, {}) })),
    attachments: all('SELECT id,name,mime,size,user_id,created_at FROM attachments WHERE task_id=? ORDER BY id', id),
    links: getLinks(id),
    epic: task.epic_id ? (() => { const e = getTask(task.epic_id); return e && { id: e.id, key: e.key, title: e.title }; })() : null,
    children: task.type === 'epic' ? all(`${TASK_SELECT} WHERE t.epic_id=? ORDER BY t.position`, id).map(shape).map(t => ({ id: t.id, key: t.key, title: t.title, status: t.status, status_label: t.status_label, status_category: t.status_category, assignee_id: t.assignee_id })) : [],
    can_edit: canEditProject(actor, project),
    can_comment: canCommentProject(actor, project),
  };
}
export { TASK_SELECT };
