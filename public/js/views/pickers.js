import { h, icon, menu, avatar, PRIORITY, STATUS_LABEL, priorityBadge, statusDot, modal, toast, todayStr, $ } from '../dom.js';
import { api } from '../api.js';
import { state, userById, membersOfProject, projectById } from '../state.js';

export const statusMenu = (anchor, cur, cb) => menu(anchor, state.statuses.map(s => ({ node: statusDot(s.id), label: s.label, checked: s.id === cur, onClick: () => cb(s.id) })));
export const priorityMenu = (anchor, cur, cb) => menu(anchor, Object.entries(PRIORITY).map(([id, p]) => ({ node: h('i', { style: { width: '8px', height: '8px', background: p.color, borderRadius: '3px', transform: 'rotate(45deg)', margin: '0 4px' } }), label: p.label, checked: id === cur, onClick: () => cb(id) })));
export const assigneeMenu = (anchor, members, cur, cb) => menu(anchor, [
  { node: avatar(null, 20), label: 'Unassigned', checked: !cur, onClick: () => cb(null) },
  { divider: true },
  ...members.map(m => ({ node: avatar(m, 20), label: m.name + (m.id === state.me.id ? ' (you)' : ''), checked: m.id === cur, onClick: () => cb(m.id) })),
]);

function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
export function dateMenu(anchor, cur, cb) {
  const input = h('input', { type: 'date', value: cur || '', style: { position: 'fixed', opacity: 0, pointerEvents: 'none', left: anchor.getBoundingClientRect().left + 'px', top: anchor.getBoundingClientRect().bottom + 'px' }, onchange: () => { cb(input.value || null); input.remove(); } });
  document.body.append(input);
  const nextMon = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  menu(anchor, [
    { label: 'Today', icon: 'calendar', onClick: () => cb(todayStr()) }, { label: 'Tomorrow', icon: 'calendar', onClick: () => cb(addDays(1)) },
    { label: 'Next Monday', icon: 'calendar', onClick: () => cb(nextMon()) }, { label: 'In a week', icon: 'calendar', onClick: () => cb(addDays(7)) },
    { label: 'Pick a date…', icon: 'edit', onClick: () => { try { input.showPicker(); } catch { input.focus(); input.click(); } setTimeout(() => { if (!input.value) setTimeout(() => input.remove(), 60000); }, 0); } },
    ...(cur ? [{ divider: true }, { label: 'Clear date', icon: 'x', danger: true, onClick: () => cb(null) }] : []),
  ]);
  setTimeout(() => { if (!document.querySelector('.popover') && !input.matches(':focus')) input.remove(); }, 100);
}

export function labelEditor(labels, onChange, { readonly = false } = {}) {
  const wrap = h('div', { class: 'labels', style: { alignItems: 'center' } });
  const paint = () => {
    wrap.replaceChildren(...labels.map(l => h('span', { class: 'label-chip' }, l, readonly ? null : h('button', { class: 'icon-btn', style: { width: '14px', height: '14px', marginLeft: '3px', verticalAlign: 'middle' }, 'aria-label': 'Remove ' + l, onclick: () => { labels.splice(labels.indexOf(l), 1); onChange([...labels]); paint(); } }, icon('x', 10))),
    ), readonly ? '' : h('input', { class: 'input', style: { width: '110px', height: '24px', fontSize: '12px', padding: '0 8px' }, placeholder: '+ label', onkeydown: e => {
      if ((e.key === 'Enter' || e.key === ',') && e.target.value.trim()) { e.preventDefault(); const v = e.target.value.trim().toLowerCase().replace(/\s+/g, '-'); if (!labels.includes(v) && labels.length < 8) { labels.push(v); onChange([...labels]); } paint(); wrap.querySelector('input').focus(); }
      if (e.key === 'Backspace' && !e.target.value && labels.length) { labels.pop(); onChange([...labels]); paint(); wrap.querySelector('input').focus(); }
    } }));
  };
  paint();
  return wrap;
}

// ---- create-task modal with "describe it in plain English" AI fill ----
export function createTaskModal({ projectId, status = 'todo', draft = {}, onCreated }) {
  const project = projectById(projectId);
  const members = membersOfProject(projectId);
  const v = { title: draft.title || '', description: draft.description || '', status: draft.status || status, priority: draft.priority || 'medium', assignee_id: draft.assignee_id ?? null, due_date: draft.due_date || null, estimate: draft.estimate ?? null, labels: [...(draft.labels || [])] };
  const magic = h('input', { class: 'input', placeholder: 'e.g. "Fix login redirect bug by Friday, assign to Marcus, urgent"', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); fill(); } } });
  const title = h('input', { class: 'input', value: v.title, placeholder: 'Task title', oninput: () => (v.title = title.value) });
  const desc = h('textarea', { class: 'textarea', placeholder: 'Add context, links, acceptance criteria…', oninput: () => (v.description = desc.value) }, v.description);
  const row = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } });
  const fillBtn = h('button', { class: 'btn ai', onclick: fill }, icon('sparkles', 15), 'Fill');
  const note = h('div', { class: 'hint' }, state.aiMode === 'claude' ? 'Claude will structure your text into a task.' : 'Smart parsing works offline (dates, @people, #labels, priority). Add an Anthropic key in Settings for full AI.');

  const chip = (label, node, onClick) => h('button', { class: 'fchip', type: 'button', onclick: e => onClick(e.currentTarget) }, node, label);
  const paintRow = () => {
    const a = userById(v.assignee_id);
    row.replaceChildren(
      chip(state.statuses.find(s => s.id === v.status).label, statusDot(v.status), el => statusMenu(el, v.status, s => { v.status = s; paintRow(); })),
      chip(PRIORITY[v.priority].label, h('i', { style: { width: '8px', height: '8px', background: PRIORITY[v.priority].color, borderRadius: '3px', transform: 'rotate(45deg)' } }), el => priorityMenu(el, v.priority, p => { v.priority = p; paintRow(); })),
      chip(a ? a.name : 'Unassigned', avatar(a, 18), el => assigneeMenu(el, members, v.assignee_id, id => { v.assignee_id = id; paintRow(); })),
      chip(v.due_date ? new Date(v.due_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date', icon('calendar', 14), el => dateMenu(el, v.due_date, d => { v.due_date = d; paintRow(); })),
      v.estimate != null ? h('span', { class: 'chip' }, v.estimate + 'h est.') : null);
  };
  paintRow();
  const labelsBox = labelEditor(v.labels, l => (v.labels = l));

  async function fill() {
    const text = magic.value.trim();
    if (!text) return;
    fillBtn.disabled = true; fillBtn.replaceChildren(h('span', { class: 'spinner' }), 'Thinking');
    try {
      const d = await api.post('/ai/parse', { text, project_id: projectId, today: todayStr() });
      Object.assign(v, { title: d.title || v.title, description: d.description || v.description, priority: d.priority || v.priority, assignee_id: d.assignee_id ?? v.assignee_id, due_date: d.due_date || v.due_date, estimate: d.estimate ?? v.estimate });
      if (d.labels?.length) v.labels = [...new Set([...v.labels, ...d.labels])];
      title.value = v.title; desc.value = v.description; paintRow();
      labelsBox.replaceWith(labelEditor(v.labels, l => (v.labels = l))); 
      if (d.warning) toast('AI unavailable — used offline parsing', 'info');
    } catch (e) { toast(e.message, 'error'); }
    fillBtn.disabled = false; fillBtn.replaceChildren(icon('sparkles', 15), 'Fill');
  }

  modal({
    title: `New task · ${project?.name || ''}`, width: 600,
    body: [
      h('div', { class: 'field' }, h('label', '✨ Describe it'), h('div', { class: 'row' }, magic, fillBtn), note),
      h('div', { class: 'field' }, h('label', 'Title'), title), h('div', { class: 'field' }, h('label', 'Description'), desc),
      row, h('div', { class: 'field' }, h('label', 'Labels'), labelsBox),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Create task', kind: 'primary', onClick: async () => {
        v.title = title.value.trim(); v.description = desc.value;
        if (!v.title) { toast('Give the task a title', 'error'); return false; }
        try { const t = await api.post(`/projects/${projectId}/tasks`, v); onCreated?.(t); toast(`Created ${t.key}`, 'success'); } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
  setTimeout(() => (draft.title ? title : magic).focus(), 60);
}
void $;
void priorityBadge;
void STATUS_LABEL;
