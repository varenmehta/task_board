import { all, get, run, insert } from './db.js';
import { bad, forbidden, notFound, isDate, todayStr } from './util.js';
import { canEditProject } from './access.js';
import { getTask, getProject, logActivity } from './tasks.js';
import { pushTo } from './events.js';

const secondsSince = iso => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));

function editable(actor, taskId) {
  const task = getTask(taskId);
  if (!task) throw notFound('Task not found');
  if (!canEditProject(actor, getProject(task.project_id))) throw forbidden();
  return task;
}

export function stopTimer(userId) {
  const running = all('SELECT * FROM time_entries WHERE user_id=? AND running=1', userId);
  for (const r of running) run('UPDATE time_entries SET running=0, seconds=seconds+?, started_at=NULL WHERE id=?', secondsSince(r.started_at), r.id);
  if (running.length) pushTo([userId], 'timer', {});
  return running.length;
}

export function startTimer(actor, taskId) {
  const task = editable(actor, taskId);
  stopTimer(actor.id);
  run('INSERT INTO time_entries(task_id,user_id,started_at,running,day) VALUES(?,?,?,1,?)', taskId, actor.id, new Date().toISOString(), todayStr());
  pushTo([actor.id], 'timer', {});
  return task;
}

export function runningTimer(userId) {
  const r = get('SELECT * FROM time_entries WHERE user_id=? AND running=1', userId);
  if (!r) return null;
  const t = getTask(r.task_id);
  return { entry_id: r.id, task_id: r.task_id, key: t?.key, title: t?.title, started_at: r.started_at, elapsed: secondsSince(r.started_at) + r.seconds };
}

export function logTime(actor, taskId, { seconds, hours, minutes, day, note }) {
  const task = editable(actor, taskId);
  const secs = Math.round(seconds ?? (Number(hours || 0) * 3600 + Number(minutes || 0) * 60));
  if (!(secs > 0) || secs > 24 * 3600) throw bad('Enter a duration between 1 minute and 24 hours');
  if (day && !isDate(day)) throw bad('Invalid date');
  const id = insert('INSERT INTO time_entries(task_id,user_id,seconds,day,note) VALUES(?,?,?,?,?)', taskId, actor.id, secs, day || todayStr(), String(note || '').slice(0, 300));
  logActivity(task, actor.id, 'logged_time', { seconds: secs });
  return id;
}

export function deleteEntry(actor, entryId) {
  const e = get('SELECT * FROM time_entries WHERE id=?', entryId);
  if (!e) throw notFound('Entry not found');
  if (e.user_id !== actor.id && actor.role !== 'admin') throw forbidden();
  run('DELETE FROM time_entries WHERE id=?', entryId);
}

export function taskTime(taskId) {
  const entries = all(`SELECT e.id, e.user_id, u.name AS user_name, e.day, e.note, e.running,
    CASE WHEN e.running=1 THEN e.seconds + CAST((julianday('now')-julianday(e.started_at))*86400 AS INTEGER) ELSE e.seconds END AS seconds
    FROM time_entries e LEFT JOIN users u ON u.id=e.user_id WHERE e.task_id=? ORDER BY e.id DESC LIMIT 100`, taskId);
  return { entries, total: entries.reduce((a, e) => a + e.seconds, 0) };
}
