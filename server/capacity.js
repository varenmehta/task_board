// Team capacity: weekly hours minus time off, versus planned (estimated) work.
import { all, get, run, insert, parseJSON } from './db.js';
import { addDays, todayStr, isDate, bad, forbidden, notFound } from './util.js';
import { visibleProjects, projectMembers } from './access.js';

export const DEFAULT_WEEK_HOURS = 30; // focused hours; deliberately below 40
export const capacityHours = user => Number(parseJSON(user.prefs, {}).capacity_hours) || DEFAULT_WEEK_HOURS;

const weekdaysBetween = (a, b) => { let n = 0; for (let d = a; d <= b; d = addDays(d, 1)) { const dow = new Date(d + 'T00:00:00Z').getUTCDay(); if (dow >= 1 && dow <= 5) n++; } return n; };
const mondayOf = d => { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };

export function offDays(userId, from, to) {
  let n = 0;
  for (const o of all('SELECT start_date, end_date FROM time_off WHERE user_id=? AND end_date>=? AND start_date<=?', userId, from, to)) {
    const a = o.start_date > from ? o.start_date : from, b = o.end_date < to ? o.end_date : to;
    n += weekdaysBetween(a, b);
  }
  return Math.min(n, weekdaysBetween(from, to));
}
// hours a person can realistically work in [from, to] (inclusive)
export function capacityBetween(user, from, to) {
  const days = weekdaysBetween(from, to);
  const perDay = capacityHours(user) / 5;
  return Math.max(0, Math.round((days - offDays(user.id, from, to)) * perDay * 10) / 10);
}

export function addTimeOff(actor, { user_id, start_date, end_date, kind = 'vacation', note = '' }) {
  const uid = user_id ? Number(user_id) : actor.id;
  if (uid !== actor.id && !['admin', 'manager'].includes(actor.role)) throw forbidden('Only managers can record time off for others');
  if (!get('SELECT 1 FROM users WHERE id=? AND active=1', uid)) throw notFound('User not found');
  if (!isDate(start_date) || !isDate(end_date) || start_date > end_date) throw bad('Choose a valid date range');
  if ((new Date(end_date) - new Date(start_date)) / 86400000 > 120) throw bad('Time off can be at most 120 days');
  return insert('INSERT INTO time_off(user_id,start_date,end_date,kind,note) VALUES(?,?,?,?,?)', uid, start_date, end_date, ['vacation', 'sick', 'holiday', 'other'].includes(kind) ? kind : 'other', String(note).slice(0, 100));
}
export function deleteTimeOff(actor, id) {
  const o = get('SELECT * FROM time_off WHERE id=?', id);
  if (!o) throw notFound('Not found');
  if (o.user_id !== actor.id && !['admin', 'manager'].includes(actor.role)) throw forbidden();
  run('DELETE FROM time_off WHERE id=?', id);
}

export function peopleFor(actor) {
  const seen = new Map();
  for (const p of visibleProjects(actor)) for (const m of projectMembers(p)) seen.set(m.id, m);
  return [...seen.values()];
}

export function capacityReport(actor, { from, weeks = 4 } = {}) {
  const start = mondayOf(isDate(from) ? from : todayStr());
  const n = Math.max(1, Math.min(12, Number(weeks) || 4));
  const people = peopleFor(actor);
  const ids = visibleProjects(actor).map(p => p.id);
  const users = people.length ? all(`SELECT * FROM users WHERE id IN (${people.map(p => p.id).join(',')})`) : [];
  const weekList = Array.from({ length: n }, (_, i) => addDays(start, i * 7));
  const unscheduled = {};
  const rows = users.map(u => {
    const cells = weekList.map(w => {
      const end = addDays(w, 6), friday = addDays(w, 4);
      const cap = capacityBetween(u, w, friday);
      const planned = ids.length ? get(`SELECT COALESCE(SUM(estimate),0) h, COUNT(*) n FROM tasks WHERE assignee_id=? AND project_id IN (${ids.join(',')}) AND status<>'done' AND parent_id IS NULL AND due_date BETWEEN ? AND ?`, u.id, w, end) : { h: 0, n: 0 };
      const logged = get('SELECT COALESCE(SUM(seconds),0) s FROM time_entries WHERE user_id=? AND day BETWEEN ? AND ?', u.id, w, end).s / 3600;
      return { week: w, capacity: cap, off_days: offDays(u.id, w, friday), planned: Math.round(planned.h * 10) / 10, tasks: planned.n, logged: Math.round(logged * 10) / 10, utilization: cap ? Math.round(planned.h / cap * 100) : (planned.h ? 999 : 0) };
    });
    unscheduled[u.id] = ids.length ? get(`SELECT COALESCE(SUM(estimate),0) h, COUNT(*) n FROM tasks WHERE assignee_id=? AND project_id IN (${ids.join(',')}) AND status<>'done' AND parent_id IS NULL AND due_date IS NULL`, u.id) : { h: 0, n: 0 };
    return { user_id: u.id, name: u.name, color: u.color, capacity_hours: capacityHours(u), weeks: cells, unscheduled_hours: Math.round(unscheduled[u.id].h * 10) / 10, unscheduled_tasks: unscheduled[u.id].n };
  });
  const off = users.length ? all(`SELECT o.*, u.name FROM time_off o JOIN users u ON u.id=o.user_id WHERE o.end_date>=? AND o.user_id IN (${users.map(u => u.id).join(',')}) ORDER BY o.start_date`, start) : [];
  return { start, weeks: weekList, people: rows, time_off: off };
}

// Actual vs estimated effort from finished work → "this person runs 1.3× over".
export function calibration(userId) {
  const q = userId ? 'AND t.assignee_id=?' : '';
  const rows = all(`SELECT t.estimate AS est, (SELECT SUM(seconds) FROM time_entries e WHERE e.task_id=t.id)/3600.0 AS actual FROM tasks t
    WHERE t.status='done' AND t.estimate>0 AND t.completed_at>=? ${q}`, new Date(Date.now() - 180 * 86400000).toISOString(), ...(userId ? [userId] : []))
    .filter(r => r.actual > 0);
  if (rows.length < 3) return null;
  const est = rows.reduce((a, r) => a + r.est, 0), act = rows.reduce((a, r) => a + r.actual, 0);
  return { factor: Math.round(act / est * 100) / 100, samples: rows.length };
}
