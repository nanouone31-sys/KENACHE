// وسيط محلي لكناش ← Yalidine. يعمل من IP حاسوبك (الذي يقبله Yalidine).
// التشغيل:  node kanach-proxy.js     ثم افتح:  http://localhost:8787
// يخدم كناش نفسه من نفس المجلد، فيتعرّف التطبيق على الوسيط تلقائياً (بلا CORS ولا إعداد «رابط الوسيط»)،
// ويمكن تثبيته كتطبيق ويعمل بلا إنترنت.
// اختياري: KANACH_ORIGINS="https://example.github.io,http://localhost:8787" لحصر المواقع المسموح لها باستعمال الوسيط.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 8787, UP = process.env.UPSTREAM || 'https://api.yalidine.app';
const ORIGINS = (process.env.KANACH_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const STATIC = { '/': 'kanach.html', '/kanach.html': 'kanach.html', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

function corsFor(req) {
  const o = req.headers.origin;
  const allow = !ORIGINS.length ? '*' : (o && ORIGINS.includes(o) ? o : '');
  return { ...(allow ? { 'Access-Control-Allow-Origin': allow, Vary: 'Origin' } : {}), 'Access-Control-Allow-Headers': 'Content-Type,X-API-ID,X-API-TOKEN', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Private-Network': 'true' };
}

http.createServer((req, res) => {
  const cors = corsFor(req), pathname = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (pathname.startsWith('/__kanach')) { res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ kanach: 'proxy', v: 3, post: true, static: true })); }
  if (req.method === 'GET' && STATIC[pathname]) {
    const f = path.join(__dirname, STATIC[pathname]);
    return fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('الملف غير موجود بجانب الوسيط: ' + STATIC[pathname]); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf);
    });
  }
  if (ORIGINS.length && req.headers.origin && !ORIGINS.includes(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'origin not allowed' })); }
  const u = new URL(UP + '/v1' + req.url.replace(/^\/v1/, ''));
  const lib = u.protocol === 'https:' ? https : http;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks), m = req.method === 'POST' ? 'POST' : 'GET';
    const hd = { 'X-API-ID': req.headers['x-api-id'] || '', 'X-API-TOKEN': req.headers['x-api-token'] || '', 'Accept': 'application/json' };
    if (m === 'POST') { hd['Content-Type'] = 'application/json'; hd['Content-Length'] = body.length; }
    const up = lib.request(u, { method: m, headers: hd }, r => {
      res.writeHead(r.statusCode, { ...cors, 'Content-Type': 'application/json' }); r.pipe(res);
    });
    up.on('error', e => { res.writeHead(502, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); });
    m === 'POST' ? up.end(body) : up.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log('كناش: http://localhost:' + PORT + '   (الوسيط يعمل — اترك هذه النافذة مفتوحة)'));
