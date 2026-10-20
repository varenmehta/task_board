# Going live

TaskBoard is one small Node process + one data folder, so any host that runs a container and keeps a disk works.
It must stay **always on** (reminders, digests, recurring tasks, Gmail polling and backups run inside it).

## Option A — Fly.io (≈ $3–5/mo, recommended)
```bash
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config --name <your-app-name>
fly volumes create taskboard_data --size 1
fly secrets set BASE_URL=https://<your-app-name>.fly.dev      # optional: ANTHROPIC_API_KEY=…
fly deploy
fly open
```
## Option B — Render (≈ $7/mo; needs a paid plan for the persistent disk)
New → **Blueprint** → select this repo → fill `BASE_URL` → Apply.

## Option C — Any VPS (Hetzner, DigitalOcean, EC2…)
```bash
git clone https://github.com/varenmehta/task_board && cd task_board
DOMAIN=tasks.yourcompany.com docker compose -f docker-compose.prod.yml up -d
```

## After it's up (5 minutes)
1. Open the URL → **create your admin account** (untick “sample data” for a real workspace).
2. Settings → **Workspace**: set the *Public URL*, then add Google / Twilio / Anthropic / SSO / Slack credentials as needed (see README). Nothing is required to start — email/SMS run in "simulated" mode until you connect them.
3. Teams & people → create teams → **invite** people (email link works once Gmail is connected; otherwise copy the link).
4. Add a custom domain: Fly `fly certs add tasks.yourcompany.com`, Render → Settings → Custom Domains, VPS → just set `DOMAIN`. Update *Public URL* afterwards.
5. **Backups**: the app snapshots the database daily into `/data/backups`. Also copy `/data/.secret` and `/data/uploads` off the machine occasionally (`fly ssh sftp get`, or `docker cp`).

## Checks
`curl https://<your-url>/api/health` → `{"ok":true}`. If the first login page says “Can’t reach the server”, the volume isn't writable — redeploy (the entrypoint fixes ownership on start).
