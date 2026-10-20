import { h, mount, icon, toast, modal, confirmDialog, priorityBadge, typeIcon, statusDot, avatar, todayStr, renderMarkdownLite } from '../dom.js';
import { userById } from '../state.js';
import { api } from '../api.js';
import { openTask } from './task.js';
import { simpleMenu } from './pickers.js';
import { newTask } from './project.js';
import { menu } from '../dom.js';

const fmtD = d => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');

export function planView(ctl, repaint) {
  ctl.planTab = ctl.planTab || 'sprints';
  const tab = (k, l, ico) => h('button', { class: 'fchip' + (ctl.planTab === k ? ' on' : ''), onclick: () => { ctl.planTab = k; repaint(true); } }, icon(ico, 14), l);
  const body = ctl.planTab === 'epics' ? epics(ctl, repaint) : ctl.planTab === 'releases' ? releases(ctl, repaint) : sprints(ctl, repaint);
  return h('div', { class: 'page' }, h('div', { class: 'row', style: { marginBottom: '16px' } }, tab('sprints', 'Sprints & backlog', 'target'), tab('epics', 'Epics & roadmap', 'layers'), tab('releases', 'Releases', 'rocket')), body);
}

// ---------- burndown chart ----------
function burndown(sp) {
  const pts = sp.burndown;
  if (!pts?.length) return null;
  const W = 520, Hh = 150, pl = 30, pb = 18, pt = 8;
  const max = Math.max(1, ...pts.map(p => Math.max(p.ideal, p.actual ?? 0)));
  const x = i => pl + (i / Math.max(1, pts.length - 1)) * (W - pl - 8), y = v => pt + (1 - v / max) * (Hh - pt - pb);
  const path = key => pts.map((p, i) => p[key] == null ? null : `${x(i)},${y(p[key])}`).filter(Boolean).map((c, i) => (i ? 'L' : 'M') + c).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Burndown chart');
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); };
  add('line', { x1: pl, y1: Hh - pb, x2: W - 8, y2: Hh - pb, class: 'axis' }); add('line', { x1: pl, y1: pt, x2: pl, y2: Hh - pb, class: 'axis' });
  add('text', { x: 2, y: pt + 8 }, Math.round(max)); add('text', { x: 2, y: Hh - pb }, '0'); add('text', { x: pl, y: Hh - 4 }, fmtD(pts[0].day)); add('text', { x: W - 50, y: Hh - 4 }, fmtD(pts.at(-1).day));
  add('path', { d: path('ideal'), class: 'ideal' }); add('path', { d: path('actual'), class: 'actual' });
  return svg;
}

// ---------- sprints ----------
function sprints(ctl, repaint) {
  const can = ctl.project.can_manage, edit = ctl.project.can_edit;
  const live = ctl.sprints.filter(s => s.state !== 'closed');
  const closed = ctl.sprints.filter(s => s.state === 'closed');
  const tasksOf = id => ctl.tasks.filter(t => t.sprint_id === id);
  const backlog = ctl.tasks.filter(t => !t.sprint_id && t.status !== 'done');
  const move = async (taskId, sprintId) => { try { await api.patch('/tasks/' + taskId, { sprint_id: sprintId }); await ctl.reload(); } catch (e) { toast(e.message, 'error'); } };
  let dragId = null;
  const row = (t, sprintId) => h('div', { class: 'sub', draggable: edit ? 'true' : null, ondragstart: e => { dragId = t.id; e.dataTransfer.setData('text/plain', String(t.id)); }, ondragend: () => { dragId = null; } },
    typeIcon(t.type, 13), h('span', { class: 'mono small faint' }, t.key), h('span', { class: 't ellipsis', style: { cursor: 'pointer', fontWeight: 500 }, onclick: () => openTask(t.id) }, t.title),
    t.estimate ? h('span', { class: 'chip' }, t.estimate + 'h') : null, priorityBadge(t.priority, true), avatar(userById(t.assignee_id), 20),
    edit ? h('button', { class: 'icon-btn', style: { width: '26px', height: '26px' }, 'aria-label': 'Move to sprint', onclick: e => simpleMenu(e.currentTarget, live.filter(s => s.id !== sprintId).map(s => [s.id, s.name]), undefined, id => move(t.id, id), sprintId ? 'Move to backlog' : null) }, icon('more', 16)) : null);
  const zone = (sprintId, children) => {
    const z = h('div', { class: 'drop-zone col', style: { gap: '2px', minHeight: '44px', borderRadius: '8px' },
      ondragover: e => { if (dragId && edit) { e.preventDefault(); z.classList.add('drop'); } }, ondragleave: () => z.classList.remove('drop'),
      ondrop: e => { e.preventDefault(); z.classList.remove('drop'); if (dragId) move(dragId, sprintId); } }, children);
    return z;
  };

  const sprintCard = s => {
    const list = tasksOf(s.id);
    const active = s.state === 'active';
    const hours = list.reduce((a, t) => a + (t.estimate || 0), 0);
    return h('div', { class: 'card sprint-card' },
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, s.name), h('span', { class: 'chip ' + (active ? 'green' : '') }, active ? 'Active' : 'Planned'), h('span', { class: 'small faint' }, `${fmtD(s.start_date)} → ${fmtD(s.end_date)}`),
        can ? h('button', { class: 'icon-btn', 'aria-label': 'Sprint options', onclick: e => menu(e.currentTarget, [
          { label: 'Edit sprint', icon: 'edit', onClick: () => sprintModal(ctl, s) },
          { label: 'Delete sprint', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Delete sprint?', 'Its tasks return to the backlog.')) { await api.del('/sprints/' + s.id).catch(e => toast(e.message, 'error')); await ctl.reload(); } } }], { align: 'right' }) }, icon('more', 18)) : null),
      s.goal ? h('p', { class: 'muted small', style: { margin: '2px 0 8px' } }, '🎯 ' + s.goal) : null,
      h('div', { class: 'row small muted', style: { marginBottom: '8px' } }, `${s.done_tasks}/${s.total_tasks} tasks done`, h('span', { class: 'faint' }, '·'), hours ? `${hours}h planned` : 'no estimates yet', ctl.velocityHours && !active && hours > ctl.velocityHours * 1.15 ? h('span', { class: 'chip amber' }, `above recent velocity (${Math.round(ctl.velocityHours)}h)`) : null),
      active ? burndown(s) : null,
      zone(s.id, list.length ? list.map(t => row(t, s.id)) : h('div', { class: 'faint small', style: { padding: '10px' } }, 'Drag tasks here from the backlog')),
      can ? h('div', { class: 'row', style: { marginTop: '10px' } }, active ? h('button', { class: 'btn primary sm', onclick: () => closeModal(ctl, s) }, icon('check', 14), 'Complete sprint') : h('button', { class: 'btn primary sm', onclick: async () => { try { await api.post(`/sprints/${s.id}/start`); toast('Sprint started', 'success'); await ctl.reload(); } catch (e) { toast(e.message, 'error'); } } }, icon('play', 13), 'Start sprint')) : null);
  };

  // velocity: average of closed sprints
  const closedDone = closed.slice(-3).map(s => (s.total > 0 ? s.total - s.remaining : s.done_tasks));
  ctl.velocityHours = closed.slice(-3).some(s => s.total > 0) && closedDone.length ? closedDone.reduce((a, b) => a + b, 0) / closedDone.length : null;

  return h('div', { class: 'plan' },
    h('div', h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { class: 'grow' }, `Backlog (${backlog.length})`), edit ? h('button', { class: 'btn sm', onclick: () => newTask(ctl, ctl.project.statuses[0].id) }, icon('plus', 14), 'Add') : null),
      h('div', { class: 'card', style: { padding: '10px' } }, zone(null, backlog.length ? backlog.map(t => row(t, null)) : h('div', { class: 'empty', style: { padding: '24px' } }, 'The backlog is empty 🎉')))),
    h('div', h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h3', { class: 'grow' }, 'Sprints'), can ? h('button', { class: 'btn primary sm', onclick: () => sprintModal(ctl) }, icon('plus', 14), 'New sprint') : null,
      edit && live.length && state_ai() ? h('button', { class: 'btn ai sm', onclick: () => aiPlanModal(ctl, live) }, icon('sparkles', 14), 'Suggest plan') : null),
    live.length ? live.map(sprintCard) : h('div', { class: 'card empty' }, h('b', 'No active or planned sprints'), can ? 'Create a sprint and drag backlog tasks into it.' : 'A project manager can create sprints.'),
    closed.length ? h('div', { class: 'card card-pad' }, h('h4', { style: { marginBottom: '8px' } }, 'Completed sprints'), closed.slice().reverse().map(s => h('div', { class: 'row', style: { padding: '5px 0', borderTop: '1px solid var(--border)' } }, h('span', { class: 'grow' }, s.name), h('span', { class: 'small muted' }, `${s.done_tasks}/${s.total_tasks} tasks`), s.total > 0 ? h('span', { class: 'chip green' }, `${s.total - s.remaining}/${s.total}h`) : null))) : null));
}
const state_ai = () => true;

function sprintModal(ctl, s) {
  const v = { name: s?.name || `Sprint ${ctl.sprints.length + 1}`, goal: s?.goal || '', start_date: s?.start_date || '', end_date: s?.end_date || '' };
  const f = (label, input) => h('div', { class: 'field' }, h('label', label), input);
  modal({ title: s ? 'Edit sprint' : 'New sprint', body: [f('Name', h('input', { class: 'input', value: v.name, oninput: e => (v.name = e.target.value) })), f('Goal', h('input', { class: 'input', value: v.goal, placeholder: 'What should this sprint achieve?', oninput: e => (v.goal = e.target.value) })),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, f('Start', h('input', { class: 'input', type: 'date', value: v.start_date, onchange: e => (v.start_date = e.target.value) }))), h('div', { class: 'grow' }, f('End', h('input', { class: 'input', type: 'date', value: v.end_date, onchange: e => (v.end_date = e.target.value) }))))],
  actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { try { s ? await api.patch('/sprints/' + s.id, v) : await api.post(`/projects/${ctl.pid}/sprints`, v); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}

function closeModal(ctl, s) {
  const open = ctl.tasks.filter(t => t.sprint_id === s.id && t.status !== 'done').length;
  const others = ctl.sprints.filter(x => x.state === 'planned' && x.id !== s.id);
  const sel = h('select', { class: 'select' }, h('option', { value: 'backlog' }, 'Back to the backlog'), others.map(o => h('option', { value: o.id }, 'Move to ' + o.name)));
  modal({ title: `Complete ${s.name}`, body: [h('p', open ? `${open} unfinished task${open > 1 ? 's' : ''} will be moved:` : 'All tasks are done — nice work! 🎉'), open ? sel : null],
    actions: [{ label: 'Cancel' }, { label: 'Complete sprint', kind: 'primary', onClick: async () => { try { const r = await api.post(`/sprints/${s.id}/close`, { move_to: open ? sel.value : 'backlog' }); toast(`Sprint complete — ${r.completed} done, ${r.moved} carried over`, 'success'); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}

function aiPlanModal(ctl, live) {
  const target = live.find(s => s.state === 'planned') || live[0];
  const out = h('div', { class: 'col' }, h('div', { class: 'loading', style: { height: '80px' } }, h('span', { class: 'spinner' })));
  const m = modal({ title: `✨ Suggested plan for ${target.name}`, width: 640, body: [out] });
  api.post(`/ai/sprint-plan`, { project_id: ctl.pid, sprint_id: target.id, today: todayStr() }).then(r => {
    const picks = r.picks.map(p => ({ ...p, cb: h('input', { type: 'checkbox', checked: true }) }));
    mount(out, h('p', { class: 'muted' }, r.summary), ...picks.map(p => h('label', { class: 'row' }, p.cb, h('span', { class: 'mono small faint' }, p.key), h('span', { class: 'grow' }, p.title), h('span', { class: 'chip' }, (p.estimate || 0) + 'h'), h('span', { class: 'small faint' }, p.reason))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { const ids = picks.filter(p => p.cb.checked).map(p => p.id); await api.post('/tasks/bulk', { ids, patch: { sprint_id: target.id } }).catch(e => toast(e.message, 'error')); m.close(); toast(`${ids.length} task(s) added`, 'success'); await ctl.reload(); } }, 'Add selected to sprint')));
  }).catch(e => mount(out, h('p', { class: 'error-msg' }, e.message)));
}

// ---------- epics ----------
function epics(ctl, repaint) {
  const list = ctl.tasks.filter(t => t.type === 'epic');
  const edit = ctl.project.can_edit;
  return h('div', { style: { maxWidth: '900px' } }, h('div', { class: 'row', style: { marginBottom: '12px' } }, h('div', { class: 'grow' }, h('h3', 'Epics'), h('p', { class: 'muted small' }, 'Group related work. Progress rolls up from child tasks; see them on the Timeline tab with “Epics only”.')),
    edit ? h('button', { class: 'btn primary', onclick: () => newTask(ctl, ctl.project.statuses[0].id, { draft: { type: 'epic' } }) }, icon('plus', 15), 'New epic') : null),
  list.length ? list.map(e => {
    const pct = e.epic_total ? Math.round(e.epic_done / e.epic_total * 100) : 0;
    return h('div', { class: 'card card-pad', style: { marginBottom: '10px', cursor: 'pointer' }, onclick: () => openTask(e.id) },
      h('div', { class: 'row' }, typeIcon('epic', 16), h('b', { class: 'grow' }, e.title), h('span', { class: 'chip' }, e.status_label), e.due_date ? h('span', { class: 'chip' }, 'due ' + fmtD(e.due_date)) : null, avatar(userById(e.assignee_id), 22)),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'progress', style: { height: '8px' } }, h('i', { style: { width: pct + '%', background: '#8b5cf6' } })), h('span', { class: 'small muted nowrap' }, `${e.epic_done}/${e.epic_total} · ${pct}%`)));
  }) : h('div', { class: 'card empty' }, h('b', 'No epics yet'), 'Create an epic, then link tasks to it from the task drawer.'));
}

// ---------- releases ----------
function releases(ctl, repaint) {
  const can = ctl.project.can_manage;
  return h('div', { style: { maxWidth: '900px' } }, h('div', { class: 'row', style: { marginBottom: '12px' } }, h('div', { class: 'grow' }, h('h3', 'Releases'), h('p', { class: 'muted small' }, 'Assign tasks to a release from the task drawer, then generate release notes in one click.')),
    can ? h('button', { class: 'btn primary', onclick: () => releaseModal(ctl) }, icon('plus', 15), 'New release') : null),
  ctl.releases.length ? ctl.releases.map(r => {
    const tasks = ctl.tasks.filter(t => t.release_id === r.id);
    const done = tasks.filter(t => t.status === 'done').length;
    return h('div', { class: 'card card-pad', style: { marginBottom: '10px' } },
      h('div', { class: 'row' }, icon('rocket', 18), h('b', r.name), r.version ? h('span', { class: 'chip accent' }, r.version) : null, h('span', { class: 'chip ' + (r.state === 'released' ? 'green' : '') }, r.state === 'released' ? 'Released' : 'Planned'), h('span', { class: 'small faint' }, r.date ? fmtD(r.date) : ''), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => notesModal(ctl, r) }, icon('fileText', 14), 'Release notes'),
        can && r.state !== 'released' ? h('button', { class: 'btn sm', onclick: async () => { await api.post(`/releases/${r.id}/ship`).catch(e => toast(e.message, 'error')); await ctl.reload(); } }, 'Mark released') : null,
        can ? h('button', { class: 'icon-btn', 'aria-label': 'Delete release', onclick: async () => { if (await confirmDialog('Delete release?', 'Tasks stay, only the grouping is removed.')) { await api.del('/releases/' + r.id); await ctl.reload(); } } }, icon('trash', 16)) : null),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'progress', style: { height: '8px' } }, h('i', { style: { width: (tasks.length ? done / tasks.length * 100 : 0) + '%' } })), h('span', { class: 'small muted nowrap' }, `${done}/${tasks.length} done`)),
      tasks.length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginTop: '8px' } }, tasks.slice(0, 12).map(t => h('button', { class: 'chip', style: { border: 0, cursor: 'pointer' }, onclick: () => openTask(t.id) }, statusDot(t.status, t.status_category), t.key))) : null);
  }) : h('div', { class: 'card empty' }, h('b', 'No releases yet')));
}
function releaseModal(ctl) {
  const v = { name: '', version: '', date: '' };
  modal({ title: 'New release', body: [h('div', { class: 'field' }, h('label', 'Name'), h('input', { class: 'input', placeholder: 'Autumn release', oninput: e => (v.name = e.target.value) })), h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', 'Version'), h('input', { class: 'input', placeholder: 'v2.1.0', oninput: e => (v.version = e.target.value) })), h('div', { class: 'field grow' }, h('label', 'Target date'), h('input', { class: 'input', type: 'date', onchange: e => (v.date = e.target.value) })))],
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async () => { try { await api.post(`/projects/${ctl.pid}/releases`, v); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}
function notesModal(ctl, r) {
  const area = h('textarea', { class: 'textarea', style: { minHeight: '280px', fontFamily: 'ui-monospace, monospace', fontSize: '13px' } }, r.notes || '');
  const gen = h('button', { class: 'btn ai sm', onclick: async () => { gen.disabled = true; gen.replaceChildren(h('span', { class: 'spinner' }), 'Writing…'); try { const n = await api.post(`/releases/${r.id}/notes`); area.value = n.notes; } catch (e) { toast(e.message, 'error'); } gen.disabled = false; gen.replaceChildren(icon('sparkles', 14), 'Generate from shipped tasks'); } }, icon('sparkles', 14), 'Generate from shipped tasks');
  modal({ title: `Release notes — ${r.name}`, width: 680, body: [h('div', { class: 'row' }, gen, h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(area.value).then(() => toast('Copied')) }, icon('copy', 14), 'Copy')), area],
    actions: [{ label: 'Close' }, { label: 'Save notes', kind: 'primary', onClick: async () => { try { await api.patch('/releases/' + r.id, { notes: area.value }); toast('Saved', 'success'); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}
void renderMarkdownLite;
