import { all, get, run, insert, parseJSON, getSetting } from './db.js';
import { bus, pushTo, flags } from './events.js';
import { sendEmail, sendPhone, emailHtml } from './delivery.js';
import { handleOf, esc, clip } from './util.js';
import { teamLeads } from './access.js';

// Which events notify through which channel (users can change this in Settings).
export const EVENTS = {
  assigned: 'A task is assigned to me',
  mention: 'I am @mentioned',
  comment: 'Someone comments on my task',
  status: 'Status changes on tasks I own or reported',
  due: 'Due soon / overdue reminders',
  digest: 'Daily briefing',
};

export const DEFAULT_PREFS = {
  matrix: {
    assigned: { app: true, email: true, phone: true },
    mention: { app: true, email: true, phone: true },
    comment: { app: true, email: false, phone: false },
    status: { app: true, email: false, phone: false },
    due: { app: true, email: true, phone: true },
    digest: { app: false, email: true, phone: false },
  },
  phone_channel: 'sms',
  phone_urgent_only: true,
  digest_hour: 9,
  digest_weekdays_only: true,
  tz_offset: 0, // minutes behind UTC as given by Date#getTimezoneOffset()
  email_to_task: true,
  default_project_id: null,
};

export function getPrefs(user) {
  const saved = parseJSON(user.prefs, {});
  const matrix = { ...DEFAULT_PREFS.matrix };
  for (const k of Object.keys(matrix)) matrix[k] = { ...matrix[k], ...(saved.matrix?.[k] || {}) };
  return { ...DEFAULT_PREFS, ...saved, matrix };
}

export function mentionedUsers(text, projectUsers) {
  const handles = new Set([...String(text).matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)].map(m => m[1].toLowerCase().replace(/[._-]+$/, '')));
  return projectUsers.filter(u => handles.has(handleOf(u.name)));
}

const appUrl = path => `${getSetting('base_url') || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`}${path}`;

/**
 * Deliver one notification to one user across in-app / email / phone.
 * opts: { title, body, task, link, cta }
 */
export function notify(userId, event, opts) {
  if (flags.quiet) return;
  const user = get('SELECT * FROM users WHERE id=? AND active=1', userId);
  if (!user) return;
  const prefs = getPrefs(user);
  const m = prefs.matrix[event] || { app: true };
  const task = opts.task;
  const link = opts.link || (task ? `/#/task/${task.id}` : '/#/inbox');

  if (m.app) {
    const id = insert('INSERT INTO notifications(user_id,type,title,body,task_id,project_id) VALUES(?,?,?,?,?,?)',
      userId, event, opts.title, opts.body || '', task?.id ?? null, task?.project_id ?? null);
    pushTo([userId], 'notification', { id, type: event, title: opts.title, body: opts.body || '', task_id: task?.id ?? null });
  }
  if (m.email && user.email) {
    const text = `${opts.title}\n\n${opts.body || ''}\n\n${appUrl(link)}`;
    sendEmail({
      userId, to: user.email, subject: opts.title, text,
      html: emailHtml({ heading: opts.title, body: esc(opts.body || '').replace(/\n/g, '<br>'), ctaText: opts.cta || 'Open task', ctaUrl: appUrl(link) }),
    });
  }
  const urgent = !task || ['urgent', 'high'].includes(task.priority) || event === 'mention';
  if (m.phone && user.phone && user.phone_verified && (!prefs.phone_urgent_only || urgent)) {
    sendPhone({ userId, to: user.phone, kind: prefs.phone_channel, text: `${opts.title}${opts.body ? ' — ' + clip(opts.body, 120) : ''}${task ? `\nReply "done ${task.key}" to complete.` : ''}` });
  }
}

const label = t => `${t.key} ${t.title}`;
const name = u => u?.name ?? 'Someone';

bus.on('task.created', ({ task, actor }) => {
  if (task.assignee_id && task.assignee_id !== actor?.id)
    notify(task.assignee_id, 'assigned', { title: `${name(actor)} assigned you ${label(task)}`, body: clip(task.description, 200), task });
});

bus.on('task.updated', ({ task, changes, actor }) => {
  if (changes.assignee_id && task.assignee_id && task.assignee_id !== actor?.id)
    notify(task.assignee_id, 'assigned', { title: `${actor ? name(actor) : 'Automation'} assigned you ${label(task)}`, body: clip(task.description, 200), task });
  if (changes.status) {
    const [, to] = changes.status;
    const label2 = { in_progress: 'In progress', todo: 'To do', backlog: 'Backlog', review: 'In review', done: 'Done' }[to] || to;
    for (const uid of new Set([task.assignee_id, task.reporter_id])) {
      if (uid && uid !== actor?.id) notify(uid, 'status', { title: `${label(task)} moved to ${label2}`, body: actor ? `by ${actor.name}` : 'by automation', task });
    }
  }
});

bus.on('comment.added', ({ task, comment, actor }) => {
  const users = all('SELECT * FROM users WHERE active=1');
  const mentioned = mentionedUsers(comment.body, users).filter(u => u.id !== actor?.id);
  for (const u of mentioned) notify(u.id, 'mention', { title: `${name(actor)} mentioned you on ${label(task)}`, body: clip(comment.body, 240), task });
  const skip = new Set([actor?.id, ...mentioned.map(u => u.id)]);
  for (const uid of new Set([task.assignee_id, task.reporter_id])) {
    if (uid && !skip.has(uid)) notify(uid, 'comment', { title: `${name(actor)} commented on ${label(task)}`, body: clip(comment.body, 240), task });
  }
});

export function notifyLeads(task, title, body) {
  const proj = get('SELECT team_id FROM projects WHERE id=?', task.project_id);
  for (const l of teamLeads(proj.team_id)) notify(l.id, 'due', { title, body, task });
}

export const unreadCount = uid => get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read=0', uid).n;
export const markAllRead = uid => run('UPDATE notifications SET read=1 WHERE user_id=?', uid);
