import { h, mount, icon, toast, typeIcon, statusDot } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { openTask } from './task.js';
import { toggleAssistant } from './assistant.js';
import { projectModal } from './team.js';
import { createTaskModal } from './pickers.js';

let open = null;

export function shortcutsHelp() {
  const row = (k, d) => [h('span', { class: 'kbd' }, k), h('span', d)];
  const wrap = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === wrap) wrap.remove(); } }, h('div', { class: 'modal', style: { maxWidth: '520px' } },
    h('div', { class: 'modal-head' }, h('h3', 'Keyboard shortcuts'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => wrap.remove() }, icon('x'))),
    h('div', { class: 'modal-body' }, h('div', { class: 'kbd-list' },
      ...row('⌘ K', 'Command palette — jump anywhere, search, run actions'), ...row('/', 'Search tasks'), ...row('c', 'Create a task (in a project)'), ...row('?', 'Show this help'),
      ...row('g d', 'Go to Dashboard'), ...row('g m', 'Go to My tasks'), ...row('g i', 'Go to Inbox'), ...row('g r', 'Go to Reports'),
      ...row('s / p / a / d', 'In a task: status / priority / assignee / due date'), ...row('1 – 9', 'In a task: set status by column'), ...row('t', 'In a task: start or stop the timer'), ...row('e', 'In a task: edit title'),
      ...row('Esc', 'Close panel · clear selection'), ...row('Space', 'On a board card: select it for bulk actions'), ...row('⌘/Ctrl-click', 'Select multiple cards')))));
  document.body.append(wrap);
  const esc = e => { if (e.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
}

export function openPalette() {
  if (open) return open.close();
  const input = h('input', { class: 'input', style: { height: '44px', fontSize: '15px' }, placeholder: 'Type a command, project or task… (prefix with ? to ask the board)', 'aria-label': 'Command palette' });
  const list = h('div', { class: 'col', style: { gap: '2px', maxHeight: '52vh', overflowY: 'auto' } });
  let items = [], sel = 0, timer;
  const back = h('div', { class: 'modal-back', style: { alignItems: 'start', paddingTop: '12vh' }, onmousedown: e => { if (e.target === back) close(); } }, h('div', { class: 'modal palette' }, h('div', { class: 'modal-body', style: { gap: '8px' } }, input, list)));
  const close = () => { back.remove(); open = null; document.removeEventListener('keydown', key, true); };
  open = { close };
  const pid = (location.hash.match(/^#\/project\/(\d+)/) || [])[1];
  const proj = pid && state.projects.find(p => p.id === +pid);

  const base = [
    ...(proj?.can_edit ? [{ ico: 'plus', label: `New task in ${proj.name}`, hint: 'c', run: () => createTaskModal({ projectId: proj.id, templates: [], onCreated: () => {} }) }] : []),
    { ico: 'sparkles', label: 'Ask the AI assistant', run: () => toggleAssistant() },
    { ico: 'home', label: 'Go to Dashboard', hint: 'g d', run: () => (location.hash = '#/') }, { ico: 'checkCircle', label: 'Go to My tasks', hint: 'g m', run: () => (location.hash = '#/my-tasks') },
    { ico: 'inbox', label: 'Go to Inbox', hint: 'g i', run: () => (location.hash = '#/inbox') }, { ico: 'barChart', label: 'Go to Reports', hint: 'g r', run: () => (location.hash = '#/reports') },
    { ico: 'users', label: 'Go to Teams & people', run: () => (location.hash = '#/team') }, { ico: 'zap', label: 'Go to Automations', run: () => (location.hash = '#/automations') },
    { ico: 'clock', label: 'Go to Capacity & time off', run: () => (location.hash = '#/capacity') },
    { ico: 'settings', label: 'Open Settings', run: () => (location.hash = '#/settings') }, { ico: 'plus', label: 'New project', run: () => projectModal() },
    { ico: 'stop', label: 'Stop the running timer', run: () => api.post('/timer/stop').then(() => toast('Timer stopped')) },
    { ico: 'moon', label: 'Toggle dark / light theme', run: () => { const d = document.documentElement.dataset.theme === 'dark'; document.documentElement.dataset.theme = d ? 'light' : 'dark'; try { localStorage.setItem('tb_theme', d ? 'light' : 'dark'); } catch { /* ignore */ } } },
    { ico: 'keyboard', label: 'Keyboard shortcuts', hint: '?', run: shortcutsHelp },
    ...state.projects.map(p => ({ ico: 'folder', label: `Project: ${p.name}`, sub: p.team_name, run: () => (location.hash = '#/project/' + p.id) })),
  ];

  const render = () => {
    mount(list, items.length ? items.map((it, i) => h('button', { class: 'pal-item' + (i === sel ? ' sel' : ''), onmouseenter: () => { sel = i; paint(); }, onclick: () => { close(); it.run(); } },
      it.node || icon(it.ico || 'search', 17), h('span', { class: 'grow ellipsis' }, it.label), it.sub ? h('span', { class: 'small faint' }, it.sub) : null, it.hint ? h('span', { class: 'kbd' }, it.hint) : null)) : h('div', { class: 'empty', style: { padding: '24px' } }, 'No matches'));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const paint = () => [...list.children].forEach((c, i) => c.classList.toggle('sel', i === sel));

  async function update() {
    const q = input.value.trim();
    sel = 0;
    if (!q) { items = base; return render(); }
    if (q.startsWith('?') || /^(who|what|which|show|list|find|how many|when)\b/i.test(q)) {
      const text = q.replace(/^\?\s*/, '');
      items = [{ ico: 'sparkles', label: `Ask the board: “${text}”`, hint: '↵', run: () => askBoard(text) }];
      return render();
    }
    const lower = q.toLowerCase();
    items = base.filter(b => (b.label + ' ' + (b.sub || '')).toLowerCase().includes(lower)).slice(0, 8);
    render();
    clearTimeout(timer);
    if (q.length >= 2) timer = setTimeout(async () => {
      const r = await api.get('/search?q=' + encodeURIComponent(q)).catch(() => []);
      if (input.value.trim() !== q) return;
      items = [...items, ...r.map(t => ({ node: statusDot(t.status, t.status_category), label: `${t.key}  ${t.title}`, sub: t.project_name, run: () => openTask(t.id) })), { ico: 'sparkles', label: `Ask the board: “${q}”`, run: () => askBoard(q) }];
      render();
    }, 160);
  }
  const key = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter' && items[sel]) { e.preventDefault(); const it = items[sel]; close(); it.run(); }
  };
  document.addEventListener('keydown', key, true);
  input.addEventListener('input', update);
  document.body.append(back);
  items = base; render(); input.focus();
}

// natural-language search: "high priority bugs assigned to Sofia due this week"
export async function askBoard(text) {
  const out = h('div', { class: 'col' }, h('div', { class: 'loading', style: { height: '80px' } }, h('span', { class: 'spinner' })));
  const wrap = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === wrap) wrap.remove(); } }, h('div', { class: 'modal', style: { maxWidth: '640px' } },
    h('div', { class: 'modal-head' }, h('h3', `✨ ${text}`), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => wrap.remove() }, icon('x'))), h('div', { class: 'modal-body' }, out)));
  document.body.append(wrap);
  try {
    const r = await api.post('/ai/search', { query: text, today: new Date().toISOString().slice(0, 10) });
    mount(out, h('p', { class: 'muted small' }, 'Interpreted as: ', ...r.explain.map(x => h('span', { class: 'chip', style: { marginRight: '4px' } }, x))),
      r.tasks.length ? r.tasks.map(t => h('div', { class: 'trow', onclick: () => { wrap.remove(); openTask(t.id); } }, statusDot(t.status, t.status_category), typeIcon(t.type, 13), h('span', { class: 'mono small faint' }, t.key), h('span', { class: 'grow ellipsis', style: { fontWeight: 550 } }, t.title), h('span', { class: 'small faint' }, t.assignee_name || 'Unassigned'), t.due_date ? h('span', { class: 'small faint' }, t.due_date) : null)) : h('div', { class: 'empty' }, h('b', 'No matching tasks'), 'Try rephrasing.'),
      r.tasks.length === 50 ? h('p', { class: 'hint' }, 'Showing the first 50 results.') : null);
  } catch (e) { mount(out, h('p', { class: 'error-msg' }, e.message)); }
}
