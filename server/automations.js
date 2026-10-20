// No-code rules: WHEN <trigger> [IF conditions] THEN <actions>.
import { all, get, run, parseJSON } from './db.js';
import { bus } from './events.js';
import { updateTask, addComment, getTask } from './tasks.js';
import { notify, notifyLeads } from './notifications.js';
import { teamLeads } from './access.js';

export const TRIGGERS = {
  task_created: 'A task is created',
  status_changed: 'Status changes',
  assigned: 'A task is assigned',
  priority_changed: 'Priority changes',
  comment_added: 'A comment is added',
  due_soon: 'A task is due within 24h',
  overdue: 'A task becomes overdue',
};
export const ACTIONS = {
  notify: 'Send a notification',
  set_status: 'Set status',
  set_priority: 'Set priority',
  set_assignee: 'Assign to',
  add_label: 'Add label',
  comment: 'Post a comment',
};

let depth = 0; // guards against rules triggering each other forever

function matches(rule, ctx) {
  const c = parseJSON(rule.conditions, {});
  const { task } = ctx;
  if (rule.project_id && rule.project_id !== task.project_id) return false;
  if (c.status && c.status !== task.status) return false;
  if (c.priority && c.priority !== task.priority) return false;
  if (c.label && !task.labels.includes(String(c.label).toLowerCase())) return false;
  if (c.to_status && ctx.changes?.status?.[1] !== c.to_status) return false;
  if (c.unassigned && task.assignee_id) return false;
  return true;
}

function recipients(spec, task) {
  if (spec === 'assignee') return task.assignee_id ? [task.assignee_id] : [];
  if (spec === 'reporter') return task.reporter_id ? [task.reporter_id] : [];
  if (spec === 'leads') return teamLeads(task.team_id).map(u => u.id);
  if (/^\d+$/.test(String(spec))) return [Number(spec)];
  return [];
}

const fill = (s, task) => String(s || '').replaceAll('{key}', task.key).replaceAll('{title}', task.title).replaceAll('{status}', task.status).replaceAll('{priority}', task.priority);

function execute(rule, ctx) {
  let task = getTask(ctx.task.id);
  for (const a of parseJSON(rule.actions, [])) {
    if (!task) return;
    switch (a.type) {
      case 'notify':
        for (const uid of recipients(a.to, task))
          notify(uid, 'due', { title: fill(a.message || `Automation: ${rule.name}`, task), body: `${task.key} · ${task.title}`, task });
        break;
      case 'set_status': task = updateTask(null, task.id, { status: a.value }); break;
      case 'set_priority': task = updateTask(null, task.id, { priority: a.value }); break;
      case 'set_assignee': {
        const v = a.value === 'reporter' ? task.reporter_id : a.value === 'unassign' ? null : Number(a.value) || null;
        task = updateTask(null, task.id, { assignee_id: v });
        break;
      }
      case 'add_label': task = updateTask(null, task.id, { labels: [...new Set([...task.labels, String(a.value).toLowerCase()])] }); break;
      case 'comment': addComment(null, task.id, `🤖 ${fill(a.value, task)}`); break;
    }
  }
}

export function fire(trigger, ctx) {
  if (depth >= 3) return;
  const rules = all('SELECT * FROM automations WHERE enabled=1 AND trigger=?', trigger);
  depth++;
  try {
    for (const rule of rules) {
      try {
        if (!matches(rule, ctx)) continue;
        execute(rule, ctx);
        run('UPDATE automations SET runs=runs+1 WHERE id=?', rule.id);
      } catch (e) { console.error(`[automation ${rule.id}]`, e.message); }
    }
  } finally { depth--; }
}

bus.on('task.created', ctx => fire('task_created', ctx));
bus.on('task.updated', ctx => {
  if (ctx.changes.status) fire('status_changed', ctx);
  if (ctx.changes.assignee_id) fire('assigned', ctx);
  if (ctx.changes.priority) fire('priority_changed', ctx);
});
bus.on('comment.added', ctx => fire('comment_added', ctx));
bus.on('task.due', ({ task, kind }) => fire(kind, { task, changes: {} }));

export function validateRule(r) {
  if (!TRIGGERS[r.trigger]) throw new Error('Unknown trigger');
  if (!Array.isArray(r.actions) || !r.actions.length) throw new Error('Add at least one action');
  for (const a of r.actions) if (!ACTIONS[a.type]) throw new Error('Unknown action');
}

export function seedDefaultRules(createdBy) {
  if (get('SELECT 1 FROM automations LIMIT 1')) return;
  const add = (name, trigger, conditions, actions, enabled = 1) =>
    run('INSERT INTO automations(name,trigger,conditions,actions,enabled,created_by) VALUES(?,?,?,?,?,?)', name, trigger, JSON.stringify(conditions), JSON.stringify(actions), enabled, createdBy);
  add('Start work when assigned', 'assigned', { status: 'todo' }, [{ type: 'set_status', value: 'in_progress' }]);
  add('Escalate overdue tasks to team leads', 'overdue', {}, [
    { type: 'notify', to: 'leads', message: '⏰ {key} is overdue' },
    { type: 'add_label', value: 'overdue' },
  ]);
  add('Ping assignee when work is due within 24h', 'due_soon', {}, [{ type: 'notify', to: 'assignee', message: '📅 {key} is due soon' }]);
  add('Tell the reporter when work lands in review', 'status_changed', { to_status: 'review' }, [{ type: 'notify', to: 'reporter', message: '👀 {key} is ready for review' }], 1);
  add('Bump priority of urgent-labelled bugs', 'task_created', { label: 'bug' }, [{ type: 'set_priority', value: 'high' }], 0);
}
