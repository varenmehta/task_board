// Optional sample data so a fresh workspace shows what a busy multi-team org looks like.
import { run, insert, get } from './db.js';
import { hashPassword } from './auth.js';
import { pickColor, todayStr, addDays } from './util.js';
import { createTask, addComment } from './tasks.js';
import { flags } from './events.js';

export const DEMO_PASSWORD = 'demo1234';

export function seedDemo(admin) {
  flags.quiet = true;
  try { return seed(admin); } finally { flags.quiet = false; }
}

function seed(admin) {
  const hash = hashPassword(DEMO_PASSWORD);
  const mk = (name, email, role, title, i) => insert('INSERT INTO users(email,name,password_hash,role,color,title) VALUES(?,?,?,?,?,?)', email, name, hash, role, pickColor(i + 2), title);
  const priya = mk('Priya Nair', 'priya@demo.taskboard.dev', 'manager', 'Engineering Manager', 1);
  const marcus = mk('Marcus Lee', 'marcus@demo.taskboard.dev', 'member', 'Senior Backend Engineer', 2);
  const sofia = mk('Sofia Alvarez', 'sofia@demo.taskboard.dev', 'member', 'Frontend Engineer', 3);
  const ken = mk('Ken Watanabe', 'ken@demo.taskboard.dev', 'member', 'Mobile Engineer', 4);
  const amara = mk('Amara Okafor', 'amara@demo.taskboard.dev', 'member', 'SRE', 5);
  const dev = mk('Dana Brooks', 'dana@demo.taskboard.dev', 'viewer', 'Product Designer (view-only)', 6);

  const team = (name, color, desc, members) => {
    const id = insert('INSERT INTO teams(name,color,description) VALUES(?,?,?)', name, color, desc);
    members.forEach(([uid, role]) => run('INSERT OR IGNORE INTO team_members(team_id,user_id,role) VALUES(?,?,?)', id, uid, role));
    return id;
  };
  const platform = team('Platform', '#6366f1', 'APIs, data and infrastructure', [[admin.id, 'lead'], [priya, 'lead'], [marcus, 'member'], [amara, 'member']]);
  const product = team('Product', '#10b981', 'Web and mobile apps', [[priya, 'lead'], [sofia, 'member'], [ken, 'member'], [dev, 'member'], [admin.id, 'member']]);

  const proj = (team_id, key, name, description, color) => insert('INSERT INTO projects(team_id,key,name,description,color) VALUES(?,?,?,?,?)', team_id, key, name, description, color);
  const api = proj(platform, 'API', 'Core API v2', 'Public REST API rebuild with new auth and rate limiting', '#6366f1');
  const infra = proj(platform, 'OPS', 'Reliability & Infra', 'Observability, on-call, and cost', '#f59e0b');
  const web = proj(product, 'WEB', 'Web App', 'Customer-facing dashboard', '#10b981');
  const mob = proj(product, 'MOB', 'Mobile App', 'iOS & Android releases', '#ec4899');

  const t = todayStr();
  const d = n => addDays(t, n);
  const rows = [
    [api, 'Design OAuth2 token refresh flow', 'done', 'high', marcus, d(-6), ['auth', 'design'], 5, 'Rotating refresh tokens with 30 day sliding expiry.'],
    [api, 'Implement rate limiting middleware', 'in_progress', 'high', marcus, d(2), ['backend'], 8, 'Token bucket per API key, configurable per plan.'],
    [api, 'Migrate /v1/users endpoints to new schema', 'review', 'medium', marcus, d(1), ['backend', 'migration'], 6, ''],
    [api, 'Write OpenAPI spec for billing endpoints', 'todo', 'medium', null, d(5), ['docs'], 4, ''],
    [api, 'Fix pagination bug returning duplicate rows', 'in_progress', 'urgent', marcus, d(-1), ['bug'], 3, 'Customers reported duplicates when sorting by created_at.'],
    [api, 'Add idempotency keys for POST /payments', 'backlog', 'high', null, null, ['payments'], 8, ''],
    [api, 'Deprecate v1 webhooks', 'backlog', 'low', null, d(30), ['cleanup'], 2, ''],
    [infra, 'Set up SLO dashboards for API latency', 'in_progress', 'medium', amara, d(3), ['observability'], 6, ''],
    [infra, 'Reduce staging cluster cost by 30%', 'todo', 'medium', amara, d(10), ['cost'], 5, ''],
    [infra, 'Postgres failover drill', 'todo', 'high', amara, d(-2), ['reliability'], 4, 'Overdue — schedule with the DBA team.'],
    [infra, 'Rotate expiring TLS certificates', 'done', 'urgent', amara, d(-3), ['security'], 1, ''],
    [web, 'Redesign onboarding checklist', 'in_progress', 'high', sofia, d(4), ['ui', 'growth'], 10, 'Follow the new design system; track completion events.'],
    [web, 'Dark mode for settings pages', 'todo', 'low', sofia, d(12), ['ui'], 5, ''],
    [web, 'Fix Safari date picker misalignment', 'review', 'medium', sofia, d(0), ['bug', 'ui'], 2, ''],
    [web, 'Accessibility audit of billing flow', 'backlog', 'medium', null, null, ['a11y'], 6, ''],
    [web, 'Instrument funnel analytics events', 'todo', 'high', priya, d(6), ['analytics'], 4, ''],
    [mob, 'Push notification deep links', 'in_progress', 'high', ken, d(3), ['ios', 'android'], 8, ''],
    [mob, 'Crash on launch for Android 12 devices', 'todo', 'urgent', ken, d(0), ['bug', 'android'], 3, 'Spike in Crashlytics since 4.2.1.'],
    [mob, 'Offline mode for task lists', 'backlog', 'medium', null, null, ['feature'], 13, ''],
    [mob, 'Update App Store screenshots', 'done', 'low', ken, d(-8), ['marketing'], 2, ''],
  ];
  const created = [];
  for (const [pid, title, status, priority, assignee, due, labels, estimate, description] of rows) {
    const task = createTask(null, pid, { title, status, priority, assignee_id: assignee, due_date: due, labels, estimate, description, reporter_id: priya }, { source: 'seed' });
    created.push(task);
  }
  // back-date completions so the velocity chart has shape
  const doneIds = created.filter(x => x.status === 'done').map(x => x.id);
  doneIds.forEach((id, i) => run(`UPDATE tasks SET completed_at=?, created_at=? WHERE id=?`, new Date(Date.now() - (i + 1) * 2 * 86400_000).toISOString(), new Date(Date.now() - 12 * 86400_000).toISOString(), id));
  run(`UPDATE tasks SET completed_at=NULL WHERE status<>'done'`);
  const extra = [[0, 3], [1, 2], [4, 1], [7, 2], [11, 1], [13, 4], [3, 5], [8, 2], [15, 1]];
  for (const [i, ago] of extra) {
    const x = created[i];
    if (x) run(`UPDATE tasks SET created_at=? WHERE id=?`, new Date(Date.now() - ago * 86400_000).toISOString(), x.id);
  }
  run(`UPDATE tasks SET updated_at=? WHERE title LIKE 'Set up SLO%'`, new Date(Date.now() - 7 * 86400_000).toISOString());

  const rl = created[1];
  addComment({ id: priya, role: 'manager' }, rl.id, '@marcus.lee can we land this before Thursday\'s release cut? @admin shouldn\'t be blocked on anything here.');
  addComment({ id: marcus, role: 'member' }, rl.id, 'On track — token bucket is done, working on per-plan config now.');
  const sub = createTask(null, api, { title: 'Add Redis-backed counters', parent_id: rl.id, assignee_id: marcus, status: 'done' }, { source: 'seed' });
  createTask(null, api, { title: 'Expose limits in response headers', parent_id: rl.id, assignee_id: marcus, status: 'todo' }, { source: 'seed' });
  createTask(null, api, { title: 'Load-test at 5k rps', parent_id: rl.id, assignee_id: amara, status: 'todo' }, { source: 'seed' });
  run(`UPDATE tasks SET description=? WHERE id=?`, 'Implement a token-bucket limiter keyed by API key.\n\n**Acceptance criteria**\n- [x] Limits configurable per plan\n- [ ] 429 responses include Retry-After\n- [ ] Dashboards show limiter rejections', rl.id);
  // default project preference for email/phone task capture is the first visible project
  return { priya, marcus, sofia, ken, amara, dev };
}
