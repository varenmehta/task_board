import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { all, get, run, insert } from './db.js';
import { bad, forbidden, notFound } from './util.js';
import { canEditProject, canViewProject } from './access.js';
import { getTask, getProject, logActivity } from './tasks.js';

export const MAX_BYTES = 15 * 1024 * 1024;
const DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(DIR, { recursive: true });

// types the browser may render inline; everything else is forced to download
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

const safeName = n => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';

export function saveAttachment(actor, taskId, buffer, { name, mime }) {
  const task = getTask(taskId);
  if (!task) throw notFound('Task not found');
  if (!canEditProject(actor, getProject(task.project_id))) throw forbidden();
  if (!buffer?.length) throw bad('Empty file');
  if (buffer.length > MAX_BYTES) throw bad('Files can be at most 15 MB');
  if (get('SELECT COUNT(*) n FROM attachments WHERE task_id=?', taskId).n >= 25) throw bad('A task can have at most 25 attachments');
  const file = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(DIR, file), buffer);
  const id = insert('INSERT INTO attachments(task_id,user_id,name,mime,size,path) VALUES(?,?,?,?,?,?)', taskId, actor.id, safeName(name), String(mime || 'application/octet-stream').slice(0, 100), buffer.length, file);
  logActivity(task, actor.id, 'attached', { name: safeName(name) });
  return get('SELECT id,name,mime,size,user_id,created_at FROM attachments WHERE id=?', id);
}

export function openAttachment(actor, id) {
  const a = get('SELECT * FROM attachments WHERE id=?', id);
  if (!a) throw notFound('Attachment not found');
  const task = getTask(a.task_id);
  if (!canViewProject(actor, getProject(task.project_id))) throw forbidden();
  const inline = INLINE.has(a.mime);
  return {
    stream: fs.createReadStream(path.join(DIR, a.path)),
    headers: {
      'Content-Type': inline ? a.mime : 'application/octet-stream',
      'Content-Length': a.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    },
  };
}

export function deleteAttachment(actor, id) {
  const a = get('SELECT * FROM attachments WHERE id=?', id);
  if (!a) throw notFound('Attachment not found');
  const task = getTask(a.task_id);
  if (!canEditProject(actor, getProject(task.project_id))) throw forbidden();
  run('DELETE FROM attachments WHERE id=?', id);
  fs.rmSync(path.join(DIR, a.path), { force: true });
}
void all;
