import { h, mount, icon, avatar, toast, menu, modal, confirmDialog, priorityBadge, statusDot, dueInfo, ago, renderMarkdownLite, typeIcon, TYPE, fmtDuration, todayStr } from '../dom.js';
import { api } from '../api.js';
import { state, userById, on, projectById, statusesOf, membersOfProject } from '../state.js';
import { statusMenu, priorityMenu, assigneeMenu, dateMenu, labelEditor, simpleMenu } from './pickers.js';

let current = null; // { id, el, back, off }

export function closeTask() {
  if (!current) return;
  current.off?.();
  current.back.remove(); current.el.remove();
  current = null;
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('paste', onPaste);
}
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
let hotkeys = {};
const onKey = e => {
  if (e.key === 'Escape' && !document.querySelector('.modal-back, .popover') && !typing()) return closeTask();
  if (typing() || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-back, .popover')) return;
  const fn = hotkeys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
};
let pasteHandler = null;
const onPaste = e => { pasteHandler?.(e); };

export async function openTask(id) {
  closeTask();
  const back = h('div', { class: 'drawer-back', onclick: closeTask });
  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Task details' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  document.body.append(back, el);
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  current = { id, el, back };
  const ctl = { id, task: null, tab: 'comments', time: null, running: null, meta: { sprints: [], releases: [], epics: [] } };
  try { await load(ctl); } catch (e) { toast(e.message, 'error'); closeTask(); return; }
  const render = () => paint(el, ctl, render);
  ctl.render = render;
  render();
  current.off = on('task', async ev => {
    if (ev.task_id !== id || !current || current.id !== id) return;
    if (el.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName)) return;
    try { await load(ctl, true); render(); } catch { closeTask(); }
  });
  const offTimer = on('timer', async () => { ctl.running = await api.get('/timer').catch(() => null); ctl.time = await api.get(`/tasks/${id}/time`).catch(() => ctl.time); render(); });
  const prevOff = current.off; current.off = () => { prevOff(); offTimer(); };
}

async function load(ctl, light) {
  const t = await api.get('/tasks/' + ctl.id);
  ctl.task = t;
  const [time, running] = await Promise.all([api.get(`/tasks/${ctl.id}/time`), api.get('/timer')]);
  ctl.time = time; ctl.running = running;
  if (!light || !ctl.metaLoaded) {
    const [sprints, releases, roadmap] = await Promise.all([
      api.get(`/projects/${t.project_id}/sprints`).catch(() => ({ sprints: [] })), api.get(`/projects/${t.project_id}/releases`).catch(() => []), api.get(`/projects/${t.project_id}/roadmap`).catch(() => [])]);
    ctl.meta = { sprints: sprints.sprints.filter(s => s.state !== 'closed'), releases: releases.filter(r => r.state !== 'released'), epics: roadmap.filter(e => e.id !== t.id) };
    ctl.metaLoaded = true;
  }
}

function paint(el, ctl, render) {
  const t = ctl.task;
  const project = projectById(t.project_id);
  const statuses = statusesOf(t.project_id);
  const members = membersOfProject(t.project_id);
  const ro = !t.can_edit;
  const reload = async () => { await load(ctl, true); render(); };
  const patch = async fields => { try { await api.patch('/tasks/' + t.id, fields); await reload(); } catch (e) { toast(e.message, 'error'); render(); } };
  const isRunning = ctl.running && ctl.running.task_id === t.id;

  // ---- title ----
  const title = h('textarea', { class: 'title-edit', rows: 1, readonly: ro, 'aria-label': 'Title', onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } },
    onblur: () => { const v = title.value.trim(); if (v && v !== t.title) patch({ title: v }); else title.value = t.title; }, oninput: fit }, t.title);
  function fit() { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; }
  setTimeout(fit, 0);

  // ---- description ----
  const descBox = h('div');
  const showDesc = () => mount(descBox, h('div', { class: 'desc-view' + (ro ? ' ro' : ''), tabindex: ro ? -1 : 0, onclick: ro ? null : () => editDesc(), onkeydown: e => { if (e.key === 'Enter' && !ro) editDesc(); } },
    t.description ? renderMarkdownLite(t.description) : h('span', { class: 'faint' }, ro ? 'No description' : 'Add a description…')));
  const editDesc = initial => {
    const ta = h('textarea', { class: 'textarea', style: { minHeight: '150px' }, placeholder: 'Markdown-lite: **bold**, - bullets, - [ ] checklists' }, typeof initial === 'string' ? initial : t.description);
    const save = async () => { if (ta.value !== t.description) await patch({ description: ta.value }); else showDesc(); };
    mount(descBox, ta, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn primary sm', onclick: save }, 'Save'), h('button', { class: 'btn ghost sm', onclick: showDesc }, 'Cancel'), h('span', { class: 'hint' }, '⌘/Ctrl+Enter to save')));
    ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); });
    ta.focus();
  };
  showDesc();
  const improveBtn = ro ? null : h('button', { class: 'btn ghost sm', onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spinner' }), 'Writing…');
    try { const r = await api.post('/ai/improve', { task_id: t.id }); editDesc(r.description); toast(r.ai ? 'AI draft ready — review and save' : 'Template added — review and save'); } catch (er) { toast(er.message, 'error'); }
    b.disabled = false; b.replaceChildren(icon('sparkles', 14), 'Improve with AI');
  } }, icon('sparkles', 14), 'Improve with AI');

  // ---- epic children ----
  const childSection = t.type !== 'epic' ? null : (() => {
    const kids = t.children || [], done = kids.filter(k => k.status_category === 'done').length;
    const input = h('input', { class: 'input', placeholder: 'Add a child task and press Enter', onkeydown: async e => { if (e.key === 'Enter' && input.value.trim()) { try { await api.post(`/projects/${t.project_id}/tasks`, { title: input.value.trim(), epic_id: t.id }); await reload(); } catch (er) { toast(er.message, 'error'); } } } });
    return h('section', h('div', { class: 'sec-title' }, 'Child issues', kids.length ? h('span', { class: 'chip' }, `${done}/${kids.length}`) : null),
      kids.length ? h('div', { class: 'progress', style: { marginBottom: '8px' } }, h('i', { style: { width: (done / kids.length * 100) + '%' } })) : null,
      kids.map(k => h('div', { class: 'sub', style: { cursor: 'pointer' }, onclick: () => openTask(k.id) }, statusDot(k.status, k.status_category), h('span', { class: 'mono small faint' }, k.key), h('span', { class: 't' }, k.title), avatar(userById(k.assignee_id), 20))),
      ro ? null : h('div', { style: { marginTop: '6px' } }, input));
  })();

  // ---- subtasks ----
  const subs = t.subtasks || [];
  const doneN = subs.filter(s => s.status === 'done').length;
  const subInput = h('input', { class: 'input', placeholder: 'Add a subtask and press Enter', onkeydown: async e => { if (e.key === 'Enter' && subInput.value.trim()) { const v = subInput.value; subInput.value = ''; try { await api.post(`/tasks/${t.id}/subtasks`, { title: v }); await reload(); } catch (er) { toast(er.message, 'error'); } } } });
  const subBox = h('div', { class: 'col', style: { gap: '2px' } }, subs.map(s => h('div', { class: 'sub' + (s.status === 'done' ? ' done' : '') },
    h('button', { class: 'check' + (s.status === 'done' ? ' on' : ''), disabled: ro, 'aria-label': 'Toggle subtask', onclick: async () => { try { await api.patch('/tasks/' + s.id, { status: s.status === 'done' ? statuses[0].id : 'done' }); await reload(); } catch (er) { toast(er.message, 'error'); } } }, s.status === 'done' ? icon('check', 12) : null),
    h('span', { class: 't' }, s.title), s.assignee_id ? avatar(userById(s.assignee_id), 20) : null,
    ro ? null : h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Delete subtask', onclick: async () => { await api.del('/tasks/' + s.id).catch(er => toast(er.message, 'error')); await reload(); } }, icon('x', 14)))));
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
      h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: async () => { const titles = boxes.filter(b => b.cb.checked).map(b => b.s.title); if (!titles.length) return panel.remove(); await api.post(`/tasks/${t.id}/subtasks`, { titles }).catch(er => toast(er.message, 'error')); await reload(); } }, 'Add selected')));
    subSection.insertBefore(panel, subBox);
  }
  const subSection = h('section', h('div', { class: 'sec-title' }, 'Subtasks', subs.length ? h('span', { class: 'chip' }, `${doneN}/${subs.length}`) : null, h('span', { class: 'grow' }), breakBtn),
    subs.length ? h('div', { class: 'progress', style: { margin: '0 0 8px' } }, h('i', { style: { width: (doneN / subs.length * 100) + '%' } })) : null, subBox, ro ? null : h('div', { style: { marginTop: '6px' } }, subInput));

  // ---- dependencies ----
  const L = t.links || { blocked_by: [], blocks: [] };
  const depRow = (x, removable) => h('div', { class: 'sub', style: { cursor: 'pointer' }, onclick: () => openTask(x.id) }, statusDot(x.status, x.status_category), h('span', { class: 'mono small faint' }, x.key), h('span', { class: 't' + (x.status === 'done' ? '' : '') }, x.title),
    removable && !ro ? h('button', { class: 'icon-btn', style: { width: '24px', height: '24px' }, 'aria-label': 'Remove dependency', onclick: async e => { e.stopPropagation(); await api.del(`/tasks/${t.id}/blockers/${x.id}`).catch(er => toast(er.message, 'error')); await reload(); } }, icon('x', 14)) : null);
  const depSection = (L.blocked_by.length || L.blocks.length || !ro) ? h('section', h('div', { class: 'sec-title' }, icon('lock', 14), 'Dependencies', h('span', { class: 'grow' }), ro ? null : h('button', { class: 'btn ghost sm', onclick: () => blockerPicker(t, reload) }, icon('plus', 14), 'Blocked by…')),
    t.blocked_by_open ? h('div', { class: 'chip red', style: { marginBottom: '6px' } }, icon('lock', 12), `Blocked by ${t.blocked_by_open} open task${t.blocked_by_open > 1 ? 's' : ''}`) : null,
    L.blocked_by.map(x => depRow(x, true)), L.blocks.length ? h('div', { class: 'small faint', style: { margin: '8px 0 2px' } }, 'Blocking') : null, L.blocks.map(x => depRow(x, false)),
    !L.blocked_by.length && !L.blocks.length ? h('div', { class: 'faint small' }, 'No dependencies') : null) : null;

  // ---- attachments ----
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hide', onchange: () => { upload([...fileInput.files]); fileInput.value = ''; } });
  async function upload(files) {
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is larger than 15 MB`, 'error'); continue; }
      try {
        const r = await fetch(`/api/tasks/${t.id}/attachments`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Upload failed');
      } catch (e) { toast(e.message, 'error'); }
    }
    await reload();
  }
  pasteHandler = ro ? null : e => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    upload(files.map(f => (f.name && f.name !== 'image.png') ? f : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  };
  const atts = t.attachments || [];
  const attSection = h('section', { ondragover: e => { if (!ro) { e.preventDefault(); attSection.classList.add('dropping'); } }, ondragleave: () => attSection.classList.remove('dropping'),
    ondrop: e => { e.preventDefault(); attSection.classList.remove('dropping'); if (!ro) upload([...e.dataTransfer.files]); } },
  h('div', { class: 'sec-title' }, icon('paperclip', 14), 'Attachments', atts.length ? h('span', { class: 'chip' }, atts.length) : null, h('span', { class: 'grow' }), ro ? null : h('button', { class: 'btn ghost sm', onclick: () => fileInput.click() }, icon('upload', 14), 'Upload'), fileInput),
  atts.length ? h('div', { class: 'att-grid' }, atts.map(a => h('div', { class: 'att' },
    a.mime.startsWith('image/') && a.mime !== 'image/svg+xml' ? h('a', { href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/attachments/${a.id}`, alt: a.name, loading: 'lazy' })) : h('a', { class: 'att-file', href: `/api/attachments/${a.id}`, download: a.name }, icon('fileText', 22)),
    h('div', { class: 'att-name', title: a.name }, a.name), h('div', { class: 'small faint' }, (a.size > 1048576 ? (a.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(a.size / 1024)) + ' KB')),
    ro ? null : h('button', { class: 'icon-btn att-del', 'aria-label': 'Delete attachment', onclick: async () => { await api.del('/attachments/' + a.id).catch(er => toast(er.message, 'error')); await reload(); } }, icon('x', 13))))) : h('div', { class: 'faint small' }, ro ? 'No attachments' : 'Drop files here or paste a screenshot (Ctrl/⌘+V)'));

  // ---- time tracking ----
  const tm = ctl.time || { entries: [], total: 0 };
  const logMin = h('input', { class: 'input', type: 'number', min: 1, placeholder: 'min', style: { width: '80px' } });
  const logNote = h('input', { class: 'input', placeholder: 'What did you do? (optional)' });
  const timeSection = h('section', h('div', { class: 'sec-title' }, icon('clock', 14), 'Time', h('span', { class: 'chip' }, fmtDuration(tm.total) + (t.estimate ? ` / ${t.estimate}h est.` : '')), h('span', { class: 'grow' }),
    ro ? null : h('button', { class: 'btn sm ' + (isRunning ? 'danger' : ''), dataset: { prop: 'timer' }, onclick: async () => { try { isRunning ? await api.post('/timer/stop') : await api.post(`/tasks/${t.id}/timer/start`); ctl.running = await api.get('/timer'); ctl.time = await api.get(`/tasks/${t.id}/time`); render(); } catch (e) { toast(e.message, 'error'); } } }, icon(isRunning ? 'stop' : 'play', 13), isRunning ? 'Stop timer' : 'Start timer')),
  t.estimate ? h('div', { class: 'progress', style: { marginBottom: '8px' } }, h('i', { style: { width: Math.min(100, tm.total / 36 / t.estimate) + '%', background: tm.total / 3600 > t.estimate ? 'var(--red)' : 'var(--accent)' } })) : null,
  ro ? null : h('div', { class: 'row', style: { marginBottom: '8px' } }, logMin, logNote, h('button', { class: 'btn sm', onclick: async () => { try { await api.post(`/tasks/${t.id}/time`, { minutes: Number(logMin.value), note: logNote.value }); await reload(); } catch (e) { toast(e.message, 'error'); } } }, 'Log')),
  tm.entries.slice(0, 6).map(e => h('div', { class: 'act' }, h('i'), h('span', h('b', e.user_name || '—'), ` ${e.running ? 'is tracking' : 'logged ' + fmtDuration(e.seconds)}`, e.note ? ` — ${e.note}` : '', ' ', h('span', { class: 'faint' }, e.day)),
    (e.user_id === state.me.id && !e.running) ? h('button', { class: 'icon-btn', style: { width: '20px', height: '20px', marginLeft: 'auto' }, 'aria-label': 'Delete entry', onclick: async () => { await api.del('/time/' + e.id); await reload(); } }, icon('x', 12)) : null)));

  // ---- comments / activity ----
  const commentArea = h('textarea', { class: 'textarea', style: { minHeight: '64px' }, placeholder: 'Write a comment… use @name to notify someone', 'aria-label': 'Comment' });
  mentionAutocomplete(commentArea, state.users.filter(u => u.role !== 'guest' || true));
  const send = async () => { const v = commentArea.value.trim(); if (!v) return; commentArea.value = ''; try { await api.post(`/tasks/${t.id}/comments`, { body: v }); await reload(); } catch (e) { toast(e.message, 'error'); commentArea.value = v; } };
  commentArea.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
  const comments = h('div', { class: 'col', style: { gap: '14px' } }, t.comments.map(c => h('div', { class: 'comment' }, avatar({ name: c.user_name || '🤖', color: c.user_color || '#64748b' }, 28),
    h('div', { class: 'bubble' }, h('div', h('span', { class: 'who' }, c.user_name || 'Automation'), h('span', { class: 'small faint' }, ago(c.created_at))), renderMarkdownLite(c.body)))),
  t.can_comment ? h('div', { class: 'col' }, commentArea, h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: send }, 'Comment'), h('span', { class: 'hint' }, '⌘/Ctrl+Enter to send'))) : null);
  const activity = h('div', t.activity.length ? t.activity.map(a => h('div', { class: 'act' }, h('i'), h('span', h('b', a.user_name || 'Automation'), ' ', describeActivity(a, statuses), ' ', h('span', { class: 'faint' }, ago(a.created_at))))) : h('div', { class: 'faint' }, 'No activity yet'));
  const tabs = h('div', { class: 'tabs', style: { marginTop: 0, marginBottom: '14px' } },
    ['comments', 'activity'].map(k => h('button', { class: 'tab' + (ctl.tab === k ? ' active' : ''), onclick: () => { ctl.tab = k; render(); } }, k === 'comments' ? `Comments${t.comments.length ? ' (' + t.comments.length + ')' : ''}` : 'Activity')));

  // ---- properties ----
  const due = dueInfo(t.due_date, t.status === 'done');
  const prop = (label, node) => h('div', { class: 'prop' }, h('span', { class: 'label' }, label), node);
  const btn = (child, onClick, key) => h('button', { class: 'cell-btn', disabled: ro, dataset: key ? { prop: key } : {}, onclick: e => onClick(e.currentTarget) }, child);
  const estimate = h('input', { class: 'input', type: 'number', min: 0, step: 0.5, value: t.estimate ?? '', placeholder: 'Hours', disabled: ro, onchange: () => patch({ estimate: estimate.value === '' ? null : Number(estimate.value) }) });
  const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const sprint = ctl.meta.sprints.find(s => s.id === t.sprint_id), release = ctl.meta.releases.find(r => r.id === t.release_id) || null;
  const aiSuggest = h('div');
  const suggestBtn = ro ? null : h('button', { class: 'btn ai sm', style: { width: '100%' }, onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.replaceChildren(h('span', { class: 'spinner' }), 'Analyzing…');
    try {
      const r = await api.post('/ai/suggest', { task_id: t.id, today: todayStr() });
      const who = userById(r.assignee_id);
      mount(aiSuggest, h('div', { class: 'ai-panel' }, h('span', { class: 'ai-badge' }, icon('sparkles', 12), r.ai ? 'AI suggestion' : 'Suggestion'),
        h('div', { class: 'small' }, priorityBadge(r.priority), ' · ', r.estimate, 'h', who ? ' · ' + who.name : ''), h('div', { class: 'small muted' }, r.reason),
        r.calibration ? h('div', { class: 'small', style: { color: 'var(--amber)' } }, r.calibration) : null,
        h('button', { class: 'btn sm', onclick: () => patch({ priority: r.priority, estimate: r.estimate, assignee_id: r.assignee_id ?? t.assignee_id }) }, 'Apply all')));
    } catch (er) { toast(er.message, 'error'); }
    b.disabled = false; b.replaceChildren(icon('sparkles', 14), 'Suggest priority & owner');
  } }, icon('sparkles', 14), 'Suggest priority & owner');

  const fields = (project?.fields || []).map(f => {
    const val = t.custom?.[f.id];
    const set = v => patch({ custom: { [f.id]: v } });
    let node;
    if (f.type === 'checkbox') node = h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!val, disabled: ro, onchange: e => set(e.target.checked) }), h('span', f.label));
    else if (f.type === 'select') node = h('select', { class: 'select', disabled: ro, onchange: e => set(e.target.value || null) }, [h('option', { value: '' }, '—'), ...(f.options || []).map(o => h('option', { value: o, selected: o === val }, o))]);
    else node = h('input', { class: 'input', type: f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text', value: val ?? '', disabled: ro, onchange: e => set(e.target.value === '' ? null : e.target.value) });
    return f.type === 'checkbox' ? h('div', { class: 'prop' }, node) : prop(f.label, node);
  });

  const side = h('div', { class: 'd-side' },
    prop('Status', btn([statusDot(t.status, t.status_category), t.status_label], el => statusMenu(el, t.status, s => patch({ status: s }), statuses), 'status')),
    prop('Type', btn([typeIcon(t.type), TYPE[t.type]?.[1]], el => menu(el, Object.entries(TYPE).map(([id, x]) => ({ node: typeIcon(id), label: x[1], checked: id === t.type, onClick: () => patch({ type: id }) }))))),
    prop('Priority', btn(priorityBadge(t.priority), el => priorityMenu(el, t.priority, p => patch({ priority: p })), 'priority')),
    prop('Assignee', btn([avatar(userById(t.assignee_id), 22), t.assignee_id ? userById(t.assignee_id)?.name : h('span', { class: 'faint' }, 'Unassigned')], el => assigneeMenu(el, members, t.assignee_id, id => patch({ assignee_id: id })), 'assignee')),
    h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      h('div', { class: 'grow' }, prop('Start', btn([icon('calendar', 14), fmtDate(t.start_date) || h('span', { class: 'faint' }, '—')], el => dateMenu(el, t.start_date, d => patch({ start_date: d }))))),
      h('div', { class: 'grow' }, prop('Due', btn([icon('calendar', 14), due ? h('span', { class: 'due ' + due.state }, due.label) : h('span', { class: 'faint' }, '—')], el => dateMenu(el, t.due_date, d => patch({ due_date: d })), 'due')))),
    prop('Estimate (hours)', estimate),
    t.type !== 'epic' ? prop('Epic', btn(t.epic ? [icon('layers', 14), h('span', { class: 'ellipsis' }, t.epic.title)] : h('span', { class: 'faint' }, 'None'), el => simpleMenu(el, ctl.meta.epics.map(e => [e.id, e.title]), t.epic_id, id => patch({ epic_id: id }), 'No epic'))) : null,
    prop('Sprint', btn(sprint ? [icon('target', 14), sprint.name] : h('span', { class: 'faint' }, 'Backlog'), el => simpleMenu(el, ctl.meta.sprints.map(s => [s.id, s.name + (s.state === 'active' ? ' (active)' : '')]), t.sprint_id, id => patch({ sprint_id: id }), 'Backlog'))),
    prop('Release', btn(release ? [icon('rocket', 14), release.name] : h('span', { class: 'faint' }, 'None'), el => simpleMenu(el, ctl.meta.releases.map(r => [r.id, r.name + (r.version ? ' ' + r.version : '')]), t.release_id, id => patch({ release_id: id }), 'No release'))),
    prop('Labels', labelEditor([...t.labels], l => patch({ labels: l }), { readonly: ro })),
    ...fields, suggestBtn, aiSuggest,
    h('div', { class: 'small faint', style: { marginTop: 'auto', lineHeight: 1.8 } }, 'Reporter: ', userById(t.reporter_id)?.name || '—', h('br'), 'Created ', ago(t.created_at), t.source !== 'web' ? ` via ${t.source}` : '', h('br'), 'Updated ', ago(t.updated_at)));

  const link = `${location.origin}/#/task/${t.id}`;
  const branch = `${t.key.toLowerCase()}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
  const head = h('div', { class: 'drawer-head' },
    h('span', { class: 'proj-key', style: { background: t.project_color } }, t.project_key), typeIcon(t.type), h('span', { class: 'mono muted' }, t.key), h('span', { class: 'small faint ellipsis' }, t.project_name), h('span', { class: 'grow' }),
    isRunning ? h('span', { class: 'chip red' }, h('span', { class: 'live-dot', style: { background: 'var(--red)' } }), 'Tracking') : null,
    h('button', { class: 'icon-btn', title: 'Copy git branch name', 'aria-label': 'Copy branch name', onclick: () => { navigator.clipboard?.writeText(branch).then(() => toast(`Copied: ${branch}`), () => toast(branch)); } }, icon('github', 17)),
    h('button', { class: 'icon-btn', title: 'Copy link', 'aria-label': 'Copy link', onclick: () => { navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast(link)); } }, icon('link', 17)),
    ro ? null : h('button', { class: 'icon-btn', title: 'Delete task', 'aria-label': 'Delete task', onclick: async () => { if (await confirmDialog('Delete this task?', `${t.key} and its subtasks and comments will be permanently removed.`)) { try { await api.del('/tasks/' + t.id); toast('Task deleted'); closeTask(); } catch (e) { toast(e.message, 'error'); } } } }, icon('trash', 17)),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeTask }, icon('x', 19)));

  const prs = (t.prs || []);
  const scroll = el.querySelector('.drawer-body')?.scrollTop || 0;
  mount(el, head, h('div', { class: 'drawer-body' },
    h('div', { class: 'd-main' }, title,
      prs.length ? h('div', { class: 'row', style: { flexWrap: 'wrap' } }, prs.map(pr => h('a', { class: 'chip ' + (pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'red' : 'green'), href: pr.url, target: '_blank', rel: 'noopener' }, icon('github', 12), `#${pr.number} ${pr.state}`))) : null,
      h('section', h('div', { class: 'sec-title' }, 'Description', h('span', { class: 'grow' }), improveBtn), descBox),
      childSection, t.parent_id ? null : subSection, depSection, attSection, timeSection, h('section', tabs, ctl.tab === 'comments' ? comments : activity)),
    side));
  const body = el.querySelector('.drawer-body'); if (body) body.scrollTop = scroll;
  if (ro) el.prepend(h('div', { class: 'chip amber', style: { margin: '10px 18px 0', alignSelf: 'flex-start' } }, t.can_comment ? 'Comment-only access' : 'View-only access'));

  // keyboard shortcuts (active while the drawer is open and you're not typing)
  const click = key => () => el.querySelector(`[data-prop="${key}"]`)?.click();
  hotkeys = ro ? {} : {
    s: click('status'), p: click('priority'), a: click('assignee'), d: click('due'), e: () => title.focus(),
    t: click('timer'),
    ...Object.fromEntries(statuses.slice(0, 9).map((s, i) => [String(i + 1), () => patch({ status: s.id })])),
  };
}

function blockerPicker(task, done) {
  const input = h('input', { class: 'input', placeholder: 'Search by title or key (e.g. API-12)…' });
  const list = h('div', { class: 'col', style: { gap: '2px', minHeight: '120px' } }, h('div', { class: 'faint small' }, 'Type at least 2 characters'));
  let timer;
  const m = modal({ title: `${task.key} is blocked by…`, body: [input, list], width: 520 });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (input.value.trim().length < 2) return;
      const r = (await api.get('/search?q=' + encodeURIComponent(input.value.trim())).catch(() => [])).filter(x => x.id !== task.id);
      mount(list, r.length ? r.map(x => h('button', { class: 'sub', style: { border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }, onclick: async () => { try { await api.post(`/tasks/${task.id}/blockers`, { blocker_id: x.id }); m.close(); done(); } catch (e) { toast(e.message, 'error'); } } },
        statusDot(x.status, x.status_category), h('span', { class: 'mono small faint' }, x.key), h('span', { class: 't' }, x.title))) : h('div', { class: 'faint small' }, 'No matches'));
    }, 200);
  });
}

function describeActivity(a, statuses) {
  const d = a.detail || {};
  const label = id => statuses.find(s => s.id === id)?.label || id;
  const fmt = v => (v == null || v === '' ? 'none' : Array.isArray(v) ? v.join(', ') || 'none' : v);
  switch (a.action) {
    case 'created': return `created this task${d.source && d.source !== 'web' ? ' via ' + d.source : ''}`;
    case 'changed_status': return `moved ${label(d.from)} → ${label(d.to)}`;
    case 'changed_priority': return `changed priority ${d.from} → ${d.to}`;
    case 'changed_assignee_id': return `assigned to ${userById(d.to)?.name || 'nobody'}`;
    case 'changed_due_date': return `set due date to ${fmt(d.to)}`;
    case 'changed_start_date': return `set start date to ${fmt(d.to)}`;
    case 'changed_title': return `renamed to “${d.to}”`;
    case 'changed_estimate': return `set estimate to ${fmt(d.to)}h`;
    case 'changed_labels': return `set labels: ${fmt(d.to)}`;
    case 'changed_type': return `changed type to ${d.to}`;
    case 'changed_sprint_id': return d.to ? 'moved into a sprint' : 'moved to the backlog';
    case 'changed_release_id': return d.to ? 'added to a release' : 'removed from a release';
    case 'changed_epic_id': return d.to ? 'linked to an epic' : 'unlinked from its epic';
    case 'changed_custom': return 'updated custom fields';
    case 'edited_description': return 'edited the description';
    case 'commented': return 'commented';
    case 'attached': return `attached ${d.name || 'a file'}`;
    case 'logged_time': return `logged ${fmtDuration(d.seconds)}`;
    case 'added_blocker': return `is blocked by ${d.key}`;
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
