import { h, mount, icon, toast, todayStr, renderMarkdownLite, avatar, priorityBadge, dueInfo } from '../dom.js';
import { api } from '../api.js';
import { state, userById } from '../state.js';
import { createTaskModal } from './pickers.js';
import { voiceButton } from '../voice.js';
import { openTask } from './task.js';

let panel = null;
const history = [];

function currentProjectId() {
  const m = location.hash.match(/^#\/project\/(\d+)/);
  return m ? +m[1] : null;
}

export function toggleAssistant(prefill) {
  if (panel) { panel.remove(); panel = null; if (!prefill) return; }
  const body = h('div', { class: 'as-body' });
  const input = h('textarea', { class: 'textarea', rows: 1, style: { minHeight: '38px', height: '38px', resize: 'none' }, placeholder: 'Ask anything, or “create fix login bug tomorrow !high”', 'aria-label': 'Message the assistant' });
  const send = h('button', { class: 'btn primary', 'aria-label': 'Send', onclick: () => ask() }, icon('send', 16));
  panel = h('div', { class: 'assistant', role: 'dialog', 'aria-label': 'AI assistant' },
    h('div', { class: 'as-head' }, icon('sparkles', 20), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 700 } }, 'AI assistant'), h('div', { style: { fontSize: '12px', opacity: .85 } }, state.aiMode === 'claude' ? 'Powered by Claude' : 'Offline mode · add an API key for full AI')), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => { panel.remove(); panel = null; } }, icon('x', 18))),
    body, h('div', { class: 'as-foot' }, input, voiceButton(() => input) || '', send));
  document.body.append(panel);

  const bot = (content, extra) => { body.append(h('div', { class: 'msg bot' }, typeof content === 'string' ? renderMarkdownLite(content) : content), extra || ''); body.scrollTop = body.scrollHeight; };
  const me = text => { body.append(h('div', { class: 'msg me' }, text)); body.scrollTop = body.scrollHeight; };

  function draftCard(d, projectId) {
    const a = userById(d.assignee_id);
    const due = dueInfo(d.due_date);
    return h('div', { class: 'draft' }, h('b', d.title), d.description ? h('div', { class: 'small muted' }, d.description) : null,
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, priorityBadge(d.priority), a ? h('span', { class: 'chip' }, avatar(a, 16), a.name.split(' ')[0]) : null, due ? h('span', { class: 'chip ' + (due.state === 'overdue' ? 'red' : '') }, icon('calendar', 11), due.label) : null, ...(d.labels || []).map(l => h('span', { class: 'label-chip' }, l))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: () => { const pid = projectId || state.projects.find(p => p.can_edit)?.id; if (!pid) return toast('You have no editable project', 'error'); createTaskModal({ projectId: pid, draft: d, onCreated: t => bot(`Created **${t.key}** — ${t.title}`) }); } }, 'Review & create'),
        h('span', { class: 'small faint' }, projectId ? '' : 'in your first project')));
  }

  async function ask(text) {
    text = (text ?? input.value).trim();
    if (!text) return;
    input.value = ''; me(text);
    const typing = h('div', { class: 'msg bot' }, h('span', { class: 'spinner' }));
    body.append(typing); body.scrollTop = body.scrollHeight;
    const pid = currentProjectId();
    try {
      const r = await api.post('/ai/chat', { message: text, project_id: pid, history: history.slice(-6), today: todayStr() });
      typing.remove();
      history.push({ role: 'user', text }, { role: 'assistant', text: r.answer });
      bot(r.answer);
      if (r.type === 'create' && r.draft) body.append(draftCard(r.draft, pid));
      body.scrollTop = body.scrollHeight;
    } catch (e) { typing.remove(); bot('Sorry — ' + e.message); }
  }
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });

  bot(`Hi ${state.me.name.split(' ')[0]}! I can draft tasks, summarise status, and flag risks${currentProjectId() ? ' for this project' : ' across your projects'}.`);
  body.append(h('div', { class: 'suggest' }, ['What’s at risk?', 'Give me a standup summary', 'What should I work on?', 'Create a task: review open pull requests tomorrow'].map(s => h('button', { onclick: () => ask(s) }, s))));
  setTimeout(() => (prefill ? ask(prefill) : input.focus()), 50);
}
void openTask;
