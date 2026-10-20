// Outgoing webhooks (JSON / Slack / Microsoft Teams) for task events.
import crypto from 'node:crypto';
import { all, get, run, insert, parseJSON } from './db.js';
import { bus } from './events.js';
import { bad, notFound, forbidden, clip } from './util.js';
import { canManageProject } from './access.js';
import { getProject } from './tasks.js';
import { safeRequest, assertUrl } from './safehttp.js';
import { audit } from './audit.js';
import { getSetting } from './db.js';

export const EVENTS = { 'task.created': 'Task created', 'task.updated': 'Task updated', 'task.status_changed': 'Status changed', 'task.assigned': 'Task assigned', 'task.completed': 'Task completed', 'task.deleted': 'Task deleted', 'comment.added': 'Comment added' };
export const FORMATS = { json: 'JSON (signed)', slack: 'Slack incoming webhook', teams: 'Microsoft Teams webhook' };

const appUrl = () => getSetting('base_url') || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function authorize(user, projectId) {
  if (projectId) { const p = getProject(projectId); if (!p) throw notFound('Project not found'); if (!canManageProject(user, p)) throw forbidden('Only project managers can manage webhooks'); }
  else if (user.role !== 'admin') throw forbidden('Workspace-wide webhooks need an admin');
}

export function listWebhooks(user, projectId) {
  authorize(user, projectId || null);
  return all(`SELECT w.*, (SELECT status FROM webhook_deliveries d WHERE d.webhook_id=w.id ORDER BY d.id DESC LIMIT 1) AS last_status
    FROM webhooks w WHERE ${projectId ? 'w.project_id=?' : 'w.project_id IS NULL'} ORDER BY w.id`, ...(projectId ? [projectId] : []))
    .map(w => ({ ...w, events: parseJSON(w.events, []), active: !!w.active, secret: undefined, url: w.url.replace(/(https?:\/\/[^/]+\/).*/, '$1…') }));
}

export function saveWebhook(user, { id, project_id = null, name, url, events, format = 'json', active = true }, req) {
  authorize(user, project_id);
  assertUrl(url);
  if (!FORMATS[format]) throw bad('Unknown format');
  const evs = (Array.isArray(events) ? events : []).filter(e => EVENTS[e]);
  if (!evs.length) throw bad('Pick at least one event');
  if (id) {
    const w = get('SELECT * FROM webhooks WHERE id=? AND project_id IS ?', id, project_id);
    if (!w) throw notFound('Webhook not found');
    run('UPDATE webhooks SET name=?, url=?, events=?, format=?, active=?, fail_count=0 WHERE id=?', String(name || '').slice(0, 60), url, JSON.stringify(evs), format, active ? 1 : 0, id);
    return { id };
  }
  const secret = crypto.randomBytes(24).toString('hex');
  const nid = insert('INSERT INTO webhooks(project_id,name,url,secret,events,format,active,created_by) VALUES(?,?,?,?,?,?,?,?)', project_id, String(name || '').slice(0, 60), url, secret, JSON.stringify(evs), format, active ? 1 : 0, user.id);
  audit(user, 'webhook.created', url.replace(/(https?:\/\/[^/]+\/).*/, '$1…'), { id: nid, project_id }, req);
  return { id: nid, secret }; // shown once
}
export function deleteWebhook(user, id) {
  const w = get('SELECT * FROM webhooks WHERE id=?', id);
  if (!w) throw notFound('Webhook not found');
  authorize(user, w.project_id);
  run('DELETE FROM webhooks WHERE id=?', id);
}
export function deliveries(user, id) {
  const w = get('SELECT * FROM webhooks WHERE id=?', id);
  if (!w) throw notFound('Webhook not found');
  authorize(user, w.project_id);
  return all('SELECT id,event,status,code,error,attempt,created_at FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 30', id);
}

// ---- payload shaping ----
function taskPayload(t) {
  return { id: t.id, key: t.key, title: t.title, status: t.status, status_label: t.status_label, priority: t.priority, type: t.type, assignee_id: t.assignee_id, due_date: t.due_date, labels: t.labels, project: t.project_key, url: `${appUrl()}/#/task/${t.id}` };
}
const person = u => (u ? u.name : 'Automation');

function summarize(event, d) {
  const t = d.task, who = person(d.actor);
  switch (event) {
    case 'task.created': return `🆕 *${t.key}* ${t.title} — created by ${who}`;
    case 'task.status_changed': return `🔄 *${t.key}* ${t.title} → *${t.status_label}* (${who})`;
    case 'task.completed': return `✅ *${t.key}* ${t.title} was completed by ${who}`;
    case 'task.assigned': return `👤 *${t.key}* ${t.title} assigned (${who})`;
    case 'task.deleted': return `🗑️ *${t.key}* ${t.title} was deleted by ${who}`;
    case 'comment.added': return `💬 ${who} on *${t.key}*: ${clip(d.comment?.body, 200)}`;
    default: return `✏️ *${t.key}* ${t.title} updated by ${who}`;
  }
}

function shape(w, event, d) {
  const link = `${appUrl()}/#/task/${d.task.id}`;
  if (w.format === 'slack') return { text: summarize(event, d), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${summarize(event, d)}\n<${link}|Open in TaskBoard>` } }] };
  if (w.format === 'teams') return { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: summarize(event, d).replace(/\*/g, ''), themeColor: '5B5BF0', title: `${d.task.key} · ${d.task.title}`, text: summarize(event, d).replace(/\*/g, '**'), potentialAction: [{ '@type': 'OpenUri', name: 'Open in TaskBoard', targets: [{ os: 'default', uri: link }] }] };
  return { event, timestamp: new Date().toISOString(), actor: d.actor ? { id: d.actor.id, name: d.actor.name } : null, task: taskPayload(d.task), changes: d.changes || undefined, comment: d.comment ? { id: d.comment.id, body: d.comment.body } : undefined };
}

export const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
const BACKOFF = [0, 1500, 8000];

async function deliver(w, event, payload, attempt = 1) {
  const body = JSON.stringify(payload);
  let status = 'failed', code = null, error = null;
  try {
    const r = await safeRequest(w.url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'User-Agent': 'TaskBoard-Webhook/1.0', 'X-TaskBoard-Event': event, 'X-TaskBoard-Delivery': crypto.randomUUID(), 'X-TaskBoard-Signature': sign(w.secret, body) } });
    code = r.status;
    status = r.status >= 200 && r.status < 300 ? 'ok' : 'failed';
    if (status === 'failed') error = clip(r.body, 200) || `HTTP ${r.status}`;
  } catch (e) { error = e.message; }
  insert('INSERT INTO webhook_deliveries(webhook_id,event,status,code,error,attempt) VALUES(?,?,?,?,?,?)', w.id, event, status, code, error, attempt);
  if (status === 'ok') run('UPDATE webhooks SET fail_count=0 WHERE id=?', w.id);
  else if (attempt < BACKOFF.length && !(code >= 400 && code < 500 && code !== 429)) setTimeout(() => deliver(w, event, payload, attempt + 1), BACKOFF[attempt]).unref();
  else {
    run('UPDATE webhooks SET fail_count=fail_count+1 WHERE id=?', w.id);
    if (get('SELECT fail_count FROM webhooks WHERE id=?', w.id)?.fail_count >= 20) run('UPDATE webhooks SET active=0 WHERE id=?', w.id);
  }
  run('DELETE FROM webhook_deliveries WHERE id NOT IN (SELECT id FROM webhook_deliveries ORDER BY id DESC LIMIT 1000)');
  return { status, code, error };
}

export function dispatch(event, d) {
  const projectId = d.task?.project_id;
  for (const w of all('SELECT * FROM webhooks WHERE active=1 AND (project_id=? OR project_id IS NULL)', projectId)) {
    if (!parseJSON(w.events, []).includes(event)) continue;
    deliver(w, event, shape(w, event, d)).catch(() => {});
  }
}

export async function sendTest(user, id) {
  const w = get('SELECT * FROM webhooks WHERE id=?', id);
  if (!w) throw notFound('Webhook not found');
  authorize(user, w.project_id);
  const task = { id: 0, key: 'TEST-1', title: 'Test event from TaskBoard', status: 'todo', status_label: 'To do', priority: 'medium', type: 'task', labels: [], project_key: 'TEST', project_id: w.project_id };
  return deliver(w, 'task.created', shape(w, 'task.created', { task, actor: user }));
}

bus.on('task.created', d => dispatch('task.created', d));
bus.on('task.deleted', d => dispatch('task.deleted', d));
bus.on('comment.added', d => dispatch('comment.added', d));
bus.on('task.updated', d => {
  dispatch('task.updated', d);
  if (d.changes.status) { dispatch('task.status_changed', d); if (d.task.status === 'done') dispatch('task.completed', d); }
  if (d.changes.assignee_id && d.task.assignee_id) dispatch('task.assigned', d);
});
