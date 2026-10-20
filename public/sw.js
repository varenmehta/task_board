// Minimal service worker so the app is installable on phones; API calls always hit the network.
const CACHE = 'tb-shell-v1';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/css/app.css', '/icon.svg'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
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
