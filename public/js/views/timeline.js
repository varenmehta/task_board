import { h, icon, toast, todayStr, typeIcon, statusDot } from '../dom.js';
import { api } from '../api.js';
import { openTask } from './task.js';
import { visible } from './project.js';

const DAY = 86400000;
const iso = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const parse = s => new Date(s + 'T00:00:00');
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / DAY);

export function timelineView(ctl, repaint) {
  ctl.tl = ctl.tl || { zoom: 24, epicsOnly: false };
  const dayW = ctl.tl.zoom;
  const today = todayStr();
  let tasks = visible(ctl).filter(t => !t.parent_id);
  if (ctl.tl.epicsOnly) tasks = tasks.filter(t => t.type === 'epic');
  const span = t => {
    const created = t.created_at.slice(0, 10);
    const start = t.start_date || (t.due_date && t.due_date < created ? t.due_date : created);
    const end = t.due_date || addDays(start, 1);
    return { start: start <= end ? start : end, end: start <= end ? end : start };
  };
  const scheduled = tasks.filter(t => t.start_date || t.due_date).sort((a, b) => span(a).start.localeCompare(span(b).start));
  const unscheduled = tasks.filter(t => !t.start_date && !t.due_date && t.status !== 'done');
  const canEdit = ctl.project.can_edit;

  const all = scheduled.map(span);
  const minD = addDays([today, ...all.map(s => s.start)].sort()[0], -3);
  const maxD = addDays([today, ...all.map(s => s.end)].sort().at(-1), 10);
  const total = diffDays(minD, maxD) + 1;
  const width = total * dayW;

  const scale = h('div', { class: 'g-scale', style: { width: width + 'px' } });
  for (let i = 0; i < total; i++) {
    const d = parse(addDays(minD, i));
    if (d.getDay() === 1 || dayW >= 40) {
      scale.append(h('div', { class: 'g-line', style: { left: i * dayW + 'px' } }), h('span', { style: { left: i * dayW + 'px' } }, d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      if (dayW < 40 && d.getDay() === 1 && i > 0) continue;
    }
  }
  const todayX = diffDays(minD, today) * dayW;

  function bar(t) {
    const s = span(t);
    const left = diffDays(minD, s.start) * dayW, w = Math.max(dayW, (diffDays(s.start, s.end) + 1) * dayW);
    const overdue = t.due_date && t.due_date < today && t.status !== 'done';
    const prog = t.type === 'epic' && t.epic_total ? t.epic_done / t.epic_total * 100 : t.subtask_total ? t.subtask_done / t.subtask_total * 100 : t.status === 'done' ? 100 : 0;
    const el = h('div', { class: 'g-bar' + (t.status === 'done' ? ' done' : overdue ? ' overdue' : t.type === 'epic' ? ' epic' : ''), style: { left: left + 'px', width: w + 'px' }, title: `${t.key} · ${s.start} → ${s.end}` },
      h('div', { class: 'fill', style: { width: prog + '%' } }), h('span', { style: { position: 'relative' } }, t.title));
    if (canEdit) {
      let startX = null, moved = false, mode = null;
      const handle = h('div', { style: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '8px', cursor: 'ew-resize' } });
      el.append(handle);
      const down = (e, m) => { startX = e.clientX; mode = m; moved = false; e.preventDefault(); e.stopPropagation(); document.addEventListener('mousemove', move); document.addEventListener('mouseup', up); };
      el.addEventListener('mousedown', e => down(e, 'move')); handle.addEventListener('mousedown', e => down(e, 'resize'));
      const move = e => {
        const dx = e.clientX - startX; if (Math.abs(dx) > 3) moved = true;
        if (mode === 'move') el.style.transform = `translateX(${Math.round(dx / dayW) * dayW}px)`; else el.style.width = Math.max(dayW, w + Math.round(dx / dayW) * dayW) + 'px';
      };
      const up = async e => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        const dd = Math.round((e.clientX - startX) / dayW);
        if (!moved || dd === 0) { el.style.transform = ''; if (!moved) openTask(t.id); else repaint(true); return; }
        const patch = mode === 'move' ? { start_date: addDays(s.start, dd), due_date: addDays(s.end, dd) } : { due_date: addDays(s.end, dd) };
        if (mode === 'resize' && patch.due_date < s.start) { repaint(true); return; }
        try { await api.patch('/tasks/' + t.id, patch); await ctl.reload(); } catch (er) { toast(er.message, 'error'); repaint(true); }
      };
    } else el.addEventListener('click', () => openTask(t.id));
    return el;
  }

  const rows = scheduled.map(t => h('div', { class: 'g-row' },
    h('div', { class: 'g-label', onclick: () => openTask(t.id) }, statusDot(t.status, t.status_category), typeIcon(t.type, 13), h('span', { class: 'mono small faint' }, t.key), h('span', { class: 'ellipsis' }, t.title)),
    h('div', { class: 'g-track', style: { width: width + 'px' } }, bar(t))));

  const zoomBtn = (label, z) => h('button', { class: 'fchip' + (ctl.tl.zoom === z ? ' on' : ''), onclick: () => { ctl.tl.zoom = z; repaint(true); } }, label);
  const wrap = h('div', { class: 'table-wrap' },
    h('div', { class: 'row', style: { marginBottom: '12px', flexWrap: 'wrap' } }, zoomBtn('Week', 64), zoomBtn('Month', 24), zoomBtn('Quarter', 10),
      h('label', { class: 'row', style: { marginLeft: '10px' } }, h('input', { type: 'checkbox', checked: ctl.tl.epicsOnly, onchange: e => { ctl.tl.epicsOnly = e.target.checked; repaint(true); } }), 'Epics only (roadmap)'), h('span', { class: 'grow' }),
      h('span', { class: 'hint' }, 'Drag a bar to shift dates · drag its right edge to change the due date')),
    scheduled.length ? h('div', { class: 'gantt', style: { maxHeight: 'calc(100vh - 300px)' } },
      h('div', { class: 'g-head', style: { width: 'max-content', minWidth: '100%' } }, h('div', { class: 'g-label', style: { cursor: 'default', fontWeight: 650 } }, 'Task'), scale),
      h('div', { style: { position: 'relative', width: 'max-content', minWidth: '100%' } }, h('div', { class: 'g-today', style: { left: `calc(260px + ${todayX}px)` } }), ...rows))
      : h('div', { class: 'empty card' }, h('b', 'Nothing scheduled yet'), 'Give tasks a start and due date and they appear here.'),
    unscheduled.length ? h('div', { class: 'card card-pad', style: { marginTop: '14px' } }, h('h4', { style: { marginBottom: '8px' } }, `Unscheduled (${unscheduled.length})`), h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, unscheduled.slice(0, 20).map(t => h('button', { class: 'chip', style: { border: 0, cursor: 'pointer' }, onclick: () => openTask(t.id) }, t.key + ' ' + t.title.slice(0, 30))))) : null);
  void icon;
  return wrap;
}
