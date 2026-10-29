// كناش السحابي — Cloudflare Worker واحد يقوم بكل شيء:
//   • يستضيف التطبيق (kanach.html و sw.js و manifest و icon) عبر Static Assets — يتحدّث تلقائياً مع كل نشر
//   • وسيط Yalidine (نفس مسارات kanach-proxy.js)
//   • مزامنة البيانات بين الهاتف والحاسوب (Durable Object بقاعدة SQLite)، محمية بمفتاح KANACH_KEY
//   • صندوق وارد لطلبيات FreeVendor (من الهاتف أو الحاسوب، بلا وسيط محلي)
//   • إشعارات Web Push: كل 15 دقيقة يفحص Yalidine ويُنبّه عند التسليم/الخروج للتسليم/الفشل/الإرجاع
import { DurableObject } from 'cloudflare:workers';

const UPSTREAM = 'https://api.yalidine.app/v1';
const up = env => (env && env.YALIDINE_URL) || UPSTREAM; // قابل للتغيير للاختبار فقط
const FV_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*freevendor\.space$/i;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-ID,X-API-TOKEN,X-Kanach-Key,If-Match',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Expose-Headers': 'X-Kanach-Rev'
};
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

/* مقارنة بزمن ثابت حتى لا يُخمَّن المفتاح حرفاً حرفاً */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
const store = env => env.KANACH.get(env.KANACH.idFromName('main'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (p === '/' || p === '/index.html') return env.ASSETS.fetch(new Request(new URL('/kanach.html', url), req));
    if (p === '/__kanach' || p === '/__kanach/') return json({ kanach: 'proxy', v: 5, post: true, inbox: true, cloud: true, push: true, keySet: !!env.KANACH_KEY });
    if (p.startsWith('/__kanach/')) {
      if (!env.KANACH_KEY) return json({ error: 'KANACH_KEY غير مضبوط في إعدادات الـWorker' }, 503);
      if (p === '/__kanach/push/key') return store(env).fetch(new Request('https://do/push/key'));
      const key = req.headers.get('X-Kanach-Key') || url.searchParams.get('k') || '';
      if (!sameKey(key, env.KANACH_KEY)) return json({ error: 'مفتاح كناش غير صحيح' }, 401);
      const o = req.headers.get('Origin');
      if (p === '/__kanach/inbox' && req.method === 'POST' && o && !FV_ORIGIN.test(o) && o !== url.origin) return json({ error: 'origin not allowed' }, 403);
      const r = await store(env).fetch(new Request('https://do' + p.slice('/__kanach'.length) + url.search, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer() }));
      const h = new Headers(r.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v)); // set وليس دمج: قيمة واحدة لكل ترويسة
      return new Response(r.body, { status: r.status, headers: h });
    }
    // وسيط Yalidine: كل ما عدا ذلك يُمرَّر إلى api.yalidine.app/v1
    if (['/wilayas', '/communes', '/centers', '/parcels', '/histories', '/deliveryfees', '/fees', '/v1/'].some(x => p.startsWith(x))) return proxyYalidine(req, url, env);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    if (!env.KANACH_KEY) return;
    ctx.waitUntil(store(env).fetch(new Request('https://do/cron', { method: 'POST' })));
  }
};

async function proxyYalidine(req, url, env) {
  const target = up(env) + url.pathname.replace(/^\/v1/, '') + url.search;
  const hd = { 'X-API-ID': req.headers.get('X-API-ID') || '', 'X-API-TOKEN': req.headers.get('X-API-TOKEN') || '', Accept: 'application/json' };
  const init = { method: req.method === 'POST' ? 'POST' : 'GET', headers: hd };
  if (init.method === 'POST') { hd['Content-Type'] = 'application/json'; init.body = await req.text(); }
  try {
    const r = await fetch(target, init);
    return new Response(r.body, { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) { return json({ error: String(e) }, 502); }
}

/* ===================== الحالة المحفوظة (SQLite Durable Object) ===================== */
const CHUNK = 100_000; // نخزّن JSON الكبير على قطع
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class KanachStore extends DurableObject {
  async getBig(name) {
    const n = (await this.ctx.storage.get(name + ':n')) || 0; if (!n) return null;
    const parts = await this.ctx.storage.get(Array.from({ length: n }, (_, i) => `${name}:${i}`));
    return Array.from({ length: n }, (_, i) => parts.get(`${name}:${i}`) || '').join('');
  }
  async putBig(name, str) {
    const old = (await this.ctx.storage.get(name + ':n')) || 0, parts = {};
    const n = Math.max(1, Math.ceil(str.length / CHUNK));
    for (let i = 0; i < n; i++) parts[`${name}:${i}`] = str.slice(i * CHUNK, (i + 1) * CHUNK);
    parts[name + ':n'] = n;
    await this.ctx.storage.put(parts);
    if (old > n) await this.ctx.storage.delete(Array.from({ length: old - n }, (_, i) => `${name}:${n + i}`));
  }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, S = this.ctx.storage;
    try {
      // ---- المزامنة: GET يعيد الحالة ورقم المراجعة، PUT يقبل فقط إن لم يتغيّر شيء منذ قرأه الجهاز (If-Match) ----
      if (p === '/sync' && req.method === 'GET') {
        const rev = (await S.get('rev')) || 0, body = await this.getBig('state');
        return new Response(body || '{}', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Kanach-Rev': String(rev), 'Cache-Control': 'no-store' } });
      }
      if (p === '/sync' && req.method === 'PUT') {
        const rev = (await S.get('rev')) || 0, base = req.headers.get('If-Match');
        if (base != null && base !== '' && +base !== rev) return json({ error: 'conflict', rev }, 409, { 'X-Kanach-Rev': String(rev) });
        const text = await req.text(); if (!/^\s*\{/.test(text)) return json({ error: 'bad state' }, 400); // بلا تحليل: نحافظ على وقت المعالج تحت حدود الخطة المجانية
        await this.putBig('state', text); await S.put('rev', rev + 1);
        return json({ ok: true, rev: rev + 1 }, 200, { 'X-Kanach-Rev': String(rev + 1) });
      }
      // ---- صندوق وارد FreeVendor ----
      if (p === '/inbox' && req.method === 'POST') {
        const payload = await req.json();
        if (payload?.kanach !== 'vonder' || !Array.isArray(payload.rows)) return json({ error: 'not a kanach payload' }, 400);
        const inbox = (await S.get('inbox')) || [], id = new Date().toISOString() + '-' + Math.random().toString(36).slice(2, 6);
        inbox.push({ id, payload }); await S.put('inbox', inbox.slice(-50));
        return json({ ok: true, id });
      }
      if (p === '/inbox') { const after = url.searchParams.get('after') || ''; return json({ items: ((await S.get('inbox')) || []).filter(x => x.id > after) }); }
      // ---- قائمة المتابعة الصغيرة: الطلبيات المعلّقة برقم تتبع (يرسلها التطبيق بعد كل مزامنة) ----
      if (p === '/watch' && req.method === 'POST') {
        const { items } = await req.json(); if (!Array.isArray(items)) return json({ error: 'bad list' }, 400);
        await S.put('watch', items.slice(0, 2000).map(x => ({ t: String(x.t || '').slice(0, 40), n: String(x.n || '').slice(0, 60), a: Math.round(+x.a || 0) })).filter(x => x.t));
        return json({ ok: true });
      }
      // ---- إعداد الإشعارات: مفاتيح Yalidine للفحص الدوري ----
      if (p === '/config' && req.method === 'POST') {
        const c = await req.json(), cfg = { ...((await S.get('config')) || {}) };
        ['apiId', 'apiToken', 'notify', 'appName'].forEach(k => { if (c[k] !== undefined) cfg[k] = c[k]; });
        await S.put('config', cfg); return json({ ok: true, notify: !!cfg.notify, yalidine: !!(cfg.apiId && cfg.apiToken) });
      }
      if (p === '/config') { const c = (await S.get('config')) || {}; return json({ notify: !!c.notify, yalidine: !!(c.apiId && c.apiToken), subs: ((await S.get('subs')) || []).length, lastCron: (await S.get('lastCron')) || null }); }
      // ---- Web Push ----
      if (p === '/push/key') { const v = await this.vapid(); return json({ key: v.pub }); }
      if (p === '/push/subscribe' && req.method === 'POST') {
        const { subscription, device } = await req.json(); if (!subscription?.endpoint) return json({ error: 'bad subscription' }, 400);
        const subs = ((await S.get('subs')) || []).filter(s => s.endpoint !== subscription.endpoint);
        subs.push({ ...subscription, device: String(device || '').slice(0, 60), at: new Date().toISOString() }); await S.put('subs', subs.slice(-10));
        return json({ ok: true, count: subs.length });
      }
      if (p === '/push/unsubscribe' && req.method === 'POST') {
        const { endpoint } = await req.json(); await S.put('subs', ((await S.get('subs')) || []).filter(s => s.endpoint !== endpoint)); return json({ ok: true });
      }
      if (p === '/push/test' && req.method === 'POST') { await this.note('كناش', 'الإشعارات تعمل على هذا الجهاز ✓', 'test'); return json(await this.pushAll()); }
      if (p === '/notes') return json({ notes: ((await S.get('notes')) || []).slice(-10) });
      if (p === '/cron' && req.method === 'POST') return json(await this.cron());
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e?.message || e) }, 500); }
  }

  async note(title, body, tag, extra = {}) {
    const notes = (await this.ctx.storage.get('notes')) || [];
    notes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title, body, tag, ts: new Date().toISOString(), ...extra });
    await this.ctx.storage.put('notes', notes.slice(-30));
  }

  /* مفاتيح VAPID: تُولَّد مرة واحدة وتُحفظ */
  async vapid() {
    let v = await this.ctx.storage.get('vapid');
    if (!v) {
      const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      v = { jwk: await crypto.subtle.exportKey('jwk', k.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)) };
      await this.ctx.storage.put('vapid', v);
    }
    return v;
  }
  async vapidHeader(endpoint) {
    const v = await this.vapid(), aud = new URL(endpoint).origin, enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
    const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:kanach@users.noreply.local' })}`;
    const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(data));
    return `vapid t=${data}.${b64u(sig)}, k=${v.pub}`;
  }
  /* إشعار بلا محتوى (لا يحتاج تشفيراً): التطبيق يسحب النص من /notes عند وصوله */
  async pushAll() {
    const subs = (await this.ctx.storage.get('subs')) || [], keep = [], res = { sent: 0, failed: 0, removed: 0 };
    for (const s of subs) {
      try {
        const r = await fetch(s.endpoint, { method: 'POST', headers: { TTL: '86400', Urgency: 'high', 'Content-Length': '0', Authorization: await this.vapidHeader(s.endpoint) } });
        if (r.status === 404 || r.status === 410) { res.removed++; continue; }
        r.ok ? res.sent++ : res.failed++;
      } catch { res.failed++; }
      keep.push(s);
    }
    if (res.removed) await this.ctx.storage.put('subs', keep);
    return res;
  }

  /* الفحص الدوري: الطلبيات المعلّقة برقم تتبع ← حالتها عند Yalidine ← إشعار عند كل تغيير مهم */
  async cron() {
    const S = this.ctx.storage, cfg = (await S.get('config')) || {};
    await S.put('lastCron', new Date().toISOString());
    if (!cfg.notify || !cfg.apiId || !cfg.apiToken) return { skipped: 'notify off or no Yalidine keys' };
    const subs = (await S.get('subs')) || []; if (!subs.length) return { skipped: 'no devices' };
    const clean = t => String(t || '').replace(/\s+/g, '').toLowerCase();
    const watch = ((await S.get('watch')) || []).filter(x => clean(x.t));
    if (!watch.length) return { checked: 0 };
    const seen = (await S.get('seen')) || {}, found = {};
    for (let i = 0; i < watch.length; i += 40) {
      const batch = watch.slice(i, i + 40).map(e => clean(e.t));
      const r = await fetch(`${up(this.env)}/parcels/?tracking=${encodeURIComponent(batch.join(','))}&page_size=100`, { headers: { 'X-API-ID': cfg.apiId, 'X-API-TOKEN': cfg.apiToken, Accept: 'application/json' } });
      if (!r.ok) return { error: `Yalidine HTTP ${r.status}` };
      ((await r.json()).data || []).forEach(p => { found[clean(p.tracking)] = p; });
    }
    let made = 0;
    for (const e of watch) {
      const t = clean(e.t), p = found[t]; if (!p) continue;
      const stage = classify(p.last_status || p.status), prev = seen[t];
      seen[t] = stage;
      if (prev === undefined || prev === stage) continue; // أول مرة نراها: نحفظ فقط بلا إشعار
      const who = e.n, amt = e.a;
      const msg = {
        delivered: ['✓ تم التسليم', `${who} — فائدتك ≈ ${amt.toLocaleString('fr-DZ')} دج`],
        out: ['🚚 خرجت للتسليم', `${who} — اتصل بالزبون ليكون جاهزاً`],
        failed: ['⚠ محاولة تسليم فاشلة', `${who} — ${p.last_status || ''}`],
        returning: ['↩ طلبية راجعة', `${who} — تواصل معه قبل أن تُرجَع`],
        returned: ['↩ رجعت الطلبية', `${who}`]
      }[stage];
      if (msg) { await this.note(msg[0], msg[1], 'trk-' + t, { stage, tracking: t }); made++; }
    }
    // لا نُبقي في الذاكرة إلا ما زال قيد المتابعة
    const live = new Set(watch.map(e => clean(e.t))); Object.keys(seen).forEach(k => { if (!live.has(k)) delete seen[k]; });
    await S.put('seen', seen);
    const push = made ? await this.pushAll() : null;
    return { checked: watch.length, notes: made, push };
  }
}

/* نفس تصنيف كناش لحالات Yalidine (مختصر) */
function classify(raw) {
  const s = String(raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/retourne au vendeur|retour recu|returned to/.test(s)) return 'returned';
  if (s.includes('retour') || s.includes('return')) return 'returning';
  if (/\blivre\b|\bdelivered\b/.test(s) || (/\bencaisse\b/.test(s) && !/non encaisse|pas encaisse/.test(s))) return 'delivered';
  if (/tentative|echec|echoue|alerte|bloque|failed/.test(s)) return 'failed';
  if (/sorti en livraison|en livraison|out for delivery/.test(s)) return 'out';
  return 'transit';
}
