// Inbound webhooks: GitHub / GitLab (PR ↔ task sync) and incident sources (generic, Sentry, PagerDuty, Datadog).
import crypto from 'node:crypto';
import { all, get, run, insert, parseJSON } from './db.js';
import { bad, notFound, forbidden, clip, HttpError } from './util.js';
import { canManageProject } from './access.js';
import { getProject, getTask, getTaskByKey, createTask, updateTask, addComment, logActivity } from './tasks.js';
import { reviewStatus, startedStatus, statusIds } from './statuses.js';
import { seal, open } from './crypto.js';
import { audit } from './audit.js';
import { rateLimit } from './auth.js';

export const KINDS = { generic: 'Generic incident / JSON', sentry: 'Sentry', pagerduty: 'PagerDuty', datadog: 'Datadog', github: 'GitHub', gitlab: 'GitLab' };
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function createHook(user, projectId, { kind, name }, req) {
  const p = getProject(projectId);
  if (!p) throw notFound('Project not found');
  if (!canManageProject(user, p)) throw forbidden('Only project managers can add integrations');
  if (!KINDS[kind]) throw bad('Unknown integration type');
  const rand = crypto.randomBytes(24).toString('base64url');
  const secret = ['github', 'gitlab'].includes(kind) ? crypto.randomBytes(20).toString('hex') : null;
  const id = insert('INSERT INTO incoming_hooks(project_id,kind,name,token_hash,secret,created_by) VALUES(?,?,?,?,?,?)', projectId, kind, String(name || KINDS[kind]).slice(0, 60), sha(rand), secret ? seal(secret) : null, user.id);
  audit(user, 'hook.created', `${kind} → ${p.key}`, { id }, req);
  return { id, kind, path: `/api/hooks/in/${id}.${rand}`, secret }; // shown once
}
export const listHooks = (user, projectId) => {
  const p = getProject(projectId);
  if (!p || !canManageProject(user, p)) throw forbidden();
  return all('SELECT id,kind,name,last_used,created_at FROM incoming_hooks WHERE project_id=? ORDER BY id', projectId);
};
export function deleteHook(user, id) {
  const h = get('SELECT * FROM incoming_hooks WHERE id=?', id);
  if (!h) throw notFound('Integration not found');
  if (!canManageProject(user, getProject(h.project_id))) throw forbidden();
  run('DELETE FROM incoming_hooks WHERE id=?', id);
}

function resolve(token) {
  const m = String(token).match(/^(\d+)\.([A-Za-z0-9_-]{20,})$/);
  if (!m) throw new HttpError(404, 'Unknown webhook');
  const hook = get('SELECT * FROM incoming_hooks WHERE id=?', Number(m[1]));
  if (!hook || !safeEq(hook.token_hash, sha(m[2]))) throw new HttpError(404, 'Unknown webhook');
  return hook;
}

// ---------- shared helpers ----------
const KEY_RE = /\b([A-Za-z][A-Za-z0-9]{1,4})-(\d+)\b/g;
function tasksMentioned(project, ...texts) {
  const seen = new Map();
  for (const t of texts) for (const m of String(t || '').matchAll(KEY_RE)) {
    const task = getTaskByKey(`${m[1]}-${m[2]}`);
    if (task && task.project_id === project.id) seen.set(task.id, task);
  }
  return [...seen.values()];
}
function move(task, status) {
  if (!status || task.status === status || !statusIds(getProject(task.project_id)).includes(status)) return;
  try { updateTask(null, task.id, { status }, { skipPermission: true }); } catch (e) { console.error('[hook move]', e.message); }
}
const note = (task, text) => { try { addComment(null, task.id, text); } catch { /* ignore */ } };

// ---------- pull requests ----------
export function handlePullRequest(hook, pr) {
  const project = getProject(hook.project_id);
  let touched = 0;
  for (const task of tasksMentioned(project, pr.title, pr.branch, pr.body)) {
    const prev = get('SELECT * FROM task_prs WHERE task_id=? AND provider=? AND repo=? AND number=?', task.id, pr.provider, pr.repo, pr.number);
    if (prev) run("UPDATE task_prs SET title=?, url=?, state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", pr.title, pr.url, pr.state, prev.id);
    else insert('INSERT INTO task_prs(task_id,provider,repo,number,title,url,state) VALUES(?,?,?,?,?,?,?)', task.id, pr.provider, pr.repo, pr.number, pr.title, pr.url, pr.state);
    if (prev?.state === pr.state && prev.title === pr.title) continue;
    const fresh = getTask(task.id);
    if (pr.state === 'merged') {
      if (fresh.status !== 'done') move(fresh, 'done');
      note(task, `🔀 PR #${pr.number} merged — ${pr.url}`);
    } else if (pr.state === 'closed') note(task, `🚫 PR #${pr.number} closed without merging — ${pr.url}`);
    else if (!prev || prev.state !== 'open') {
      if (fresh.status_category !== 'done') move(fresh, pr.draft ? startedStatus(project) : reviewStatus(project));
      note(task, `🔧 PR #${pr.number} ${pr.draft ? 'drafted' : 'opened'}: ${pr.title} — ${pr.url}`);
    }
    logActivity(task, null, 'pr_' + pr.state, { number: pr.number });
    touched++;
  }
  return touched;
}

function handleCommits(hook, commits, repo) {
  const project = getProject(hook.project_id);
  let n = 0;
  for (const c of (commits || []).slice(0, 10)) {
    for (const task of tasksMentioned(project, c.message)) { note(task, `📝 Commit \`${String(c.id).slice(0, 7)}\` in ${repo}: ${clip(c.message.split('\n')[0], 120)} — ${c.url}`); n++; }
  }
  return n;
}

function github(hook, headers, raw, body) {
  const secret = open(hook.secret);
  const sig = headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!sig || !safeEq(sig, expected)) throw new HttpError(401, 'Bad signature');
  const ev = headers['x-github-event'];
  const repo = body.repository?.full_name || '';
  if (ev === 'ping') return { ok: true, pong: true };
  if (ev === 'pull_request') {
    const p = body.pull_request;
    if (!['opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'closed', 'edited', 'synchronize'].includes(body.action)) return { ok: true, ignored: body.action };
    return { ok: true, tasks: handlePullRequest(hook, { provider: 'github', repo, number: p.number, title: p.title, body: p.body, branch: p.head?.ref, url: p.html_url, draft: !!p.draft, state: p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open' }) };
  }
  if (ev === 'push') return { ok: true, comments: handleCommits(hook, (body.commits || []).map(c => ({ id: c.id, message: c.message, url: c.url })), repo) };
  return { ok: true, ignored: ev };
}

function gitlab(hook, headers, raw, body) {
  if (!headers['x-gitlab-token'] || !safeEq(headers['x-gitlab-token'], open(hook.secret))) throw new HttpError(401, 'Bad token');
  const repo = body.project?.path_with_namespace || '';
  if (body.object_kind === 'merge_request') {
    const a = body.object_attributes;
    return { ok: true, tasks: handlePullRequest(hook, { provider: 'gitlab', repo, number: a.iid, title: a.title, body: a.description, branch: a.source_branch, url: a.url, draft: !!(a.draft || a.work_in_progress), state: a.state === 'merged' ? 'merged' : a.state === 'closed' ? 'closed' : 'open' }) };
  }
  if (body.object_kind === 'push') return { ok: true, comments: handleCommits(hook, (body.commits || []).map(c => ({ id: c.id, message: c.message, url: c.url })), repo) };
  return { ok: true, ignored: body.object_kind };
}

// ---------- incidents ----------
const LEVEL = { fatal: 'urgent', critical: 'urgent', error: 'high', warning: 'medium', info: 'low', debug: 'low' };
const PD = { high: 'urgent', low: 'medium' };
const DD = { P1: 'urgent', P2: 'high', P3: 'medium', P4: 'low', P5: 'low' };

function normalize(kind, b) {
  if (kind === 'sentry') {
    const issue = b.data?.issue || b.issue || b;
    const title = issue.title || b.event?.title || b.message || 'Sentry issue';
    return { title: `[Sentry] ${title}`, description: [issue.culprit && `Culprit: ${issue.culprit}`, issue.metadata?.value, issue.permalink || issue.url || b.url].filter(Boolean).join('\n'), priority: LEVEL[issue.level || b.level] || 'high', fingerprint: String(issue.id || issue.shortId || b.id || title), resolve: b.action === 'resolved', labels: ['sentry', 'incident'] };
  }
  if (kind === 'pagerduty') {
    const e = b.event || b.messages?.[0] || {};
    const d = e.data || e.incident || {};
    const type = e.event_type || b.event_type || '';
    return { title: `[PagerDuty] ${d.title || d.summary || 'Incident'}`, description: [d.html_url || d.self, d.service?.summary && `Service: ${d.service.summary}`].filter(Boolean).join('\n'), priority: PD[d.urgency] || 'urgent', fingerprint: String(d.id || d.number || d.title), resolve: type === 'incident.resolved', ack: type === 'incident.acknowledged', labels: ['pagerduty', 'incident'] };
  }
  if (kind === 'datadog') {
    const title = b.title || b.event_title || b.alert_title || 'Datadog alert';
    const trans = String(b.alert_transition || b.transition || '').toLowerCase();
    return { title: `[Datadog] ${title}`, description: [b.body || b.text_only_msg, b.link || b.url].filter(Boolean).join('\n'), priority: DD[String(b.priority || '').toUpperCase()] || 'high', fingerprint: String(b.alert_id || b.aggreg_key || b.id || title), resolve: /recover|resolved|ok/.test(trans), labels: ['datadog', 'incident'] };
  }
  return { title: b.title || b.summary || 'Incident', description: [b.description || b.message, b.url].filter(Boolean).join('\n'), priority: ['urgent', 'high', 'medium', 'low'].includes(b.priority) ? b.priority : LEVEL[b.severity] || 'high', fingerprint: b.fingerprint ? String(b.fingerprint) : null, resolve: !!b.resolved, labels: Array.isArray(b.labels) ? b.labels : ['incident'] };
}

function incident(hook, body) {
  const n = normalize(hook.kind, body);
  const project = getProject(hook.project_id);
  const existing = n.fingerprint ? get('SELECT f.*, t.status FROM hook_fingerprints f JOIN tasks t ON t.id=f.task_id WHERE f.hook_id=? AND f.fingerprint=?', hook.id, n.fingerprint) : null;
  if (existing && existing.status !== 'done') {
    const task = getTask(existing.task_id);
    if (n.resolve) { move(task, 'done'); note(task, '✅ Resolved by the monitoring system.'); return { ok: true, task: task.key, action: 'resolved' }; }
    if (n.ack) { move(task, startedStatus(project)); note(task, '👀 Acknowledged.'); return { ok: true, task: task.key, action: 'acknowledged' }; }
    run('UPDATE hook_fingerprints SET occurrences=occurrences+1 WHERE hook_id=? AND fingerprint=?', hook.id, n.fingerprint);
    note(task, `🔁 Occurred again (×${existing.occurrences + 1}).`);
    return { ok: true, task: task.key, action: 'deduplicated' };
  }
  if (n.resolve || n.ack) return { ok: true, ignored: 'nothing to resolve' };
  const task = createTask(null, project.id, { title: clip(n.title, 300), description: clip(n.description, 4000), priority: n.priority, type: 'bug', labels: n.labels, reporter_id: hook.created_by }, { source: 'incident' });
  if (n.fingerprint) run('INSERT INTO hook_fingerprints(hook_id,fingerprint,task_id) VALUES(?,?,?) ON CONFLICT(hook_id,fingerprint) DO UPDATE SET task_id=excluded.task_id, occurrences=1', hook.id, n.fingerprint, task.id);
  return { ok: true, task: task.key, action: 'created' };
}

export function handleIncoming(token, headers, raw, body) {
  const hook = resolve(token);
  if (!rateLimit('hook:' + hook.id, 120)) throw new HttpError(429, 'Too many requests');
  run("UPDATE incoming_hooks SET last_used=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?", hook.id);
  if (hook.kind === 'github') return github(hook, headers, raw, body);
  if (hook.kind === 'gitlab') return gitlab(hook, headers, raw, body);
  return incident(hook, body);
}
