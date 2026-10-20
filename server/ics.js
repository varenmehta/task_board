// Personal iCalendar feed: due dates + sprint boundaries. Subscribe from Google/Apple/Outlook calendar.
import crypto from 'node:crypto';
import { all, get, run, getSetting } from './db.js';
import { listAssigned } from './tasks.js';
import { visibleProjects } from './access.js';
import { addDays } from './util.js';

const esc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const day = d => d.replace(/-/g, '');
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

export function ensureToken(userId) {
  let t = get('SELECT calendar_token FROM users WHERE id=?', userId)?.calendar_token;
  if (!t) { t = crypto.randomBytes(24).toString('base64url'); run('UPDATE users SET calendar_token=? WHERE id=?', t, userId); }
  return t;
}
export const rotateToken = userId => { run('UPDATE users SET calendar_token=NULL WHERE id=?', userId); return ensureToken(userId); };

export function buildCalendar(token, host) {
  const user = get('SELECT * FROM users WHERE calendar_token=? AND active=1', token);
  if (!user) return null;
  const base = getSetting('base_url') || `http://${host}`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TaskBoard//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc('TaskBoard — ' + user.name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const ev = (uid, date, summary, desc, url) => lines.push('BEGIN:VEVENT', `UID:${uid}@taskboard`, `DTSTAMP:${stamp()}`, `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(addDays(date, 1))}`, `SUMMARY:${esc(summary)}`, ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []), ...(url ? [`URL:${url}`] : []), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  for (const t of listAssigned(user.id)) if (t.due_date && t.status !== 'done') ev(`task-${t.id}`, t.due_date, `[${t.key}] ${t.title}`, `${t.project_name} · ${t.priority} priority`, `${base}/#/task/${t.id}`);
  const ids = visibleProjects(user).map(p => p.id);
  if (ids.length) for (const s of all(`SELECT s.*, p.name AS project_name FROM sprints s JOIN projects p ON p.id=s.project_id WHERE s.project_id IN (${ids.join(',')}) AND s.state<>'closed'`)) {
    if (s.start_date) ev(`sprint-start-${s.id}`, s.start_date, `🏁 ${s.name} starts`, `${s.project_name}${s.goal ? ' — ' + s.goal : ''}`);
    if (s.end_date) ev(`sprint-end-${s.id}`, s.end_date, `🏁 ${s.name} ends`, s.project_name);
  }
  for (const r of all(`SELECT r.*, p.name AS project_name FROM releases r JOIN projects p ON p.id=r.project_id WHERE r.project_id IN (${ids.join(',') || 0}) AND r.state='planned' AND r.date IS NOT NULL`)) ev(`release-${r.id}`, r.date, `🚀 Release ${r.name} ${r.version}`.trim(), r.project_name);
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
