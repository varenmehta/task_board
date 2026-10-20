// Auto-triage: new, unprioritised tasks in opted-in projects get a suggested priority/labels/owner and an explanatory comment.
import { all } from './db.js';
import { bus } from './events.js';
import { getProject, updateTask, addComment } from './tasks.js';
import { projectMembers } from './access.js';
import { triage } from './ai.js';
import { todayStr } from './util.js';

bus.on('task.created', ({ task }) => {
  const project = getProject(task.project_id);
  if (!project?.auto_triage || ['seed', 'recurring', 'template', 'triage'].includes(task.source) || task.parent_id) return;
  if (task.priority !== 'medium' || task.labels.length || task.assignee_id) return; // the author already decided something
  setImmediate(async () => {
    try {
      const members = projectMembers(project);
      const workload = Object.fromEntries(all(`SELECT assignee_id a, COUNT(*) n FROM tasks WHERE status<>'done' AND assignee_id IS NOT NULL GROUP BY assignee_id`).map(r => [r.a, r.n]));
      const t = await triage(task, { members, workload, today: todayStr() });
      const patch = {};
      if (t.priority !== task.priority) patch.priority = t.priority;
      if (t.labels?.length) patch.labels = t.labels;
      if (t.type && t.type !== task.type && task.type === 'task') patch.type = t.type;
      if (t.assignee_id) patch.assignee_id = t.assignee_id;
      if (!Object.keys(patch).length) return;
      updateTask(null, task.id, patch, { skipPermission: true });
      const who = members.find(m => m.id === patch.assignee_id)?.name;
      addComment(null, task.id, `🤖 **Auto-triage**${t.ai ? '' : ' (rule-based)'}: ${[patch.priority && `priority → ${patch.priority}`, patch.labels && `labels → ${patch.labels.join(', ')}`, patch.type && `type → ${patch.type}`, who && `assigned to ${who}`].filter(Boolean).join(' · ')}\n${t.reason}`);
    } catch (e) { console.error('[triage]', e.message); }
  });
});
