// اختبارات كناش السحابي (Cloudflare Worker) محلياً عبر wrangler dev:
// Yalidine وخدمة الإشعارات محاكيان بخادم محلي. التشغيل: node tests/worker.test.js
// (يحتاج wrangler: npm install، أو WRANGLER_BIN=/path/to/wrangler)
const http = require('http'), crypto = require('crypto'), path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), KEY = 'test-key-' + crypto.randomBytes(4).toString('hex');
const WPORT = 18800 + Math.floor(Math.random() * 400), MPORT = WPORT + 500;
const W = `http://127.0.0.1:${WPORT}`, M = `http://127.0.0.1:${MPORT}`;
let failed = 0, passed = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? passed++ : failed++; console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`}`); };

// ---- محاكي Yalidine + خدمة الإشعارات ----
const yal = { statuses: {}, hits: [] }, pushes = [], graphHits = [];
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, M);
  if (u.pathname.startsWith('/graph/')) {
    let b = ''; for await (const c of req) b += c;
    graphHits.push({ path: u.pathname, auth: req.headers.authorization, body: JSON.parse(b || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.T' + graphHits.length }] }));
  }
  if (u.pathname.startsWith('/push/')) { pushes.push({ auth: req.headers.authorization, ttl: req.headers.ttl, aud: M }); res.writeHead(201); return res.end(); }
  if (u.pathname.startsWith('/v1/')) {
    yal.hits.push({ path: u.pathname, id: req.headers['x-api-id'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (u.pathname === '/v1/parcels/') { const ts = (u.searchParams.get('tracking') || '').split(',').filter(Boolean); return res.end(JSON.stringify({ data: ts.filter(t => yal.statuses[t]).map(t => ({ tracking: t, last_status: yal.statuses[t] })) })); }
    return res.end(JSON.stringify({ data: [{ id: 31, name: 'Oran' }] }));
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise(r => mock.listen(MPORT, '127.0.0.1', r));
  const bin = process.env.WRANGLER_BIN || require.resolve('wrangler/bin/wrangler.js', { paths: [ROOT] });
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'kanach-wr-'));
  const wr = spawn(bin.endsWith('.js') ? process.execPath : bin, [...(bin.endsWith('.js') ? [bin] : []), 'dev', '--port', String(WPORT), '--ip', '127.0.0.1', '--test-scheduled', '--persist-to', persist,
    '--var', `KANACH_KEY:${KEY}`, '--var', `YALIDINE_URL:${M}/v1`, '--var', `GRAPH_URL:${M}/graph`], { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  let log = ''; wr.stdout.on('data', d => log += d); wr.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) { try { const r = await fetch(W + '/__kanach'); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
  const call = (p, opt = {}) => fetch(W + p, { ...opt, headers: { 'X-Kanach-Key': KEY, ...(opt.headers || {}) } });
  try {
    eq('القدرات', await (await fetch(W + '/__kanach')).json(), { kanach: 'proxy', v: 5, post: true, inbox: true, cloud: true, push: true, keySet: true });
    eq('التطبيق يُخدَم والملفات الأخرى مخفية', [(await fetch(W + '/')).status, (await fetch(W + '/sw.js')).status, (await fetch(W + '/tests/worker.test.js')).status, (await fetch(W + '/wrangler.toml')).status, (await fetch(W + '/archive/kanach-v7-2026-10-28.html')).status], [200, 200, 404, 404, 404]);
    eq('بلا مفتاح / بمفتاح خاطئ', [(await fetch(W + '/__kanach/sync')).status, (await fetch(W + '/__kanach/sync', { headers: { 'X-Kanach-Key': 'nope' } })).status], [401, 401]);

    // ---- المزامنة مع منع الكتابة فوق تعديل جهاز آخر ----
    const g0 = await call('/__kanach/sync');
    const st1 = { entries: [{ id: 'a', type: 'expense', amount: 1, updatedAt: '2026-10-29' }], v: 4 };
    const p1 = await call('/__kanach/sync', { method: 'PUT', headers: { 'If-Match': g0.headers.get('X-Kanach-Rev'), 'Content-Type': 'application/json' }, body: JSON.stringify(st1) });
    const p2 = await call('/__kanach/sync', { method: 'PUT', headers: { 'If-Match': '0', 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [] }) });
    const g1 = await call('/__kanach/sync');
    eq('المزامنة: مراجعة + تعارض 409', [g0.headers.get('X-Kanach-Rev'), p1.status, p2.status, g1.headers.get('X-Kanach-Rev'), (await g1.json()).entries[0].id], ['0', 200, 409, '1', 'a']);
    const big = { entries: Array.from({ length: 1500 }, (_, i) => ({ id: 'e' + i, desc: 'طلبية رقم ' + i + ' '.repeat(120), amount: i })) };
    const pb = await call('/__kanach/sync', { method: 'PUT', headers: { 'If-Match': '1' }, body: JSON.stringify(big) });
    eq('حالة كبيرة (~300KB) تُقسَّم وتُستعاد', [pb.status, (await (await call('/__kanach/sync')).json()).entries.length], [200, 1500]);

    // ---- صندوق وارد FreeVendor ----
    const payload = { kanach: 'vonder', v: 3, rows: [{ id: '000585899', status: ['Confirmé avec le client'] }] };
    const i1 = await call('/__kanach/inbox', { method: 'POST', headers: { Origin: 'https://freevendor.space', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const i2 = await call('/__kanach/inbox', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const ib = await (await call('/__kanach/inbox?after=')).json();
    eq('صندوق الوارد', [i1.status, i2.status, ib.items.length, ib.items[0].payload.rows[0].id], [200, 403, 1, '000585899']);
    const pre = await fetch(W + '/__kanach/inbox', { method: 'OPTIONS', headers: { Origin: 'https://freevendor.space', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-kanach-key', 'Access-Control-Request-Private-Network': 'true' } });
    eq('CORS من صفحة FreeVendor', [pre.status, /x-kanach-key/i.test(pre.headers.get('access-control-allow-headers'))], [204, true]);
    eq('ترويسة CORS واحدة (لا تكرار)', i1.headers.get('access-control-allow-origin'), '*');

    // ---- وسيط Yalidine ----
    const yw = await fetch(W + '/wilayas/?page_size=100', { headers: { 'X-API-ID': '123', 'X-API-TOKEN': 't' } });
    eq('وسيط Yalidine', [yw.status, (await yw.json()).data[0].name, yal.hits.at(-1).path, yal.hits.at(-1).id], [200, 'Oran', '/v1/wilayas/', '123']);

    // ---- Web Push: مفتاح VAPID، اشتراك، وتوقيع ES256 صحيح ----
    const { key } = await (await fetch(W + '/__kanach/push/key')).json();
    eq('مفتاح VAPID (65 بايت)', Buffer.from(key, 'base64url').length, 65);
    await call('/__kanach/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: `${M}/push/dev1`, keys: { p256dh: 'x', auth: 'y' } }, device: 'هاتف' }) });
    const t = await (await call('/__kanach/push/test', { method: 'POST' })).json();
    const auth = pushes.at(-1)?.auth || '', m = auth.match(/^vapid t=([^,]+), k=(.+)$/), [h, pl, sig] = (m?.[1] || '..').split('.');
    const raw = Buffer.from(m?.[2] || '', 'base64url'), pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${pl}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig || '', 'base64url'));
    const claims = JSON.parse(Buffer.from(pl || 'e30', 'base64url'));
    eq('إرسال إشعار بتوقيع VAPID صالح', [t.sent, valid, claims.aud, m?.[2] === key, pushes.at(-1).ttl], [1, true, M, true, '86400']);
    eq('نص الإشعار متاح للتطبيق', (await (await call('/__kanach/notes')).json()).notes.at(-1).body, 'الإشعارات تعمل على هذا الجهاز ✓');

    // ---- الفحص الدوري: إشعار فقط عند تغيّر الحالة (لا إشعار في أول مشاهدة) ----
    const state = { entries: [
      { id: 'o1', type: 'vonder', status: 'pending', tracking: 'yal-AAA111', amount: 531, yalidineInfo: { clientName: 'سمير' } },
      { id: 'o2', type: 'vonder', status: 'pending', tracking: 'yal-BBB222', amount: 400, yalidineInfo: { clientName: 'ليلى' } },
      { id: 'o3', type: 'vonder', status: 'delivered', tracking: 'yal-CCC333', amount: 100 }] };
    await call('/__kanach/watch', { method: 'POST', body: JSON.stringify({ items: state.entries.filter(e => e.status === 'pending').map(e => ({ t: e.tracking, n: e.yalidineInfo.clientName, a: e.amount })) }) });
    await call('/__kanach/config', { method: 'POST', body: JSON.stringify({ notify: true, apiId: '999', apiToken: 'tok' }) });
    yal.statuses = { 'yal-aaa111': 'En transit vers la wilaya', 'yal-bbb222': 'Sorti en livraison' };
    const n0 = pushes.length;
    await fetch(W + '/__scheduled?cron=*/15+*+*+*+*');
    const c1 = await (await call('/__kanach/notes')).json();
    yal.statuses = { 'yal-aaa111': 'Livré', 'yal-bbb222': 'Tentative échouée' };
    await fetch(W + '/__scheduled?cron=*/15+*+*+*+*');
    await new Promise(r => setTimeout(r, 500));
    const c2 = (await (await call('/__kanach/notes')).json()).notes.slice(-2);
    eq('الفحص الدوري', [c1.notes.length, c2.map(n => n.stage).sort(), c2.find(n => n.stage === 'delivered').body.includes('سمير'), pushes.length - n0, yal.hits.filter(h => h.path === '/v1/parcels/').every(h => h.id === '999')],
      [1, ['delivered', 'failed'], true, 1, true]);
    const cfg = await (await call('/__kanach/config')).json();
    eq('حالة الإعداد', [cfg.notify, cfg.yalidine, cfg.subs, !!cfg.lastCron], [true, true, 1, true]);

    // ---- حجز الطلبيات: جهازان مفتوحان لا يُنشئان طردين لنفس الطلبية ----
    const claim = async (device, ids) => (await (await call('/__kanach/claim', { method: 'POST', body: JSON.stringify({ device, ids }) })).json()).claimed;
    eq('الحجز: الطلبية لجهاز واحد', [await claim('pc', ['x', 'y']), await claim('phone', ['y', 'z']), await claim('pc', ['x'])], [['x', 'y'], ['z'], ['x']]);

    // ---- واتساب: إعداد، إرسال قالب، Webhook موقّع من Meta، نتائج للتطبيق ----
    const SECRET = 'app-secret-' + crypto.randomBytes(4).toString('hex');
    const wc = await (await call('/__kanach/wa/config', { method: 'POST', body: JSON.stringify({ token: 'EAAtest', phoneId: '1055', template: 'kanach_order_confirm', appSecret: SECRET, lang: 'ar' }) })).json();
    eq('إعداد واتساب: لا يكشف الأسرار', [wc.configured, wc.token, wc.appSecret, wc.verifyToken.length > 16, JSON.stringify(wc).includes('EAAtest') || JSON.stringify(wc).includes(SECRET)], [true, true, true, true, false]);
    const hub = q => fetch(W + '/__kanach/wa/webhook?' + new URLSearchParams(q));
    const v1 = await hub({ 'hub.mode': 'subscribe', 'hub.verify_token': wc.verifyToken, 'hub.challenge': '8812' }), v2 = await hub({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    eq('تحقق Meta من الـWebhook (بلا مفتاح كناش)', [v1.status, await v1.text(), v2.status], [200, '8812', 403]);
    const send = b => call('/__kanach/wa/send', { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
    const s1 = await send({ id: 'fv-1', phone: '0661223344', name: 'سامي منصوري', vars: ['سامي', 'متجري', 'Montre Casio', '3 900', 'وهران'] });
    const s2 = await send({ id: 'fv-1', phone: '0661223344', name: 'سامي منصوري', vars: ['سامي'] });
    const s3 = await send({ id: 'fv-2', phone: '0550998877', name: 'كريم', vars: ['كريم', 'متجري', 'Casque', '2 500', 'الجزائر'] });
    const g = graphHits[0];
    eq('إرسال قالب التأكيد', [s1.ok, s1.msgId, s2.skipped, graphHits.length, g.path, g.auth, g.body.to, g.body.template.name, g.body.template.language.code, g.body.template.components[0].parameters.map(x => x.text)],
      [true, 'wamid.T1', true, 2, '/graph/v23.0/1055/messages', 'Bearer EAAtest', '213661223344', 'kanach_order_confirm', 'ar', ['سامي', 'متجري', 'Montre Casio', '3 900', 'وهران']]);
    const gc = graphHits.length, both = await Promise.all([send({ id: 'fv-9', phone: '0770000009', vars: ['a'] }), send({ id: 'fv-9', phone: '0770000009', vars: ['a'] })]);
    eq('جهازان يرسلان في نفس اللحظة: رسالة واحدة', [graphHits.length - gc, both.filter(x => x.skipped).length], [1, 1]);
    eq('رقم غير صالح لا يُرسل', (await send({ id: 'fv-3', phone: '0123', vars: [] })).error, 'رقم هاتف غير صالح');
    const hook = (body, secret = SECRET) => { const raw = JSON.stringify(body); return fetch(W + '/__kanach/wa/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw }); };
    const msg = (...messages) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages } }] }] });
    const forged = await hook(msg({ from: '213661223344', type: 'text', text: { body: 'نعم' } }), 'wrong-secret');
    const n1 = pushes.length;
    const h1 = await hook(msg({ from: '213661223344', type: 'button', context: { id: 'wamid.T1' }, button: { text: 'نعم، أكّد الطلبية', payload: 'نعم، أكّد الطلبية' } }));
    const h2 = await hook(msg({ from: '213550998877', type: 'text', text: { body: 'واش هو السعر الأخير؟' } }));
    await new Promise(r => setTimeout(r, 300));
    const wr1 = (await (await call('/__kanach/wa/results?after=')).json()).results;
    eq('Webhook: توقيع مزوّر مرفوض، الردود تُصنَّف وتُشعِر', [forged.status, h1.status, h2.status, wr1.map(r => [r.id, r.result]), pushes.length - n1 >= 1, (await (await call('/__kanach/notes')).json()).notes.some(n => n.title.includes('أكّد') && n.body.includes('سامي'))],
      [401, 200, 200, [['fv-1', 'yes'], ['fv-2', 'reply']], true, true]);
    await hook(msg({ from: '213550998877', type: 'text', text: { body: 'لالا بدلت رأيي' } }));
    const wr2 = (await (await call('/__kanach/wa/results?after=' + encodeURIComponent(wr1.at(-1).rid))).json()).results;
    eq('النتائج الجديدة فقط بعد آخر قراءة', wr2.map(r => [r.id, r.result]), [['fv-2', 'no']]);

    // ---- التطبيق الحقيقي من رابط الـWorker: «هاتف» و«حاسوب» يتزامنان، وطلبيات FreeVendor تصل للاثنين ----
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const open = async (vp) => { const ctx = await browser.newContext({ viewport: vp }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
      await p.goto(W + '/'); await p.waitForFunction(() => typeof S !== 'undefined' && S.settings.v >= 7); return { ctx, p, errs }; };
    const phone = await open({ width: 390, height: 844 }), pc = await open({ width: 1280, height: 860 });
    eq('التطبيق يتعرّف على كناش السحابي', await phone.p.evaluate(() => [SAME_ORIGIN_PROXY, !!KANACH_CAPS?.cloud, kanachCloud()]), [true, true, false]);
    for (const d of [phone, pc]) { await d.p.evaluate(() => go('settings', { scrollTo: 'sec-app' })); await d.p.fill('#kcKey', KEY); await d.p.click('[data-act=kc-save]'); await d.p.waitForFunction(() => kanachCloud() && ui.cloud === 'ok', null, { timeout: 10000 }); }
    await phone.p.evaluate(() => { S.entries.unshift({ id: 'ph1', type: 'expense', desc: 'من الهاتف', amount: 300, date: iso(), status: 'completed' }); persist(); });
    await phone.p.waitForFunction(() => !CLOUD.busy && !CLOUD.dirty && ui.cloud === 'ok', null, { timeout: 10000 }).catch(() => {});
    await phone.p.waitForTimeout(4000);
    await pc.p.evaluate(() => cloudSync());
    await pc.p.waitForFunction(() => S.entries.some(e => e.id === 'ph1'), null, { timeout: 10000 });
    eq('الحاسوب استلم تعديل الهاتف عبر السحابة', await pc.p.evaluate(() => S.entries.find(e => e.id === 'ph1').desc), 'من الهاتف');
    eq('مفتاح السحابة محفوظ لعامل الإشعارات', await phone.p.evaluate(async () => [await IDB.get('cloudKey') === cloudKey(), await IDB.get('cloudBase') === location.origin]), [true, true]);
    // الزر في FreeVendor يحمل المفتاح ويرسل إلى صندوق الوارد السحابي
    const code = await pc.p.evaluate(() => decodeURIComponent(fvBookmarklet().slice('javascript:'.length)));
    eq('زر FreeVendor مضبوط على السحابة', [code.includes(W), code.includes(KEY)], [true, true]);
    // في الواقع الـWorker على https عام فلا يلزم إذن؛ هنا يعمل على 127.0.0.1 فنمنح إذن الشبكة المحلية
    await pc.ctx.grantPermissions(['local-network-access'], { origin: 'https://freevendor.space' });
    const fv = await pc.ctx.newPage();
    await fv.route('https://freevendor.space/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><table><tr><td>#000990001</td><td><div>48800 DZD</div><div>600 DZD</div><div>49400 DZD</div><div>50400 DZD</div></td><td>Confirmé avec le client</td><td>نوال<br>0557439912<br>Oran</td><td>1000 DZD</td><td><button onclick="document.getElementById('m').style.display='block'">👁</button></td></tr></table>
      <div id="m" style="display:none;position:fixed;inset:0;background:#fff"><button class="close" onclick="this.parentElement.style.display='none'"><i class="fa fa-times"></i></button><p>- Numéro de commande : #000990001</p><p>- Client : نوال</p><p>- Numéro de téléphone : 0557439912</p><p>- La wilaya de : Oran</p><p>- La commune : Oran</p><table><tr><th>Produit</th><th>Q</th><th>Prix</th></tr><tr><td>Dell Latitude 5490</td><td>1</td><td>48800</td></tr></table><div>Prix total de la commande :</div><div>48800 DZD</div><div>Type de livraison :</div><div>Livraison à domicile</div><div>Prix de livraison :</div><div>600 DZD</div><div>Prix de vente :</div><div>50400 DZD</div></div>` }));
    await fv.goto('https://freevendor.space/home/account');
    await fv.evaluate(c => (0, eval)(c), code);
    await fv.waitForFunction(() => /أُرسلت/.test(document.body.innerText), null, { timeout: 15000 });
    for (const d of [phone, pc]) await d.p.evaluate(() => pollInbox());
    await phone.p.waitForFunction(() => S.entries.some(e => e.vonderId === '000990001'), null, { timeout: 10000 });
    eq('طلبية FreeVendor وصلت للهاتف والحاسوب', [await phone.p.evaluate(() => S.entries.filter(e => e.vonderId === '000990001').length), await pc.p.evaluate(() => S.entries.filter(e => e.vonderId === '000990001').length)], [1, 1]);
    eq('المنتج سُجّل وحده بسعر البيع', await phone.p.evaluate(() => catalogGet('Dell Latitude 5490')?.price), 48800);
    for (const d of [phone, pc]) await d.p.evaluate(() => cloudSync());
    for (const d of [phone, pc]) await d.p.evaluate(() => cloudSync());
    eq('بعد المزامنة: نسخة واحدة للطلبية على الجهازين', [await phone.p.evaluate(() => S.entries.filter(e => e.vonderId === '000990001').map(e => e.id)), await pc.p.evaluate(() => S.entries.filter(e => e.vonderId === '000990001').map(e => e.id))], [['fv-000990001'], ['fv-000990001']]);
    // تأكيد عبر واتساب من البداية للنهاية: طلبية بانتظار التأكيد ← رسالة تلقائية ← الزبون يضغط «نعم» ← مؤكدة في كناش
    const g0n = graphHits.length;
    await phone.p.evaluate(async () => { await waRefresh(); S.settings.autoWA = true; saveSettings(); });
    await phone.p.evaluate(() => receiveFv({ rows: [{ id: '000990002', status: ['En attente de confirmation'], prices: ['2500', '400', '2900', '3200'], seller: '300', name: 'ياسين', phone: '0698765432', wilaya: 'Oran',
      detail: { client: 'ياسين بلقاسم', phone: '0698765432', wilaya: 'Oran', commune: 'Es Senia', items: [{ name: 'Écouteurs sans fil', qty: 1, price: 2500 }], total: 2500, fee: 400, sale: 3200, delivery: 'Livraison à domicile' } }] }));
    for (let i = 0; i < 30 && graphHits.length === g0n; i++) await new Promise(r => setTimeout(r, 200));
    const gh = graphHits.at(-1);
    eq('رسالة واتساب أُرسلت وحدها للطلبية الجديدة', [graphHits.length - g0n, gh?.body.to, gh?.body.template.components[0].parameters.map(x => x.text)], [1, '213698765432', ['ياسين', 'كناش', 'Écouteurs sans fil', '3 200', 'وهران']]);
    await hook(msg({ from: '213698765432', type: 'button', context: { id: 'wamid.T' + graphHits.length }, button: { text: 'نعم، أكّد الطلبية', payload: 'نعم، أكّد الطلبية' } }));
    await phone.p.evaluate(() => cloudSync()); await pc.p.evaluate(() => cloudSync());
    await pc.p.evaluate(async () => { await waRefresh(); await pollWaResults(); });
    eq('الزبون ضغط «نعم» ← مؤكدة في كناش وجاهزة للرفع', await pc.p.evaluate(() => { const e = S.entries.find(x => x.vonderId === '000990002'); return [e.status, e.confirm.via, readyToPush().includes(e)]; }), ['pending', 'whatsapp', true]);
    // تفعيل مراقبة السحابة يرسل مفاتيح Yalidine إلى الـWorker
    await phone.p.evaluate(async () => { S.carrier.apiId = '777'; S.carrier.apiToken = 'tk'; await serverNotify(true); });
    eq('المراقبة من السحابة مفعّلة', await (await call('/__kanach/config')).json().then(c => [c.notify, c.yalidine]), [true, true]);
    eq('التطبيق يرسل قائمة المتابعة الصغيرة', await phone.p.evaluate(async () => { S.entries.unshift({ id: 'w1', type: 'vonder', status: 'pending', tracking: 'yal-WWW999', amount: 700, date: iso(), desc: 'رضا 0550000000' }); persist(); sendWatch.last = ''; await sendWatch(); const r = await kcFetch('/config'); return sendWatch.last.includes('yal-WWW999') && sendWatch.last.includes('"n":"رضا"') && r.ok; }), true);
    eq('عامل الخدمة مسجّل (تطبيق قابل للتثبيت)', await phone.p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())), true);
    eq('قسم الهاتف يُعرض', await phone.p.evaluate(() => { go('settings', { scrollTo: 'sec-app' }); return /رابط كناش/.test(document.getElementById('sec-app').innerText); }), true);
    eq('بلا أخطاء في الصفحات', [...phone.errs, ...pc.errs], []);
    await browser.close();
  } catch (e) { failed++; console.error('✗ استثناء:', e, '\n--- wrangler ---\n', log.slice(-2000)); }
  wr.kill(); mock.close();
  console.log(`\n${passed} نجح • ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})();
