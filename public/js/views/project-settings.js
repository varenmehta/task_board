import { h, mount, icon, toast, modal, confirmDialog, avatar } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { reloadLookups } from '../main.js';

const SCHEDULES = [['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly:1', 'Every Monday'], ['weekly:2', 'Every Tuesday'], ['weekly:3', 'Every Wednesday'], ['weekly:4', 'Every Thursday'], ['weekly:5', 'Every Friday'], ['monthly:1', 'Monthly on the 1st'], ['monthly:15', 'Monthly on the 15th']];

export function projectSettingsView(ctl, repaint) {
  const p = ctl.project;
  if (!p.can_manage) return h('div', { class: 'page' }, h('div', { class: 'empty card' }, h('b', 'Managers only'), 'Ask a project manager or team lead to change these settings.'));
  const box = h('div', { class: 'col', style: { maxWidth: '820px', gap: '16px' } });
  const section = (title, sub, ...kids) => h('div', { class: 'card setting-card', style: { margin: 0 } }, h('h3', title), h('p', { class: 'muted small', style: { margin: '2px 0 14px' } }, sub), ...kids);
  const save = async (patch, msg = 'Saved') => { try { await api.patch('/projects/' + p.id, patch); toast(msg, 'success', 1800); await reloadLookups(); await ctl.reload(); } catch (e) { toast(e.message, 'error', 5000); } };

  // ---- columns ----
  let cols = p.statuses.map(s => ({ ...s }));
  const colsBox = h('div');
  const paintCols = () => mount(colsBox, cols.map((c, i) => h('div', { class: 'field-row' },
    h('input', { class: 'input', style: { flex: 1 }, value: c.label, 'aria-label': 'Column name', oninput: e => (c.label = e.target.value) }),
    c.id === 'done' ? h('span', { class: 'chip green', style: { width: '110px', justifyContent: 'center' } }, 'Done column') : h('select', { class: 'select', style: { width: '110px' }, 'aria-label': 'Column type', onchange: e => (c.category = e.target.value) }, [['todo', 'Not started'], ['doing', 'In flight']].map(([v, l]) => h('option', { value: v, selected: c.category === v }, l))),
    h('input', { class: 'input', style: { width: '78px' }, type: 'number', min: 1, placeholder: 'WIP', title: 'Work-in-progress limit', 'aria-label': 'WIP limit', value: c.wip ?? '', oninput: e => (c.wip = e.target.value === '' ? null : Number(e.target.value)) }),
    h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [cols[i - 1], cols[i]] = [cols[i], cols[i - 1]]; paintCols(); } }, icon('arrowUp', 16)),
    h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === cols.length - 1, onclick: () => { [cols[i + 1], cols[i]] = [cols[i], cols[i + 1]]; paintCols(); } }, icon('arrowUp', 16, 'flipy')),
    c.id === 'done' ? h('span', { style: { width: '32px' } }) : h('button', { class: 'icon-btn', 'aria-label': 'Delete column', onclick: () => { cols.splice(i, 1); paintCols(); } }, icon('trash', 16)))));
  paintCols();
  const saveCols = async () => {
    const used = cols.map(c => c.id);
    const removed = p.statuses.filter(s => !used.includes(s.id));
    const body = { statuses: cols.map(c => ({ ...c, id: c.id || ('c_' + c.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) + '_' + Math.random().toString(36).slice(2, 5)) })) };
    const busy = removed.filter(r => ctl.tasks.some(t => t.status === r.id));
    if (busy.length) {
      const target = await new Promise(res => { const sel = h('select', { class: 'select' }, body.statuses.filter(s => s.id !== 'done').map(s => h('option', { value: s.id }, s.label))); modal({ title: 'Move tasks', body: [h('p', `“${busy.map(b => b.label).join('”, “')}” still ${busy.length > 1 ? 'have' : 'has'} tasks. Move them to:`), sel], onClose: () => res(null), actions: [{ label: 'Cancel' }, { label: 'Move & save', kind: 'primary', onClick: () => res(sel.value) }] }); });
      if (!target) return;
      body.move_tasks_to = target;
    }
    await save(body, 'Columns saved');
  };

  // ---- custom fields ----
  let fields = (p.fields || []).map(f => ({ ...f, options: f.options ? [...f.options] : undefined }));
  const fieldsBox = h('div');
  const paintFields = () => mount(fieldsBox, fields.map((f, i) => h('div', { class: 'field-row' },
    h('input', { class: 'input', style: { flex: 1 }, placeholder: 'Field name', value: f.label, oninput: e => (f.label = e.target.value) }),
    h('select', { class: 'select', style: { width: '120px' }, onchange: e => { f.type = e.target.value; if (f.type === 'select' && !f.options) f.options = ['Option 1', 'Option 2']; paintFields(); } }, ['text', 'number', 'select', 'date', 'checkbox'].map(t => h('option', { value: t, selected: f.type === t }, t))),
    f.type === 'select' ? h('input', { class: 'input', style: { flex: 1 }, placeholder: 'Options, comma separated', value: (f.options || []).join(', '), oninput: e => (f.options = e.target.value.split(',').map(x => x.trim()).filter(Boolean)) }) : null,
    h('button', { class: 'icon-btn', 'aria-label': 'Delete field', onclick: () => { fields.splice(i, 1); paintFields(); } }, icon('trash', 16)))));
  paintFields();

  // ---- templates & recurring ----
  const tplBox = h('div'), recBox = h('div');
  const paintTpl = () => mount(tplBox, ctl.templates.length ? ctl.templates.map(t => h('div', { class: 'field-row' }, icon('fileText', 16), h('b', { class: 'grow' }, t.name), h('span', { class: 'small faint' }, t.data.subtasks?.length ? `${t.data.subtasks.length} subtasks` : ''), h('button', { class: 'btn sm', onclick: () => templateModal(ctl, t, repaint) }, 'Edit'), h('button', { class: 'icon-btn', 'aria-label': 'Delete template', onclick: async () => { await api.del(`/projects/${p.id}/templates/${t.id}`); await ctl.reload(); } }, icon('trash', 16)))) : h('p', { class: 'faint small' }, 'No templates yet.'));
  paintTpl();
  api.get(`/projects/${p.id}/recurrences`).then(list => mount(recBox, list.length ? list.map(r => h('div', { class: 'field-row' }, icon('repeat', 16), h('b', { class: 'grow' }, r.name), h('span', { class: 'chip' }, SCHEDULES.find(s => s[0] === r.schedule)?.[1] || r.schedule), h('span', { class: 'small faint' }, r.enabled ? 'next ' + r.next_run : 'paused'),
    h('button', { class: 'btn sm', onclick: async () => { await api.put(`/projects/${p.id}/recurrences/${r.id}`, { ...r, enabled: !r.enabled, start: r.next_run }); repaint(true); } }, r.enabled ? 'Pause' : 'Resume'), h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await api.del(`/projects/${p.id}/recurrences/${r.id}`); repaint(true); } }, icon('trash', 16)))) : h('p', { class: 'faint small' }, 'No recurring tasks yet.'))).catch(() => {});

  // ---- access ----
  const accessBox = h('div', h('span', { class: 'spinner' }));
  const loadAccess = async () => {
    const a = await api.get(`/projects/${p.id}/access`);
    const explicit = new Set(a.explicit.map(x => x.user_id));
    const addable = state.users.filter(u => !explicit.has(u.id) && u.role !== 'admin');
    mount(accessBox,
      h('div', { class: 'small faint', style: { marginBottom: '6px' } }, `Everyone in the ${p.team_name} team can work here by default. Add exceptions below — to restrict a teammate, give them a lower role; to include a client or contractor, add them with a role.`),
      a.explicit.length ? a.explicit.map(x => h('div', { class: 'field-row' }, avatar(state.users.find(u => u.id === x.user_id) || { name: x.name }, 26), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 550 } }, x.name), h('div', { class: 'small faint' }, x.email + (x.org_role === 'guest' ? ' · guest' : ''))),
        h('select', { class: 'select', style: { width: '130px' }, onchange: async e => { await api.put(`/projects/${p.id}/members/${x.user_id}`, { role: e.target.value }).catch(er => toast(er.message, 'error')); loadAccess(); } }, a.roles.map(r => h('option', { value: r, selected: x.role === r }, r))),
        h('button', { class: 'icon-btn', 'aria-label': 'Remove exception', onclick: async () => { await api.del(`/projects/${p.id}/members/${x.user_id}`); loadAccess(); } }, icon('x', 16)))) : h('p', { class: 'faint small' }, 'No exceptions.'),
      addable.length ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('select', { class: 'select', id: 'acc-user' }, h('option', { value: '' }, 'Add a person…'), addable.map(u => h('option', { value: u.id }, `${u.name} (${u.role})`))), h('select', { class: 'select', id: 'acc-role', style: { width: '130px' } }, a.roles.map(r => h('option', { value: r, selected: r === 'editor' }, r))),
        h('button', { class: 'btn', onclick: async () => { const u = document.getElementById('acc-user').value; if (!u) return; await api.put(`/projects/${p.id}/members/${u}`, { role: document.getElementById('acc-role').value }).catch(er => toast(er.message, 'error')); loadAccess(); } }, 'Add')) : null);
  };
  loadAccess().catch(() => {});

  // ---- integrations: outgoing webhooks + inbound hooks ----
  const whBox = h('div'), hookBox = h('div');
  const showSecret = (title, rows) => modal({ title, width: 620, body: [h('p', { class: 'muted small' }, 'Copy these now — for security they are shown only once.'), ...rows.map(([l, v]) => h('div', { class: 'field' }, h('label', l), h('input', { class: 'input mono', readonly: true, value: v, onfocus: e => e.target.select() })))], actions: [{ label: 'Done', kind: 'primary' }] });
  const loadWh = async () => {
    const [meta, list] = await Promise.all([api.get('/webhook-meta'), api.get(`/projects/${p.id}/webhooks`)]);
    mount(whBox, list.length ? list.map(w => h('div', { class: 'field-row' }, icon(w.format === 'json' ? 'link' : 'message', 16), h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { style: { fontWeight: 550 } }, w.name || w.url), h('div', { class: 'small faint ellipsis' }, `${meta.formats[w.format]} · ${w.events.length} events · ${w.url}`)),
      w.active ? h('span', { class: 'chip ' + (w.last_status === 'failed' ? 'red' : w.last_status === 'ok' ? 'green' : '') }, w.last_status || 'idle') : h('span', { class: 'chip amber' }, 'disabled'),
      h('button', { class: 'btn sm', onclick: async e => { e.currentTarget.disabled = true; const r = await api.post(`/webhooks/${w.id}/test`).catch(er => ({ status: 'failed', error: er.message })); toast(r.status === 'ok' ? 'Test delivered ✓' : `Failed: ${r.error || r.code}`, r.status === 'ok' ? 'success' : 'error', 4500); loadWh(); } }, 'Test'),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete webhook', onclick: async () => { await api.del('/webhooks/' + w.id); loadWh(); } }, icon('trash', 16)))) : h('p', { class: 'faint small' }, 'No webhooks yet.'));
    whBox.meta = meta;
  };
  const addWebhook = () => {
    const meta = whBox.meta; if (!meta) return;
    const v = { name: '', url: '', format: 'slack', events: ['task.created', 'task.completed'] };
    const fmt = h('select', { class: 'select', onchange: e => (v.format = e.target.value) }, Object.entries(meta.formats).map(([k, l]) => h('option', { value: k, selected: k === v.format }, l)));
    modal({ title: 'New webhook', width: 560, body: [
      h('div', { class: 'field' }, h('label', 'Send to'), fmt, h('div', { class: 'hint' }, 'Slack: create an Incoming Webhook in your Slack app. Teams: add a Workflows/Incoming Webhook to a channel. JSON: any HTTPS endpoint — requests are signed with HMAC-SHA256.')),
      h('div', { class: 'field' }, h('label', 'URL'), h('input', { class: 'input', placeholder: 'https://hooks.slack.com/services/…', oninput: e => (v.url = e.target.value) })),
      h('div', { class: 'field' }, h('label', 'Name (optional)'), h('input', { class: 'input', oninput: e => (v.name = e.target.value) })),
      h('div', { class: 'field' }, h('label', 'Events'), h('div', { class: 'col', style: { gap: '6px' } }, Object.entries(meta.events).map(([k, l]) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.events.includes(k), onchange: e => { e.target.checked ? v.events.push(k) : v.events.splice(v.events.indexOf(k), 1); } }), l))))],
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async () => { try { const r = await api.post(`/projects/${p.id}/webhooks`, v); if (v.format === 'json') showSecret('Webhook created', [['Signing secret (HMAC-SHA256, header X-TaskBoard-Signature)', r.secret]]); else toast('Webhook created', 'success'); loadWh(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
  };
  const loadHooks = async () => {
    const list = await api.get(`/projects/${p.id}/hooks`);
    mount(hookBox, list.length ? list.map(x => h('div', { class: 'field-row' }, icon(x.kind === 'github' || x.kind === 'gitlab' ? 'github' : 'alert', 16), h('b', { class: 'grow' }, x.name), h('span', { class: 'small faint' }, x.last_used ? 'last used ' + x.last_used.slice(0, 10) : 'never used'), h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { await api.del('/hooks/' + x.id); loadHooks(); } }, icon('trash', 16)))) : h('p', { class: 'faint small' }, 'No inbound integrations yet.'));
  };
  const addHook = async () => {
    const meta = whBox.meta || await api.get('/webhook-meta');
    const v = { kind: 'github', name: '' };
    const kind = h('select', { class: 'select', onchange: e => (v.kind = e.target.value) }, Object.entries(meta.hook_kinds).map(([k, l]) => h('option', { value: k, selected: k === v.kind }, l)));
    modal({ title: 'Add inbound integration', body: [h('div', { class: 'field' }, h('label', 'Source'), kind, h('div', { class: 'hint' }, 'GitHub/GitLab: link pull requests to tasks (mention the task key like API-12 in the PR title or branch) — opening a PR moves the task to review, merging completes it. Sentry/PagerDuty/Datadog/generic: alerts create tasks, de-duplicate repeats, and auto-resolve.')), h('div', { class: 'field' }, h('label', 'Name (optional)'), h('input', { class: 'input', oninput: e => (v.name = e.target.value) }))],
      actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async () => { try { const r = await api.post(`/projects/${p.id}/hooks`, v); showSecret('Integration created', [['Webhook URL', r.url], ...(r.secret ? [[v.kind === 'gitlab' ? 'Secret token' : 'Secret (GitHub “Secret” field)', r.secret]] : [])]); loadHooks(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
  };
  loadWh().catch(() => {}); loadHooks().catch(() => {});

  const v = { name: p.name, description: p.description || '', digest: (p.digest_emails || []).join(', '), triage: !!p.auto_triage };
  mount(box,
    section('General', 'Name, description and automation preferences.',
      h('div', { class: 'col' }, h('div', { class: 'field' }, h('label', 'Name'), h('input', { class: 'input', value: v.name, oninput: e => (v.name = e.target.value) })), h('div', { class: 'field' }, h('label', 'Description'), h('input', { class: 'input', value: v.description, oninput: e => (v.description = e.target.value) })),
        h('label', { class: 'row' }, h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: v.triage, onchange: e => (v.triage = e.target.checked) }), h('i')), h('span', h('b', '✨ Auto-triage new tasks'), h('div', { class: 'small muted' }, 'AI suggests a priority, labels and owner for new, unprioritised tasks and leaves a comment explaining why.'))),
        h('div', { class: 'field' }, h('label', 'Weekly stakeholder digest — recipients'), h('input', { class: 'input', placeholder: 'ceo@acme.com, client@partner.io', value: v.digest, oninput: e => (v.digest = e.target.value) }), h('div', { class: 'hint' }, 'Every Monday, these addresses get an AI-written summary of shipped work, progress and risks (needs Gmail connected).')),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => save({ name: v.name, description: v.description, auto_triage: v.triage, digest_emails: v.digest.split(',').map(x => x.trim()).filter(Boolean) }) }, 'Save'),
          h('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog('Archive project?', `“${p.name}” will disappear from the sidebar. Data is kept.`, 'Archive')) { await save({ archived: true }, 'Archived'); location.hash = '#/'; } } }, 'Archive project')))),
    section('Board columns', 'Rename, reorder, add and set work-in-progress limits. Columns marked “In flight” count as active work. The Done column is permanent.',
      colsBox, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => { cols.splice(cols.length - 1, 0, { id: '', label: 'New column', category: 'doing', wip: null }); paintCols(); } }, icon('plus', 14), 'Add column'), h('button', { class: 'btn primary', onclick: saveCols }, 'Save columns'))),
    section('Custom fields', 'Extra data on every task — story points, environment, customer…',
      fieldsBox, h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onclick: () => { fields.push({ label: '', type: 'text' }); paintFields(); } }, icon('plus', 14), 'Add field'), h('button', { class: 'btn primary', onclick: () => save({ fields: fields.filter(f => f.label.trim()) }, 'Fields saved') }, 'Save fields'))),
    section('Task templates', 'Reusable starting points (with subtasks). Pick one from “New task”.', tplBox, h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => templateModal(ctl, null, repaint) }, icon('plus', 14), 'New template')),
    section('Recurring tasks', 'Tasks created automatically on a schedule — release checklists, weekly reviews, on-call handovers.', recBox, h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => recurringModal(ctl, repaint) }, icon('plus', 14), 'New recurring task')),
    section('Access', 'Per-project roles: manager, editor, commenter, viewer.', accessBox),
    section('Notify Slack, Teams & other tools', 'Outgoing webhooks fire when tasks change. Slack and Teams get ready-made messages; JSON webhooks are HMAC-signed.', whBox, h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: addWebhook }, icon('plus', 14), 'Add webhook')),
    section('Inbound integrations', 'GitHub / GitLab pull requests and Sentry / PagerDuty / Datadog alerts become task updates.', hookBox, h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: addHook }, icon('plus', 14), 'Add integration')));
  return h('div', { class: 'page' }, box);
}

function dataForm(init = {}) {
  const v = { title: init.title || '', description: init.description || '', priority: init.priority || 'medium', type: init.type || 'task', labels: init.labels || [], estimate: init.estimate ?? '', due_in_days: init.due_in_days ?? '', subtasks: init.subtasks || [] };
  const f = (label, input, hint) => h('div', { class: 'field' }, h('label', label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const node = h('div', { class: 'col' },
    f('Task title', h('input', { class: 'input', value: v.title, oninput: e => (v.title = e.target.value) })), f('Description', h('textarea', { class: 'textarea', oninput: e => (v.description = e.target.value) }, v.description)),
    h('div', { class: 'row' }, f('Priority', h('select', { class: 'select', onchange: e => (v.priority = e.target.value) }, ['urgent', 'high', 'medium', 'low'].map(x => h('option', { value: x, selected: v.priority === x }, x)))), f('Type', h('select', { class: 'select', onchange: e => (v.type = e.target.value) }, ['task', 'bug', 'story', 'epic'].map(x => h('option', { value: x, selected: v.type === x }, x)))),
      f('Estimate (h)', h('input', { class: 'input', type: 'number', min: 0, value: v.estimate, oninput: e => (v.estimate = e.target.value === '' ? null : Number(e.target.value)) })), f('Due in (days)', h('input', { class: 'input', type: 'number', min: 0, value: v.due_in_days, oninput: e => (v.due_in_days = e.target.value === '' ? null : Number(e.target.value)) }))),
    f('Labels', h('input', { class: 'input', value: v.labels.join(', '), placeholder: 'release, ops', oninput: e => (v.labels = e.target.value.split(',').map(x => x.trim()).filter(Boolean)) })),
    f('Subtasks (one per line)', h('textarea', { class: 'textarea', oninput: e => (v.subtasks = e.target.value.split('\n').map(x => x.trim()).filter(Boolean)) }, v.subtasks.join('\n'))));
  return { v, node };
}

function templateModal(ctl, t, repaint) {
  const { v, node } = dataForm(t?.data);
  const name = h('input', { class: 'input', value: t?.name || '', placeholder: 'e.g. Release checklist' });
  modal({ title: t ? 'Edit template' : 'New template', width: 600, body: [h('div', { class: 'field' }, h('label', 'Template name'), name), node],
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { try { await api.post(`/projects/${ctl.pid}/templates`, { id: t?.id, name: name.value, data: v }); await ctl.reload(); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}
function recurringModal(ctl, repaint) {
  const { v, node } = dataForm({});
  const sched = h('select', { class: 'select' }, SCHEDULES.map(([val, l]) => h('option', { value: val }, l)));
  const asg = h('select', { class: 'select' }, h('option', { value: '' }, 'Unassigned'), ctl.members.map(m => h('option', { value: m.id }, m.name)));
  modal({ title: 'New recurring task', width: 600, body: [h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', 'Repeats'), sched), h('div', { class: 'field grow' }, h('label', 'Assign to'), asg)), node],
    actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async () => { try { await api.post(`/projects/${ctl.pid}/recurrences`, { name: v.title, data: v, schedule: sched.value, assignee_id: asg.value ? +asg.value : null }); toast('Recurring task created', 'success'); repaint(true); } catch (e) { toast(e.message, 'error'); return false; } } }] });
}
