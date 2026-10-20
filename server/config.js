import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PORT = Number(process.env.PORT || 3000);
export const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Signing secret for sessions; generated once and persisted unless provided.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.secret');
  try { return fs.readFileSync(file, 'utf8'); } catch { /* first run */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
export const SECRET = loadSecret();

export const STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'done', label: 'Done' },
];
export const STATUS_IDS = STATUSES.map(s => s.id);
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const ORG_ROLES = ['admin', 'manager', 'member', 'viewer'];
