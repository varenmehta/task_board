import fs from 'node:fs';

// Each test file runs in its own process: fresh in-memory DB + temp data dir + ephemeral port.
export async function boot() {
  process.env.DB_FILE = ':memory:';
  process.env.DATA_DIR = fs.mkdtempSync('/tmp/tb-test-');
  process.env.ALLOW_PRIVATE_URLS = '1';
  const { server } = await import('../server/index.js');
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  class Client {
    cookie = '';
    headers = {};
    async req(method, path, body, extra = {}) {
      const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', cookie: this.cookie, ...this.headers, ...extra }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
      const sc = r.headers.get('set-cookie');
      if (sc) this.cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      const out = ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer());
      return { status: r.status, body: out, headers: r.headers };
    }
    get = p => this.req('GET', p);
    post = (p, b) => this.req('POST', p, b ?? {});
    patch = (p, b) => this.req('PATCH', p, b);
    put = (p, b) => this.req('PUT', p, b);
    del = p => this.req('DELETE', p);
  }

  const admin = new Client(), member = new Client(), viewer = new Client(), manager = new Client();
  await admin.post('/api/setup', { name: 'Ada Admin', email: 'ada@example.com', password: 'supersecret1', workspace: 'Acme', demo: true });
  await member.post('/api/login', { email: 'marcus@demo.taskboard.dev', password: 'demo1234' });
  await viewer.post('/api/login', { email: 'dana@demo.taskboard.dev', password: 'demo1234' });
  await manager.post('/api/login', { email: 'priya@demo.taskboard.dev', password: 'demo1234' });
  const projects = (await admin.get('/api/projects')).body;
  const ids = Object.fromEntries(projects.map(p => [p.key.toLowerCase(), p.id]));
  return { server, base, Client, admin, member, viewer, manager, ids, projects };
}
