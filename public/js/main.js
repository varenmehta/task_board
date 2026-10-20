import { h, $, mount, icon, avatar, toast, menu, clear, priorityBadge } from './dom.js';
import { api } from './api.js';
import { state, on, emit, canManage, isViewer } from './state.js';
import { renderAuth } from './views/auth.js';
import { dashboardView } from './views/dashboard.js';
import { projectView } from './views/project.js';
import { myTasksView } from './views/mytasks.js';
import { inboxView } from './views/inbox.js';
import { teamView } from './views/team.js';
import { automationsView } from './views/automations.js';
import { settingsView } from './views/settings.js';
import { openTask } from './views/task.js';
import { toggleAssistant } from './views/assistant.js';
import { projectModal, teamModal } from './views/team.js';
import { reportsView } from './views/reports.js';
import { capacityView } from './views/capacity.js';
import { openPalette, shortcutsHelp } from './views/palette.js';
import { fmtDuration } from './dom.js';

const root = $('#root');
let cleanup = null, es = null;

// ---------- boot ----------
async function boot() {
  try {
    const b = await api.get('/bootstrap');
    state.demo = b.demo;
    state.sso = b.sso;
    Object.assign(state, { workspace: b.workspace, statuses: b.statuses, aiMode: b.ai_mode, me: b.me });
    document.title = b.workspace;
    if (b.needs_setup) return renderAuth(root, 'setup', onAuthed);
    if (!b.me) return renderAuth(root, location.hash.startsWith('#/invite/') ? 'invite' : 'login', onAuthed);
    await startApp();
  } catch (e) {
    mount(root, h('div', { class: 'empty' }, h('b', 'Can’t reach the server'), e.message, h('p', h('button', { class: 'btn', onclick: () => location.reload() }, 'Retry'))));
  }
}
async function onAuthed(me) {
  state.me = me;
  if (location.hash.startsWith('#/invite/') || location.hash.startsWith('#/login')) location.hash = '#/';
  await startApp();
}

export async function reloadLookups() {
  const [projects, users, teams] = await Promise.all([api.get('/projects'), api.get('/users'), api.get('/teams')]);
  Object.assign(state, { projects, users, teams });
  renderSidebarProjects();
}

async function startApp() {
  await reloadLookups();
  buildShell();
  connectEvents();
  window.addEventListener('hashchange', route);
  route();
}

window.addEventListener('tb:unauthorized', () => { if (state.me) { state.me = null; es?.close(); renderAuth(root, 'login', onAuthed); toast('Please sign in again', 'error'); } });

// ---------- shell ----------
let sidebarNav, viewEl, bellBtn;
const timerChip = h('button', { class: 'timer-chip hide', 'aria-label': 'Running timer' });
let timerState = null, timerTick = null;
async function refreshTimer() {
  const t = await api.get('/timer').catch(() => null);
  timerState = t && !t.none ? { ...t, at: Date.now() } : null;
  paintTimer();
}
function paintTimer() {
  clearInterval(timerTick);
  if (!timerState) return timerChip.classList.add('hide');
  const draw = () => { const secs = timerState.elapsed + (Date.now() - timerState.at) / 1000; const m = Math.floor(secs / 60), s2 = Math.floor(secs % 60); timerChip.replaceChildren(icon('clock', 14), `${timerState.key} · ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s2).padStart(2, '0')}`); };
  draw(); timerChip.classList.remove('hide'); timerTick = setInterval(draw, 1000);
  timerChip.onclick = () => openTask(timerState.task_id);
}
function timerChipInit() { refreshTimer(); on('timer', refreshTimer); }
function buildShell() {
  sidebarNav = h('div', { class: 'side-scroll' });
  viewEl = h('div', { style: { display: 'contents' } });
  bellBtn = h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: () => (location.hash = '#/inbox') }, icon('bell', 19));
  const searchBox = searchWidget();
  const app = h('div', { id: 'app' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('board', 17)), h('span', { class: 'ellipsis' }, state.workspace)),
      sidebarNav,
      h('div', { class: 'side-foot' }, h('button', { class: 'me-row', onclick: e => meMenu(e.currentTarget) },
        avatar(state.me, 32), h('div', { class: 'grow' }, h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, state.me.name), h('div', { class: 'small faint', style: { textTransform: 'capitalize' } }, state.me.role)), icon('chevronDown', 15)))),
    h('main', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu', 20)),
        searchBox, h('div', { class: 'grow' }),
        timerChip,
        h('button', { class: 'btn ai sm', onclick: () => toggleAssistant(), title: 'AI assistant' }, icon('sparkles', 15), 'Ask AI'),
        bellBtn),
      viewEl));
  mount(root, app);
  renderSidebar();
  updateBell();
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) { e.preventDefault(); $('.search .input')?.focus(); }
  });
  document.addEventListener('click', e => { if (e.target.closest('.sidebar a, .nav-item')) document.body.classList.remove('nav-open'); });
  // vim-style "g then <key>" navigation and "?" help
  let gPending = null;
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-back, .popover')) return;
    if (gPending) { const to = { d: '#/', m: '#/my-tasks', i: '#/inbox', r: '#/reports', c: '#/capacity', t: '#/team', a: '#/automations', s: '#/settings' }[e.key]; clearTimeout(gPending); gPending = null; if (to) { e.preventDefault(); location.hash = to; } return; }
    if (e.key === 'g') gPending = setTimeout(() => (gPending = null), 900);
    if (e.key === '?') { e.preventDefault(); shortcutsHelp(); }
  });
  timerChipInit();
  if (!isViewer()) root.append(h('button', { class: 'fab', onclick: () => toggleAssistant(), 'aria-label': 'AI assistant' }, icon('sparkles', 18), h('span', 'AI assistant')));
}

function navItem(href, ico, label, extra) {
  const current = location.hash || '#/';
  const active = href === '#/' ? current === '#/' : current.startsWith(href);
  return h('a', { class: 'nav-item' + (active ? ' active' : ''), href }, icon(ico, 18), h('span', label), extra);
}

export function renderSidebar() {
  if (!sidebarNav) return;
  const unread = state.unread;
  const byTeam = new Map();
  for (const p of state.projects) { if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, { name: p.team_name, color: p.team_color, projects: [] }); byTeam.get(p.team_id).projects.push(p); }
  mount(sidebarNav,
    navItem('#/', 'home', 'Dashboard'),
    navItem('#/my-tasks', 'checkCircle', 'My tasks'),
    navItem('#/inbox', 'inbox', 'Inbox', unread ? h('span', { class: 'count' }, unread > 99 ? '99+' : unread) : null),
    h('div', { class: 'nav-title' }, 'Projects', canManage() || state.teams.some(t => t.can_manage) ? h('button', { class: 'icon-btn', style: { width: '22px', height: '22px' }, title: 'New project', 'aria-label': 'New project', onclick: () => projectModal() }, icon('plus', 15)) : null),
    h('div', { id: 'side-projects' }),
    h('div', { class: 'nav-title' }, 'Workspace'),
    state.me.role !== 'guest' ? navItem('#/reports', 'barChart', 'Reports') : null,
    state.me.role !== 'guest' ? navItem('#/capacity', 'clock', 'Capacity') : null,
    navItem('#/team', 'users', 'Teams & people'),
    navItem('#/automations', 'zap', 'Automations'),
    navItem('#/settings', 'settings', 'Settings'));
  renderSidebarProjects();
}
function renderSidebarProjects() {
  const box = $('#side-projects');
  if (!box) return;
  const cur = location.hash;
  const byTeam = new Map();
  for (const p of state.projects) { if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, { name: p.team_name, color: p.team_color, projects: [] }); byTeam.get(p.team_id).projects.push(p); }
  mount(box, byTeam.size ? [...byTeam.values()].map(t => h('div', h('div', { class: 'team-label' }, h('span', { class: 'pdot', style: { background: t.color } }), t.name),
    t.projects.map(p => h('a', { class: 'nav-item' + (cur.startsWith(`#/project/${p.id}`) ? ' active' : ''), href: `#/project/${p.id}`, style: { paddingLeft: '22px' } },
      h('span', { class: 'pdot', style: { background: p.color } }), h('span', { class: 'ellipsis' }, p.name), p.overdue ? h('span', { class: 'count', style: { background: 'var(--red)' }, title: `${p.overdue} overdue` }, p.overdue) : null)))) : h('p', { class: 'small faint', style: { padding: '6px 12px' } }, 'No projects yet — ask a team lead to add you to a team.'));
}

function meMenu(anchor) {
  const dark = document.documentElement.dataset.theme === 'dark';
  menu(anchor, [
    { header: state.me.email },
    { label: 'Profile & notifications', icon: 'settings', onClick: () => (location.hash = '#/settings/profile') },
    { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon', onClick: () => { const t = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('tb_theme', t); } catch { /* private mode */ } } },
    { divider: true },
    { label: 'Sign out', icon: 'logout', danger: true, onClick: async () => { es?.close(); await api.post('/logout'); location.reload(); } },
  ]);
}

// ---------- global search ----------
function searchWidget() {
  const results = h('div', { class: 'search-results hide' });
  const input = h('input', { class: 'input', placeholder: 'Search tasks…  (press / )', 'aria-label': 'Search tasks' });
  let timer, sel = -1, items = [];
  const close = () => { results.classList.add('hide'); sel = -1; };
  const paint = () => items.forEach((b, i) => b.classList.toggle('sel', i === sel));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const r = await api.get('/search?q=' + encodeURIComponent(q)).catch(() => []);
      items = r.map(t => h('button', { onclick: () => { close(); input.value = ''; openTask(t.id); } },
        h('span', { class: 'sdot s-' + t.status }), h('span', { class: 'mono small faint' }, t.key), h('span', { class: 'grow ellipsis' }, t.title), priorityBadge(t.priority, true)));
      mount(results, items.length ? items : h('div', { class: 'empty', style: { padding: '18px' } }, 'No matching tasks'));
      results.classList.remove('hide'); sel = -1;
    }, 180);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); input.blur(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    if (e.key === 'Enter' && items[sel]) items[sel].click();
  });
  document.addEventListener('mousedown', e => { if (!e.target.closest('.search')) close(); });
  return h('div', { class: 'search' }, icon('search', 16), input, h('span', { class: 'kbd' }, '⌘K'), results);
}

// ---------- notifications / live updates ----------
function updateBell() {
  bellBtn?.querySelector('.bell-dot')?.remove();
  if (state.unread) bellBtn?.append(h('span', { class: 'bell-dot' }, state.unread > 9 ? '9+' : state.unread));
  if (state.unread) document.title = `(${state.unread}) ${state.workspace}`; else document.title = state.workspace;
}
export function setUnread(n) { state.unread = n; updateBell(); renderSidebar(); }

function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('task', e => emit('task', JSON.parse(e.data)));
  es.addEventListener('timer', () => emit('timer', {}));
  es.addEventListener('notification', e => {
    const n = JSON.parse(e.data);
    setUnread(state.unread + 1);
    emit('notification', n);
    toast('🔔 ' + n.title);
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const note = new Notification(n.title, { body: n.body, icon: '/icon.svg' });
      note.onclick = () => { focus(); if (n.task_id) location.hash = '#/task/' + n.task_id; };
    }
  });
  api.get('/notifications').then(r => setUnread(r.unread)).catch(() => {});
}

// ---------- router ----------
const routes = [
  [/^#\/?$/, () => dashboardView],
  [/^#\/project\/(\d+)(?:\/(\w+))?/, m => (el) => projectView(el, +m[1], m[2] || 'board')],
  [/^#\/my-tasks/, () => myTasksView],
  [/^#\/inbox/, () => inboxView],
  [/^#\/reports/, () => reportsView],
  [/^#\/capacity/, () => capacityView],
  [/^#\/team/, () => teamView],
  [/^#\/automations/, () => automationsView],
  [/^#\/settings(?:\/(\w+))?/, m => (el) => settingsView(el, m[1] || 'profile')],
];

async function route() {
  const hash = location.hash || '#/';
  const tm = hash.match(/^#\/task\/(\d+)/);
  if (tm) {
    try { const t = await api.get('/tasks/' + tm[1]); history.replaceState(null, '', `#/project/${t.project_id}`); } catch (e) { toast(e.message, 'error'); history.replaceState(null, '', '#/'); }
    await route();
    if (tm) openTask(+tm[1]);
    return;
  }
  cleanup?.(); cleanup = null;
  document.querySelector('.drawer-back, .drawer')?.remove?.();
  renderSidebar();
  for (const [re, make] of routes) {
    const m = hash.match(re);
    if (m) {
      const view = make(m);
      mount(viewEl);
      const out = await view(viewEl);
      cleanup = typeof out === 'function' ? out : null;
      return;
    }
  }
  mount(viewEl, h('div', { class: 'page' }, h('div', { class: 'empty' }, h('b', 'Page not found'), h('a', { href: '#/' }, 'Back to dashboard'))));
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
