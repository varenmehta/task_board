# TaskBoard

An automated, AI-assisted task board for software organisations running **multiple projects across multiple teams, with different roles**. Zero dependencies — just Node 22.

```bash
npm start            # → http://localhost:3000
npm test             # API + parser + permission tests
```

First visit shows a setup screen: create your admin account and (optionally) load sample data — two teams, four projects, 20 tasks and teammates you can sign in as (`marcus@demo.taskboard.dev`, `priya@…`, `dana@…`, password `demo1234`) to try the member/manager/viewer roles.

## What's inside

| Area | What you get |
|---|---|
| **Work** | Kanban board with drag & drop (auto-scroll, live updates over SSE), sortable list view with inline-editable cells, task drawer with inline editing of every field, markdown-lite descriptions, subtasks, comments with `@mention` autocomplete, activity history, labels, estimates, due dates, filters, global search (`/` or ⌘K). |
| **Orgs & roles** | Teams own projects. Org roles: **Admin** (everything), **Manager** (create teams/projects, edit automations), **Member** (edit tasks in their teams), **Viewer** (read-only). Team roles: **Lead** / Member. Visibility follows team membership; assignees are validated against it. Invite by email link. |
| **Automations** | No-code rules (*when* a task is created / status changes / assigned / due soon / overdue → *then* notify, set status/priority/assignee, add label, comment). Built-in: due-date reminders, daily briefing, mention & assignment alerts. |
| **Gmail** | Each person connects Gmail via OAuth. Notifications + daily briefing are sent from the workspace sender; label any email **`TaskBoard`** and it becomes a task (AI extracts due date/priority). |
| **Phone** | Verify a number, get SMS or WhatsApp alerts (optionally only urgent/high), and **reply to control tasks**: `list`, `done API-12`, `start API-12`, `comment API-12 text`, `add fix login bug tomorrow !high`. Installable as a PWA on your home screen. |
| **AI (Claude)** | Plain-English → structured task, one-click subtask breakdown, description rewrite with acceptance criteria, priority/estimate/owner suggestion, risk radar, standup generator, daily-briefing blurb, chat assistant over your boards (can draft tasks). **Works offline too** with deterministic fallbacks (date/priority/@person parsing, templates, rule-based risks), so nothing breaks without a key. |

## Connect the integrations (Settings → Workspace, admin only)

Everything works out of the box in **simulated** mode: emails/texts are recorded in *Settings → Email, phone & AI → Delivery log* instead of being sent. To go live:

1. **Public URL** — set `BASE_URL` (or *Public URL* in the UI) to where the app is reachable, e.g. `https://tasks.acme.dev`. Google and Twilio need HTTPS callbacks.
2. **Gmail** — Google Cloud console → enable the *Gmail API* → OAuth consent screen → Credentials → *OAuth client ID (Web)*. Add the redirect URI shown in the Workspace tab (`<BASE_URL>/api/integrations/google/callback`). Paste Client ID/Secret. Then each user clicks **Connect Gmail**. (Scopes: `gmail.send`, `gmail.modify` — the latter is needed to mark processed emails read; while your OAuth app is in *Testing* mode, add your team as test users, or publish it internally for a Workspace domain.)
3. **Phone** — Twilio console → copy Account SID, Auth Token and a number (and/or WhatsApp sender). Set the number's **incoming message webhook** (HTTP POST) to `<BASE_URL>/api/webhooks/twilio` — requests are verified with Twilio's signature. Users add their number in *Integrations* and confirm a 6-digit code.
4. **AI** — paste an Anthropic API key (`ANTHROPIC_API_KEY`). Default model is `claude-sonnet-5-5`; override with `ANTHROPIC_MODEL`.

## Deploy

It needs a process that stays up (the scheduler sends reminders/briefings and polls Gmail every couple of minutes) and a persistent disk for `DATA_DIR` (SQLite).

```bash
docker build -t taskboard . && docker run -d -p 3000:3000 -v taskboard-data:/data -e BASE_URL=https://tasks.acme.dev taskboard
```

Put it behind HTTPS (Caddy, nginx, Fly.io, Render, …); send `X-Forwarded-Proto: https` so session cookies are marked `Secure`.

## Security notes

Passwords: scrypt. Sessions: signed, HttpOnly, SameSite=Lax cookies; writes require `application/json` (CSRF-safe). OAuth tokens and API keys are encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET` / `data/.secret` — back that file up). Strict CSP, login rate-limiting, role checks on every route (see `tests/api.test.js`).

## Layout

```
server/   index.js (HTTP) · routes.js (REST API) · tasks.js (domain) · access.js (roles/visibility)
          automations.js · notifications.js · scheduler.js · ai.js · commands.js (phone bot)
          channels/google.js · channels/twilio.js · delivery.js (outbox) · seed.js
public/   no-build SPA: js/main.js (shell/router) · js/views/* · css/app.css (design tokens, light/dark)
tests/    node:test API suite
```

Not included (by design, to stay dependency-free): background Web Push when the app is closed (use SMS/email), per-project custom workflow columns (statuses are Backlog → To do → In progress → In review → Done), file attachments.
