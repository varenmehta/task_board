// SQLite online backups (VACUUM INTO is safe while the server is running) with retention.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './db.js';
import { bad, notFound } from './util.js';

const DIR = path.join(DATA_DIR, 'backups');
const NAME = /^taskboard-\d{8}-\d{6}\.db$/;
const KEEP = Number(process.env.BACKUP_KEEP || 7);

export function backupNow() {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(DIR, `taskboard-${stamp}.db`);
  if (fs.existsSync(file)) return path.basename(file);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = listBackups();
  for (const old of all.slice(KEEP)) fs.rmSync(path.join(DIR, old.name), { force: true });
  return path.basename(file);
}
export function listBackups() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(n => NAME.test(n)).sort().reverse().map(name => { const st = fs.statSync(path.join(DIR, name)); return { name, size: st.size, created_at: st.mtime.toISOString() }; });
}
export function backupPath(name) {
  if (!NAME.test(String(name))) throw bad('Invalid backup name');
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) throw notFound('Backup not found');
  return p;
}
export const backupDue = () => { const l = listBackups()[0]; return !l || Date.now() - new Date(l.created_at).getTime() > 23 * 3600 * 1000; };
