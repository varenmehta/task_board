import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { seal, open } from './crypto.js';

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

// ---- additive migrations (safe to run on every boot) ----
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('projects', 'statuses', 'TEXT');
addColumn('projects', 'fields', "TEXT NOT NULL DEFAULT '[]'");
addColumn('projects', 'digest_emails', "TEXT NOT NULL DEFAULT '[]'");
addColumn('projects', 'auto_triage', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'start_date', 'TEXT');
addColumn('tasks', 'type', "TEXT NOT NULL DEFAULT 'task'");
addColumn('tasks', 'epic_id', 'INTEGER');
addColumn('tasks', 'sprint_id', 'INTEGER');
addColumn('tasks', 'release_id', 'INTEGER');
addColumn('tasks', 'custom', "TEXT NOT NULL DEFAULT '{}'");
addColumn('users', 'calendar_token', 'TEXT');
addColumn('users', 'slack_id', 'TEXT');
addColumn('users', 'totp_secret', 'TEXT');
addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'totp_last', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'recovery_codes', "TEXT NOT NULL DEFAULT '[]'");

db.exec(`
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, filters TEXT NOT NULL DEFAULT '{}', shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_by INTEGER, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS recurrences (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', schedule TEXT NOT NULL, next_run TEXT NOT NULL,
  assignee_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1, last_task_id INTEGER, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS task_links (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  other_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (task_id, other_id, kind)
);
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, started_at TEXT, seconds INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '', day TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, day);
CREATE TABLE IF NOT EXISTS sprints (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', start_date TEXT, end_date TEXT,
  state TEXT NOT NULL DEFAULT 'planned', closed_at TEXT, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS sprint_snapshots (
  sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE, day TEXT NOT NULL,
  remaining REAL NOT NULL, total REAL NOT NULL, done_tasks INTEGER NOT NULL, total_tasks INTEGER NOT NULL,
  PRIMARY KEY (sprint_id, day)
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'write',
  expires_at TEXT, last_used TEXT, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]',
  format TEXT NOT NULL DEFAULT 'json', active INTEGER NOT NULL DEFAULT 1, fail_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL, status TEXT NOT NULL, code INTEGER, error TEXT, attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS incoming_hooks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL, secret TEXT,
  created_by INTEGER, last_used TEXT, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS hook_fingerprints (
  hook_id INTEGER NOT NULL REFERENCES incoming_hooks(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, occurrences INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (hook_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS task_prs (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', updated_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (task_id, provider, repo, number)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL, end_date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'vacation', note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ua TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (${NOW}), last_seen TEXT NOT NULL DEFAULT (${NOW}), revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', date TEXT, state TEXT NOT NULL DEFAULT 'planned',
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (${NOW})
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
  'google_login', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret', 'sso_label', 'sso_allowed_domains', 'sso_default_role',
  'slack_signing_secret', 'slack_bot_token', 'vapid_public', 'vapid_private',
];
export const SECRET_KEYS = new Set(['google_client_secret', 'twilio_auth_token', 'anthropic_api_key', 'oidc_client_secret', 'slack_signing_secret', 'slack_bot_token', 'vapid_private']);
// settings that the UI form must never overwrite (managed internally)
export const INTERNAL_KEYS = new Set(['vapid_public', 'vapid_private']);

export function getSetting(key) {
  const env = process.env[key.toUpperCase()];
  if (env) return env;
  const v = get('SELECT value FROM settings WHERE key=?', key)?.value || '';
  return SECRET_KEYS.has(key) ? open(v) : v;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, SECRET_KEYS.has(key) ? seal(value) : value);
}

export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
export const nowISO = () => new Date().toISOString();
