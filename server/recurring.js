import { all, get, run, insert, parseJSON } from './db.js';
import { bad, notFound, forbidden, addDays, todayStr, isDate } from './util.js';
import { canManageProject, canEditProject } from './access.js';
import { createTask, getProject } from './tasks.js';

// schedule grammar: daily | weekdays | weekly:<0-6, Sunday=0> | monthly:<1-28>
export function validSchedule(s) {
  return /^(daily|weekdays|weekly:[0-6]|monthly:([1-9]|1\d|2[0-8]))$/.test(String(s));
}
export function nextRun(schedule, after) {
  let d = addDays(after, 1);
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) {
    const dt = new Date(d + 'T00:00:00Z'), dow = dt.getUTCDay();
    if (schedule === 'daily') return d;
    if (schedule === 'weekdays' && dow >= 1 && dow <= 5) return d;
    if (schedule.startsWith('weekly:') && dow === Number(schedule.slice(7))) return d;
    if (schedule.startsWith('monthly:') && dt.getUTCDate() === Number(schedule.slice(8))) return d;
  }
  return addDays(after, 1);
}

const cleanData = d => ({
  title: String(d.title || '').trim().slice(0, 300), description: String(d.description || '').slice(0, 20000),
  priority: ['urgent', 'high', 'medium', 'low'].includes(d.priority) ? d.priority : 'medium',
  type: ['task', 'bug', 'story', 'epic'].includes(d.type) ? d.type : 'task',
  labels: Array.isArray(d.labels) ? d.labels.slice(0, 8).map(String) : [], estimate: d.estimate ?? null,
  due_in_days: d.due_in_days == null || d.due_in_days === '' ? null : Math.max(0, Math.min(365, Number(d.due_in_days) || 0)),
  subtasks: Array.isArray(d.subtasks) ? d.subtasks.map(s => String(s).trim()).filter(Boolean).slice(0, 12) : [],
});

function manageable(actor, projectId) {
  const p = getProject(projectId);
  if (!p) throw notFound('Project not found');
  if (!canManageProject(actor, p) && !canEditProject(actor, p)) throw forbidden();
  return p;
}

export const listTemplates = projectId => all('SELECT * FROM templates WHERE project_id=? ORDER BY name', projectId).map(t => ({ ...t, data: parseJSON(t.data, {}) }));
export function saveTemplate(actor, projectId, { id, name, data }) {
  manageable(actor, projectId);
  const clean = cleanData(data || {});
  if (!String(name || '').trim()) throw bad('Give the template a name');
  if (id) { run('UPDATE templates SET name=?, data=? WHERE id=? AND project_id=?', name.trim().slice(0, 60), JSON.stringify(clean), id, projectId); return id; }
  return insert('INSERT INTO templates(project_id,name,data,created_by) VALUES(?,?,?,?)', projectId, name.trim().slice(0, 60), JSON.stringify(clean), actor.id);
}
export const deleteTemplate = (actor, projectId, id) => { manageable(actor, projectId); run('DELETE FROM templates WHERE id=? AND project_id=?', id, projectId); };

export const listRecurrences = projectId => all('SELECT * FROM recurrences WHERE project_id=? ORDER BY id', projectId).map(r => ({ ...r, data: parseJSON(r.data, {}), enabled: !!r.enabled }));
export function saveRecurrence(actor, projectId, { id, name, data, schedule, assignee_id, enabled = true, start }) {
  manageable(actor, projectId);
  if (!validSchedule(schedule)) throw bad('Invalid schedule');
  const clean = cleanData(data || {});
  if (!clean.title) throw bad('A recurring task needs a title');
  const first = isDate(start) ? start : nextRun(schedule, addDays(todayStr(), -1));
  if (id) {
    run('UPDATE recurrences SET name=?, data=?, schedule=?, assignee_id=?, enabled=?, next_run=? WHERE id=? AND project_id=?', String(name || clean.title).slice(0, 60), JSON.stringify(clean), schedule, assignee_id || null, enabled ? 1 : 0, first, id, projectId);
    return id;
  }
  return insert('INSERT INTO recurrences(project_id,name,data,schedule,next_run,assignee_id,enabled,created_by) VALUES(?,?,?,?,?,?,?,?)', projectId, String(name || clean.title).slice(0, 60), JSON.stringify(clean), schedule, first, assignee_id || null, enabled ? 1 : 0, actor.id);
}
export const deleteRecurrence = (actor, projectId, id) => { manageable(actor, projectId); run('DELETE FROM recurrences WHERE id=? AND project_id=?', id, projectId); };

export function instantiate(actor, projectId, data, extra = {}, source = 'template') {
  const d = cleanData(data);
  const task = createTask(actor, projectId, {
    title: d.title, description: d.description, priority: d.priority, type: d.type, labels: d.labels, estimate: d.estimate,
    due_date: d.due_in_days != null ? addDays(todayStr(), d.due_in_days) : null, ...extra,
  }, { source, skipPermission: !actor });
  for (const s of d.subtasks) createTask(actor, projectId, { title: s, parent_id: task.id, assignee_id: task.assignee_id }, { source, skipPermission: !actor });
  return task;
}

export function runRecurrences(today = todayStr()) {
  let n = 0;
  for (const r of all('SELECT * FROM recurrences WHERE enabled=1 AND next_run<=?', today)) {
    try {
      const project = getProject(r.project_id);
      if (!project || project.archived) continue;
      const task = instantiate(null, r.project_id, parseJSON(r.data, {}), { assignee_id: r.assignee_id, reporter_id: r.created_by }, 'recurring');
      run('UPDATE recurrences SET next_run=?, last_task_id=? WHERE id=?', nextRun(r.schedule, today), task.id, r.id);
      n++;
    } catch (e) {
      console.error(`[recurrence ${r.id}]`, e.message);
      run('UPDATE recurrences SET next_run=? WHERE id=?', nextRun(r.schedule, today), r.id); // don't retry a broken rule forever
    }
  }
  return n;
}
void get;
