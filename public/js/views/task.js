import { h, mount, icon, avatar, toast, menu, confirmDialog, priorityBadge, statusDot, dueInfo, ago, renderMarkdownLite, PRIORITY, STATUS_LABEL, clear } from '../dom.js';
import { api } from '../api.js';
import { state, userById, membersOfTeam, on, projectById } from '../state.js';
import { statusMenu, priorityMenu, assigneeMenu, dateMenu, labelEditor } from './pickers.js';
import { todayStr } from '../dom.js';

let current = null; // { id, el, off }

export function closeTask() {
  if (!current) return;
  current.off?.();
  current.back.remove(); current.el.remove();
  current = null;
  document.removeEventListener('keydown', onKey);
}
const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.modal-back, .popover') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) closeTask(); };

export async function openTask(id) {
  closeTask();
  const back = h('div', { class: 'drawer-back', onclick: closeTask });
  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Task details' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  document.body.append(back, el);
  document.addEventListener('keydown', onKey);
  current = { id, el, back };
  let task;
  try { task = await api.get('/tasks/' + id); } catch (e) { toast(e.message, 'error'); closeTask(); return; }
  const ctl = { task, tab: 'comments' };
  const render = () => paint(el, ctl, render);
  render();
  // live refresh when someone else changes this task
  current.off = on('task', async ev => {
    if (ev.task_id !== id || !current || current.id !== id) return;
    if (el.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
    try { ctl.task = await api.get('/tasks/' + id); render(); } catch { closeTask(); }
  });
}

async function reload(ctl, render) { ctl.task = await api.get('/tasks/' + ctl.task.id); render(); }

function paint(el, ctl, render) {
  const t = ctl.task;
  const members = membersOfTeam(t.team_id);
  const ro = !t.can_edit;
  const patch = async fields => {
    try { await api.patch('/tasks/' + t.id, fields); await reload(ctl, render); } catch (e) { toast(e.message, 'error'); render(); }
  };

  // ---- title ----
  const title = h('textarea', { class: 'title-edit', rows: 1, readonly: ro, 'aria-label': 'Title', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } },
    onblur: () => { const v = title.value.trim(); if (v && v !== t.title) patch({ title: v }); else title.value = t.title; }, oninput: fit }, t.title);
  function fit() { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; }
  setTimeout(fit, 0);

  // ---- description ----
  const descBox = h('div');
  const showDesc = () => {
    const view = h('div', { class: 'desc-view' + (ro ? ' ro' : ''), tabindex: ro ? -1 : 0, onclick: ro ? null : editDesc, onkeydown: e => { if (e.key === 'Enter' && !ro) editDesc(); } },
      t.description ? renderMarkdownLite(t.description) : h('span', { class: 'faint' }, ro ? 'No description' : 'Add a description…'));
    mount(descBox, view);
  };
  const editDesc = (initial) => {
    const ta = h('textarea', { class: 'textarea', style: { minHeight: '150px' }, placeholder: 'Markdown-lite: **bold**, - bullets, - [ ] checklists' }, typeof initial === 'string' ? initial : t.description);
    const save = async () => { if (ta.value !== t.description) await patch({ description: ta.value }); else showDesc(); };
    mount(descBox, ta, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary sm', onclick: save }, 'Save'), h('button', { class: 'btn ghost sm', onclick: showDesc }, 'Cancel'), h('span', { class: 'hint' }, 'Tip: ⌘/Ctrl+Enter to save')));
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); });
    ta.focus();
  };
  showDesc();
  const improveBtn = ro ? null : h('button', { class: 'btn ghost sm', onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spinner' }), 'Writing…');
    try { const r = await api.post('/ai/improve', { task_id: t.id }); editDesc(r.description); toast(r.ai ? 'AI draft ready — review and save' : 'Template added — review and save'); } catch (er) { toast(er.message, 'error'); }
    b.disabled = false; b.replaceChildren(icon('sparkles', 14), 'Improve with AI');
  } }, icon('sparkles', 14), 'Improve with AI');

  // ---- subtasks ----
  const subs = t.subtasks || [];
  const doneN = subs.filter(s => s.status === 'done').length;
  const subInput = h('input', { class: 'input', placeholder: 'Add a subtask and press Enter', onkeydown: async e => { if (e.key === 'Enter' && subInput.value.trim()) { const v = subInput.value; subInput.value = ''; try { await api.post(`/tasks/${t.id}/subtasks`, { title: v }); await reload(ctl, render); } catch (er) { toast(er.message, 'error'); } } } });
  const subBox = h('div', { class: 'col', style: { gap: '2px' } }, subs.map(s => h('div', { class: 'sub' + (s.status === 'done' ? ' done' : '') },
    h('button', { class: 'check' + (s.status === 'done' ? ' on' : ''), disabled: ro, 'aria-label': 'Toggle subtask', onclick: async () => { try { await api.patch('/tasks/' + s.id, { status: s.status === 'done' ? 'todo' : 'done' }); await reload(ctl, render); } catch (er) { toast(er.message, 'error'); } } }, s.status === 'done' ? icon('check', 12) : null),
    h('span', { class: 't' }, s.title), s.assignee_id ? avatar(userById(s.assignee_id), 20) : null,
    ro ? null : h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Delete subtask', onclick: async () => { await api.del('/tasks/' + s.id).catch(er => toast(er.message, 'error')); await reload(ctl, render); } }, icon('x', 14)))));
  const breakBtn = ro ? null : h('button', { class: 'btn ghost sm', onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spinner' }), 'Thinking…');
    try { const r = await api.post('/ai/breakdown', { task_id: t.id }); suggestSubtasks(r.subtasks, r.ai); } catch (er) { toast(er.message, 'error'); }
    b.disabled = false; b.replaceChildren(icon('sparkles', 14), 'Break down with AI');
  } }, icon('sparkles', 14), 'Break down with AI');
  function suggestSubtasks(list, ai) {
    const boxes = list.map(s => ({ s, cb: h('input', { type: 'checkbox', checked: true }) }));
    const panel = h('div', { class: 'ai-panel' },
      h('div', { class: 'row' }, h('span', { class: 'ai-badge' }, icon('sparkles', 12), ai ? 'AI suggestion' : 'Template'), h('span', { class: 'grow' }), h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, onclick: () => panel.remove() }, icon('x', 14))),
      ...boxes.map(({ s, cb }) => h('label', { class: 'row' }, cb, h('span', s.title))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: async () => { const titles = boxes.filter(b => b.cb.checked).map(b => b.s.title); if (!titles.length) return panel.remove(); await api.post(`/tasks/${t.id}/subtasks`, { titles }).catch(er => toast(er.message, 'error')); await reload(ctl, render); } }, 'Add selected')));
    subSection.insertBefore(panel, subBox);
  }
  const subSection = h('section', h('div', { class: 'sec-title' }, 'Subtasks', subs.length ? h('span', { class: 'chip' }, `${doneN}/${subs.length}`) : null, h('span', { class: 'grow' }), breakBtn),
    subs.length ? h('div', { class: 'progress', style: { margin: '0 0 8px' } }, h('i', { style: { width: (doneN / subs.length * 100) + '%' } })) : null, subBox, ro ? null : h('div', { style: { marginTop: '6px' } }, subInput));

  // ---- comments / activity ----
  const commentArea = h('textarea', { class: 'textarea', style: { minHeight: '64px' }, placeholder: 'Write a comment… use @name to notify someone', 'aria-label': 'Comment' });
  mentionAutocomplete(commentArea, members);
  const send = async () => { const v = commentArea.value.trim(); if (!v) return; commentArea.value = ''; try { await api.post(`/tasks/${t.id}/comments`, { body: v }); await reload(ctl, render); } catch (e) { toast(e.message, 'error'); commentArea.value = v; } };
  commentArea.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
  const comments = h('div', { class: 'col', style: { gap: '14px' } }, t.comments.map(c => h('div', { class: 'comment' }, avatar({ name: c.user_name || '🤖', color: c.user_color || '#64748b' }, 28),
    h('div', { class: 'bubble' }, h('div', h('span', { class: 'who' }, c.user_name || 'Automation'), h('span', { class: 'small faint' }, ago(c.created_at))), renderMarkdownLite(c.body)))),
    ro ? null : h('div', { class: 'col' }, commentArea, h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: send }, 'Comment'), h('span', { class: 'hint' }, '⌘/Ctrl+Enter to send'))));
  const activity = h('div', t.activity.length ? t.activity.map(a => h('div', { class: 'act' }, h('i'), h('span', h('b', a.user_name || 'Automation'), ' ', describeActivity(a), ' ', h('span', { class: 'faint' }, ago(a.created_at))))) : h('div', { class: 'faint' }, 'No activity yet'));
  const tabs = h('div', { class: 'tabs', style: { marginTop: 0, marginBottom: '14px' } },
    ['comments', 'activity'].map(k => h('button', { class: 'tab' + (ctl.tab === k ? ' active' : ''), onclick: () => { ctl.tab = k; render(); } }, k === 'comments' ? `Comments${t.comments.length ? ' (' + t.comments.length + ')' : ''}` : 'Activity')));

  // ---- properties ----
  const due = dueInfo(t.due_date, t.status === 'done');
  const prop = (label, node) => h('div', { class: 'prop' }, h('span', { class: 'label' }, label), node);
  const btn = (child, onClick) => h('button', { class: 'cell-btn', disabled: ro, onclick: e => onClick(e.currentTarget) }, child);
  const estimate = h('input', { class: 'input', type: 'number', min: 0, step: 0.5, value: t.estimate ?? '', placeholder: 'Hours', disabled: ro, onchange: () => patch({ estimate: estimate.value === '' ? null : Number(estimate.value) }) });
  const aiSuggest = h('div');
  const suggestBtn = ro ? null : h('button', { class: 'btn ai sm', style: { width: '100%' }, onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spinner' }), 'Analyzing…');
    try {
      const r = await api.post('/ai/suggest', { task_id: t.id, today: todayStr() });
      const who = userById(r.assignee_id);
      mount(aiSuggest, h('div', { class: 'ai-panel' }, h('span', { class: 'ai-badge' }, icon('sparkles', 12), r.ai ? 'AI suggestion' : 'Suggestion'),
        h('div', { class: 'small' }, priorityBadge(r.priority), ' · ', r.estimate, 'h', who ? ' · ' + who.name : ''), h('div', { class: 'small muted' }, r.reason),
        h('button', { class: 'btn sm', onclick: () => patch({ priority: r.priority, estimate: r.estimate, assignee_id: r.assignee_id ?? t.assignee_id }) }, 'Apply all')));
    } catch (er) { toast(er.message, 'error'); }
    b.disabled = false; b.replaceChildren(icon('sparkles', 14), 'Suggest priority & owner');
  } }, icon('sparkles', 14), 'Suggest priority & owner');

  const side = h('div', { class: 'd-side' },
    prop('Status', btn([statusDot(t.status), STATUS_LABEL[t.status]], el => statusMenu(el, t.status, s => patch({ status: s })))),
    prop('Priority', btn(priorityBadge(t.priority), el => priorityMenu(el, t.priority, p => patch({ priority: p })))),
    prop('Assignee', btn([avatar(userById(t.assignee_id), 22), t.assignee_id ? userById(t.assignee_id)?.name : h('span', { class: 'faint' }, 'Unassigned')], el => assigneeMenu(el, members, t.assignee_id, id => patch({ assignee_id: id })))),
    prop('Due date', btn([icon('calendar', 15), due ? h('span', { class: 'due ' + due.state }, due.label, due.state === 'overdue' ? ' · overdue' : '') : h('span', { class: 'faint' }, 'No date')], el => dateMenu(el, t.due_date, d => patch({ due_date: d })))),
    prop('Estimate (hours)', estimate),
    prop('Labels', labelEditor([...t.labels], l => patch({ labels: l }), { readonly: ro })),
    suggestBtn, aiSuggest,
    h('div', { class: 'small faint', style: { marginTop: 'auto', lineHeight: 1.8 } }, 'Reporter: ', userById(t.reporter_id)?.name || '—', h('br'), 'Created ', ago(t.created_at), t.source !== 'web' ? ` via ${t.source}` : '', h('br'), 'Updated ', ago(t.updated_at)));

  const link = `${location.origin}/#/task/${t.id}`;
  const head = h('div', { class: 'drawer-head' },
    h('span', { class: 'proj-key', style: { background: t.project_color } }, t.project_key), h('span', { class: 'mono muted' }, t.key), h('span', { class: 'small faint ellipsis' }, t.project_name), h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: 'Copy link', 'aria-label': 'Copy link', onclick: () => { navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast(link)); } }, icon('link', 17)),
    ro ? null : h('button', { class: 'icon-btn', title: 'Delete task', 'aria-label': 'Delete task', onclick: async () => { if (await confirmDialog('Delete this task?', `${t.key} and its subtasks and comments will be permanently removed.`)) { try { await api.del('/tasks/' + t.id); toast('Task deleted'); closeTask(); } catch (e) { toast(e.message, 'error'); } } } }, icon('trash', 17)),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeTask }, icon('x', 19)));

  const scroll = el.querySelector('.drawer-body')?.scrollTop || 0;
  mount(el, head, h('div', { class: 'drawer-body' },
    h('div', { class: 'd-main' }, title,
      h('section', h('div', { class: 'sec-title' }, 'Description', h('span', { class: 'grow' }), improveBtn), descBox),
      t.parent_id ? null : subSection, h('section', tabs, ctl.tab === 'comments' ? comments : activity)),
    side));
  const body = el.querySelector('.drawer-body'); if (body) body.scrollTop = scroll;
  if (ro) el.prepend(h('div', { class: 'chip amber', style: { margin: '10px 18px 0', alignSelf: 'flex-start' } }, 'View-only access'));
}

function describeActivity(a) {
  const d = a.detail || {};
  const fmt = v => (v == null || v === '' ? 'none' : Array.isArray(v) ? v.join(', ') || 'none' : v);
  switch (a.action) {
    case 'created': return `created this task${d.source && d.source !== 'web' ? ' via ' + d.source : ''}`;
    case 'changed_status': return `moved ${STATUS_LABEL[d.from] || d.from} → ${STATUS_LABEL[d.to] || d.to}`;
    case 'changed_priority': return `changed priority ${d.from} → ${d.to}`;
    case 'changed_assignee_id': return `assigned to ${userById(d.to)?.name || 'nobody'}`;
    case 'changed_due_date': return `set due date to ${fmt(d.to)}`;
    case 'changed_title': return `renamed to “${d.to}”`;
    case 'changed_estimate': return `set estimate to ${fmt(d.to)}h`;
    case 'changed_labels': return `set labels: ${fmt(d.to)}`;
    case 'edited_description': return 'edited the description';
    case 'commented': return 'commented';
    default: return a.action.replace(/_/g, ' ');
  }
}

function mentionAutocomplete(ta, members) {
  let pop = null;
  const close = () => { pop?.remove(); pop = null; };
  ta.addEventListener('input', () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/@([a-z0-9._-]*)$/i);
    if (!m) return close();
    const q = m[1].toLowerCase();
    const list = members.filter(u => u.handle.includes(q) || u.name.toLowerCase().includes(q)).slice(0, 6);
    if (!list.length) return close();
    close();
    const r = ta.getBoundingClientRect();
    pop = h('div', { class: 'popover', style: { left: r.left + 'px', top: Math.max(8, r.top - list.length * 38 - 12) + 'px' } }, list.map(u => h('button', { class: 'pop-item', onmousedown: e => {
      e.preventDefault();
      ta.value = before.slice(0, before.length - m[0].length) + '@' + u.handle + ' ' + ta.value.slice(ta.selectionStart);
      close(); ta.focus();
    } }, avatar(u, 20), h('span', u.name), h('span', { class: 'small faint' }, '@' + u.handle))));
    document.body.append(pop);
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
}
void clear; void projectById; void PRIORITY;
