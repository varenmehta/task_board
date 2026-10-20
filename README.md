# TaskBoard

An automated, AI-assisted work-management platform for software organisations running **many projects across many teams with different roles**. Zero runtime dependencies — just Node 22.

```bash
npm start            # → http://localhost:3000
npm test             # 56 API/security tests (node:test)
npm run backup       # consistent copy of the database → data/backups
```

First visit shows a setup screen: create your admin account and (optionally) load sample data — two teams, four projects, ~20 tasks and teammates you can sign in as (`priya@…` manager, `marcus@…` engineer, `dana@…` viewer — all `@demo.taskboard.dev`, password `demo1234`).

## Features

### Work
Kanban board (drag & drop, edge auto-scroll, live updates over SSE) · sortable list with inline-editable cells · **calendar** (drag to reschedule) · **timeline/Gantt** (drag to shift, resize to change due date) · **custom columns per project with WIP limits** · task types (task/bug/story/epic) · subtasks · **dependencies** ("blocked by", cycle-safe) · **custom fields** (text/number/select/date/checkbox) · labels · estimates · **time tracking** (timer + manual log) · **attachments** (upload, drag-drop, paste screenshots) · comments with `@mention` autocomplete · activity history · **bulk actions** (⌘/Ctrl-click or Space to select) · **saved & shared views** · **task templates & recurring tasks** · global search · **command palette (⌘K)** and keyboard shortcuts (`?` lists them) · light/dark themes · installable PWA that **works offline for recently viewed boards**.

### Planning & reporting
**Sprints** with backlog planning, burndown (scope-creep aware) and velocity · **epics & roadmap** · **releases** with generated release notes · **capacity & time-off** planning · **reports** (throughput, cycle time, aging, workload, time logged) with CSV export (formula-injection safe) · dashboards scoped to all teams / one team / one person.

### Teams, roles & access
Org roles **Admin / Manager / Member / Viewer / Guest** · team roles (Lead/Member) · **per-project roles** (manager/editor/commenter/viewer) that can restrict a teammate or grant a client access to one project · guests only see projects they're invited to and the people on them · invite links · **audit log** · **two-step verification (TOTP + recovery codes)** · **session management** (see devices, sign out everywhere) · OIDC **single sign-on** (Okta, Entra ID, Auth0, Keycloak, Google…) with domain-based auto-provisioning · API tokens.

### Automation & integrations
No-code **automation rules** · due-date reminders, daily briefing, weekly stakeholder digest · **Gmail** (OAuth: notifications, email→task via the `TaskBoard` label, replies to notification emails become comments — only if DKIM/SPF passed) · **SMS / WhatsApp** via Twilio with two-way commands (`list`, `done API-12`, `add …`) · **web push** (RFC 8291, verified against the RFC test vector) · **Slack** slash command + Slack/Teams/JSON **outgoing webhooks** (HMAC-signed, SSRF-guarded, retried, delivery log) · **GitHub / GitLab** (PR opened → In review, merged → Done, commits comment on tasks) · **Sentry / PagerDuty / Datadog / generic incident hooks** (dedupe, acknowledge, auto-resolve) · personal **iCalendar feed** for Google/Apple/Outlook · public REST API with scoped tokens.

### AI (Claude — with offline fallbacks for everything)
Plain English → task · subtask breakdown · description rewrite with acceptance criteria · priority/estimate/owner suggestions **calibrated on how long your past work really took** · **auto-triage** of new tasks (opt-in per project) · **duplicate detection** while typing · **meeting notes → tasks** · **natural-language search** ("urgent bugs Sofia shipped last week") · **sprint planning** against real capacity · risk radar · standups · release notes · chat assistant · **voice input**. Without an Anthropic key, deterministic local versions run instead.

## Connect integrations (Settings → Workspace, admin only)

Everything works out of the box in **simulated** mode: emails/texts are recorded in *Settings → Email, phone & AI → Delivery log*. To go live:

1. **Public URL** — set `BASE_URL`; Google, Twilio, Slack and Git hosts need HTTPS callbacks.
2. **Gmail** — Google Cloud → enable *Gmail API* → OAuth client (Web). Redirect URI: `<BASE_URL>/api/integrations/google/callback`. Scopes `gmail.send`, `gmail.modify`.
3. **Twilio** — Account SID/Auth token/number; incoming-message webhook → `<BASE_URL>/api/webhooks/twilio`.
4. **Anthropic** — `ANTHROPIC_API_KEY` (default model `claude-sonnet-5-5`).
5. **SSO** — issuer URL + client id/secret; redirect URI `<BASE_URL>/api/auth/sso/callback`.
6. **Slack** — slash command `/taskboard` → `<BASE_URL>/api/hooks/slack`; paste the signing secret. For Slack/Teams *notifications*, add an incoming-webhook URL under a project's settings.
7. **GitHub/GitLab/Sentry/PagerDuty/Datadog** — project settings → *Inbound integrations* gives you the URL (and secret) to paste into the other tool. Put the task key (e.g. `API-12`) in the PR title or branch name.

## Deploy
See **[DEPLOY.md](DEPLOY.md)** for step-by-step Fly.io, Render and VPS guides (`fly.toml`, `render.yaml` and `docker-compose.prod.yml` are included). Quick version:
Needs a long-running process (scheduler: reminders, digests, recurring tasks, Gmail polling, backups) and a persistent `DATA_DIR`.

```bash
docker build -t taskboard . && docker run -d -p 3000:3000 -v taskboard-data:/data -e BASE_URL=https://tasks.acme.dev taskboard
```
Terminate TLS in front (Caddy/nginx/Fly/Render) and forward `X-Forwarded-Proto: https` so cookies are `Secure`.
**Back up** `data/backups` (automatic, daily, last 7), plus `data/uploads` and `data/.secret` (decrypts stored OAuth tokens/API keys; keep it separate from the database backups). Restore = stop the server and replace `data/taskboard.db`.

## Security notes
scrypt passwords · signed HttpOnly SameSite cookies backed by revocable server-side sessions · CSRF-safe (JSON-only writes, custom header on uploads) · optional TOTP 2FA (SSO logins rely on the identity provider's MFA) · secrets & OAuth tokens encrypted at rest (AES-256-GCM) · strict CSP · login/2FA/API rate limits · SSRF-guarded outbound requests (address validated at connect time) · uploads served with `nosniff` + sandbox CSP and forced download for anything that isn't an image/PDF/text · role checks on every route (see `tests/`).

## Layout
```
server/   index.js · routes.js (REST) · tasks.js · access.js (roles) · automations · notifications · scheduler
          ai.js · triage.js · planning.js · capacity.js · reports.js · hooks.js · webhooks.js · sso.js · totp.js
          channels/{google,twilio,webpush}.js · safehttp.js · crypto.js · backup.js · seed.js
public/   no-build SPA: js/main.js · js/views/* · js/qr.js (QR generator) · sw.js (offline + push)
tests/    56 tests across 6 files (RFC 6238/8291 vectors included)
```

## What is *not* included
SAML (use OIDC) · Postgres / multi-instance deployment (single SQLite file; use the backups) · native iOS/Android apps (the PWA installs to the home screen) · two-way Google Calendar sync and focus-time blocking (read-only ICS feed instead) · offline *editing* (offline is read-only) · per-project dependency arrows on the timeline · file storage other than local disk. The Gmail, Twilio, Slack, SSO, GitHub and Claude integrations are implemented against their public APIs and unit-tested with local stand-ins, but I could not exercise them against the live services without credentials.
