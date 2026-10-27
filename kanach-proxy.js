// وسيط محلي لكناش ← Yalidine. يعمل من IP حاسوبك (الذي يقبله Yalidine).
// التشغيل:  node kanach-proxy.js     ثم في كناش > الربط > رابط الوسيط:  http://localhost:8787
const http = require('http'), https = require('https');
const PORT = process.env.PORT || 8787, UP = process.env.UPSTREAM || 'https://api.yalidine.app';
const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type,X-API-ID,X-API-TOKEN', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Private-Network':'true' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url.startsWith('/__kanach')) { res.writeHead(200, { ...cors, 'Content-Type':'application/json' }); return res.end(JSON.stringify({ kanach:'proxy', v:2, post:true })); }
  const u = new URL(UP + '/v1' + req.url.replace(/^\/v1/, ''));
  const lib = u.protocol === 'https:' ? https : http;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
  const body = Buffer.concat(chunks), m = req.method === 'POST' ? 'POST' : 'GET';
  const hd = { 'X-API-ID': req.headers['x-api-id'] || '', 'X-API-TOKEN': req.headers['x-api-token'] || '', 'Accept':'application/json' };
  if (m === 'POST') { hd['Content-Type'] = 'application/json'; hd['Content-Length'] = body.length; }
  const up = lib.request(u, { method: m, headers: hd }, r => {
    res.writeHead(r.statusCode, { ...cors, 'Content-Type': 'application/json' }); r.pipe(res);
  });
  up.on('error', e => { res.writeHead(502, { ...cors, 'Content-Type':'application/json' }); res.end(JSON.stringify({ error: String(e) })); });
  m === 'POST' ? up.end(body) : up.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log('Kanach proxy: http://localhost:' + PORT));
