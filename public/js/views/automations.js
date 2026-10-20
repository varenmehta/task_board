import { h, mount, icon, toast, modal, confirmDialog, PRIORITY, STATUS_LABEL } from '../dom.js';
import { api } from '../api.js';
import { state, canManage, projectById } from '../state.js';

const ACTION_DEFAULTS = { notify: { type: 'notify', to: 'assignee', message: '' }, set_status: { type: 'set_status', value: 'in_progress' }, set_priority: { type: 'set_priority', value: 'high' }, set_assignee: { type: 'set_assignee', value: 'reporter' }, add_label: { type: 'add_label', value: '' }, comment: { type: 'comment', value: '' } };

function describeAction(a) {
  switch (a.type) {
    case 'notify': return `Notify ${a.to === 'leads' ? 'team leads' : a.to}`;
    case 'set_status': return `Set status → ${STATUS_LABEL[a.value] || a.value}`;
    case 'set_priority': return `Set priority → ${a.value}`;
    case 'set_assignee': return a.value === 'unassign' ? 'Unassign' : `Assign to ${a.value === 'reporter' ? 'reporter' : (state.users.find(u => u.id === +a.value)?.name || '…')}`;
    case 'add_label': return `Add label #${a.value}`;
    case 'comment': return 'Post a comment';
    default: return a.type;
  }
}
function describeConditions(c) {
  const out = [];
  if (c.to_status) out.push(`moved to ${STATUS_LABEL[c.to_status]}`);
  if (c.status) out.push(`status is ${STATUS_LABEL[c.status]}`);
  if (c.priority) out.push(`priority is ${c.priority}`);
  if (c.label) out.push(`has label #${c.label}`);
  if (c.unassigned) out.push('is unassigned');
  return out;
}

export async function automationsView(el) {
  const render = async () => {
    const data = await api.get('/automations');
    const editable = canManage();
    mount(el, h('div', { class: 'page', style: { maxWidth: '980px' } },
      h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', 'Automations'), h('p', { class: 'muted' }, 'Rules that run on their own: when something happens, do something — no manual follow-ups.')),
        editable ? h('button', { class: 'btn primary', onclick: () => ruleModal(data, null, render) }, icon('plus', 15), 'New rule') : null),
      !editable ? h('div', { class: 'chip amber', style: { marginBottom: '12px' } }, 'Only admins and managers can edit rules') : null,
      h('div', { class: 'card' }, data.rules.length ? data.rules.map(r => h('div', { class: 'rule' },
        h('label', { class: 'switch', title: r.enabled ? 'Enabled' : 'Disabled' }, h('input', { type: 'checkbox', checked: r.enabled, disabled: !editable, onchange: async e => { await api.patch('/automations/' + r.id, { enabled: e.target.checked }).catch(er => toast(er.message, 'error')); render(); } }), h('i')),
        h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, r.name, r.project_name ? h('span', { class: 'chip', style: { marginLeft: '8px' } }, r.project_name) : h('span', { class: 'chip', style: { marginLeft: '8px' } }, 'All projects')),
          h('div', { class: 'flow' }, h('span', { class: 'chip blue' }, icon('zap', 12), 'When ' + data.triggers[r.trigger].toLowerCase()), ...describeConditions(r.conditions).map(c => h('span', { class: 'chip' }, 'if ' + c)), icon('chevronRight', 14), ...r.actions.map(a => h('span', { class: 'chip green' }, describeAction(a))))),
        h('span', { class: 'small faint nowrap' }, r.runs + ' run' + (r.runs === 1 ? '' : 's')),
        editable ? h('button', { class: 'icon-btn', 'aria-label': 'Edit', onclick: () => ruleModal(data, r, render) }, icon('edit', 16)) : null,
        editable ? h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => { if (await confirmDialog('Delete rule?', `“${r.name}” will stop running.`)) { await api.del('/automations/' + r.id); render(); } } }, icon('trash', 16)) : null)) : h('div', { class: 'empty' }, h('b', 'No automations yet'), 'Create a rule to auto-assign, escalate, or notify.')),
      h('div', { class: 'card card-pad', style: { marginTop: '16px' } }, h('div', { class: 'row' }, icon('clock', 18), h('div', h('b', 'Always on, no setup needed'), h('p', { class: 'small muted' }, 'Due-date reminders (24h before and when overdue), a daily briefing, and mention/assignment alerts run automatically. Choose where you receive them in Settings → Notifications.'))))));
  };
  await render();
}

function ruleModal(data, rule, done) {
  const v = rule ? JSON.parse(JSON.stringify(rule)) : { name: '', trigger: 'status_changed', project_id: null, conditions: {}, actions: [{ ...ACTION_DEFAULTS.notify }], enabled: true };
  const body = h('div', { class: 'col', style: { gap: '14px' } });
  const sel = (opts, cur, on, cls = '') => h('select', { class: 'select ' + cls, onchange: e => on(e.target.value) }, opts.map(([val, label]) => h('option', { value: val, selected: String(val) === String(cur ?? '') }, label)));
  const paint = () => {
    const c = v.conditions;
    mount(body,
      h('div', { class: 'field' }, h('label', 'Rule name'), h('input', { class: 'input', value: v.name, placeholder: 'e.g. Notify QA when work is ready for review', oninput: e => (v.name = e.target.value) })),
      h('div', { class: 'row' }, h('div', { class: 'field grow' }, h('label', 'Applies to'), sel([['', 'All projects'], ...state.projects.map(p => [p.id, p.name])], v.project_id, x => (v.project_id = x ? +x : null))),
        h('div', { class: 'field grow' }, h('label', 'When'), sel(Object.entries(data.triggers), v.trigger, x => { v.trigger = x; paint(); }))),
      h('div', { class: 'field' }, h('label', 'Only if (optional)'), h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        v.trigger === 'status_changed' ? sel([['', 'Moved to any status'], ...state.statuses.map(s => [s.id, 'Moved to ' + s.label])], c.to_status, x => (x ? (c.to_status = x) : delete c.to_status), 'grow') : null,
        sel([['', 'Any priority'], ...Object.keys(PRIORITY).map(p => [p, p[0].toUpperCase() + p.slice(1)])], c.priority, x => (x ? (c.priority = x) : delete c.priority), 'grow'),
        h('input', { class: 'input grow', placeholder: 'Has label…', value: c.label || '', oninput: e => (e.target.value ? (c.label = e.target.value.trim().toLowerCase()) : delete c.label) }))),
      h('div', { class: 'field' }, h('label', 'Then'), ...v.actions.map((a, i) => {
        const row = h('div', { class: 'row', style: { alignItems: 'stretch' } }, sel(Object.entries(data.actions), a.type, x => { v.actions[i] = { ...ACTION_DEFAULTS[x] }; paint(); }, 'grow'));
        if (a.type === 'notify') row.append(sel([['assignee', 'the assignee'], ['reporter', 'the reporter'], ['leads', 'team leads'], ...state.users.map(u => [u.id, u.name])], a.to, x => (a.to = x), 'grow'), h('input', { class: 'input grow', placeholder: 'Message ({key}, {title})', value: a.message || '', oninput: e => (a.message = e.target.value) }));
        if (a.type === 'set_status') row.append(sel(state.statuses.map(s => [s.id, s.label]), a.value, x => (a.value = x), 'grow'));
        if (a.type === 'set_priority') row.append(sel(Object.keys(PRIORITY).map(p => [p, p]), a.value, x => (a.value = x), 'grow'));
        if (a.type === 'set_assignee') row.append(sel([['reporter', 'the reporter'], ['unassign', 'nobody'], ...state.users.map(u => [u.id, u.name])], a.value, x => (a.value = x), 'grow'));
        if (a.type === 'add_label' || a.type === 'comment') row.append(h('input', { class: 'input grow', placeholder: a.type === 'comment' ? 'Comment text' : 'label-name', value: a.value || '', oninput: e => (a.value = e.target.value) }));
        row.append(v.actions.length > 1 ? h('button', { class: 'icon-btn', 'aria-label': 'Remove action', onclick: () => { v.actions.splice(i, 1); paint(); } }, icon('x', 16)) : null);
        return row;
      }), h('button', { class: 'btn ghost sm', style: { alignSelf: 'flex-start' }, onclick: () => { v.actions.push({ ...ACTION_DEFAULTS.notify }); paint(); } }, icon('plus', 14), 'Add action')));
  };
  paint();
  modal({ title: rule ? 'Edit rule' : 'New automation rule', width: 640, body, actions: [{ label: 'Cancel' }, { label: 'Save rule', kind: 'primary', onClick: async () => {
    try { rule ? await api.put('/automations/' + rule.id, v) : await api.post('/automations', v); toast('Rule saved', 'success'); done(); } catch (e) { toast(e.message, 'error'); return false; }
  } }] });
}
void projectById;
