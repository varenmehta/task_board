import { all } from './db.js';
import { visibleProjects } from './access.js';
import { addDays, todayStr } from './util.js';
import { parseJSON } from './db.js';

const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

function scope(user, { project_id, team_id }) {
  let ps = visibleProjects(user);
  if (team_id) ps = ps.filter(p => p.team_id === Number(team_id));
  if (project_id) ps = ps.filter(p => p.id === Number(project_id));
  return ps.map(p => p.id);
}

export function report(user, q) {
  const ids = scope(user, q);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : todayStr();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(to, -29);
  if (!ids.length) return { from, to, empty: true, weekly: [], people: [], labels: [], aging: [], summary: {} };
  const list = ids.join(',');
  const done = all(`SELECT t.id, t.type, t.labels, t.assignee_id, t.estimate, t.created_at, t.completed_at, u.name AS assignee
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.project_id IN (${list}) AND t.parent_id IS NULL AND t.status='done' AND substr(t.completed_at,1,10) BETWEEN ? AND ?`, from, to);
  const created = all(`SELECT substr(created_at,1,10) d FROM tasks WHERE project_id IN (${list}) AND parent_id IS NULL AND substr(created_at,1,10) BETWEEN ? AND ?`, from, to);
  const time = all(`SELECT e.user_id, u.name, e.day, e.seconds, e.task_id FROM time_entries e JOIN tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.user_id
    WHERE t.project_id IN (${list}) AND e.day BETWEEN ? AND ?`, from, to);

  const cycle = t => Math.max(0, days(t.created_at, t.completed_at));
  // weekly buckets starting Monday
  const weekStart = d => { const dt = new Date(d + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); return dt.toISOString().slice(0, 10); };
  const weeks = new Map();
  const bucket = d => { const w = weekStart(d); if (!weeks.has(w)) weeks.set(w, { week: w, created: 0, completed: 0, cycle: [] }); return weeks.get(w); };
  for (const c of created) bucket(c.d).created++;
  for (const t of done) { const b = bucket(t.completed_at.slice(0, 10)); b.completed++; b.cycle.push(cycle(t)); }

  const people = new Map();
  const person = (id, name) => { const k = id ?? 0; if (!people.has(k)) people.set(k, { user_id: id, name: name || 'Unassigned', completed: 0, hours_estimated: 0, cycle: [], seconds: 0 }); return people.get(k); };
  for (const t of done) { const p = person(t.assignee_id, t.assignee); p.completed++; p.hours_estimated += t.estimate || 0; p.cycle.push(cycle(t)); }
  for (const e of time) person(e.user_id, e.name).seconds += e.seconds;

  const labels = new Map();
  for (const t of done) for (const l of parseJSON(t.labels, [])) labels.set(l, (labels.get(l) || 0) + 1);

  const open = all(`SELECT created_at FROM tasks WHERE project_id IN (${list}) AND parent_id IS NULL AND status<>'done'`);
  const buckets = [['0-3 days', 0, 3], ['4-7 days', 4, 7], ['8-14 days', 8, 14], ['15-30 days', 15, 30], ['30+ days', 31, 1e9]];
  const aging = buckets.map(([label, lo, hi]) => ({ label, count: open.filter(t => { const a = days(t.created_at, new Date().toISOString()); return a >= lo && a < hi + 1; }).length }));

  const types = new Map();
  for (const t of done) { const x = types.get(t.type) || []; x.push(cycle(t)); types.set(t.type, x); }
  const all_cycle = done.map(cycle);

  return {
    from, to, project_ids: ids,
    summary: {
      created: created.length, completed: done.length, open: open.length,
      cycle_avg: round(avg(all_cycle)), cycle_median: round(median(all_cycle)),
      hours_logged: round(time.reduce((a, e) => a + e.seconds, 0) / 3600),
    },
    weekly: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map(w => ({ week: w.week, created: w.created, completed: w.completed, cycle_avg: round(avg(w.cycle)) })),
    people: [...people.values()].map(p => ({ user_id: p.user_id, name: p.name, completed: p.completed, hours_estimated: round(p.hours_estimated), hours_logged: round(p.seconds / 3600), cycle_avg: round(avg(p.cycle)) })).sort((a, b) => b.completed - a.completed),
    labels: [...labels.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    types: [...types.entries()].map(([type, xs]) => ({ type, count: xs.length, cycle_avg: round(avg(xs)) })),
    aging,
  };
}

// CSV with spreadsheet-formula neutralisation (cells starting with = + - @ are prefixed)
const cell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';

export function exportCsv(user, q) {
  const ids = scope(user, q);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : todayStr();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(to, -29);
  if (!ids.length) return toCsv(['No data'], []);
  const list = ids.join(',');
  if (q.type === 'time') {
    const rows = all(`SELECT e.day, u.name, p.key || '-' || t.number AS task, t.title, ROUND(e.seconds/3600.0,2) AS hours, e.note FROM time_entries e
      JOIN tasks t ON t.id=e.task_id JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=e.user_id
      WHERE t.project_id IN (${list}) AND e.day BETWEEN ? AND ? ORDER BY e.day, u.name`, from, to);
    return toCsv(['Date', 'Person', 'Task', 'Title', 'Hours', 'Note'], rows.map(r => [r.day, r.name, r.task, r.title, r.hours, r.note]));
  }
  const rows = all(`SELECT p.key || '-' || t.number AS key, t.title, t.type, t.status, t.priority, u.name AS assignee, r.name AS reporter, t.estimate, t.due_date, t.created_at, t.completed_at, t.labels
    FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN users r ON r.id=t.reporter_id
    WHERE t.project_id IN (${list}) AND (substr(t.created_at,1,10) BETWEEN ? AND ? OR substr(COALESCE(t.completed_at,''),1,10) BETWEEN ? AND ?) ORDER BY t.id`, from, to, from, to);
  return toCsv(['Key', 'Title', 'Type', 'Status', 'Priority', 'Assignee', 'Reporter', 'Estimate (h)', 'Due', 'Created', 'Completed', 'Labels'],
    rows.map(r => [r.key, r.title, r.type, r.status, r.priority, r.assignee, r.reporter, r.estimate, r.due_date, r.created_at, r.completed_at, parseJSON(r.labels, []).join(' ')]));
}
