// Tiny DOM toolkit: h() builds elements safely (text is never parsed as HTML).
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...kids) => append(clear(el), kids);

// ---- icons (24x24 stroke icons) ----
const P = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v6h-4z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l3 3 5-6',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.7a3.5 3.5 0 0 1 0 6.6',
  zap: 'M13 3 5 13.5h6L10 21l8-10.5h-6z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 15l.6 1.6L7 17l-1.4.4L5 19l-.6-1.6L3 17l1.4-.4z',
  mail: 'M3 6.5h18v11H3zM3.5 7l8.5 6.5L20.5 7',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  x: 'M6 6l12 12M18 6 6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8h.01',
  message: 'M4 5h16v11H9l-5 4z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  send: 'M4 12 20 4l-4 16-4-7z',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  folder: 'M3 6h6l2 2h10v11H3z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  refresh: 'M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bot: 'M5 9h14v10H5zM12 5v4M9.5 14h.01M14.5 14h.01M3 13v2M21 13v2',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  whatsapp: 'M4 20l1.2-4A8 8 0 1 1 8 18.8z',
  bug: 'M9 7V5a3 3 0 0 1 6 0v2M6 9h12v6a6 6 0 0 1-12 0zM3 13h3M18 13h3M4 19l3-2M20 19l-3-2M4 7l3 2M20 7l-3 2M12 9v12',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  paperclip: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14 7',
  play: 'M7 4l13 8-13 8z', pause: 'M7 4h3v16H7zM14 4h3v16h-3z', stop: 'M6 6h12v12H6z',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  gantt: 'M4 6h9M8 12h12M6 18h8',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
  rocket: 'M5 15c-1 1-2 4-2 6 2 0 5-1 6-2M14 4c4-1 6 0 6 0s1 2 0 6l-7 7-6-6zM9.5 14.5 7 12',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM6 11a6 6 0 0 0 12 0M12 17v4',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  fileText: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  barChart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.5 3.1 5.5 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.700 5.700 5.500 6-.6.6-.6 1.200-.5 2V21',
  clipboard: 'M9 4h6v3H9zM7 5H5v16h14V5h-2',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  key: 'M14 10a4 4 0 1 0-3.9 4l.9.9V18h3v2h3v-3l2-2.100zM8 10h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  wand: 'M4 20 15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.300 1.300.7-1.300.7-.7 1.300-.7-1.300-1.300-.7 1.300-.7z',
};
export function icon(name, size = 18, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'icon ' + cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.more);
  s.append(p);
  return s;
}

// ---- formatting ----
export const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
export function avatar(user, size = 24) {
  if (!user) return h('span', { class: 'avatar unassigned', style: { width: size + 'px', height: size + 'px' }, title: 'Unassigned' }, icon('user', size * 0.58));
  return h('span', { class: 'avatar', title: user.name || user.user_name, style: { width: size + 'px', height: size + 'px', background: user.color || user.user_color || '#64748b', fontSize: Math.round(size * 0.4) + 'px' } }, initials(user.name || user.user_name));
}
export const todayStr = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
export function dueInfo(due, done) {
  if (!due) return null;
  const t = todayStr();
  const diff = Math.round((new Date(due + 'T00:00:00') - new Date(t + 'T00:00:00')) / 86400000);
  const d = new Date(due + 'T00:00:00');
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { label, state: done ? 'done' : diff < 0 ? 'overdue' : diff <= 1 ? 'soon' : 'ok', diff };
}
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const TYPE = { task: ['check', 'Task', 'var(--text-3)'], bug: ['bug', 'Bug', 'var(--red)'], story: ['bookmark', 'Story', 'var(--green)'], epic: ['layers', 'Epic', '#8b5cf6'] };
export const typeIcon = (type, size = 14) => { const [ico, label, color] = TYPE[type] || TYPE.task; const el = icon(ico, size); el.style.color = color; el.setAttribute('aria-label', label); return h('span', { title: label, style: { display: 'inline-flex' } }, el); };
export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h2 = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h2 ? `${h2}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
export const PRIORITY = { urgent: { label: 'Urgent', color: 'var(--p-urgent)' }, high: { label: 'High', color: 'var(--p-high)' }, medium: { label: 'Medium', color: 'var(--p-medium)' }, low: { label: 'Low', color: 'var(--p-low)' } };
export const STATUS_LABEL = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'In review', done: 'Done' };
export function priorityBadge(p, compact) {
  const pr = PRIORITY[p] || PRIORITY.medium;
  return h('span', { class: 'prio' + (compact ? ' compact' : ''), title: pr.label + ' priority' }, h('i', { style: { background: pr.color } }), compact ? null : pr.label);
}
export function statusDot(s, category) { return h('span', { class: 'sdot s-' + s + (['backlog', 'todo', 'in_progress', 'review', 'done'].includes(s) ? '' : ' c-' + (category || 'todo')) }); }

// ---- toast / modal / popover ----
let toastHost;
export function toast(msg, kind = 'info', ms = 3800) {
  if (!toastHost) toastHost = document.body.appendChild(h('div', { class: 'toasts', 'aria-live': 'polite' }));
  const t = h('div', { class: 'toast ' + kind }, msg);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
}

export function modal({ title, body, actions = [], width = 480, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: { maxWidth: width + 'px' } },
      h('div', { class: 'modal-head' }, h('h3', title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map(a => h('button', { class: 'btn ' + (a.kind || ''), onclick: async e => { const r = await a.onClick?.(e, close); if (r !== false && !a.keepOpen) close(); } }, a.label))) : null));
  document.body.append(back);
  document.addEventListener('keydown', esc);
  setTimeout(() => back.querySelector('input,textarea,select')?.focus(), 30);
  return { close, el: back };
}
export const confirmDialog = (title, text, label = 'Delete') => new Promise(res => {
  let done = false;
  modal({ title, body: h('p', { class: 'muted' }, text), width: 400, onClose: () => { if (!done) res(false); },
    actions: [{ label: 'Cancel' }, { label, kind: 'danger', onClick: () => { done = true; res(true); } }] });
});

// Popover menu anchored to an element. items: [{label, icon, onClick, danger, checked}] or {divider}
export function menu(anchor, items, { align = 'left' } = {}) {
  document.querySelector('.popover')?.remove();
  const pop = h('div', { class: 'popover', role: 'menu' }, items.map(it => it.divider ? h('div', { class: 'divider' }) : it.header ? h('div', { class: 'pop-head' }, it.header) :
    h('button', { class: 'pop-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), role: 'menuitem', onclick: () => { pop.remove(); it.onClick?.(); } },
      it.node || (it.icon ? icon(it.icon, 16) : null), h('span', it.label), it.checked ? icon('check', 14, 'tick') : null)));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, hh = pop.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + hh > innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  const off = e => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', k); } };
  const k = e => { if (e.key === 'Escape') { pop.remove(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', k); } };
  setTimeout(() => { document.addEventListener('mousedown', off, true); document.addEventListener('keydown', k); }, 0);
  return pop;
}

export function renderMarkdownLite(text) {
  // Safe mini-markdown: **bold**, `code`, "- " bullets, "- [ ]" checklists, line breaks. Builds nodes (no innerHTML).
  const wrap = h('div', { class: 'md' });
  const inline = (s, parent) => {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|@[a-z0-9][a-z0-9._-]*)/gi;
    let last = 0, m;
    while ((m = re.exec(s))) {
      parent.append(s.slice(last, m.index));
      const t = m[0];
      parent.append(t.startsWith('**') ? h('strong', t.slice(2, -2)) : t.startsWith('`') ? h('code', t.slice(1, -1)) : h('span', { class: 'mention' }, t));
      last = m.index + t.length;
    }
    parent.append(s.slice(last));
  };
  let ul = null;
  for (const line of String(text || '').split('\n')) {
    const li = line.match(/^\s*[-•*]\s+(\[( |x)\]\s+)?(.*)$/i);
    if (li) {
      if (!ul) ul = wrap.appendChild(h('ul'));
      const item = h('li');
      if (li[1]) item.append(h('span', { class: 'cb' + (li[2].toLowerCase() === 'x' ? ' on' : '') }, li[2].toLowerCase() === 'x' ? icon('check', 11) : null));
      inline(li[3], item); ul.append(item);
    } else {
      ul = null;
      if (!line.trim()) { wrap.append(h('div', { class: 'gap' })); continue; }
      const p = h('p'); inline(line, p); wrap.append(p);
    }
  }
  return wrap;
}
