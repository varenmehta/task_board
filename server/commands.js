// Two-way phone control: text the bot "list", "done TB-12", "add fix login bug tomorrow".
import { all, get } from './db.js';
import { listAssigned, updateTask, createTask, getTask, addComment, getProject } from './tasks.js';
import { startedStatus, reviewStatus, defaultStatus, statusIds } from './statuses.js';
import { visibleProjects, projectMembers } from './access.js';
import { localParseTask, parseTask } from './ai.js';
import { getPrefs } from './notifications.js';
import { todayStr, clip } from './util.js';

const HELP = `TaskBoard commands:
list — your open tasks
done TB-12 — complete a task
start TB-12 — move to In progress
comment TB-12 text — add a comment
add <text> — create a task (e.g. add fix login bug tomorrow !high)
help`;

function findTask(user, key) {
  const m = String(key || '').toUpperCase().match(/^([A-Z0-9]+)-(\d+)$/);
  if (!m) return null;
  const t = get(`SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.key=? AND t.number=?`, m[1], Number(m[2]));
  if (!t) return null;
  const task = getTask(t.id);
  return visibleProjects(user).some(p => p.id === task.project_id) ? task : null;
}

export async function handleCommand(user, raw) {
  const text = String(raw || '').trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const verb = (cmd || '').toLowerCase();
  const today = todayStr();
  try {
    if (!verb || verb === 'help' || verb === '?') return HELP;

    if (['list', 'tasks', 'my', 'today'].includes(verb)) {
      const mine = listAssigned(user.id).filter(t => t.status !== 'done');
      if (!mine.length) return 'You have no open tasks 🎉';
      return `Your open tasks (${mine.length}):\n` + mine.slice(0, 10).map(t => `${t.key} ${clip(t.title, 50)}${t.due_date ? ` · ${t.due_date < today ? 'OVERDUE ' : 'due '}${t.due_date}` : ''}`).join('\n');
    }

    if (['done', 'finish', 'complete', 'start', 'review', 'todo'].includes(verb)) {
      const task = findTask(user, rest[0]);
      if (!task) return `I couldn't find task "${rest[0] || ''}". Try "list".`;
      const proj = getProject(task.project_id);
      const status = { done: 'done', finish: 'done', complete: 'done', start: startedStatus(proj), review: reviewStatus(proj), todo: defaultStatus(proj) }[verb];
      if (!status || !statusIds(proj).includes(status)) return `${task.project_name} has no “${verb}” column.`;
      const updated = updateTask(user, task.id, { status });
      return `✅ ${task.key} → ${updated.status_label}`;
    }

    if (verb === 'comment' || verb === 'note') {
      const task = findTask(user, rest[0]);
      if (!task || !rest[1]) return 'Usage: comment TB-12 your note';
      addComment(user, task.id, rest.slice(1).join(' '));
      return `💬 Added to ${task.key}`;
    }

    if (['add', 'new', 'create'].includes(verb)) {
      const body = rest.join(' ');
      if (!body) return 'Usage: add <task description>';
      const projects = visibleProjects(user);
      const pid = getPrefs(user).default_project_id;
      const project = projects.find(p => p.id === pid) || projects[0];
      if (!project) return 'You are not in any project yet.';
      const members = projectMembers(project);
      const draft = await parseTask(body, { members, today });
      const task = createTask(user, project.id, { ...draft, assignee_id: draft.assignee_id ?? user.id }, { source: 'phone' });
      return `✅ Created ${task.key} in ${project.name}: ${clip(task.title, 60)}${task.due_date ? ` (due ${task.due_date})` : ''}`;
    }
    return `I didn't understand that.\n\n${HELP}`;
  } catch (e) {
    return `⚠️ ${e.message}`;
  }
}
