// Turn email replies to notifications into task comments.
import { get } from './db.js';
import { getTaskByKey, addComment } from './tasks.js';
import { canCommentProject } from './access.js';
import { getProject } from './tasks.js';

const KEY = /\[([A-Za-z][A-Za-z0-9]{1,4}-\d+)\]/;
export const extractKey = subject => (String(subject).match(KEY) || [])[1]?.toUpperCase() || null;
export const parseFromAddress = from => (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();

// Drop quoted history and signatures so only the new text becomes the comment.
export function stripQuoted(body) {
  const lines = String(body).replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^>/.test(l) || /^On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s.+/.test(l) && out.length) break;
    if (/^--\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

// Gmail adds Authentication-Results; only accept mail that passed DKIM or SPF so a forged From: can't comment as someone else.
export const authenticated = header => /\b(dkim|spf)=pass\b/i.test(String(header || ''));

export function applyReply({ subject, from, body, auth }) {
  const key = extractKey(subject);
  if (!key) return { ok: false, reason: 'no task key' };
  if (!authenticated(auth)) return { ok: false, reason: 'sender not authenticated' };
  const user = get('SELECT * FROM users WHERE email=? AND active=1', parseFromAddress(from));
  if (!user) return { ok: false, reason: 'unknown sender' };
  const task = getTaskByKey(key);
  if (!task || !canCommentProject(user, getProject(task.project_id))) return { ok: false, reason: 'no access' };
  const text = stripQuoted(body);
  if (!text) return { ok: false, reason: 'empty' };
  addComment(user, task.id, `${text}\n\n_— via email reply_`);
  return { ok: true, task: key };
}
