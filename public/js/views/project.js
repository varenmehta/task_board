import { h, mount, icon, avatar, toast, menu, modal, confirmDialog, priorityBadge, statusDot, dueInfo, PRIORITY, todayStr, renderMarkdownLite, typeIcon, TYPE } from '../dom.js';
import { api } from '../api.js';
import { state, on, userById, projectById, isViewer } from '../state.js';
import { createTaskModal, statusMenu, priorityMenu, assigneeMenu, dateMenu, simpleMenu } from './pickers.js';
import { openTask } from './task.js';
import { calendarView } from './calendar.js';
import { timelineView } from './timeline.js';
import { planView } from './plan.js';
import { projectSettingsView } from './project-settings.js';
import { reloadLookups } from '../main.js';
import { notesImportModal } from './notes.js';

const FILTER_KEY = pid => `tb_filters_${pid}`;
const DEFAULT_FILTERS = { assignee: 'all', priority: 'all', label: 'all', type: 'all', sprint: 'all' };

export async function projectView(el, pid, tab) {
  const ctl = { pid, tab, project: null, tasks: [], members: [], sprints: [], releases: [], views: [], templates: [], q: '', ...DEFAULT_FILTERS, sort: { key: 'default', dir: 1 }, newId: null, sel: new Set() };
  try { Object.assign(ctl, JSON.parse(sessionStorage.getItem(FILTER_KEY(pid)) || '{}')); } catch { /* ignore */ }
  mount(el, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  try { await load(ctl); } catch (e) { mount(el, h('div', { class: 'page' }, h('div', { class: 'empty' }, h('b', 'Project unavailable'), e.message, h('p', h('a', { href: '#/' }, 'Back to dashboard'))))); return; }

  const shell = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } });
  mount(el, shell);
  ctl.reload = async () => { await load(ctl); repaint(); };
  const repaint = (soft) => paint(shell, ctl, repaint, soft);
  ctl.repaintSoon = repaint;
  repaint();

  let t;
  const off = on('task', ev => {
    if (ev.project_id !== pid) return;
    clearTimeout(t);
    t = setTimeout(async () => {
      if (ctl.dragId) { ctl.dirty = true; return; } // don't swap the DOM under an in-flight drag
      await load(ctl).catch(() => {});
      if (ev.change === 'project') await reloadLookups().catch(() => {});
      if (!document.querySelector('.drawer')?.contains(document.activeElement) && !shell.querySelector('.quick-add textarea:focus') && !document.querySelector('.modal-back')) repaint(true);
    }, 150);
  });
  const keys = e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-back, .drawer, .popover')) return;
    if (e.key === 'c' && ctl.project.can_edit) { e.preventDefault(); newTask(ctl, defaultStatusId(ctl)); }
    if (e.key === 'Escape' && ctl.sel.size) { ctl.sel.clear(); repaint(true); }
  };
  document.addEventListener('keydown', keys);
  return () => { off(); clearTimeout(t); document.removeEventListener('keydown', keys); document.body.classList.remove('selecting'); document.querySelector('.bulkbar')?.remove(); };
}

async function load(ctl) {
  const r = await api.get(`/projects/${ctl.pid}/board`);
  Object.assign(ctl, { project: r.project, tasks: r.tasks, members: r.members, sprints: r.sprints, releases: r.releases, views: r.views, templates: r.templates });
  const live = new Set(ctl.tasks.map(t => t.id));
  for (const id of [...ctl.sel]) if (!live.has(id)) ctl.sel.delete(id);
}
const defaultStatusId = ctl => (ctl.project.statuses.find(s => s.id === 'todo') || ctl.project.statuses[0]).id;
const saveFilters = ctl => { try { sessionStorage.setItem(FILTER_KEY(ctl.pid), JSON.stringify({ assignee: ctl.assignee, priority: ctl.priority, label: ctl.label, type: ctl.type, sprint: ctl.sprint })); } catch { /* ignore */ } };
const filtersOf = ctl => ({ assignee: ctl.assignee, priority: ctl.priority, label: ctl.label, type: ctl.type, sprint: ctl.sprint });
const hasFilters = ctl => ['assignee', 'priority', 'label', 'type', 'sprint'].some(k => ctl[k] !== 'all') || ctl.q;

export function visible(ctl) {
  const q = ctl.q.trim().toLowerCase();
  const active = ctl.sprints.find(s => s.state === 'active');
  return ctl.tasks.filter(t =>
    (!q || t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q) || t.labels.some(l => l.includes(q))) &&
    (ctl.assignee === 'all' || (ctl.assignee === 'me' ? t.assignee_id === state.me.id : ctl.assignee === 'none' ? !t.assignee_id : t.assignee_id === +ctl.assignee)) &&
    (ctl.priority === 'all' || t.priority === ctl.priority) && (ctl.label === 'all' || t.labels.includes(ctl.label)) && (ctl.type === 'all' || t.type === ctl.type) &&
    (ctl.sprint === 'all' || (ctl.sprint === 'active' ? active && t.sprint_id === active.id : ctl.sprint === 'backlog' ? !t.sprint_id : t.sprint_id === +ctl.sprint)));
}

function paint(shell, ctl, repaint, soft) {
  const p = ctl.project;
  const readonly = !p.can_edit;
  const scrollers = soft ? [...shell.querySelectorAll('.board-wrap, .table-wrap, .col-body, .page')].map(e => [e.scrollLeft, e.scrollTop]) : null;
  const tabBtn = (k, label, ico) => h('a', { class: 'tab' + (ctl.tab === k ? ' active' : ''), href: `#/project/${p.id}${k === 'board' ? '' : '/' + k}`, style: { textDecoration: 'none' } }, icon(ico, 16), h('span', { class: 'tab-l' }, label));
  const total = ctl.tasks.length, done = ctl.tasks.filter(t => t.status === 'done').length;

  const head = h('div', { class: 'proj-head' },
    h('div', { class: 'proj-title' }, h('span', { class: 'proj-key', style: { background: p.color } }, p.key),
      h('div', { class: 'grow' }, h('h1', p.name), p.description ? h('p', { class: 'muted small', style: { marginTop: '2px' } }, p.description) : null),
      h('span', { class: 'chip green', title: 'Updates appear live' }, h('span', { class: 'live-dot' }), 'Live'),
      total ? h('span', { class: 'chip' }, `${done}/${total} done`) : null,
      p.can_manage ? h('a', { class: 'icon-btn', href: `#/project/${p.id}/settings`, 'aria-label': 'Project settings', title: 'Project settings' }, icon('settings', 18)) : null,
      readonly ? h('span', { class: 'chip amber' }, p.role === 'commenter' ? 'Comment only' : 'View only') : [h('button', { class: 'btn', onclick: () => notesImportModal(ctl), title: 'Create tasks from meeting notes' }, icon('wand', 15), h('span', { class: 'tab-l' }, 'From notes')), h('button', { class: 'btn primary', onclick: () => newTask(ctl, defaultStatusId(ctl)) }, icon('plus', 16), 'New task')]),
    h('div', { class: 'tabs' }, tabBtn('board', 'Board', 'board'), tabBtn('list', 'List', 'list'), tabBtn('calendar', 'Calendar', 'calendar'), tabBtn('timeline', 'Timeline', 'gantt'), tabBtn('plan', 'Plan', 'target'), tabBtn('insights', 'Insights', 'sparkles')));

  let body;
  if (ctl.tab === 'insights') body = insights(ctl);
  else if (ctl.tab === 'plan') body = planView(ctl, repaint);
  else if (ctl.tab === 'settings') body = projectSettingsView(ctl, repaint);
  else {
    const bar = toolbar(ctl, repaint);
    const view = ctl.tab === 'list' ? listView(ctl, repaint) : ctl.tab === 'calendar' ? calendarView(ctl, repaint) : ctl.tab === 'timeline' ? timelineView(ctl, repaint) : boardView(ctl, repaint);
    body = h('div', { style: { display: 'contents' } }, bar, view);
  }
  mount(shell, head, body);
  document.body.classList.toggle('selecting', ctl.sel.size > 0);
  renderBulkBar(ctl, repaint);
  if (scrollers) [...shell.querySelectorAll('.board-wrap, .table-wrap, .col-body, .page')].forEach((e, i) => { if (scrollers[i]) { e.scrollLeft = scrollers[i][0]; e.scrollTop = scrollers[i][1]; } });
}

export function newTask(ctl, status, extra = {}) {
  createTaskModal({ projectId: ctl.pid, status, templates: ctl.templates, ...extra, onCreated: async t => { ctl.newId = t.id; await ctl.reload(); } });
}

// ---------- toolbar ----------
function toolbar(ctl, repaint) {
  const labels = [...new Set(ctl.tasks.flatMap(t => t.labels))].sort();
  const q = h('input', { class: 'input sm', placeholder: 'Filter…', value: ctl.q, 'aria-label': 'Filter tasks', oninput: () => { ctl.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { repaint(true); const n = document.querySelector('.toolbar input'); n?.focus(); n?.setSelectionRange(99, 99); }, 120); } });
  const chip = (label, active, onClick, ico) => h('button', { class: 'fchip' + (active ? ' on' : ''), onclick: e => onClick(e.currentTarget) }, ico ? icon(ico, 14) : null, label, icon('chevronDown', 12));
  const aLabel = ctl.assignee === 'all' ? 'Assignee' : ctl.assignee === 'me' ? 'Me' : ctl.assignee === 'none' ? 'Unassigned' : userById(+ctl.assignee)?.name?.split(' ')[0] || 'Assignee';
  const set = (k, v) => { ctl[k] = v; saveFilters(ctl); repaint(true); };
  const sprintLabel = ctl.sprint === 'all' ? 'Sprint' : ctl.sprint === 'active' ? 'Active sprint' : ctl.sprint === 'backlog' ? 'Backlog' : ctl.sprints.find(s => s.id === +ctl.sprint)?.name || 'Sprint';
  const viewsBtn = h('button', { class: 'fchip', onclick: e => menu(e.currentTarget, [
    ...(ctl.views.length ? ctl.views.map(v => ({ label: v.name + (v.shared ? ' · shared' : ''), icon: 'eye', onClick: () => { Object.assign(ctl, DEFAULT_FILTERS, v.filters); saveFilters(ctl); repaint(true); } })) : [{ header: 'No saved views yet' }]),
    { divider: true }, { label: 'Save current filters as view…', icon: 'plus', onClick: () => saveViewModal(ctl) },
    ...ctl.views.filter(v => v.mine).map(v => ({ label: `Delete “${v.name}”`, icon: 'trash', danger: true, onClick: async () => { await api.del('/views/' + v.id).catch(e => toast(e.message, 'error')); await ctl.reload(); } }))]) }, icon('eye', 14), 'Views', icon('chevronDown', 12));
  return h('div', { class: 'toolbar' }, h('div', { class: 'search', style: { maxWidth: '200px' } }, icon('search', 15), q),
    chip(aLabel, ctl.assignee !== 'all', el => menu(el, [
      { label: 'Everyone', checked: ctl.assignee === 'all', onClick: () => set('assignee', 'all') }, { label: 'Assigned to me', checked: ctl.assignee === 'me', onClick: () => set('assignee', 'me') }, { label: 'Unassigned', checked: ctl.assignee === 'none', onClick: () => set('assignee', 'none') }, { divider: true },
      ...ctl.members.map(m => ({ node: avatar(m, 20), label: m.name, checked: ctl.assignee === String(m.id), onClick: () => set('assignee', String(m.id)) }))]), 'user'),
    chip(ctl.priority === 'all' ? 'Priority' : PRIORITY[ctl.priority].label, ctl.priority !== 'all', el => menu(el, [{ label: 'Any priority', checked: ctl.priority === 'all', onClick: () => set('priority', 'all') }, ...Object.entries(PRIORITY).map(([id, pr]) => ({ label: pr.label, checked: ctl.priority === id, onClick: () => set('priority', id) }))]), 'flag'),
    chip(ctl.type === 'all' ? 'Type' : TYPE[ctl.type][1], ctl.type !== 'all', el => menu(el, [{ label: 'Any type', checked: ctl.type === 'all', onClick: () => set('type', 'all') }, ...Object.entries(TYPE).map(([id, x]) => ({ node: typeIcon(id), label: x[1], checked: ctl.type === id, onClick: () => set('type', id) }))]), 'layers'),
    labels.length ? chip(ctl.label === 'all' ? 'Label' : '#' + ctl.label, ctl.label !== 'all', el => menu(el, [{ label: 'Any label', checked: ctl.label === 'all', onClick: () => set('label', 'all') }, ...labels.map(l => ({ label: '#' + l, checked: ctl.label === l, onClick: () => set('label', l) }))]), 'tag') : null,
    ctl.sprints.length ? chip(sprintLabel, ctl.sprint !== 'all', el => menu(el, [{ label: 'All work', checked: ctl.sprint === 'all', onClick: () => set('sprint', 'all') }, ...(ctl.sprints.some(s => s.state === 'active') ? [{ label: 'Active sprint', checked: ctl.sprint === 'active', onClick: () => set('sprint', 'active') }] : []), { label: 'Backlog (no sprint)', checked: ctl.sprint === 'backlog', onClick: () => set('sprint', 'backlog') }, { divider: true }, ...ctl.sprints.filter(s => s.state !== 'closed').map(s => ({ label: s.name, checked: ctl.sprint === String(s.id), onClick: () => set('sprint', String(s.id)) }))]), 'target') : null,
    viewsBtn,
    hasFilters(ctl) ? h('button', { class: 'btn ghost sm', onclick: () => { Object.assign(ctl, { q: '' }, DEFAULT_FILTERS); saveFilters(ctl); repaint(true); } }, 'Clear') : null,
    h('span', { class: 'grow' }),
    h('a', { class: 'btn ghost sm', href: '/api/reports/export?type=tasks&project_id=' + ctl.pid, title: 'Export CSV' }, icon('download', 14)));
}

function saveViewModal(ctl) {
  const name = h('input', { class: 'input', placeholder: 'e.g. My urgent bugs' });
  const share = h('input', { type: 'checkbox' });
  modal({ title: 'Save view', body: [h('div', { class: 'field' }, h('label', 'Name'), name), ctl.project.can_manage ? h('label', { class: 'row' }, share, 'Share with the whole project') : null],
    actions: [{ label: 'Cancel' }, { label: 'Save view', kind: 'primary', onClick: async () => { try { await api.post(`/projects/${ctl.pid}/views`, { name: name.value, filters: filtersOf(ctl), shared: share.checked }); toast('View saved', 'success'); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}

// ---------- selection & bulk ----------
function toggleSel(ctl, id, repaint) { ctl.sel.has(id) ? ctl.sel.delete(id) : ctl.sel.add(id); repaint(true); }
function renderBulkBar(ctl, repaint) {
  document.querySelector('.bulkbar')?.remove();
  if (!ctl.sel.size) return;
  const ids = [...ctl.sel];
  const apply = async patch => { const r = await api.post('/tasks/bulk', { ids, patch }).catch(e => ({ ok: 0, failed: [{ error: e.message }] })); if (r.failed.length) toast(`${r.ok} updated, ${r.failed.length} failed: ${r.failed[0].error}`, 'error', 5000); else toast(`${r.ok} task${r.ok > 1 ? 's' : ''} updated`, 'success'); ctl.sel.clear(); await ctl.reload(); };
  const bar = h('div', { class: 'bulkbar' }, h('b', `${ids.length} selected`),
    h('button', { class: 'btn sm', onclick: e => statusMenu(e.currentTarget, null, s => apply({ status: s }), ctl.project.statuses) }, 'Status'),
    h('button', { class: 'btn sm', onclick: e => assigneeMenu(e.currentTarget, ctl.members, undefined, id => apply({ assignee_id: id })) }, 'Assign'),
    h('button', { class: 'btn sm', onclick: e => priorityMenu(e.currentTarget, null, p => apply({ priority: p })) }, 'Priority'),
    ctl.sprints.some(s => s.state !== 'closed') ? h('button', { class: 'btn sm', onclick: e => simpleMenu(e.currentTarget, ctl.sprints.filter(s => s.state !== 'closed').map(s => [s.id, s.name]), undefined, id => apply({ sprint_id: id }), 'Backlog') }, 'Sprint') : null,
    h('button', { class: 'btn sm', onclick: e => dateMenu(e.currentTarget, null, d => apply({ due_date: d })) }, 'Due'),
    h('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog(`Delete ${ids.length} task(s)?`, 'This cannot be undone.')) { const r = await api.post('/tasks/bulk', { ids, delete: true }); toast(`${r.ok} deleted${r.failed.length ? `, ${r.failed.length} not allowed` : ''}`); ctl.sel.clear(); await ctl.reload(); } } }, icon('trash', 14)),
    h('button', { class: 'icon-btn', style: { color: 'inherit' }, 'aria-label': 'Clear selection', onclick: () => { ctl.sel.clear(); repaint(true); } }, icon('x', 16)));
  document.body.append(bar);
}

// ---------- board ----------
function card(ctl, t, repaint) {
  const due = dueInfo(t.due_date, t.status === 'done');
  const a = userById(t.assignee_id);
  const canDrag = !isViewer() && ctl.project.can_edit;
  const el = h('div', { class: 'tcard' + (t.status === 'done' ? ' is-done' : '') + (ctl.newId === t.id ? ' new' : '') + (ctl.sel.has(t.id) ? ' selected' : '') + (t.blocked_by_open ? ' is-blocked' : ''), draggable: canDrag ? 'true' : null, tabindex: 0, role: 'button', 'aria-label': `${t.key} ${t.title}`, dataset: { id: t.id },
    onclick: e => { if (e.metaKey || e.ctrlKey || e.shiftKey || ctl.sel.size) { e.preventDefault(); toggleSel(ctl, t.id, repaint); } else openTask(t.id); },
    onkeydown: e => { if (e.key === 'Enter') openTask(t.id); if (e.key === ' ' && canDrag) { e.preventDefault(); toggleSel(ctl, t.id, repaint); } },
    ondragstart: e => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; setTimeout(() => el.classList.add('dragging'), 0); ctl.dragId = t.id; },
    ondragend: () => { el.classList.remove('dragging'); ctl.dragId = null; if (ctl.dirty) { ctl.dirty = false; load(ctl).then(() => ctl.repaintSoon()).catch(() => {}); } document.querySelectorAll('.drop').forEach(c => c.classList.remove('drop')); document.querySelector('.drop-line')?.remove(); } },
    canDrag ? h('button', { class: 'sel-box' + (ctl.sel.has(t.id) ? ' on' : ''), 'aria-label': 'Select task', tabindex: -1, onclick: e => { e.stopPropagation(); toggleSel(ctl, t.id, repaint); } }, ctl.sel.has(t.id) ? icon('check', 12) : null) : null,
    t.labels.length ? h('div', { class: 'labels' }, t.labels.slice(0, 3).map(l => h('span', { class: 'label-chip' }, l)), t.labels.length > 3 ? h('span', { class: 'label-chip' }, '+' + (t.labels.length - 3)) : null) : null,
    h('div', { class: 'title' }, t.title),
    t.subtask_total ? h('div', { class: 'row', style: { gap: '8px' } }, h('div', { class: 'progress' }, h('i', { style: { width: (t.subtask_done / t.subtask_total * 100) + '%' } })), h('span', { class: 'small faint' }, `${t.subtask_done}/${t.subtask_total}`)) : null,
    t.type === 'epic' && t.epic_total ? h('div', { class: 'row', style: { gap: '8px' } }, icon('layers', 12), h('div', { class: 'progress' }, h('i', { style: { width: (t.epic_done / t.epic_total * 100) + '%', background: '#8b5cf6' } })), h('span', { class: 'small faint' }, `${t.epic_done}/${t.epic_total}`)) : null,
    h('div', { class: 'meta' }, typeIcon(t.type, 13), h('span', { class: 'key' }, t.key), priorityBadge(t.priority, true),
      t.blocked_by_open ? h('span', { class: 'blocked-ic', title: `Blocked by ${t.blocked_by_open} open task(s)` }, icon('lock', 12)) : null,
      due ? h('span', { class: 'due ' + due.state }, icon('calendar', 12), due.label) : null,
      t.comment_count ? h('span', { class: 'row', style: { gap: '3px' } }, icon('message', 12), t.comment_count) : null,
      t.attachment_count ? h('span', { class: 'row', style: { gap: '3px' } }, icon('paperclip', 12), t.attachment_count) : null,
      h('span', { class: 'grow' }), avatar(a, 22)));
  return el;
}

function boardView(ctl, repaint) {
  const tasks = visible(ctl);
  const readonly = !ctl.project.can_edit;
  const cols = ctl.project.statuses.map(s => {
    const list = tasks.filter(t => t.status === s.id);
    const total = ctl.tasks.filter(t => t.status === s.id).length;
    const over = s.wip && total > s.wip;
    const body = h('div', { class: 'col-body', dataset: { status: s.id } }, list.length ? list.map(t => card(ctl, t, repaint)) : null);
    const column = h('section', { class: 'column', 'aria-label': s.label },
      h('div', { class: 'col-head' }, statusDot(s.id, s.category), s.label, h('span', { class: 'n' + (over ? ' wip-over' : '') }, list.length), s.wip ? h('span', { class: 'wip' + (over ? ' wip-over' : ''), title: 'Work-in-progress limit' }, `/ ${s.wip}`) : null, h('span', { class: 'grow' }),
        readonly ? null : h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, 'aria-label': `Add task to ${s.label}`, onclick: () => newTask(ctl, s.id) }, icon('plus', 16))),
      body, readonly ? null : quickAdd(ctl, s.id, repaint));
    if (!readonly) wireDrop(ctl, column, body, s.id, repaint);
    return column;
  });
  ctl.newId = null;
  if (!ctl.tasks.length) return h('div', { class: 'board-wrap' }, h('div', { class: 'empty' }, h('b', 'No tasks yet'), readonly ? 'Nothing here yet.' : 'Create your first task, or ask the AI assistant to draft a few.'));
  const wrap = h('div', { class: 'board-wrap' }, h('div', { class: 'board' }, cols));
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
        ctl.newId = t.id; await ctl.reload(); toast(`Created ${t.key}`, 'success');
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
    const same = ctl.tasks.filter(x => x.status === status && x.id !== id).sort((a, b) => a.position - b.position);
    const prev = same[i - 1]?.position, next = same[i]?.position;
    t.position = prev == null ? (next ?? 1024) - 1024 : next == null ? prev + 1024 : (prev + next) / 2;
    t.status = status;
    ctl.tasks.sort((a, b) => a.position - b.position);
    repaint(true);
    try {
      const r = await api.post(`/tasks/${id}/move`, { status, index: i });
      if (r.blocked_by_open && status === 'done') toast(`${r.key} is still blocked by an open task`, 'info', 5000);
      await load(ctl); repaint(true);
    } catch (er) { toast(er.message, 'error'); await load(ctl); repaint(true); }
  });
}

// ---------- list ----------
function listView(ctl, repaint) {
  const readonly = !ctl.project.can_edit;
  let rows = visible(ctl);
  const { key, dir } = ctl.sort;
  const stIdx = id => ctl.project.statuses.findIndex(s => s.id === id);
  const val = { title: t => t.title.toLowerCase(), status: t => stIdx(t.status), priority: t => Object.keys(PRIORITY).indexOf(t.priority), assignee: t => userById(t.assignee_id)?.name || '~', due: t => t.due_date || '9999', key: t => t.number, type: t => t.type };
  if (key !== 'default') rows = [...rows].sort((a, b) => (val[key](a) > val[key](b) ? 1 : val[key](a) < val[key](b) ? -1 : 0) * dir);
  const th = (label, k, cls) => h('th', { class: 'sortable ' + (cls || ''), onclick: () => { ctl.sort = ctl.sort.key === k ? { key: k, dir: -dir } : { key: k, dir: 1 }; repaint(true); } }, label, ctl.sort.key === k ? (dir === 1 ? ' ↑' : ' ↓') : '');
  const patch = async (t, f) => { try { await api.patch('/tasks/' + t.id, f); await ctl.reload(); } catch (e) { toast(e.message, 'error'); } };
  const allSel = rows.length && rows.every(t => ctl.sel.has(t.id));
  const row = t => {
    const due = dueInfo(t.due_date, t.status === 'done');
    const cell = (child, fn) => h('button', { class: 'cell-btn', disabled: readonly, onclick: e => { e.stopPropagation(); fn(e.currentTarget); } }, child);
    return h('tr', { class: 'clickable' + (ctl.sel.has(t.id) ? ' sel-row' : ''), onclick: () => openTask(t.id) },
      h('td', { style: { width: '28px' } }, readonly ? null : h('button', { class: 'check' + (ctl.sel.has(t.id) ? ' on' : ''), 'aria-label': 'Select', onclick: e => { e.stopPropagation(); toggleSel(ctl, t.id, repaint); } }, ctl.sel.has(t.id) ? icon('check', 12) : null)),
      h('td', { class: 'mono small faint nowrap' }, h('span', { class: 'row', style: { gap: '6px' } }, typeIcon(t.type, 13), t.key)),
      h('td', { style: { maxWidth: '420px' } }, h('div', { class: 'ellipsis', style: { fontWeight: 550 } }, t.blocked_by_open ? h('span', { class: 'blocked-ic' }, icon('lock', 12), ' ') : null, t.title), t.labels.length ? h('div', { class: 'labels', style: { marginTop: '3px' } }, t.labels.slice(0, 4).map(l => h('span', { class: 'label-chip' }, l))) : null),
      h('td', cell([statusDot(t.status, t.status_category), t.status_label], el => statusMenu(el, t.status, s => patch(t, { status: s }), ctl.project.statuses))),
      h('td', cell(priorityBadge(t.priority), el => priorityMenu(el, t.priority, p => patch(t, { priority: p })))),
      h('td', { class: 'hide-sm' }, cell([avatar(userById(t.assignee_id), 22), userById(t.assignee_id)?.name || h('span', { class: 'faint' }, 'Unassigned')], el => assigneeMenu(el, ctl.members, t.assignee_id, id => patch(t, { assignee_id: id })))),
      h('td', cell(due ? h('span', { class: 'due ' + due.state }, due.label) : h('span', { class: 'faint' }, '—'), el => dateMenu(el, t.due_date, d => patch(t, { due_date: d })))),
      h('td', { class: 'hide-sm small faint' }, t.subtask_total ? `${t.subtask_done}/${t.subtask_total}` : ''));
  };
  const body = [];
  if (key === 'default') {
    for (const s of ctl.project.statuses) {
      const g = rows.filter(t => t.status === s.id);
      if (!g.length) continue;
      body.push(h('tr', { class: 'group-row' }, h('td', { colspan: 8 }, h('span', { class: 'row' }, statusDot(s.id, s.category), s.label, h('span', { class: 'chip' }, g.length)))), ...g.map(row));
    }
  } else body.push(...rows.map(row));
  return h('div', { class: 'table-wrap' }, rows.length ? h('table', { class: 't' }, h('thead', h('tr', h('th', { style: { width: '28px' } }, readonly ? '' : h('button', { class: 'check' + (allSel ? ' on' : ''), 'aria-label': 'Select all', onclick: () => { allSel ? rows.forEach(t => ctl.sel.delete(t.id)) : rows.forEach(t => ctl.sel.add(t.id)); repaint(true); } }, allSel ? icon('check', 12) : null)), th('Key', 'key'), th('Title', 'title'), th('Status', 'status'), th('Priority', 'priority'), th('Assignee', 'assignee', 'hide-sm'), th('Due', 'due'), h('th', { class: 'hide-sm' }, 'Sub'))), h('tbody', body)) : h('div', { class: 'empty' }, h('b', 'No matching tasks'), 'Try clearing your filters.'));
}

// ---------- insights ----------
function insights(ctl) {
  const counts = ctl.project.statuses.map(s => ({ ...s, n: ctl.tasks.filter(t => t.status === s.id).length }));
  const total = ctl.tasks.length || 1;
  const palette = ['var(--text-3)', 'var(--blue)', 'var(--amber)', '#8b5cf6', '#ec4899', '#14b8a6', 'var(--green)'];
  const colorOf = (s, i) => s.id === 'done' ? 'var(--green)' : palette[Math.min(i, palette.length - 2)];
  const load = ctl.members.map(m => ({ m, open: ctl.tasks.filter(t => t.assignee_id === m.id && t.status !== 'done').length, hours: ctl.tasks.filter(t => t.assignee_id === m.id && t.status !== 'done').reduce((a, t) => a + (t.estimate || 0), 0) })).sort((a, b) => b.open - a.open);
  const max = Math.max(1, ...load.map(l => l.open));

  const riskBox = h('div', { class: 'card-body' }, h('div', { class: 'loading', style: { height: '90px' } }, h('span', { class: 'spinner' })));
  const sumBox = h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Generate a ready-to-paste status update for your standup or stakeholders.'));
  async function runRisks() {
    mount(riskBox, h('div', { class: 'loading', style: { height: '90px' } }, h('span', { class: 'spinner' })));
    try {
      const r = await api.post('/ai/risks', { project_id: ctl.pid, today: todayStr() });
      mount(riskBox, r.summary ? h('p', { class: 'muted', style: { marginBottom: '8px' } }, r.summary) : null,
        r.risks.length ? r.risks.map(x => h('div', { class: 'risk', style: { cursor: x.task_id ? 'pointer' : 'default' }, onclick: () => x.task_id && openTask(x.task_id) }, h('span', { class: 'lvl ' + x.level }), h('div', x.key ? h('b', { class: 'mono small' }, x.key + ' ') : null, x.reason))) : h('div', { class: 'empty', style: { padding: '14px' } }, '🎉 Nothing looks at risk.'));
      if (r.warning) riskBox.append(h('p', { class: 'hint' }, 'AI unavailable, showing rule-based analysis.'));
    } catch (e) { mount(riskBox, h('p', { class: 'error-msg' }, e.message)); }
  }
  async function runSummary(b) {
    b.disabled = true; mount(sumBox, h('div', { class: 'loading', style: { height: '120px' } }, h('span', { class: 'spinner' })));
    try {
      const r = await api.post('/ai/summary', { project_id: ctl.pid, today: todayStr() });
      mount(sumBox, renderMarkdownLite(r.text), h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(r.text).then(() => toast('Copied'), () => {}) }, icon('copy', 14), 'Copy')));
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
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Work by status')), h('div', { class: 'card-body col' }, h('div', { class: 'bar', style: { height: '12px' } }, counts.map((c, i) => h('i', { style: { width: (c.n / total * 100) + '%', background: colorOf(c, i) }, title: `${c.label}: ${c.n}` }))),
        counts.map((c, i) => h('div', { class: 'row' }, h('i', { class: 'pdot', style: { background: colorOf(c, i) } }), h('span', { class: 'grow' }, c.label), h('b', c.n))))),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', 'Workload')), h('div', { class: 'card-body col', style: { gap: '12px' } }, load.map(l => h('div', h('div', { class: 'row', style: { marginBottom: '4px' } }, avatar(l.m, 22), h('span', { class: 'grow' }, l.m.name), h('span', { class: 'small faint' }, `${l.open} open${l.hours ? ' · ' + l.hours + 'h' : ''}`)), h('div', { class: 'bar' }, h('i', { style: { width: (l.open / max * 100) + '%', background: l.open >= 6 ? 'var(--amber)' : 'var(--accent)' } })))))))));
}
void renderMarkdownLite; void isViewer;
