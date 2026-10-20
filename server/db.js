import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'taskboard.db'));

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT,
  title TEXT DEFAULT '',
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  phone_code TEXT,
  phone_code_exp INTEGER,
  prefs TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  invite_token TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  estimate REAL,
  labels TEXT NOT NULL DEFAULT '[]',
  position REAL NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW}),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  project_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  task_id INTEGER,
  project_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, id);
CREATE TABLE IF NOT EXISTS integrations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}',
  actions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  runs INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  channel TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS sent_reminders (key TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS processed_emails (
  user_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  task_id INTEGER,
  PRIMARY KEY (user_id, message_id)
);
`);

const cache = new Map();
const stmt = sql => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
const norm = p => p.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));

export const all = (sql, ...p) => stmt(sql).all(...norm(p));
export const get = (sql, ...p) => stmt(sql).get(...norm(p));
export const run = (sql, ...p) => stmt(sql).run(...norm(p));
export const insert = (sql, ...p) => Number(stmt(sql).run(...norm(p)).lastInsertRowid);

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { txDepth--; }
}

// ---- settings: env vars win over values stored in the database ----
export const SETTING_KEYS = [
  'workspace_name', 'base_url',
  'google_client_id', 'google_client_secret',
  'twilio_account_sid', 'twilio_auth_token', 'twilio_from', 'twilio_whatsapp_from',
  'anthropic_api_key', 'anthropic_model',
];
export const SECRET_KEYS = new Set(['google_client_secret', 'twilio_auth_token', 'anthropic_api_key']);

export function getSetting(key) {
  const env = process.env[key.toUpperCase()];
  if (env) return env;
  return get('SELECT value FROM settings WHERE key=?', key)?.value || '';
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
}

export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
export const nowISO = () => new Date().toISOString();
