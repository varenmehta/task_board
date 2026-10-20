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
