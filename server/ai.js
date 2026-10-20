// AI features. Uses Claude when an API key is configured, and falls back to
// deterministic local heuristics so every feature still works offline.
import { getSetting } from './db.js';
import { addDays, todayStr, handleOf, clip } from './util.js';

export const aiMode = () => (getSetting('anthropic_api_key') ? 'claude' : 'local');

async function claude({ system, prompt, maxTokens = 1500 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': getSetting('anthropic_api_key'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: getSetting('anthropic_model') || 'claude-sonnet-5-5', max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Claude API error ${r.status}`);
  return j.content?.map(c => c.text || '').join('') || '';
}

function parseJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = (m ? m[1] : text).trim();
  const start = Math.min(...['{', '['].map(c => { const i = s.indexOf(c); return i < 0 ? Infinity : i; }));
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return JSON.parse(s.slice(start, end + 1));
}

const SYSTEM = `You are the AI assistant inside TaskBoard, a project management tool for software teams.
Be concise, concrete and practical. Priorities: urgent, high, medium, low. Statuses: backlog, todo, in_progress, review, done.
When asked for JSON, reply with JSON only — no prose, no markdown fences.`;

async function ask(prompt, { json = false, maxTokens } = {}) {
  const text = await claude({ system: SYSTEM, prompt, maxTokens });
  return json ? parseJson(text) : text.trim();
}

// ---------- context helpers ----------
export function boardSnapshot({ project, tasks, members, today }) {
  const names = new Map(members.map(m => [m.id, m.name]));
  return [
    `Today: ${today}`, project ? `Project: ${project.name} (${project.key})` : '',
    `Team: ${members.map(m => `${m.name} [id ${m.id}]`).join(', ')}`,
    'Tasks (key | title | status | priority | assignee | due | labels):',
    ...tasks.slice(0, 150).map(t => `${t.key} | ${clip(t.title, 90)} | ${t.status} | ${t.priority} | ${names.get(t.assignee_id) || 'unassigned'} | ${t.due_date || '-'} | ${t.labels.join(',') || '-'}`),
  ].filter(Boolean).join('\n');
}

const open = t => t.status !== 'done';
const overdue = (t, today) => open(t) && t.due_date && t.due_date < today;

// ---------- 1. natural language -> task draft ----------
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function parseDate(text, today) {
  const t = text.toLowerCase();
  const base = new Date(today + 'T00:00:00Z');
  let m;
  if ((m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/))) return { date: m[1], raw: m[0] };
  if (/\btoday\b|\beod\b/.test(t)) return { date: today, raw: t.match(/\btoday\b|\beod\b/)[0] };
  if (/\btomorrow\b|\btmrw\b/.test(t)) return { date: addDays(today, 1), raw: t.match(/\btomorrow\b|\btmrw\b/)[0] };
  if ((m = t.match(/\bin (\d+) (day|week)s?\b/))) return { date: addDays(today, +m[1] * (m[2] === 'week' ? 7 : 1)), raw: m[0] };
  if (/\bnext week\b/.test(t)) return { date: addDays(today, 7), raw: 'next week' };
  if (/\bend of (the )?week\b|\beow\b/.test(t)) return { date: addDays(today, (5 - base.getUTCDay() + 7) % 7 || 7), raw: t.match(/\bend of (the )?week\b|\beow\b/)[0] };
  if ((m = t.match(/\b(?:by |on |next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/))) {
    const want = DOW.indexOf(m[1]);
    const diff = ((want - base.getUTCDay() + 7) % 7) || 7;
    return { date: addDays(today, diff), raw: m[0] };
  }
  return { date: null, raw: '' };
}

export function localParseTask(text, { members = [], today = todayStr() } = {}) {
  let rest = ' ' + text + ' ';
  const out = { title: '', description: '', priority: 'medium', assignee_id: null, due_date: null, labels: [], estimate: null };

  const bang = rest.match(/!(urgent|high|medium|low)\b/i);
  if (bang) { out.priority = bang[1].toLowerCase(); rest = rest.replace(bang[0], ' '); }
  else {
    const prio = rest.match(/\b(p0|urgent|asap|critical|blocker)\b|\b(p1|high priority|high-priority|important)\b|\b(p3|low priority|low-priority|nice to have)\b/i);
    if (prio) {
      out.priority = prio[1] ? 'urgent' : prio[2] ? 'high' : 'low';
      rest = rest.replace(prio[0], ' ');
    }
  }

  for (const m of rest.matchAll(/#([a-z0-9][\w-]*)/gi)) out.labels.push(m[1].toLowerCase());
  rest = rest.replace(/#[a-z0-9][\w-]*/gi, ' ');

  const at = rest.match(/@([a-z0-9._-]+)/i);
  if (at) {
    const h = at[1].toLowerCase();
    const u = members.find(m => handleOf(m.name) === h) || members.find(m => m.name.toLowerCase().split(' ')[0] === h);
    if (u) { out.assignee_id = u.id; rest = rest.replace(at[0], ' '); }
    else { out.description = `Requested assignee: ${at[0]} (not a member of this project).`; rest = rest.replace(at[0], ' '); }
  }
  const asg = rest.match(/\b(?:assign(?:ed)? to|for) ([a-z]+)\b/i);
  if (asg && !out.assignee_id) {
    const u = members.find(m => m.name.toLowerCase().split(' ')[0] === asg[1].toLowerCase());
    if (u) { out.assignee_id = u.id; rest = rest.replace(asg[0], ' '); }
  }

  const est = rest.match(/\b(\d+(?:\.\d+)?)\s?(h|hrs?|hours?|pts?|points?|sp)\b/i);
  if (est) { out.estimate = Number(est[1]); rest = rest.replace(est[0], ' '); }

  const d = parseDate(rest, today);
  if (d.date) { out.due_date = d.date; rest = rest.replace(new RegExp('\\b(?:by |on |due )?' + d.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), ' '); }

  out.title = rest.replace(/\bdue\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,:;-]+|[\s,:;-]+$/g, '');
  out.title = out.title.charAt(0).toUpperCase() + out.title.slice(1);
  return out;
}

export async function parseTask(text, ctx) {
  const local = localParseTask(text, ctx);
  if (aiMode() === 'local') return { ...local, ai: false };
  try {
    const j = await ask(`Turn this request into a task. Today is ${ctx.today}.
Team members: ${ctx.members.map(m => `${m.name} [id ${m.id}]`).join(', ') || 'none'}.
Request: """${text}"""
Return JSON: {"title": string (imperative, <=80 chars), "description": string (1-3 sentences of useful context, or "" if the request has nothing more), "priority": "urgent|high|medium|low", "assignee_id": number|null (only if a team member is clearly named), "due_date": "YYYY-MM-DD"|null, "labels": string[] (max 3, lowercase), "estimate": number|null (hours)}`, { json: true });
    return {
      title: clip(j.title || local.title, 300), description: j.description || '',
      priority: ['urgent', 'high', 'medium', 'low'].includes(j.priority) ? j.priority : local.priority,
      assignee_id: ctx.members.some(m => m.id === j.assignee_id) ? j.assignee_id : local.assignee_id,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(j.due_date || '') ? j.due_date : local.due_date,
      labels: Array.isArray(j.labels) ? j.labels.slice(0, 3).map(String) : local.labels,
      estimate: Number.isFinite(j.estimate) ? j.estimate : local.estimate, ai: true,
    };
  } catch (e) { return { ...local, ai: false, warning: e.message }; }
}

// ---------- 2. break a task into subtasks ----------
export async function breakdown(task) {
  const generic = ['Clarify requirements & acceptance criteria', 'Design / spike the approach', 'Implement', 'Write automated tests', 'Code review & QA', 'Deploy & monitor'];
  if (aiMode() === 'local') return { ai: false, subtasks: generic.map(title => ({ title })) };
  try {
    const j = await ask(`Break this software task into 3-7 concrete, independently completable subtasks, ordered logically.
Task: ${task.title}\nDescription: ${task.description || '(none)'}\nLabels: ${task.labels.join(', ') || '-'}
Return JSON: {"subtasks":[{"title": string (<=90 chars, starts with a verb)}]}`, { json: true });
    return { ai: true, subtasks: (j.subtasks || []).slice(0, 8).map(s => ({ title: clip(s.title, 200) })) };
  } catch (e) { return { ai: false, warning: e.message, subtasks: generic.map(title => ({ title })) }; }
}

// ---------- 3. improve a description ----------
export async function improveDescription(task) {
  const local = `${task.description || task.title}\n\n**Acceptance criteria**\n- [ ] Behaviour matches the description\n- [ ] Tests added/updated\n- [ ] Reviewed and deployed`;
  if (aiMode() === 'local') return { ai: false, description: local };
  try {
    const text = await ask(`Rewrite this task description so an engineer can pick it up without asking questions.
Keep it short: a one-paragraph summary, then "Acceptance criteria" as a checklist ("- [ ] ..."), and "Notes" only if useful. Do not invent facts; flag open questions instead.
Title: ${task.title}\nCurrent description: ${task.description || '(empty)'}`, { maxTokens: 900 });
    return { ai: true, description: text };
  } catch (e) { return { ai: false, warning: e.message, description: local }; }
}

// ---------- 4. suggest priority / estimate / assignee ----------
export async function suggest({ task, members, workload, today }) {
  const t = `${task.title} ${task.description}`.toLowerCase();
  const priority = /(outage|prod|security|data loss|crash|critical|urgent|blocker)/.test(t) ? 'urgent' : /(bug|regression|fail|broken|customer)/.test(t) ? 'high' : /(refactor|cleanup|docs|typo|nice)/.test(t) ? 'low' : 'medium';
  const least = [...members].sort((a, b) => (workload[a.id] || 0) - (workload[b.id] || 0))[0];
  const local = {
    ai: false, priority, estimate: Math.min(16, Math.max(1, Math.round((task.title.split(' ').length + task.description.length / 80) / 2))),
    assignee_id: least?.id ?? null, reason: `${least?.name ?? 'Nobody'} has the lightest open workload (${workload[least?.id] || 0} open tasks).`,
  };
  if (aiMode() === 'local') return local;
  try {
    const j = await ask(`Suggest priority, estimate (hours) and the best assignee for this task, balancing workload.
Today ${today}. Task: ${task.title}\nDescription: ${task.description || '(none)'}
Team & open tasks per person: ${members.map(m => `${m.name} [id ${m.id}] ${workload[m.id] || 0}`).join('; ')}
Return JSON: {"priority":"urgent|high|medium|low","estimate":number,"assignee_id":number|null,"reason":string (1-2 sentences)}`, { json: true });
    return {
      ai: true, priority: ['urgent', 'high', 'medium', 'low'].includes(j.priority) ? j.priority : local.priority,
      estimate: Number.isFinite(j.estimate) ? j.estimate : local.estimate,
      assignee_id: members.some(m => m.id === j.assignee_id) ? j.assignee_id : local.assignee_id, reason: j.reason || local.reason,
    };
  } catch (e) { return { ...local, warning: e.message }; }
}

// ---------- 5. risks ----------
export function localRisks({ tasks, members, today }) {
  const names = new Map(members.map(m => [m.id, m.name]));
  const risks = [];
  const staleCut = Date.now() - 5 * 86400_000;
  for (const t of tasks.filter(open)) {
    if (overdue(t, today)) risks.push({ key: t.key, task_id: t.id, level: 'high', reason: `Overdue since ${t.due_date}${t.assignee_id ? ` (${names.get(t.assignee_id)})` : ' and unassigned'}.` });
    else if (t.due_date && t.due_date <= addDays(today, 2) && t.status === 'todo') risks.push({ key: t.key, task_id: t.id, level: 'medium', reason: `Due ${t.due_date} but work hasn't started.` });
    else if (t.status === 'in_progress' && new Date(t.updated_at).getTime() < staleCut) risks.push({ key: t.key, task_id: t.id, level: 'medium', reason: 'In progress with no updates for 5+ days.' });
    else if (!t.assignee_id && ['urgent', 'high'].includes(t.priority)) risks.push({ key: t.key, task_id: t.id, level: 'medium', reason: `${t.priority} priority with no owner.` });
  }
  const load = {};
  for (const t of tasks.filter(open)) if (t.assignee_id) load[t.assignee_id] = (load[t.assignee_id] || 0) + 1;
  const avg = Object.values(load).reduce((a, b) => a + b, 0) / (Object.keys(load).length || 1);
  for (const [id, n] of Object.entries(load)) if (n >= 6 && n > avg * 1.6) risks.push({ key: null, task_id: null, level: 'medium', reason: `${names.get(+id)} carries ${n} open tasks (team average ${avg.toFixed(1)}).` });
  return risks.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1)).slice(0, 12);
}

export async function risks(ctx) {
  const local = localRisks(ctx);
  if (aiMode() === 'local') return { ai: false, risks: local, summary: local.length ? `${local.length} item${local.length > 1 ? 's' : ''} need attention.` : 'Nothing looks at risk right now.' };
  try {
    const j = await ask(`${boardSnapshot(ctx)}\n\nIdentify the delivery risks a team lead should act on today (overdue work, stalled tasks, unowned urgent work, overloaded people, deadline clusters).
Return JSON: {"summary": string (1-2 sentences), "risks":[{"key": string|null (task key), "level":"high|medium", "reason": string (<=140 chars, include a suggested action)}]} with at most 8 risks.`, { json: true });
    const byKey = new Map(ctx.tasks.map(t => [t.key, t]));
    return { ai: true, summary: j.summary || '', risks: (j.risks || []).slice(0, 8).map(r => ({ key: r.key || null, task_id: byKey.get(r.key)?.id ?? null, level: r.level === 'high' ? 'high' : 'medium', reason: String(r.reason || '') })) };
  } catch (e) { return { ai: false, warning: e.message, risks: local, summary: '' }; }
}

// ---------- 6. standup / status summary ----------
export function localSummary({ tasks, members, today, project }) {
  const names = new Map(members.map(m => [m.id, m.name]));
  const wk = Date.now() - 7 * 86400_000;
  const doneRecently = tasks.filter(t => t.status === 'done' && t.completed_at && new Date(t.completed_at).getTime() > wk);
  const inProg = tasks.filter(t => t.status === 'in_progress');
  const od = tasks.filter(t => overdue(t, today));
  const lines = [`**${project?.name || 'Overview'} — status for ${today}**`, ''];
  lines.push(`✅ **Shipped this week (${doneRecently.length})**`, ...(doneRecently.slice(0, 6).map(t => `- ${t.key} ${t.title}${t.assignee_id ? ` — ${names.get(t.assignee_id)}` : ''}`) || []), '');
  lines.push(`🚧 **In progress (${inProg.length})**`, ...inProg.slice(0, 8).map(t => `- ${t.key} ${t.title}${t.assignee_id ? ` — ${names.get(t.assignee_id)}` : ''}`), '');
  lines.push(`⚠️ **Needs attention (${od.length} overdue)**`, ...(od.length ? od.slice(0, 6).map(t => `- ${t.key} ${t.title} (due ${t.due_date})`) : ['- Nothing overdue']));
  return lines.join('\n');
}

export async function summary(ctx) {
  const local = localSummary(ctx);
  if (aiMode() === 'local') return { ai: false, text: local };
  try {
    const text = await ask(`${boardSnapshot(ctx)}\n\nWrite a crisp standup / status update for stakeholders in Markdown: "Shipped", "In progress", "Blockers & risks", "Next up". Use task keys. Max ~180 words. Don't invent work not on the board.`, { maxTokens: 700 });
    return { ai: true, text };
  } catch (e) { return { ai: false, warning: e.message, text: local }; }
}

// ---------- 7. chat over the board ----------
export async function chat({ message, history = [], ...ctx }) {
  const m = message.trim();
  const lower = m.toLowerCase();
  if (aiMode() === 'local') {
    const create = lower.match(/^(?:create|add|new)(?: a)?(?: task)?[:\s]+(.+)/is);
    if (create) return { ai: false, type: 'create', answer: 'Here is the task I drafted — review it and hit Create.', draft: localParseTask(create[1], ctx) };
    if (/risk|overdue|late|behind|blocked/.test(lower)) { const r = localRisks(ctx); return { ai: false, type: 'answer', answer: r.length ? r.map(x => `• ${x.key || 'Team'}: ${x.reason}`).join('\n') : 'Nothing looks at risk right now. 🎉' }; }
    if (/summary|standup|status|update|progress/.test(lower)) return { ai: false, type: 'answer', answer: localSummary(ctx) };
    if (/my (tasks|work)|assigned to me|what should i/.test(lower) && ctx.me) {
      const mine = ctx.tasks.filter(t => t.assignee_id === ctx.me.id && open(t)).sort((a, b) => (a.due_date || '9') < (b.due_date || '9') ? -1 : 1);
      return { ai: false, type: 'answer', answer: mine.length ? `You have ${mine.length} open task${mine.length > 1 ? 's' : ''}:\n` + mine.slice(0, 8).map(t => `• ${t.key} ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n') : 'You have no open tasks assigned. 🎉' };
    }
    return { ai: false, type: 'answer', answer: 'I can create tasks ("create fix login bug tomorrow !high @priya"), summarise status, and flag risks. Add an Anthropic API key in Settings → Workspace to unlock open-ended questions.' };
  }
  try {
    const j = await ask(`${boardSnapshot(ctx)}\n\nCurrent user: ${ctx.me?.name} [id ${ctx.me?.id}]\n${history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n')}\nuser: ${m}\n
Decide: does the user want to CREATE a task, or just get an ANSWER about the board? Answer using only the data above; reference task keys. Keep answers short (use "•" bullets).
Return JSON: {"type":"answer","answer":string} or {"type":"create","answer":string (one short sentence),"draft":{"title":string,"description":string,"priority":"urgent|high|medium|low","assignee_id":number|null,"due_date":"YYYY-MM-DD"|null,"labels":string[],"estimate":number|null}}`, { json: true, maxTokens: 900 });
    if (j.type === 'create' && j.draft?.title) {
      const d = j.draft;
      return { ai: true, type: 'create', answer: j.answer || 'Here is the task I drafted.', draft: { title: d.title, description: d.description || '', priority: ['urgent', 'high', 'medium', 'low'].includes(d.priority) ? d.priority : 'medium', assignee_id: ctx.members.some(x => x.id === d.assignee_id) ? d.assignee_id : null, due_date: /^\d{4}-\d{2}-\d{2}$/.test(d.due_date || '') ? d.due_date : null, labels: Array.isArray(d.labels) ? d.labels.slice(0, 3) : [], estimate: Number.isFinite(d.estimate) ? d.estimate : null } };
    }
    return { ai: true, type: 'answer', answer: String(j.answer || '') };
  } catch (e) { return { ai: false, type: 'answer', answer: `The AI service is unavailable right now (${e.message}).` }; }
}

// ---------- 8. daily briefing blurb ----------
export async function briefingBlurb({ user, mine, today }) {
  if (aiMode() === 'local' || !mine.length) return '';
  try {
    return await ask(`Write a friendly 2-sentence morning briefing for ${user.name} (today is ${today}). Mention what to tackle first and any risk. Their open tasks:\n${mine.slice(0, 25).map(t => `${t.key} | ${t.title} | ${t.status} | ${t.priority} | due ${t.due_date || '-'}`).join('\n')}`, { maxTokens: 200 });
  } catch { return ''; }
}

// ---------- 9. email -> task ----------
export async function emailToTask({ subject, body, from }, ctx) {
  const text = `${subject}\n${body}`.trim();
  const base = await parseTask(`${subject}${body ? `\n\n${clip(body, 1500)}` : ''}`, ctx);
  const local = localParseTask(subject, ctx);
  return { ...base, title: local.title || base.title, description: `${clip(body, 4000)}${body ? '\n\n' : ''}— via email from ${from}`.trim(), _text: text };
}


// ---------- 10. release notes ----------
export async function releaseNotes(release, tasks, local) {
  const done = tasks.filter(t => t.status === 'done');
  if (aiMode() === 'local' || !done.length) return { ai: false, notes: local };
  try {
    const text = await ask(`Write polished, user-facing release notes in Markdown for "${release.name}${release.version ? ' ' + release.version : ''}".
Group into New / Improvements / Fixes (omit empty groups), one friendly line per item, keep task keys in parentheses. Don't invent features.
Shipped items:\n${done.map(t => `${t.ref} | ${t.type} | ${t.title}`).join('\n')}`, { maxTokens: 900 });
    return { ai: true, notes: text };
  } catch (e) { return { ai: false, warning: e.message, notes: local }; }
}

// =====================================================================
// Phase 4 — triage, duplicates, notes → tasks, natural-language search, sprint planning
// =====================================================================
const STOP = new Set('the a an and or of to for in on at by with from is are be this that it as we our i you your my me please need needs should would could can add fix update make new task issue'.split(' '));
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, ''));

// ---------- auto-triage ----------
const LABEL_RULES = [['bug', /\b(bug|crash|error|exception|regression|broken|fails?|failing|500|stack ?trace)\b/i], ['security', /\b(security|vulnerab|xss|csrf|cve|auth bypass|leak|token)\b/i], ['performance', /\b(slow|latency|perf|performance|timeout|memory|cpu)\b/i], ['docs', /\b(docs?|documentation|readme|guide)\b/i], ['ui', /\b(ui|ux|css|layout|button|modal|style|responsive)\b/i], ['infra', /\b(deploy|ci|pipeline|kubernetes|terraform|docker|infra|aws|gcp)\b/i], ['tech-debt', /\b(refactor|cleanup|tech debt|deprecat|migrat)\b/i]];
export function localTriage(task, { members = [], workload = {} } = {}) {
  const t = `${task.title} ${task.description || ''}`;
  const priority = /\b(outage|prod(uction)? (down|issue)|data loss|security|critical|urgent|blocker|p0)\b/i.test(t) ? 'urgent' : /\b(bug|regression|customer|broken|crash|fail)/i.test(t) ? 'high' : /\b(refactor|cleanup|docs?|typo|nice to have|polish)\b/i.test(t) ? 'low' : 'medium';
  const labels = LABEL_RULES.filter(([, re]) => re.test(t)).map(([l]) => l).slice(0, 3);
  const type = labels.includes('bug') ? 'bug' : 'task';
  const least = [...members].sort((a, b) => (workload[a.id] || 0) - (workload[b.id] || 0))[0];
  return { priority, labels, type, assignee_id: least?.id ?? null, reason: `Keywords suggest ${priority} priority${labels.length ? ` (${labels.join(', ')})` : ''}${least ? `; ${least.name} has the lightest workload.` : '.'}` };
}
export async function triage(task, ctx) {
  const local = localTriage(task, ctx);
  if (aiMode() === 'local') return { ...local, ai: false };
  try {
    const j = await ask(`Triage this new software task. Today ${ctx.today}.
Title: ${task.title}\nDescription: ${task.description || '(none)'}
Team (open tasks): ${ctx.members.map(m => `${m.name} [id ${m.id}] ${ctx.workload[m.id] || 0}`).join('; ')}
Return JSON: {"priority":"urgent|high|medium|low","type":"task|bug|story","labels":string[] (max 3, lowercase),"assignee_id":number|null (balance workload; null if unclear),"reason":string (one sentence)}`, { json: true });
    return { ai: true, priority: ['urgent', 'high', 'medium', 'low'].includes(j.priority) ? j.priority : local.priority, type: ['task', 'bug', 'story'].includes(j.type) ? j.type : local.type, labels: Array.isArray(j.labels) ? j.labels.slice(0, 3).map(l => String(l).toLowerCase()) : local.labels, assignee_id: ctx.members.some(m => m.id === j.assignee_id) ? j.assignee_id : local.assignee_id, reason: j.reason || local.reason };
  } catch { return { ...local, ai: false }; }
}

// ---------- duplicates ----------
const trigrams = s => { const t = ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `; const set = new Set(); for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3)); return set; };
const dice = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return 2 * n / (a.size + b.size); };
export function findDuplicates(title, description, tasks, { limit = 5, threshold = 0.5 } = {}) {
  const tw = new Set(words(title + ' ' + (description || '').slice(0, 200))), tg = trigrams(title);
  return tasks.map(t => {
    const ow = new Set(words(t.title + ' ' + (t.description || '').slice(0, 200)));
    const inter = [...tw].filter(w => ow.has(w)).length;
    const jac = tw.size && ow.size ? inter / (tw.size + ow.size - inter) : 0;
    const score = Math.max(dice(tg, trigrams(t.title)), jac * 1.15);
    return { id: t.id, key: t.key, title: t.title, status: t.status, status_category: t.status_category, score: Math.round(Math.min(1, score) * 100) / 100 };
  }).filter(x => x.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- meeting notes → tasks ----------
export function localExtract(text, { members = [], today = todayStr() } = {}) {
  const out = [];
  for (let line of String(text).split(/\n+/)) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(/^(?:[-*•]\s*(?:\[[ x]?\]\s*)?|\d+[.)]\s+)?(?:(?:todo|to-do|action(?: item)?|ai|follow[- ]?up)\s*[:\-]\s*)(.+)$/i) || line.match(/^[-*•]\s*\[ \]\s*(.+)$/) || line.match(/^(?:@[\w.]+|[A-Z][a-z]+)\s+(?:to|will|should|needs? to)\s+.+$/) && [null, line];
    if (!m) continue;
    const parsed = localParseTask(m[1].replace(/^(?:([A-Z][a-z]+)\s+(?:to|will|should|needs? to)\s+)/, (_, n) => `@${n.toLowerCase()} `), { members, today });
    parsed.title = parsed.title.replace(/^(?:to|will|should|needs? to)\s+/i, '');
    parsed.title = parsed.title.charAt(0).toUpperCase() + parsed.title.slice(1);
    if (parsed.title.length >= 3) out.push(parsed);
  }
  return out.slice(0, 25);
}
export async function extractTasks(text, ctx) {
  const local = localExtract(text, ctx);
  if (aiMode() === 'local') return { ai: false, tasks: local };
  try {
    const j = await ask(`Extract the concrete action items from these meeting notes as tasks. Today is ${ctx.today}.
Team: ${ctx.members.map(m => `${m.name} [id ${m.id}]`).join(', ') || 'unknown'}.
Notes:\n"""${clip(text, 8000)}"""
Return JSON: {"tasks":[{"title": imperative <=80 chars, "description": string, "assignee_id": number|null (only if someone is clearly named), "due_date":"YYYY-MM-DD"|null, "priority":"urgent|high|medium|low"}]}. Skip discussion that isn't an action. Max 20.`, { json: true, maxTokens: 1800 });
    return { ai: true, tasks: (j.tasks || []).slice(0, 20).map(t => ({ title: clip(t.title, 200), description: t.description || '', assignee_id: ctx.members.some(m => m.id === t.assignee_id) ? t.assignee_id : null, due_date: /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null, priority: ['urgent', 'high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium', labels: [], estimate: null })) };
  } catch (e) { return { ai: false, warning: e.message, tasks: local }; }
}

// ---------- natural-language search ----------
export function localFilter(query, { members = [], me, today = todayStr() }) {
  const q = ` ${query.toLowerCase()} `;
  const f = {}, explain = [];
  const used = [];
  const take = (re, fn) => { const m = q.match(re); if (m) { fn(m); used.push(m[0]); } return !!m; };
  if (take(/\bunassigned\b/, () => { f.unassigned = true; explain.push('unassigned'); })) { /* done */ }
  else if (take(/\b(?:my|mine|assigned to me|i own)\b/, () => { f.assignee_ids = [me?.id]; explain.push('assigned to you'); })) { /* done */ }
  else {
    for (const m of members) {
      const first = m.name.toLowerCase().split(' ')[0], full = m.name.toLowerCase();
      if (new RegExp(`\\b(?:assigned to |by |for |owned by )?(?:${full}|${first})(?:'s)?\\b`).test(q) && q.includes(first)) { (f.assignee_ids ||= []).push(m.id); explain.push(`assigned to ${m.name}`); used.push(first); }
    }
  }
  take(/\b(urgent|high|medium|low)(?:[- ]priority)?\b/, m => { f.priority = m[1]; explain.push(`${m[1]} priority`); });
  take(/\bp([0-3])\b/, m => { f.priority = ['urgent', 'high', 'medium', 'low'][+m[1]]; explain.push(`${f.priority} priority`); });
  if (take(/\b(?:done|completed|shipped|finished|closed|resolved)\b/, () => { f.status_category = 'done'; explain.push('done'); })) { /* */ }
  else if (take(/\b(?:in progress|doing|started|being worked on)\b/, () => { f.status = 'in_progress'; explain.push('in progress'); })) { /* */ }
  else if (take(/\bin review|awaiting review|needs review\b/, () => { f.status = 'review'; explain.push('in review'); })) { /* */ }
  else if (take(/\b(?:open|not done|unfinished|outstanding)\b/, () => { f.open = true; explain.push('not done'); })) { /* */ }
  take(/\b(bugs?|epics?|stor(?:y|ies))\b/, m => { f.type = m[1].startsWith('bug') ? 'bug' : m[1].startsWith('epic') ? 'epic' : 'story'; explain.push(`${f.type}s`); });
  take(/\boverdue|late|past due\b/, () => { f.overdue = true; explain.push('overdue'); });
  take(/\b(?:blocked)\b/, () => { f.blocked = true; explain.push('blocked'); });
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7));
  if (take(/\bdue today\b/, () => { f.due_from = f.due_to = today; explain.push('due today'); })) { /* */ }
  else if (take(/\bdue tomorrow\b/, () => { f.due_from = f.due_to = addDays(today, 1); explain.push('due tomorrow'); })) { /* */ }
  else if (take(/\bdue (?:this week|by (?:the )?end of (?:the )?week|soon)\b/, () => { f.due_from = today; f.due_to = addDays(monday, 6); explain.push('due this week'); })) { /* */ }
  else if (take(/\bdue next week\b/, () => { f.due_from = addDays(monday, 7); f.due_to = addDays(monday, 13); explain.push('due next week'); })) { /* */ }
  if (take(/\b(?:last week)\b/, () => { f.range_from = addDays(monday, -7); f.range_to = addDays(monday, -1); explain.push('last week'); })) { /* */ }
  else if (take(/\b(?:this week)\b/, () => { if (!f.due_from) { f.range_from = monday; f.range_to = addDays(monday, 6); explain.push('this week'); } })) { /* */ }
  else if (take(/\b(?:in the )?last (\d+) days\b/, m => { f.range_from = addDays(today, -Number(m[1])); f.range_to = today; explain.push(`last ${m[1]} days`); })) { /* */ }
  else if (take(/\byesterday\b/, () => { f.range_from = f.range_to = addDays(today, -1); explain.push('yesterday'); })) { /* */ }
  for (const m of query.matchAll(/#([\w-]+)/g)) { (f.labels ||= []).push(m[1].toLowerCase()); explain.push('#' + m[1]); used.push(m[0]); }
  take(/\b(?:label(?:led)?|tagged)\s+([\w-]+)/, m => { (f.labels ||= []).push(m[1]); explain.push('#' + m[1]); });
  let rest = q; for (const u of used) rest = rest.replace(u, ' ');
  const text = words(rest.replace(/\b(show|list|find|tasks?|tickets?|issues?|all|that|which|what|who|where|how many|are|were|have|has|got|any|there|things|work)\b/g, ' ')).join(' ');
  if (text) { f.text = text; explain.push(`matching “${text}”`); }
  return { filter: f, explain };
}

export function applyFilter(tasks, f, { me, today = todayStr() } = {}) {
  const inRange = (iso, a, b) => iso && iso.slice(0, 10) >= a && iso.slice(0, 10) <= b;
  const textWords = f.text ? f.text.split(' ') : [];
  return tasks.filter(t => {
    if (f.unassigned && t.assignee_id) return false;
    if (f.assignee_ids?.length && !f.assignee_ids.includes(t.assignee_id)) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.status_category && t.status_category !== f.status_category) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.open && t.status === 'done') return false;
    if (f.type && t.type !== f.type) return false;
    if (f.overdue && !(t.due_date && t.due_date < today && t.status !== 'done')) return false;
    if (f.blocked && !t.blocked_by_open) return false;
    if (f.due_from && !(t.due_date && t.due_date >= f.due_from && t.due_date <= f.due_to)) return false;
    if (f.range_from) { const when = f.status_category === 'done' ? t.completed_at : (t.completed_at || t.updated_at); if (!inRange(when, f.range_from, f.range_to)) return false; }
    if (f.labels?.length && !f.labels.every(l => t.labels.includes(l))) return false;
    if (textWords.length) { const hay = words(t.title + ' ' + t.description + ' ' + t.labels.join(' ')).join(' '); if (!textWords.every(w => hay.includes(w))) return false; }
    return true;
  });
}

export async function nlSearch(query, ctx) {
  const local = localFilter(query, ctx);
  if (aiMode() === 'local') return { ai: false, ...local };
  try {
    const j = await ask(`Convert this question about a task board into a filter. Today is ${ctx.today}. Current user: ${ctx.me?.name} [id ${ctx.me?.id}].
Team: ${ctx.members.map(m => `${m.name} [id ${m.id}]`).join(', ')}
Question: "${query}"
Return JSON using only these optional keys: {"assignee_ids":number[],"unassigned":boolean,"priority":"urgent|high|medium|low","status_category":"todo|doing|done","status":string,"open":boolean,"type":"task|bug|story|epic","overdue":boolean,"blocked":boolean,"due_from":"YYYY-MM-DD","due_to":"YYYY-MM-DD","range_from":"YYYY-MM-DD","range_to":"YYYY-MM-DD" (for when work was completed/changed),"labels":string[],"text":string (keywords),"explain":string[] (short human-readable pieces)}`, { json: true });
    const f = {};
    for (const k of ['unassigned', 'open', 'overdue', 'blocked']) if (j[k] === true) f[k] = true;
    if (Array.isArray(j.assignee_ids)) f.assignee_ids = j.assignee_ids.filter(id => ctx.members.some(m => m.id === id));
    if (['urgent', 'high', 'medium', 'low'].includes(j.priority)) f.priority = j.priority;
    if (['todo', 'doing', 'done'].includes(j.status_category)) f.status_category = j.status_category;
    if (typeof j.status === 'string') f.status = j.status.slice(0, 24);
    if (['task', 'bug', 'story', 'epic'].includes(j.type)) f.type = j.type;
    for (const k of ['due_from', 'due_to', 'range_from', 'range_to']) if (/^\d{4}-\d{2}-\d{2}$/.test(j[k] || '')) f[k] = j[k];
    if (f.due_from && !f.due_to) f.due_to = f.due_from;
    if (f.range_from && !f.range_to) f.range_to = ctx.today;
    if (Array.isArray(j.labels)) f.labels = j.labels.map(l => String(l).toLowerCase()).slice(0, 5);
    if (typeof j.text === 'string' && j.text.trim()) f.text = words(j.text).join(' ');
    return { ai: true, filter: f, explain: Array.isArray(j.explain) && j.explain.length ? j.explain.slice(0, 8).map(String) : local.explain };
  } catch { return { ai: false, ...local }; }
}

// ---------- sprint planning ----------
export function localSprintPlan({ backlog, capacity, taskCapacity = null }) {
  const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
  const order = [...backlog].filter(t => t.type !== 'epic' && !t.blocked_by_open).sort((a, b) => rank[a.priority] - rank[b.priority] || (a.due_date || '9') .localeCompare(b.due_date || '9') || a.number - b.number);
  const budget = capacity * 0.85; // leave slack for interruptions
  let used = 0; const picks = [];
  for (const t of order) {
    const est = t.estimate || 3;
    if (used + est > budget) continue;
    used += est;
    picks.push({ id: t.id, key: t.key, title: t.title, estimate: est, reason: `${t.priority} priority${t.due_date ? `, due ${t.due_date}` : ''}${t.estimate ? '' : ' (estimate assumed 3h)'}` });
    if (taskCapacity && picks.length >= taskCapacity) break;
  }
  return { picks, planned: Math.round(used * 10) / 10, budget: Math.round(budget * 10) / 10 };
}
export async function sprintPlan(ctx) {
  const local = localSprintPlan(ctx);
  const summary = `Capacity ${ctx.capacity}h across ${ctx.people} people${ctx.velocity ? ` (recent velocity ${Math.round(ctx.velocity)}h)` : ''}. Plan: ${local.picks.length} tasks, ${local.planned}h of a ${local.budget}h budget (85% of capacity).`;
  if (aiMode() === 'local' || !local.picks.length) return { ai: false, summary, ...local };
  try {
    const text = await ask(`You are planning a sprint. ${summary}
Selected tasks:\n${local.picks.map(p => `${p.key} | ${p.title} | ${p.estimate}h | ${p.reason}`).join('\n')}
Write 2 sentences: is the scope realistic, and what is the main risk? Be specific.`, { maxTokens: 160 });
    return { ai: true, summary: `${summary} ${text}`, ...local };
  } catch { return { ai: false, summary, ...local }; }
}

// ---------- weekly stakeholder digest ----------
export async function stakeholderDigest({ project, done, inProgress, upcoming, risks }) {
  const lines = [`## ${project.name} — weekly update`, '', `**Shipped this week (${done.length})**`, ...(done.length ? done.slice(0, 10).map(t => `- ${t.title} (${t.key})`) : ['- Nothing completed this week']), '',
    `**In flight (${inProgress.length})**`, ...inProgress.slice(0, 8).map(t => `- ${t.title} (${t.key})`), '', `**Coming up**`, ...(upcoming.length ? upcoming.slice(0, 6).map(t => `- ${t.title} — due ${t.due_date}`) : ['- No dated work scheduled']), '',
    ...(risks.length ? ['**Watch-outs**', ...risks.slice(0, 5).map(r => `- ${r.reason}`)] : [])];
  const local = lines.join('\n');
  if (aiMode() === 'local') return { ai: false, text: local };
  try {
    const text = await ask(`Write a concise weekly stakeholder update (Markdown, <200 words, no fluff) for project "${project.name}".
Shipped: ${done.map(t => `${t.key} ${t.title}`).join('; ') || 'nothing'}
In progress: ${inProgress.map(t => `${t.key} ${t.title}`).join('; ') || 'nothing'}
Upcoming: ${upcoming.map(t => `${t.key} ${t.title} (due ${t.due_date})`).join('; ') || 'none'}
Risks: ${risks.map(r => r.reason).join('; ') || 'none'}
Sections: Highlights, In progress, Next, Risks. Only use the facts above.`, { maxTokens: 600 });
    return { ai: true, text };
  } catch { return { ai: false, text: local }; }
}
