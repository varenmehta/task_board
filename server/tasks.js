import { all, get, run, insert, tx, parseJSON } from './db.js';
import { STATUS_IDS, PRIORITIES } from './config.js';
import { bad, notFound, forbidden, isDate, clip } from './util.js';
import { bus, pushTo } from './events.js';
import { canEditProject, canViewProject, usersWhoCanView, projectMembers } from './access.js';

const TASK_SELECT = `SELECT t.*, p.key AS project_key, p.name AS project_name, p.color AS project_color, p.team_id,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id=t.id) AS subtask_total,
  (SELECT COUNT(*) FROM tasks s WHERE s.parent_id=t.id AND s.status='done') AS subtask_done,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id=t.id) AS comment_count
  FROM tasks t JOIN projects p ON p.id=t.project_id`;

export function shape(t) {
  if (!t) return t;
  return { ...t, key: `${t.project_key}-${t.number}`, labels: parseJSON(t.labels, []) };
}
export const getTask = id => shape(get(`${TASK_SELECT} WHERE t.id=?`, id));
export const listProjectTasks = pid => all(`${TASK_SELECT} WHERE t.project_id=? AND t.parent_id IS NULL ORDER BY t.position`, pid).map(shape);
export const listSubtasks = id => all(`${TASK_SELECT} WHERE t.parent_id=? ORDER BY t.position, t.id`, id).map(shape);
export const listAssigned = uid => all(`${TASK_SELECT} WHERE t.assignee_id=? AND p.archived=0 ORDER BY t.due_date IS NULL, t.due_date, t.id`, uid).map(shape);
export const getProject = id => get('SELECT * FROM projects WHERE id=?', id);

function logActivity(task, userId, action, detail = {}) {
  insert('INSERT INTO activity(task_id,project_id,user_id,action,detail) VALUES(?,?,?,?,?)', task.id, task.project_id, userId, action, JSON.stringify(detail));
}

function cleanLabels(v) {
  if (!Array.isArray(v)) throw bad('labels must be a list');
  return [...new Set(v.map(x => String(x).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24)).filter(Boolean))].slice(0, 8);
}

function validateAssignee(project, id) {
  if (id == null || id === '') return null;
  const ok = projectMembers(project).some(m => m.id === Number(id));
  if (!ok) throw bad('Assignee must be a member of this project\'s team');
  return Number(id);
}

function notifyBoard(project, event, data) {
  pushTo(usersWhoCanView(project), event, { project_id: project.id, ...data });
}

function endPosition(projectId, status) {
  return (get('SELECT MAX(position) AS m FROM tasks WHERE project_id=? AND status=? AND parent_id IS NULL', projectId, status)?.m ?? 0) + 1024;
}

// actor === null means "the system" (automations, scheduler, inbound email)
export function createTask(actor, projectId, data, { source = 'web', skipPermission = false } = {}) {
  const project = getProject(projectId);
  if (!project || project.archived) throw notFound('Project not found');
  if (actor && !skipPermission && !canEditProject(actor, project)) throw forbidden();
  const title = String(data.title ?? '').trim();
  if (!title) throw bad('Title is required');
  const status = data.status ?? 'todo';
  const priority = data.priority ?? 'medium';
  if (!STATUS_IDS.includes(status)) throw bad('Invalid status');
  if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
  if (data.due_date && !isDate(data.due_date)) throw bad('Invalid due date');
  const assignee = validateAssignee(project, data.assignee_id);
  const labels = cleanLabels(data.labels ?? []);
  let parent = null;
  if (data.parent_id) {
    parent = get('SELECT * FROM tasks WHERE id=? AND project_id=?', data.parent_id, projectId);
    if (!parent || parent.parent_id) throw bad('Invalid parent task');
  }
  const id = tx(() => {
    const number = project.next_number;
    run('UPDATE projects SET next_number=next_number+1 WHERE id=?', project.id);
    return insert(`INSERT INTO tasks(project_id,number,title,description,status,priority,assignee_id,reporter_id,due_date,estimate,labels,position,parent_id,source,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      project.id, number, clip(title, 300), String(data.description ?? '').slice(0, 20000), status, priority, assignee,
      actor?.id ?? data.reporter_id ?? null, data.due_date || null, data.estimate ?? null, JSON.stringify(labels),
      endPosition(project.id, status), parent?.id ?? null, source, status === 'done' ? new Date().toISOString() : null);
  });
  const task = getTask(id);
  logActivity(task, actor?.id, 'created', { source });
  notifyBoard(project, 'task', { task_id: id, change: 'created' });
  bus.emit('task.created', { task, actor });
  return task;
}

const EDITABLE = ['title', 'description', 'status', 'priority', 'assignee_id', 'due_date', 'estimate', 'labels'];

export function updateTask(actor, id, patch, { skipPermission = false } = {}) {
  const before = getTask(id);
  if (!before) throw notFound('Task not found');
  const project = getProject(before.project_id);
  if (actor && !skipPermission && !canEditProject(actor, project)) throw forbidden();

  const set = {};
  for (const f of EDITABLE) if (f in patch) set[f] = patch[f];
  if ('title' in set) { set.title = clip(String(set.title).trim(), 300); if (!set.title) throw bad('Title is required'); }
  if ('description' in set) set.description = String(set.description ?? '').slice(0, 20000);
  if ('status' in set && !STATUS_IDS.includes(set.status)) throw bad('Invalid status');
  if ('priority' in set && !PRIORITIES.includes(set.priority)) throw bad('Invalid priority');
  if ('due_date' in set) { set.due_date = set.due_date || null; if (set.due_date && !isDate(set.due_date)) throw bad('Invalid due date'); }
  if ('estimate' in set) {
    set.estimate = set.estimate === '' || set.estimate == null ? null : Number(set.estimate);
    if (set.estimate != null && (!isFinite(set.estimate) || set.estimate < 0)) throw bad('Invalid estimate');
  }
  if ('assignee_id' in set) set.assignee_id = validateAssignee(project, set.assignee_id);
  if ('labels' in set) set.labels = cleanLabels(set.labels);

  const changes = {};
  for (const [k, v] of Object.entries(set)) {
    const old = k === 'labels' ? before.labels : before[k];
    if (JSON.stringify(old ?? null) !== JSON.stringify(v ?? null)) changes[k] = [old ?? null, v ?? null];
  }
  if (!Object.keys(changes).length) return before;

  const cols = Object.keys(changes);
  const vals = cols.map(c => (c === 'labels' ? JSON.stringify(set.labels) : set[c]));
  let extra = '';
  if (changes.status) extra = changes.status[1] === 'done' ? ", completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')" : ', completed_at=NULL';
  tx(() => {
    run(`UPDATE tasks SET ${cols.map(c => c + '=?').join(',')}${extra}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, ...vals, id);
    if (changes.status) run('UPDATE tasks SET position=? WHERE id=?', endPosition(project.id, changes.status[1]), id);
    for (const [field, [from, to]] of Object.entries(changes)) {
      logActivity(before, actor?.id, field === 'description' ? 'edited_description' : `changed_${field}`,
        field === 'description' ? {} : { from, to });
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
  if (!STATUS_IDS.includes(status)) throw bad('Invalid status');
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
  return { ok: true };
}

export function addComment(actor, taskId, body) {
  const task = getTask(taskId);
  if (!task) throw notFound('Task not found');
  const project = getProject(task.project_id);
  if (actor && !canEditProject(actor, project)) throw forbidden();
  const text = String(body ?? '').trim();
  if (!text) throw bad('Comment is empty');
  const id = insert('INSERT INTO comments(task_id,user_id,body) VALUES(?,?,?)', taskId, actor?.id ?? null, text.slice(0, 10000));
  logActivity(task, actor?.id, 'commented', { comment_id: id });
  notifyBoard(project, 'task', { task_id: taskId, change: 'commented' });
  const comment = get('SELECT * FROM comments WHERE id=?', id);
  bus.emit('comment.added', { task, comment, actor });
  return comment;
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
    can_edit: canEditProject(actor, project),
  };
}
