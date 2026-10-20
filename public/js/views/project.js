import { h, mount, icon, avatar, toast, menu, priorityBadge, statusDot, dueInfo, PRIORITY, STATUS_LABEL, todayStr, renderMarkdownLite } from '../dom.js';
import { api } from '../api.js';
import { state, on, userById, projectById, isViewer } from '../state.js';
import { createTaskModal, statusMenu, priorityMenu, assigneeMenu, dateMenu } from './pickers.js';
import { openTask } from './task.js';
import { projectModal } from './team.js';

const FILTER_KEY = pid => `tb_filters_${pid}`;

export async function projectView(el, pid, tab) {
  const ctl = { pid, tab, project: null, tasks: [], members: [], q: '', assignee: 'all', priority: 'all', label: 'all', sort: { key: 'default', dir: 1 }, newId: null };
  try { Object.assign(ctl, JSON.parse(sessionStorage.getItem(FILTER_KEY(pid)) || '{}')); ctl.q = ''; } catch { /* ignore */ }
  mount(el, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  try { await load(ctl); } catch (e) { mount(el, h('div', { class: 'page' }, h('div', { class: 'empty' }, h('b', 'Project unavailable'), e.message, h('p', h('a', { href: '#/' }, 'Back to dashboard'))))); return; }

  const shell = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } });
  mount(el, shell);
  const repaint = () => paint(shell, ctl, repaint);
  ctl.repaintSoon = repaint;
  repaint();

  let t;
  const off = on('task', ev => {
    if (ev.project_id !== pid) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      if (ctl.dragId) { ctl.dirty = true; return; } // don't swap the DOM under an in-flight drag
      await load(ctl).catch(() => {}); if (!document.querySelector('.drawer')?.contains(document.activeElement) && !shell.querySelector('.quick-add textarea:focus')) paint(shell, ctl, repaint, true); }, 150);
  });
  return () => { off(); clearTimeout(t); };
}

async function load(ctl) {
  const r = await api.get(`/projects/${ctl.pid}/board`);
  Object.assign(ctl, { project: r.project, tasks: r.tasks, members: r.members });
}
const saveFilters = ctl => { try { sessionStorage.setItem(FILTER_KEY(ctl.pid), JSON.stringify({ assignee: ctl.assignee, priority: ctl.priority, label: ctl.label })); } catch { /* ignore */ } };

function visible(ctl) {
  const q = ctl.q.trim().toLowerCase();
  return ctl.tasks.filter(t =>
    (!q || t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.labels.some(l => l.includes(q))) &&
    (ctl.assignee === 'all' || (ctl.assignee === 'me' ? t.assignee_id === state.me.id : ctl.assignee === 'none' ? !t.assignee_id : t.assignee_id === +ctl.assignee)) &&
    (ctl.priority === 'all' || t.priority === ctl.priority) && (ctl.label === 'all' || t.labels.includes(ctl.label)));
}

function paint(shell, ctl, repaint, soft) {
  const p = ctl.project;
  const readonly = !p.can_edit;
  const scrollers = soft ? [...shell.querySelectorAll('.board-wrap, .table-wrap, .col-body')].map(e => [e.scrollLeft, e.scrollTop]) : null;
  const tabBtn = (k, label, ico) => h('a', { class: 'tab' + (ctl.tab === k ? ' active' : ''), href: `#/project/${p.id}${k === 'board' ? '' : '/' + k}`, style: { textDecoration: 'none' } }, icon(ico, 16), label);
  const total = ctl.tasks.length, done = ctl.tasks.filter(t => t.status === 'done').length;

  const head = h('div', { class: 'proj-head' },
    h('div', { class: 'proj-title' }, h('span', { class: 'proj-key', style: { background: p.color } }, p.key),
      h('div', { class: 'grow' }, h('h1', p.name), p.description ? h('p', { class: 'muted small', style: { marginTop: '2px' } }, p.description) : null),
      h('span', { class: 'chip green', title: 'Updates appear live' }, h('span', { class: 'live-dot' }), 'Live'),
      total ? h('span', { class: 'chip' }, `${done}/${total} done`) : null,
      p.can_manage ? h('button', { class: 'icon-btn', 'aria-label': 'Project settings', onclick: () => projectModal(p, () => location.reload()) }, icon('settings', 18)) : null,
      readonly ? h('span', { class: 'chip amber' }, 'View only') : h('button', { class: 'btn primary', onclick: () => newTask(ctl, 'todo') }, icon('plus', 16), 'New task')),
    h('div', { class: 'tabs' }, tabBtn('board', 'Board', 'board'), tabBtn('list', 'List', 'list'), tabBtn('insights', 'Insights', 'sparkles')));

  let body;
  if (ctl.tab === 'insights') body = insights(ctl);
  else {
    const filters = toolbar(ctl, repaint);
    body = h('div', { style: { display: 'contents' } }, filters, ctl.tab === 'list' ? listView(ctl, repaint) : boardView(ctl, repaint));
  }
  mount(shell, head, body);
  if (scrollers) [...shell.querySelectorAll('.board-wrap, .table-wrap, .col-body')].forEach((e, i) => { if (scrollers[i]) { e.scrollLeft = scrollers[i][0]; e.scrollTop = scrollers[i][1]; } });
}

function newTask(ctl, status) {
  createTaskModal({ projectId: ctl.pid, status, onCreated: async t => { ctl.newId = t.id; await load(ctl); ctl.repaintSoon?.(); } });
}

// ---------- toolbar ----------
function toolbar(ctl, repaint) {
  const labels = [...new Set(ctl.tasks.flatMap(t => t.labels))].sort();
  const members = ctl.members;
  const q = h('input', { class: 'input sm', placeholder: 'Filter…', value: ctl.q, 'aria-label': 'Filter tasks', oninput: () => { ctl.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { repaint(); const n = document.querySelector('.toolbar input'); n?.focus(); n?.setSelectionRange(99, 99); }, 120); } });
  const chip = (label, active, onClick, ico) => h('button', { class: 'fchip' + (active ? ' on' : ''), onclick: e => onClick(e.currentTarget) }, ico ? icon(ico, 14) : null, label, icon('chevronDown', 12));
  const aLabel = ctl.assignee === 'all' ? 'Assignee' : ctl.assignee === 'me' ? 'Me' : ctl.assignee === 'none' ? 'Unassigned' : userById(+ctl.assignee)?.name?.split(' ')[0] || 'Assignee';
  const set = (k, v) => { ctl[k] = v; saveFilters(ctl); repaint(); };
  const active = ctl.assignee !== 'all' || ctl.priority !== 'all' || ctl.label !== 'all' || ctl.q;
  return h('div', { class: 'toolbar' }, h('div', { class: 'search', style: { maxWidth: '220px' } }, icon('search', 15), q),
    chip(aLabel, ctl.assignee !== 'all', el => menu(el, [
      { label: 'Everyone', checked: ctl.assignee === 'all', onClick: () => set('assignee', 'all') }, { label: 'Assigned to me', checked: ctl.assignee === 'me', onClick: () => set('assignee', 'me') }, { label: 'Unassigned', checked: ctl.assignee === 'none', onClick: () => set('assignee', 'none') }, { divider: true },
      ...members.map(m => ({ node: avatar(m, 20), label: m.name, checked: ctl.assignee === String(m.id), onClick: () => set('assignee', String(m.id)) }))]), 'user'),
    chip(ctl.priority === 'all' ? 'Priority' : PRIORITY[ctl.priority].label, ctl.priority !== 'all', el => menu(el, [{ label: 'Any priority', checked: ctl.priority === 'all', onClick: () => set('priority', 'all') }, ...Object.entries(PRIORITY).map(([id, pr]) => ({ label: pr.label, checked: ctl.priority === id, onClick: () => set('priority', id) }))]), 'flag'),
    labels.length ? chip(ctl.label === 'all' ? 'Label' : '#' + ctl.label, ctl.label !== 'all', el => menu(el, [{ label: 'Any label', checked: ctl.label === 'all', onClick: () => set('label', 'all') }, ...labels.map(l => ({ label: '#' + l, checked: ctl.label === l, onClick: () => set('label', l) }))]), 'tag') : null,
    active ? h('button', { class: 'btn ghost sm', onclick: () => { Object.assign(ctl, { q: '', assignee: 'all', priority: 'all', label: 'all' }); saveFilters(ctl); repaint(); } }, 'Clear') : null);
}

// ---------- board ----------
function card(ctl, t, repaint) {
  const due = dueInfo(t.due_date, t.status === 'done');
  const a = userById(t.assignee_id);
  const el = h('div', { class: 'tcard' + (t.status === 'done' ? ' is-done' : '') + (ctl.newId === t.id ? ' new' : ''), draggable: !isViewer() && ctl.project.can_edit ? 'true' : null, tabindex: 0, role: 'button', 'aria-label': `${t.key} ${t.title}`, dataset: { id: t.id },
    onclick: () => openTask(t.id), onkeydown: e => { if (e.key === 'Enter') openTask(t.id); },
    ondragstart: e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => el.classList.add('dragging'), 0); ctl.dragId = t.id; },
    ondragend: () => { el.classList.remove('dragging'); ctl.dragId = null; if (ctl.dirty) { ctl.dirty = false; load(ctl).then(() => ctl.repaintSoon()).catch(() => {}); } document.querySelectorAll('.drop').forEach(c => c.classList.remove('drop')); document.querySelector('.drop-line')?.remove(); } },
    t.labels.length ? h('div', { class: 'labels' }, t.labels.slice(0, 3).map(l => h('span', { class: 'label-chip' }, l)), t.labels.length > 3 ? h('span', { class: 'label-chip' }, '+' + (t.labels.length - 3)) : null) : null,
    h('div', { class: 'title' }, t.title),
    t.subtask_total ? h('div', { class: 'row', style: { gap: '8px' } }, h('div', { class: 'progress' }, h('i', { style: { width: (t.subtask_done / t.subtask_total * 100) + '%' } })), h('span', { class: 'small faint' }, `${t.subtask_done}/${t.subtask_total}`)) : null,
    h('div', { class: 'meta' }, h('span', { class: 'key' }, t.key), priorityBadge(t.priority, true),
      due ? h('span', { class: 'due ' + due.state }, icon('calendar', 12), due.label) : null,
      t.comment_count ? h('span', { class: 'row', style: { gap: '3px' } }, icon('message', 12), t.comment_count) : null,
      h('span', { class: 'grow' }), avatar(a, 22)));
  return el;
}

function boardView(ctl, repaint) {
  const tasks = visible(ctl);
  const readonly = !ctl.project.can_edit;
  const cols = state.statuses.map(s => {
    const list = tasks.filter(t => t.status === s.id);
    const body = h('div', { class: 'col-body', dataset: { status: s.id } }, list.length ? list.map(t => card(ctl, t, repaint)) : null);
    const column = h('section', { class: 'column', 'aria-label': s.label },
      h('div', { class: 'col-head' }, statusDot(s.id), s.label, h('span', { class: 'n' }, list.length), h('span', { class: 'grow' }),
        readonly ? null : h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, 'aria-label': `Add task to ${s.label}`, onclick: () => newTask(ctl, s.id) }, icon('plus', 16))),
      body,
      readonly ? null : quickAdd(ctl, s.id, repaint));
    if (!readonly) wireDrop(ctl, column, body, s.id, repaint);
    return column;
  });
  ctl.newId = null;
  if (!ctl.tasks.length) return h('div', { class: 'board-wrap' }, h('div', { class: 'empty' }, h('b', 'No tasks yet'), readonly ? 'Nothing here yet.' : 'Create your first task, or ask the AI assistant to draft a few.'));
  const wrap = h('div', { class: 'board-wrap' }, h('div', { class: 'board' }, cols));
  // scroll the board while dragging near its left/right edge so every column is reachable
  wrap.addEventListener('dragover', e => {
    const r = wrap.getBoundingClientRect();
    if (e.clientX > r.right - 70) wrap.scrollLeft += 20; else if (e.clientX < r.left + 70) wrap.scrollLeft -= 20;
  });
  return wrap;
}

function quickAdd(ctl, status, repaint) {
  const wrap = h('div');
  const open = () => {
    const ta = h('textarea', { class: 'textarea', placeholder: 'Type a task — e.g. “Fix signup bug tomorrow !high @priya”. Enter to add.', rows: 2 });
    const submit = async () => {
      const text = ta.value.trim(); if (!text) return;
      ta.disabled = true;
      try {
        const d = await api.post('/ai/parse', { text, project_id: ctl.pid, today: todayStr() });
        const t = await api.post(`/projects/${ctl.pid}/tasks`, { ...d, status, title: d.title || text });
        ctl.newId = t.id; await load(ctl); repaint(); toast(`Created ${t.key}`, 'success');
      } catch (e) { toast(e.message, 'error'); ta.disabled = false; }
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') close(); });
    const close = () => mount(wrap, addBtn());
    mount(wrap, h('div', { class: 'quick-add' }, ta, h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: submit }, 'Add'), h('button', { class: 'btn ghost sm', onclick: close }, 'Cancel'), h('span', { class: 'hint' }, state.aiMode === 'claude' ? '✨ AI-parsed' : 'Smart-parsed'))));
    ta.focus();
  };
  const addBtn = () => h('button', { class: 'add-card', onclick: open }, icon('plus', 15), 'Add task');
  mount(wrap, addBtn());
  return wrap;
}

function wireDrop(ctl, column, body, status, repaint) {
  const indexAt = y => {
    const cards = [...body.querySelectorAll('.tcard:not(.dragging)')];
    let i = 0;
    for (const c of cards) { const r = c.getBoundingClientRect(); if (y > r.top + r.height / 2) i++; }
    return { i, cards };
  };
  const line = h('div', { class: 'drop-line' });
  column.addEventListener('dragover', e => {
    if (!ctl.dragId) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    column.classList.add('drop');
    const { i, cards } = indexAt(e.clientY);
    if (cards[i]) body.insertBefore(line, cards[i]); else body.append(line);
  });
  column.addEventListener('dragleave', e => { if (!column.contains(e.relatedTarget)) { column.classList.remove('drop'); line.remove(); } });
  column.addEventListener('drop', async e => {
    e.preventDefault();
    const id = ctl.dragId; if (!id) return;
    const { i } = indexAt(e.clientY);
    column.classList.remove('drop'); line.remove();
    const t = ctl.tasks.find(x => x.id === id);
    if (!t) return;
    // optimistic reorder
    const same = ctl.tasks.filter(x => x.status === status && x.id !== id).sort((a, b) => a.position - b.position);
    const prev = same[i - 1]?.position, next = same[i]?.position;
    t.position = prev == null ? (next ?? 1024) - 1024 : next == null ? prev + 1024 : (prev + next) / 2;
    t.status = status;
    ctl.tasks.sort((a, b) => a.position - b.position);
    repaint();
    try { await api.post(`/tasks/${id}/move`, { status, index: i }); await load(ctl); repaint(); } catch (er) { toast(er.message, 'error'); await load(ctl); repaint(); }
  });
}

// ---------- list ----------
function listView(ctl, repaint) {
  const readonly = !ctl.project.can_edit;
  let rows = visible(ctl);
  const { key, dir } = ctl.sort;
  const val = { title: t => t.title.toLowerCase(), status: t => state.statuses.findIndex(s => s.id === t.status), priority: t => Object.keys(PRIORITY).indexOf(t.priority), assignee: t => userById(t.assignee_id)?.name || '~', due: t => t.due_date || '9999', key: t => t.number };
  if (key !== 'default') rows = [...rows].sort((a, b) => (val[key](a) > val[key](b) ? 1 : val[key](a) < val[key](b) ? -1 : 0) * dir);
  const th = (label, k, cls) => h('th', { class: 'sortable ' + (cls || ''), onclick: () => { ctl.sort = ctl.sort.key === k ? { key: k, dir: -dir } : { key: k, dir: 1 }; repaint(); } }, label, ctl.sort.key === k ? (dir === 1 ? ' ↑' : ' ↓') : '');
  const patch = async (t, f) => { try { await api.patch('/tasks/' + t.id, f); await load(ctl); repaint(); } catch (e) { toast(e.message, 'error'); } };
  const row = t => {
    const due = dueInfo(t.due_date, t.status === 'done');
    const cell = (child, fn) => h('button', { class: 'cell-btn', disabled: readonly, onclick: e => { e.stopPropagation(); fn(e.currentTarget); } }, child);
    return h('tr', { class: 'clickable', onclick: () => openTask(t.id) },
      h('td', { class: 'mono small faint nowrap' }, t.key),
      h('td', { style: { maxWidth: '420px' } }, h('div', { class: 'ellipsis', style: { fontWeight: 550 } }, t.title), t.labels.length ? h('div', { class: 'labels', style: { marginTop: '3px' } }, t.labels.slice(0, 4).map(l => h('span', { class: 'label-chip' }, l))) : null),
      h('td', cell([statusDot(t.status), STATUS_LABEL[t.status]], el => statusMenu(el, t.status, s => patch(t, { status: s })))),
      h('td', cell(priorityBadge(t.priority), el => priorityMenu(el, t.priority, p => patch(t, { priority: p })))),
      h('td', { class: 'hide-sm' }, cell([avatar(userById(t.assignee_id), 22), userById(t.assignee_id)?.name || h('span', { class: 'faint' }, 'Unassigned')], el => assigneeMenu(el, ctl.members, t.assignee_id, id => patch(t, { assignee_id: id })))),
      h('td', cell(due ? h('span', { class: 'due ' + due.state }, due.label) : h('span', { class: 'faint' }, '—'), el => dateMenu(el, t.due_date, d => patch(t, { due_date: d })))),
      h('td', { class: 'hide-sm small faint' }, t.subtask_total ? `${t.subtask_done}/${t.subtask_total}` : ''));
  };
  const body = [];
  if (key === 'default') {
    for (const s of state.statuses) {
      const g = rows.filter(t => t.status === s.id);
      if (!g.length) continue;
      body.push(h('tr', { class: 'group-row' }, h('td', { colspan: 7 }, h('span', { class: 'row' }, statusDot(s.id), s.label, h('span', { class: 'chip' }, g.length)))), ...g.map(row));
    }
  } else body.push(...rows.map(row));
  return h('div', { class: 'table-wrap' }, rows.length ? h('table', { class: 't' }, h('thead', h('tr', th('Key', 'key'), th('Title', 'title'), th('Status', 'status'), th('Priority', 'priority'), th('Assignee', 'assignee', 'hide-sm'), th('Due', 'due'), h('th', { class: 'hide-sm' }, 'Sub'))), h('tbody', body)) : h('div', { class: 'empty' }, h('b', 'No matching tasks'), 'Try clearing your filters.'));
}

// ---------- insights ----------
function insights(ctl) {
  const counts = state.statuses.map(s => ({ ...s, n: ctl.tasks.filter(t => t.status === s.id).length }));
  const total = ctl.tasks.length || 1;
  const colors = { backlog: 'var(--text-3)', todo: 'var(--blue)', in_progress: 'var(--amber)', review: '#8b5cf6', done: 'var(--green)' };
  const load = ctl.members.map(m => ({ m, open: ctl.tasks.filter(t => t.assignee_id === m.id && t.status !== 'done').length, hours: ctl.tasks.filter(t => t.assignee_id === m.id && t.status !== 'done').reduce((a, t) => a + (t.estimate || 0), 0) })).sort((a, b) => b.open - a.open);
  const max = Math.max(1, ...load.map(l => l.open));

  const riskBox = h('div', { class: 'card-body' }, h('div', { class: 'loading', style: { height: '90px' } }, h('span', { class: 'spinner' })));
  const sumBox = h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Generate a ready-to-paste status update for your standup or stakeholders.'));
  async function runRisks() {
    mount(riskBox, h('div', { class: 'loading', style: { height: '90px' } }, h('span', { class: 'spinner' })));
    try {
      const r = await api.post('/ai/risks', { project_id: ctl.pid, today: todayStr() });
      mount(riskBox, r.summary ? h('p', { class: 'muted', style: { marginBottom: '8px' } }, r.summary) : null,
        r.risks.length ? r.risks.map(x => h('div', { class: 'risk' + '', style: { cursor: x.task_id ? 'pointer' : 'default' }, onclick: () => x.task_id && openTask(x.task_id) }, h('span', { class: 'lvl ' + x.level }), h('div', x.key ? h('b', { class: 'mono small' }, x.key + ' ') : null, x.reason))) : h('div', { class: 'empty', style: { padding: '14px' } }, '🎉 Nothing looks at risk.'));
      if (r.warning) riskBox.append(h('p', { class: 'hint' }, 'AI unavailable, showing rule-based analysis.'));
    } catch (e) { mount(riskBox, h('p', { class: 'error-msg' }, e.message)); }
  }
  async function runSummary(b) {
    b.disabled = true; mount(sumBox, h('div', { class: 'loading', style: { height: '120px' } }, h('span', { class: 'spinner' })));
    try {
      const r = await api.post('/ai/summary', { project_id: ctl.pid, today: todayStr() });
      mount(sumBox, renderMarkdownLite(r.text), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(r.text).then(() => toast('Copied'), () => {}) }, icon('copy', 14), 'Copy'), h('button', { class: 'btn sm', onclick: () => api.post('/integrations/test', { channel: 'briefing' }).then(x => toast(x.status === 'sent' ? 'Briefing emailed to you' : 'Briefing logged (email not connected)'), e => toast(e.message, 'error')) }, icon('mail', 14), 'Email me my briefing')));
    } catch (e) { mount(sumBox, h('p', { class: 'error-msg' }, e.message)); }
    b.disabled = false;
  }
  const sumBtn = h('button', { class: 'btn ai sm', onclick: e => runSummary(e.currentTarget) }, icon('sparkles', 14), 'Generate');
  setTimeout(runRisks, 0);
  return h('div', { class: 'page' }, h('div', { class: 'grid g2' },
    h('div', { class: 'col', style: { gap: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Risks & attention'), state.aiMode === 'claude' ? h('span', { class: 'ai-badge' }, icon('sparkles', 12), 'AI') : null, h('span', { class: 'grow' }), h('button', { class: 'btn ghost sm', onclick: runRisks }, icon('refresh', 14), 'Re-analyze')), riskBox),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Status update'), h('span', { class: 'grow' }), sumBtn), sumBox)),
    h('div', { class: 'col', style: { gap: '16px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Work by status')), h('div', { class: 'card-body col' }, h('div', { class: 'bar', style: { height: '12px' } }, counts.map(c => h('i', { style: { width: (c.n / total * 100) + '%', background: colors[c.id] }, title: `${c.label}: ${c.n}` }))),
        counts.map(c => h('div', { class: 'row' }, h('i', { class: 'pdot', style: { background: colors[c.id] } }), h('span', { class: 'grow' }, c.label), h('b', c.n))))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Workload')), h('div', { class: 'card-body col', style: { gap: '12px' } }, load.map(l => h('div', h('div', { class: 'row', style: { marginBottom: '4px' } }, avatar(l.m, 22), h('span', { class: 'grow' }, l.m.name), h('span', { class: 'small faint' }, `${l.open} open${l.hours ? ' · ' + l.hours + 'h' : ''}`)), h('div', { class: 'bar' }, h('i', { style: { width: (l.open / max * 100) + '%', background: l.open >= 6 ? 'var(--amber)' : 'var(--accent)' } })))))))));
}
