// Minimal service worker so the app is installable on phones; API calls always hit the network.
const CACHE = 'tb-shell-v2';
const API_CACHE = 'tb-api-v1';
// read-only endpoints worth keeping for offline viewing (network first, cache as fallback)
const READABLE = /^\/api\/(bootstrap|me|my-tasks|notifications|users|teams|dashboard|capacity|projects|tasks\/\d+|projects\/\d+\/(board|sprints|releases|roadmap))$/;
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/css/app.css', '/icon.svg'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== API_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method === 'GET' && u.origin === location.origin && READABLE.test(u.pathname)) {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(API_CACHE).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.open(API_CACHE).then(c => c.match(e.request)).then(r => r || Response.error())));
    return;
  }
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'TaskBoard', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'TaskBoard', { body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', tag: d.tag, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => 'focus' in x);
    if (c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});

// private data must not outlive the session: the page asks us to drop it on logout
self.addEventListener('message', e => { if (e.data === 'clear-api') e.waitUntil(caches.delete(API_CACHE)); });
