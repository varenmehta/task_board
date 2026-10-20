// Background automation: due-date reminders, daily briefings, inbound Gmail -> tasks.
import { all, get, run, parseJSON } from './db.js';
import { bus } from './events.js';
import { todayStr, addDays, esc } from './util.js';
import { notify, getPrefs } from './notifications.js';
import { sendEmail, sendPhone, emailHtml, pruneOutbox } from './delivery.js';
import { listAssigned, getTask, createTask } from './tasks.js';
import { projectMembers, visibleProjects } from './access.js';
import { googleConfigured, getIntegration, fetchLabelledEmails, markRead, fetchReplyCandidates, senderUserId } from './channels/google.js';
import { applyReply } from './emailreply.js';
import { briefingBlurb, emailToTask, stakeholderDigest, localRisks } from './ai.js';
import { listProjectTasks } from './tasks.js';
import { mdToHtml } from './util.js';
import { getSetting } from './db.js';
import { runRecurrences } from './recurring.js';
import { snapshotActiveSprints } from './planning.js';

const once = key => {
  if (get('SELECT 1 FROM sent_reminders WHERE key=?', key)) return false;
  run('INSERT INTO sent_reminders(key) VALUES(?)', key);
  return true;
};

export function runReminders(today = todayStr()) {
  const tasks = all(`SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status<>'done' AND t.due_date IS NOT NULL AND t.due_date<=? AND p.archived=0`, addDays(today, 1));
  let sent = 0;
  for (const { id } of tasks) {
    const task = getTask(id);
    const isOver = task.due_date < today;
    const kind = isOver ? 'overdue' : 'due_soon';
    if (!once(`${kind}:${id}:${task.due_date}`)) continue;
    if (task.assignee_id) {
      notify(task.assignee_id, 'due', {
        title: isOver ? `Overdue: ${task.key} ${task.title}` : `Due ${task.due_date === today ? 'today' : 'tomorrow'}: ${task.key} ${task.title}`,
        body: `Priority ${task.priority}. ${isOver ? 'Was due ' + task.due_date + '.' : ''}`, task,
      });
    }
    bus.emit('task.due', { task, kind });
    sent++;
  }
  return sent;
}

function localHour(user, now) {
  const p = getPrefs(user);
  const d = new Date(now.getTime() - p.tz_offset * 60_000);
  return { hour: d.getUTCHours(), date: d.toISOString().slice(0, 10), dow: d.getUTCDay(), prefs: p };
}

export async function buildDigest(user, today) {
  const mine = listAssigned(user.id).filter(t => t.status !== 'done');
  const overdue = mine.filter(t => t.due_date && t.due_date < today);
  const dueToday = mine.filter(t => t.due_date === today);
  const soon = mine.filter(t => t.due_date && t.due_date > today && t.due_date <= addDays(today, 3));
  const doing = mine.filter(t => t.status === 'in_progress' && !overdue.includes(t) && !dueToday.includes(t));
  const blurb = await briefingBlurb({ user, mine, today });
  const section = (title, list) => list.length ? `${title} (${list.length})\n` + list.slice(0, 8).map(t => `  • ${t.key} ${t.title}${t.due_date ? ` — ${t.due_date}` : ''}`).join('\n') + '\n\n' : '';
  const text = `${blurb ? blurb + '\n\n' : ''}${section('Overdue', overdue)}${section('Due today', dueToday)}${section('Coming up', soon)}${section('In progress', doing)}` || 'Nothing on your plate today. Enjoy! 🎉';
  const li = list => list.slice(0, 8).map(t => `<li><b>${esc(t.key)}</b> ${esc(t.title)}${t.due_date ? ` <span style="color:#8b90a0">— ${esc(t.due_date)}</span>` : ''}</li>`).join('');
  const html = (blurb ? `<p>${esc(blurb)}</p>` : '') + [['Overdue', overdue, '#dc2626'], ['Due today', dueToday, '#d97706'], ['Coming up', soon, '#4f46e5'], ['In progress', doing, '#0891b2']]
    .filter(([, l]) => l.length).map(([t, l, c]) => `<h3 style="color:${c};margin:18px 0 6px;font-size:14px">${t} (${l.length})</h3><ul style="margin:0;padding-left:20px">${li(l)}</ul>`).join('') || '<p>Nothing on your plate today. 🎉</p>';
  return { text, html, count: mine.length, empty: !mine.length };
}

export async function runDigests(now = new Date()) {
  const users = all('SELECT * FROM users WHERE active=1');
  let n = 0;
  for (const u of users) {
    const { hour, date, dow, prefs } = localHour(u, now);
    const m = prefs.matrix.digest;
    if (!(m.email || m.phone || m.app) || hour !== Number(prefs.digest_hour)) continue;
    if (prefs.digest_weekdays_only && (dow === 0 || dow === 6)) continue;
    if (!once(`digest:${u.id}:${date}`)) continue;
    const d = await buildDigest(u, date);
    if (d.empty) continue;
    const title = `Your TaskBoard briefing — ${date}`;
    const base = getSetting('base_url') || `http://localhost:${process.env.PORT || 3000}`;
    if (m.email) await sendEmail({ userId: u.id, to: u.email, subject: title, text: d.text, html: emailHtml({ heading: 'Good morning, ' + u.name.split(' ')[0] + ' ☀️', body: d.html, ctaText: 'Open my tasks', ctaUrl: base + '/#/my-tasks' }) });
    if (m.phone && u.phone && u.phone_verified) await sendPhone({ userId: u.id, to: u.phone, kind: prefs.phone_channel, text: `${title}\n${d.text.slice(0, 600)}` });
    if (m.app) notify(u.id, 'digest', { title, body: d.text.slice(0, 400) });
    n++;
  }
  return n;
}

export async function pollInbox() {
  if (!googleConfigured()) return 0;
  let created = 0;
  const users = all(`SELECT u.* FROM users u JOIN integrations i ON i.user_id=u.id AND i.provider='google' WHERE u.active=1`);
  for (const u of users) {
    const prefs = getPrefs(u);
    if (!prefs.email_to_task || !getIntegration(u.id)?.refresh_token) continue;
    try {
      const projects = visibleProjects(u);
      const project = projects.find(p => p.id === prefs.default_project_id) || projects[0];
      if (!project || u.role === 'viewer') continue;
      const members = projectMembers(project);
      for (const mail of await fetchLabelledEmails(u.id)) {
        if (get('SELECT 1 FROM processed_emails WHERE user_id=? AND message_id=?', u.id, mail.id)) { await markRead(u.id, mail.id); continue; }
        const draft = await emailToTask(mail, { members, today: todayStr() });
        const task = createTask(u, project.id, { ...draft, assignee_id: draft.assignee_id ?? u.id, status: 'todo' }, { source: 'email' });
        run('INSERT INTO processed_emails(user_id,message_id,task_id) VALUES(?,?,?)', u.id, mail.id, task.id);
        await markRead(u.id, mail.id);
        notify(u.id, 'assigned', { title: `📧 Email became task ${task.key}`, body: task.title, task });
        created++;
      }
    } catch (e) { console.error(`[inbox ${u.email}]`, e.message); }
  }
  return created;
}

// Monday-morning (UTC) AI-written project update for stakeholders listed on the project.
export async function sendProjectDigest(project, { force = false } = {}) {
  const emails = parseJSON(project.digest_emails, []);
  if (!emails.length) return { sent: 0 };
  const today = todayStr(), weekAgo = addDays(today, -7);
  const tasks = listProjectTasks(project.id);
  const members = projectMembers(project);
  const d = await stakeholderDigest({
    project,
    done: tasks.filter(t => t.status === 'done' && t.completed_at && t.completed_at.slice(0, 10) >= weekAgo),
    inProgress: tasks.filter(t => t.status_category === 'doing'),
    upcoming: tasks.filter(t => t.status !== 'done' && t.due_date && t.due_date >= today && t.due_date <= addDays(today, 14)).sort((a, b) => a.due_date.localeCompare(b.due_date)),
    risks: localRisks({ tasks, members, today }),
  });
  let sent = 0;
  for (const to of emails) {
    const r = await sendEmail({ to, subject: `${project.name} — weekly update (${today})`, text: d.text.replace(/[*#]/g, ''), html: emailHtml({ heading: `${project.name} — weekly update`, body: mdToHtml(d.text) }) });
    if (r !== 'skipped') sent++;
  }
  void force;
  return { sent, text: d.text };
}
export async function runWeeklyDigests(now = new Date()) {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 9) return 0;
  let n = 0;
  for (const p of all("SELECT * FROM projects WHERE archived=0 AND digest_emails<>'[]'")) {
    if (!once(`weekly:${p.id}:${now.toISOString().slice(0, 10)}`)) continue;
    await sendProjectDigest(p); n++;
  }
  return n;
}

// Replies to notification emails land in the workspace sender's inbox; turn them into comments.
export async function pollReplies() {
  const sender = googleConfigured() ? senderUserId() : null;
  if (!sender) return 0;
  let n = 0;
  try {
    for (const mail of await fetchReplyCandidates(sender)) {
      if (get('SELECT 1 FROM processed_emails WHERE user_id=? AND message_id=?', sender, mail.id)) { await markRead(sender, mail.id); continue; }
      const r = applyReply(mail);
      run('INSERT OR IGNORE INTO processed_emails(user_id,message_id,task_id) VALUES(?,?,NULL)', sender, mail.id);
      if (r.ok) n++;
      await markRead(sender, mail.id);
    }
  } catch (e) { console.error('[replies]', e.message); }
  return n;
}

export function startScheduler() {
  let tick = 0;
  const safe = (name, fn) => Promise.resolve().then(fn).catch(e => console.error(`[scheduler:${name}]`, e.message));
  const loop = () => {
    tick++;
    safe('reminders', () => (tick % 5 === 1 ? runReminders() : 0));
    safe('digests', () => runDigests());
    safe('inbox', () => (tick % 2 === 0 ? pollInbox() : 0));
    safe('replies', () => (tick % 2 === 1 ? pollReplies() : 0));
    safe('weekly', () => (tick % 10 === 3 ? runWeeklyDigests() : 0));
    safe('recurring', () => (tick % 5 === 2 ? runRecurrences() : 0));
    if (tick % 60 === 0) { safe('prune', pruneOutbox); safe('snapshots', snapshotActiveSprints); }
  };
  setTimeout(loop, 5_000).unref();
  setInterval(loop, 60_000).unref();
}
