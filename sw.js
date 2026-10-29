// كناش — يعمل بلا إنترنت، ويعرض إشعارات التسليم حتى والتطبيق مغلق.
// الصفحة: الشبكة أولاً (لتصلك التحديثات فوراً)، ثم النسخة المحفوظة عند الانقطاع. لا يُخزَّن أي طلب API.
const CACHE = 'kanach-v10';
const SHELL = ['./kanach.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './badge-96.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => c.addAll(['./kanach.html']))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const isShell = u.pathname === '/' || SHELL.some(p => u.pathname.endsWith(p.slice(1)));
  if (!isShell) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./kanach.html')))
  );
});

/* ---- الإشعارات: الخادم يرسل «نبضة» بلا محتوى، فنسحب النص من كناش السحابي بمفتاحك المحفوظ ---- */
const kv = (key, val) => new Promise(res => {
  const r = indexedDB.open('kanach', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onerror = () => res(undefined);
  r.onsuccess = () => {
    try {
      const t = r.result.transaction('kv', val === undefined ? 'readonly' : 'readwrite'), st = t.objectStore('kv');
      const q = val === undefined ? st.get(key) : st.put(val, key);
      t.oncomplete = () => res(val === undefined ? q.result : val); t.onerror = () => res(undefined);
    } catch { res(undefined); }
  };
});
async function showNotes() {
  let notes = [];
  try {
    const base = (await kv('cloudBase')) || self.location.origin, key = (await kv('cloudKey')) || '';
    const r = await fetch(base + '/__kanach/notes', { headers: { 'X-Kanach-Key': key }, cache: 'no-store' });
    if (r.ok) notes = (await r.json()).notes || [];
  } catch {}
  const last = (await kv('lastNote')) || '';
  let fresh = notes.filter(n => n.ts > last).slice(-4);
  if (!fresh.length) fresh = [{ title: 'كناش', body: 'تحديث جديد في طلبياتك', tag: 'kanach', ts: last }];
  else await kv('lastNote', fresh[fresh.length - 1].ts);
  await Promise.all(fresh.map(n => self.registration.showNotification(n.title, {
    body: n.body, tag: n.tag || 'kanach', renotify: true, dir: 'rtl', lang: 'ar',
    icon: './icon-192.png', badge: './badge-96.png', data: { url: './kanach.html', tracking: n.tracking || '' }
  })));
}
self.addEventListener('push', e => e.waitUntil(showNotes()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.includes('kanach') || new URL(c.url).pathname === '/');
    return w ? w.focus() : self.clients.openWindow(e.notification.data?.url || './kanach.html');
  }));
});
