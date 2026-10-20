import { h, icon, toast, todayStr, typeIcon } from '../dom.js';
import { api } from '../api.js';
import { openTask } from './task.js';
import { visible, newTask } from './project.js';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function calendarView(ctl, repaint) {
  const now = new Date();
  ctl.cal = ctl.cal || { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = ctl.cal;
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(y, m, 1 - lead);
  const today = todayStr();
  const tasks = visible(ctl).filter(t => t.due_date);
  const byDay = new Map();
  for (const t of tasks) { if (!byDay.has(t.due_date)) byDay.set(t.due_date, []); byDay.get(t.due_date).push(t); }
  const canEdit = ctl.project.can_edit;
  let dragId = null;

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = fmt(d);
    const list = byDay.get(key) || [];
    const cell = h('div', { class: 'cal-d' + (d.getMonth() !== m ? ' out' : '') + (key === today ? ' today' : ''), dataset: { day: key },
      ondblclick: e => { if (canEdit && e.target === cell) newTask(ctl, null, { date: key, status: ctl.project.statuses[1]?.id || ctl.project.statuses[0].id }); },
      ondragover: e => { if (dragId) { e.preventDefault(); cell.classList.add('drop'); } }, ondragleave: () => cell.classList.remove('drop'),
      ondrop: async e => {
        e.preventDefault(); cell.classList.remove('drop');
        if (!dragId) return;
        try { await api.patch('/tasks/' + dragId, { due_date: key }); await ctl.reload(); toast('Rescheduled to ' + key, 'success', 1800); } catch (er) { toast(er.message, 'error'); }
      } },
      h('div', { class: 'row' }, h('span', { class: 'num' }, d.getDate()), h('span', { class: 'grow' }),
        canEdit ? h('button', { class: 'icon-btn', style: { width: '20px', height: '20px', opacity: .5 }, 'aria-label': 'Add task on ' + key, onclick: () => newTask(ctl, null, { date: key }) }, icon('plus', 13)) : null),
      ...list.slice(0, 4).map(t => h('div', { class: 'cal-t' + (t.status === 'done' ? ' done' : '') + (t.due_date < today && t.status !== 'done' ? ' overdue' : ''), draggable: canEdit ? 'true' : null, title: `${t.key} ${t.title}`,
        onclick: () => openTask(t.id), ondragstart: e => { dragId = t.id; e.dataTransfer.setData('text/plain', String(t.id)); }, ondragend: () => { dragId = null; } }, t.title)),
      list.length > 4 ? h('div', { class: 'small faint', style: { paddingLeft: '6px' } }, `+${list.length - 4} more`) : null);
    cells.push(cell);
  }
  const nav = d => { const nd = new Date(y, m + d, 1); ctl.cal = { y: nd.getFullYear(), m: nd.getMonth() }; repaint(true); };
  const unscheduled = visible(ctl).filter(t => !t.due_date && t.status !== 'done').length;
  return h('div', { class: 'table-wrap' },
    h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h2', { style: { minWidth: '170px' } }, first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => nav(-1) }, icon('chevronRight', 18, 'flip')), h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => nav(1) }, icon('chevronRight', 18)),
      h('button', { class: 'btn sm', onclick: () => { ctl.cal = { y: now.getFullYear(), m: now.getMonth() }; repaint(true); } }, 'Today'), h('span', { class: 'grow' }),
      unscheduled ? h('span', { class: 'chip' }, `${unscheduled} without a due date`) : null, h('span', { class: 'hint' }, 'Drag a task to reschedule · double-click a day to add')),
    h('div', { class: 'cal' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => h('div', { class: 'cal-h' }, d)), cells));
}
void typeIcon;
