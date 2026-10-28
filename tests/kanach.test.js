// اختبارات كناش في متصفح حقيقي (Chromium عبر Playwright).
// التشغيل: node tests/kanach.test.js   — يشغّل الوسيط على منفذ مؤقت ويفتح التطبيق منه.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18787 + Math.floor(Math.random() * 500);
const URL = `http://localhost:${PORT}/`;
let failed = 0, passed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`}`);
};

(async () => {
  const inboxFile = path.join(require('os').tmpdir(), `kanach-inbox-${PORT}-${Date.now()}.json`);
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'kanach-proxy.js')], { env: { ...process.env, PORT, KANACH_INBOX: inboxFile } });
  await new Promise(r => proxy.stdout.once('data', r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ar-DZ' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|fonts\.g/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(URL);
    await page.waitForFunction(() => typeof S !== 'undefined' && document.querySelector('#view').children.length);

    // ---- الحساب ----
    eq('calcVonder: سعر الزبون', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, extra: 0 }); return [c.totalCost, c.finalPrice, c.sellPrice]; }), [12402, 13450, 14600]);
    // أدرار منزل، سعر 11700: سعر الزبون 14600؛ الزبون يدفع 1000 لـFreeVendor، Yalidine يقتطع 1400 + 0.75% من 15600 = 117 → عليك 517
    eq('calcVonder: فرق التوصيل + 0.75% (أدرار منزل)', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, wid: 1, type: 'home' });
      return [Math.round(c.sellPrice), c.delivery.fv, c.delivery.yal, c.delivery.cod, c.delivery.cost, c.netProfit, c.customerPays]; }), [14600, 1000, 1400, 117, 517, 531, 15600]);
    eq('calcVonder: الجزائر مكتب', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, wid: 16, type: 'desk' }); return [c.delivery.fv, c.delivery.yal, c.delivery.cost]; }), [300, 400, 100 + 0.0075 * 14900]);
    eq('ولاية غير متوفرة عند FreeVendor', await page.evaluate(() => calcVonder({ price: 1, qty: 1, myProfit: 1, seller: 0, wid: 56 }).delivery.unavailable), true);
    eq('Net من النموذج يعطي نفس الفائدة', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, wid: 31, type: 'home' });
      const net = c.sellPrice + c.delivery.fv - c.delivery.yal - c.delivery.cod; return Math.round(realProfit(net, c.totalCost - c.buffer, c.seller)) === Math.round(c.netProfit); }), true);
    eq('الحاسبة العكسية', await page.evaluate(() => Math.round(solveCalc({ mode: 'rev', sell: 14600, price: 11700, qty: 1, seller: 1150, extra: 0, wid: 1, type: 'home' }).mpPiece)), 1048);
    eq('أقصى سعر للمنتج يحقق الصافي المطلوب', await page.evaluate(() => { const x = solveCalc({ mode: 'max', sell: 14600, target: 531, qty: 1, seller: 1150, extra: 0, wid: 1, type: 'home' }); return [Math.round(x.price), Math.round(x.netProfit)]; }), [11700, 531]);
    eq('القيمة المتوقعة ونقطة التعادل', await page.evaluate(() => [expectedValue(1000, 0.8, 250), Math.round(breakEvenRate(1000, 250) * 100)]), [750, 20]);

    // ---- الولايات ----
    eq('wilayaIdOf', await page.evaluate(() => ['وهران', 'Oran', '16 - Alger', 'الجزائر العاصمة', "wilaya de Sétif", 'عين الدفلى', 'Bordj Bou Arreridj', 'تيزي وزو', 'أم البواقي', 'البليدة', 'مدينة لا توجد'].map(t => wilayaIdOf(t))), [31, 31, 16, 16, 19, 44, 34, 15, 4, 9, 0]);

    // ---- لصق رسالة الزبون ----
    eq('parse: رسالة بعناوين', await page.evaluate(() => parseCustomerMsg('الاسم: محمد بن علي\nالهاتف: 0550 12 34 56\nالولاية: وهران\nالبلدية: بئر الجير')), { phone: '0550123456', name: 'محمد بن علي', wid: 31 });
    eq('parse: رسالة حرّة', await page.evaluate(() => parseCustomerMsg('سلام نحب نطلب\nكريم بوزيد\n+213 661 23 45 67\nسطيف')), { phone: '0661234567', name: 'كريم بوزيد', wid: 19 });

    // ---- دمج المزامنة ----
    eq('mergeById', await page.evaluate(() => mergeById(
      [{ id: 'a', v: 'local-new', updatedAt: '2026-10-02' }, { id: 'b', v: 'local-old', updatedAt: '2026-10-01' }, { id: 'd', v: 'deleted-elsewhere', updatedAt: '2026-10-01' }],
      [{ id: 'a', v: 'remote-old', updatedAt: '2026-10-01' }, { id: 'b', v: 'remote-new', updatedAt: '2026-10-03' }, { id: 'c', v: 'remote-only' }],
      { d: '2026-10-05' }).map(x => x.v).sort()), ['local-new', 'remote-new', 'remote-only']);
    eq('persist يختم التعديل ويسجّل الحذف', await page.evaluate(() => {
      S.entries = [{ id: 'x1', type: 'expense', desc: 'a', amount: 1, date: iso() }, { id: 'x2', type: 'expense', desc: 'b', amount: 2, date: iso() }]; resetSigs();
      S.entries[0].amount = 5; S.entries = S.entries.filter(e => e.id !== 'x2'); persist();
      return [!!S.entries[0].updatedAt, !!S.deleted.x2];
    }), [true, true]);

    // ---- نموذج الإضافة: لصق + ولاية + خصم التوصيل ----
    await page.evaluate(() => { S.entries = []; S.deleted = {}; resetSigs(); persist(); render(); });
    await page.click('#fab');
    await page.click('summary:has-text("لصق رسالة الزبون")');
    await page.fill('[data-f=paste]', 'الاسم: سمير\nالهاتف: 0770112233\nالولاية: وهران');
    eq('النموذج: الوصف من الرسالة', await page.inputValue('[data-f=desc]'), 'سمير 0770112233');
    eq('النموذج: الولاية من الرسالة', await page.inputValue('select[data-f=wid]'), '31');
    await page.click('#formSave');
    eq('الطلبية المحفوظة', await page.evaluate(() => { const e = S.entries[0]; return [e.ship.wilaya, e.yalidineInfo.phone, e.grossProfit, e.buffer, Math.round(e.sellPrice), Math.round(e.amount)]; }), ['Oran', '0770112233', 1048, 0, 14600, 684]);

    // ---- الحفظ في IndexedDB يبقى بعد إعادة التحميل ----
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForFunction(() => typeof S !== 'undefined' && S.entries.length > 0);
    eq('IndexedDB بعد إعادة التحميل', await page.evaluate(() => S.entries[0].desc), 'سمير 0770112233');

    // ---- المعايرة ----
    eq('التحقق من Net الحقيقي يطابق النموذج', await page.evaluate(() => {
      // وهران منزل: 15000 + 600 − 850 − 0.75%×15600 (117) = 14633
      for (let i = 0; i < 4; i++) S.entries.push({ id: 'c' + i, type: 'vonder', status: 'delivered', isActualProfit: true, netSource: 'excel', sellPrice: 15000, netClient: 14633 - (i % 2) * 10, date: iso(), ship: { wilaya: 'Oran', type: 'home' } });
      const c = calibrateFees(); return [c.n, c.verdict];
    }), [4, 'ok']);

    // ---- اتصل اليوم ----
    eq('callList + رسالة واتساب', await page.evaluate(() => {
      S.entries.push({ id: 'k1', type: 'vonder', status: 'pending', date: iso(), desc: 'ليلى', tracking: 'yal-ABC123', sellPrice: 9000, yalidineInfo: { clientName: 'ليلى حداد', phone: '0555443322' }, carrier: { stage: 'failed', status: 'Tentative échouée' } });
      const l = callList(); return [l.length, l[0].why, waLink(l[0].phone, callMsg(l[0])).startsWith('https://wa.me/213555443322?text=')];
    }), [1, 'risk', true]);

    // ---- كل الشاشات تُعرض بلا أخطاء + Escape يغلق النافذة ----
    for (const tab of ['home', 'orders', 'calc', 'carrier', 'reports', 'settings']) await page.evaluate(t => go(t), tab);
    for (const r of ['summary', 'customers', 'budget', 'assistant']) await page.evaluate(t => go('reports', { rTab: t }), r);
    await page.evaluate(() => openCallList());
    await page.keyboard.press('Escape');
    eq('Escape يغلق النافذة', await page.evaluate(() => Sheet.isOpen()), false);
    eq('أخطاء في الكونسول', errors, []);

    // ---- ترحيل بيانات النسخة القديمة (localStorage) إلى IndexedDB ----
    {
      const c2 = await browser.newContext(), p2 = await c2.newPage();
      await p2.goto(URL + '__kanach'); // نفس الأصل لنكتب localStorage قبل فتح التطبيق
      await p2.evaluate(() => {
        localStorage.setItem('kanach_settings_v1', JSON.stringify({ fixedFee: 400, appFeePct: 6, feePayer: 'unset' }));
        localStorage.setItem('dailyEntries_v2', JSON.stringify([
          { id: 'old1', type: 'vonder', status: 'pending', date: '2026-10-01', desc: 'قديمة', amount: 1048, myProfit: 1048, quantity: 1, productPrice: 11700, extraFee: 0, totalCost: 12802, sellPrice: 15000, ship: { wilaya: 'Adrar', type: 'home' } },
          { id: 'old2', type: 'vonder', status: 'delivered', isActualProfit: true, netClient: 14000, netSource: 'excel', date: '2026-09-01', desc: 'مُسلَّمة', amount: 48, myProfit: 1048, quantity: 1, productPrice: 11700, extraFee: 0, totalCost: 12802, sellerProfit: 1150, sellPrice: 15000 }]));
      });
      await p2.goto(URL);
      await p2.waitForFunction(() => typeof S !== 'undefined' && S.entries.length);
      eq('ترحيل localStorage ← IndexedDB', await p2.evaluate(async () => [S.entries[0].id, (await IDB.get('entries'))[0].id]), ['old1', 'old1']);
      // معلّقة أدرار: 1048 + هامش 400 القديم (يبقى له) − (1400 − 1000 + 0.75%×16000=120) = 928 • مُسلَّمة: 14000 − (12802 − 400) − 1150 = 448
      eq('ترحيل v5: إلغاء 400 وتصحيح الفوائد', await p2.evaluate(() => [S.settings.fixedFee, S.settings.v, Math.round(S.entries[0].amount), Math.round(S.entries[1].amount), readJSON('kanach_mig5', {}).n]), [0, 6, 928, 448, 2]);
      await c2.close();
    }

    // ---- مزامنة جهازين عبر JSONBin وهمي: لا يضيع تعديل أي منهما ----
    {
      let bin = { entries: [{ id: 'shared', type: 'expense', desc: 'مشترك', amount: 100, date: '2026-10-01', updatedAt: '2026-10-01T00:00:00.000Z' }], budgetExp: [], budgets: {}, deleted: {}, deletedB: {}, device: 'other' };
      let puts = 0;
      const mkDevice = async () => {
        const c = await browser.newContext(), p = await c.newPage();
        await p.route('https://api.jsonbin.io/**', async r => {
          if (r.request().method() === 'PUT') { bin = JSON.parse(r.request().postData()); puts++; return r.fulfill({ json: { ok: true } }); }
          return r.fulfill({ json: bin });
        });
        await p.goto(URL + '__kanach');
        await p.evaluate(() => { localStorage.setItem('jsonbin_key', 'k'); localStorage.setItem('jsonbin_id', 'b'); });
        await p.goto(URL);
        await p.waitForFunction(() => typeof S !== 'undefined' && S.entries.some(e => e.id === 'shared'));
        return { c, p };
      };
      const A = await mkDevice(), B = await mkDevice();
      // كلاهما يعدّل قبل أن يرى تعديل الآخر (أوفلاين ثم رجع)
      await A.p.evaluate(() => { S.entries.unshift({ id: 'fromA', type: 'expense', desc: 'من الهاتف', amount: 1, date: iso() }); persist(); });
      await B.p.evaluate(() => { S.entries.unshift({ id: 'fromB', type: 'expense', desc: 'من الحاسوب', amount: 2, date: iso() }); S.entries = S.entries.filter(e => e.id !== 'shared'); persist(); });
      await A.p.evaluate(() => cloudSync()); await A.p.waitForFunction(() => !CLOUD.busy);
      await B.p.evaluate(() => cloudSync()); await B.p.waitForFunction(() => !CLOUD.busy);
      await A.p.evaluate(() => cloudSync()); await A.p.waitForFunction(() => !CLOUD.busy);
      const ids = async p => p.evaluate(() => S.entries.map(e => e.id).sort());
      eq('مزامنة: الهاتف يرى الكل', await ids(A.p), ['fromA', 'fromB']);
      eq('مزامنة: الحاسوب يرى الكل', await ids(B.p), ['fromA', 'fromB']);
      eq('مزامنة: السحابة مطابقة والحذف انتشر', bin.entries.map(e => e.id).sort(), ['fromA', 'fromB']);
      const before = puts; await A.p.evaluate(() => cloudSync()); await A.p.waitForFunction(() => !CLOUD.busy);
      eq('مزامنة: لا رفع عندما لا جديد', puts, before);
      await A.c.close(); await B.c.close();
    }

    // ---- FreeVendor ← قارئ الصفحة ← الوسيط ← كناش ← Yalidine (صفحة FreeVendor مقلَّدة من لقطات الشاشة) ----
    {
      const row = (id, prices, status, client, seller) => `<tr><td><span class="b">#000${id}</span></td><td>${prices.map(p => `<div>${p} DZD</div>`).join('')}</td>
        <td><button>${status}</button><button>Note</button></td><td>${client.join('<br>')}</td><td><span>${seller} DZD</span></td><td><button class="eye" onclick="openM('${id}')"><i>👁</i></button></td></tr>`;
      // نافذة 1: زر إغلاق بأيقونة بلا نص (مثل FreeVendor) • نافذة 2: لا زر، تُغلق بالنقر على الخلفية فقط
      const modal = (id, d, how) => `<div id="m${id}" class="modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4)" ${how === 'backdrop' ? `onclick="if(event.target===this)this.style.display='none'"` : ''}><div class="dlg" style="background:#fff;margin:40px;padding:20px">
        ${how === 'icon' ? `<button type="button" class="btn-x" onclick="document.getElementById('m${id}').style.display='none'"><i class="fa fa-times"></i></button>` : ''}
        <button>Imprimer</button><p>- Numéro de commande : #000${id}</p><p>- Statut : <span>Annulé</span></p><p>- Informations client :</p>
        <p>- Client : ${d.client}</p><p>- Numéro de téléphone : ${d.phone}</p><p>- La wilaya de : ${d.wilaya}</p><p>- La commune : ${d.commune}</p><p>- L'adresse : ${d.address}</p><p>- Questions et remarques : /</p>
        <table><tr><th>Produit</th><th>Quantité</th><th>Prix</th><th>Prix de cet quantité</th><th>Plus d'informations</th></tr><tr><td>${d.product}</td><td>1</td><td>${d.total}</td><td>${d.total} DZD</td><td>- Taille:<br>- Couleur:</td></tr></table>
        <div style="display:flex;justify-content:space-between"><div>Prix total de la commande :</div><div>${d.total} DZD</div></div>
        <div style="display:flex;justify-content:space-between"><div>Type de livraison :</div><div>${d.type}</div></div>
        <div style="display:flex;justify-content:space-between"><div>Prix de livraison :</div><div>${d.fee} DZD</div></div>
        <div style="display:flex;justify-content:space-between"><div>Prix total :</div><div>${d.total + d.fee} DZD</div></div>
        <div style="display:flex;justify-content:space-between"><div>Prix de vente :</div><div>${d.total + d.fee + d.seller} DZD</div></div></div></div>`;
      const D1 = { client: 'nawal fetouh', phone: '0557439912', wilaya: 'Oran', commune: 'Oran', address: 'hai el hamri', product: 'Dell Laptop | Intel Core i3 10th Gen - 8GB RAM', total: 48800, fee: 600, seller: 1000, type: 'Livraison à domicile' };
      const D2 = { client: 'هادي حسن', phone: '0668882231', wilaya: 'médéa', commune: 'Médéa', address: 'centre', product: 'HP EliteBook', total: 44000, fee: 350, seller: 1350, type: 'Stop desk' };
      const html = `<!doctype html><meta charset="utf-8"><body><table><tr><th>Numéro de commande</th><th>Prix total</th><th>Statut</th><th>Le client</th><th>Le vendeur</th><th>Options</th></tr>
        ${row('585899', [48800, 600, 49400, 50400], 'Confirmè avec le client', ['nawal fetouh', '0557439912', 'Oran'], 1000)}
        ${row('585893', [44000, 550, 44550, 45550], 'Annulé', ['هادي حسن', '0668882231', 'médéa'], 1000)}
        ${row('585888', [44000, 350, 44350, 45700], 'Confirmè avec le client', ['هادي حسن', '0668882231', 'médéa'], 1350)}
        </table>${modal('585899', D1, 'icon')}${modal('585888', D2, 'backdrop')}<script>function openM(id){document.getElementById('m'+id).style.display='block'}</script>`;
      const fv = await ctx.newPage();
      await fv.route('https://freevendor.space/**', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await fv.goto('https://freevendor.space/home/account');
      const codeFor = cfg => page.evaluate(c => decodeURIComponent(fvBookmarklet().slice('javascript:'.length)).replace(/\)\(\{.*\}\)$/, ')(' + JSON.stringify(c) + ')'), cfg);
      eq('القارئ يعرف الوسيط المحلي', await page.evaluate(() => KANACH_PROXY === location.origin), true);
      const appURL = URL;
      fv.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
      const run = async cfg => { await fv.goto('https://freevendor.space/home/account'); await fv.evaluate(c => (0, eval)(c), await codeFor(cfg)); };
      // 1) كناش مفتوح من رابط http: زر «افتح كناش وأرسل» يسلّم الطلبيات بـ postMessage (بلا إذن الشبكة المحلية)
      await page.evaluate(() => { S.entries = []; S.deleted = {}; resetSigs(); persist(); });
      await run({ inbox: '', app: appURL });
      await fv.waitForSelector('text=افتح كناش وأرسل', { timeout: 15000 });
      eq('القراءة كاملة رغم نافذة بلا نص إغلاق', await fv.evaluate(() => document.body.innerText.includes('قُرئت 2 طلبية مؤكدة') && !document.body.innerText.includes('تعذّرت')), true);
      const [kan] = await Promise.all([ctx.waitForEvent('page'), fv.click('text=افتح كناش وأرسل')]);
      await fv.waitForFunction(() => /وصلت/.test(document.body.innerText), null, { timeout: 15000 });
      eq('postMessage: الطلبيات وصلت لتبويب كناش', await kan.evaluate(() => S.entries.map(e => e.vonderId).sort()), ['000585888', '000585899']);
      await kan.close();
      await page.waitForFunction(() => S.entries.length === 2, null, { timeout: 5000 });
      eq('التبويب الآخر حدّث نفسه (BroadcastChannel)', await page.evaluate(() => S.entries.map(e => e.vonderId).sort()), ['000585888', '000585899']);
      // 2) كناش مفتوح من ملف (file://) بلا وسيط: «نسخ إلى كناش» ثم «لصق من FreeVendor»
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://freevendor.space' });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appURL.replace(/\/$/, '') });
      await page.evaluate(() => { S.entries = []; S.deleted = {}; resetSigs(); persist(); });
      await run({ inbox: '', app: '' });
      await fv.waitForSelector('text=نسخ إلى كناش', { timeout: 15000 });
      eq('بلا رابط لكناش لا يظهر زر الفتح', await fv.locator('text=افتح كناش وأرسل').count(), 0);
      await fv.click('text=نسخ إلى كناش');
      await fv.waitForFunction(() => /نُسخت/.test(document.body.innerText), null, { timeout: 5000 });
      await page.bringToFront();
      await page.evaluate(() => A['fv-paste']());
      await page.waitForFunction(() => S.entries.length === 2, null, { timeout: 5000 });
      eq('الحافظة: الطلبيات وصلت', await page.evaluate(() => S.entries.map(e => e.vonderId).sort()), ['000585888', '000585899']);
      // 3) مع إذن الشبكة المحلية: إرسال مباشر إلى الوسيط ثم يلتقطها كناش من صندوق الوارد
      await ctx.grantPermissions(['local-network-access'], { origin: 'https://freevendor.space' });
      await run({ inbox: appURL.replace(/\/$/, ''), app: appURL });
      await fv.waitForFunction(() => /أُرسلت/.test(document.body.innerText), null, { timeout: 15000 });
      await fv.close();
      await page.route('**/fakeworker/**', r => r.fulfill({ status: 400, json: { error: { message: 'Invalid API ID format. It must be numeric and up to 20 characters.', code: 400 } } }));
      // 4) Cloudflare Worker كوسيط: ليس وسيط كناش، فلا استطلاع لصندوق الوارد ولا رسالة «الوسيط قديم»
      eq('Worker لا يُعامَل كوسيط كناش', await page.evaluate(async () => {
        const keep = [SAME_ORIGIN_PROXY, S.carrier.proxy]; SAME_ORIGIN_PROXY = false; S.carrier.proxy = location.origin + '/fakeworker';
        const k = await detectKanachProxy(); let threw = false; try { await Carrier.checkProxy(); } catch { threw = true; }
        [SAME_ORIGIN_PROXY, S.carrier.proxy] = keep; await detectKanachProxy(); return [k, threw];
      }), ['', false]);
      // Yalidine وهمي: نتحقق مما يُرسَل فعلاً
      const sent = [];
      await page.route(/\/(wilayas|communes|centers|parcels)\//, async r => {
        const u = new globalThis.URL(r.request().url());
        if (u.pathname.startsWith('/wilayas')) return r.fulfill({ json: { has_more: false, data: [{ id: 31, name: 'Oran' }, { id: 26, name: 'Médéa' }] } });
        if (u.pathname.startsWith('/communes')) return r.fulfill({ json: { has_more: false, data: u.searchParams.get('wilaya_id') === '31' ? [{ id: 3101, name: 'Oran', is_deliverable: true }, { id: 3102, name: 'Bir El Djir', is_deliverable: true }] : [{ id: 2601, name: 'Médéa', is_deliverable: true }, { id: 2602, name: 'Berrouaghia', is_deliverable: true }] } });
        if (u.pathname.startsWith('/centers')) return r.fulfill({ json: { has_more: false, data: [{ center_id: 26101, name: 'Agence de Médéa', commune_id: 2601, commune_name: 'Médéa', wilaya_id: 26 }, { center_id: 26102, name: 'Agence Berrouaghia', commune_id: 2602, commune_name: 'Berrouaghia', wilaya_id: 26 }] } });
        if (r.request().method() === 'POST') { const body = JSON.parse(r.request().postData()); sent.push(...body); return r.fulfill({ json: Object.fromEntries(body.map(p => [p.order_id, { success: true, order_id: p.order_id, tracking: 'yal-T' + p.order_id }])) }); }
        return r.fulfill({ json: { data: [] } });
      });
      await page.evaluate(() => { S.entries = []; S.deleted = {}; resetSigs(); localStorage.removeItem('kanach_inbox_after'); S.carrier.apiId = 'id'; S.carrier.apiToken = 'tok'; S.settings.autoPush = false; catalogSet('Dell Laptop | Intel Core i3 10th Gen - 8GB RAM', 45000, 2); persist(); });
      await page.evaluate(() => pollInbox());
      await page.waitForFunction(() => S.entries.length === 2, null, { timeout: 5000 });
      eq('FreeVendor: المؤكدة فقط وصلت', await page.evaluate(() => S.entries.map(e => e.vonderId).sort()), ['000585888', '000585899']);
      // Dell: سعر التطبيق 48800، سعر الزبون 49800، المحصَّل 50400؛ الشراء 45000 → تكلفة 47700 → فائدتي 1100
      // التوصيل: Yalidine وهران 850 − FreeVendor 600 + 0.75%×50400 (378) = 628 → صافي 472
      eq('تسعير طلبية FreeVendor بسعر شراء معروف', await page.evaluate(() => { const e = S.entries.find(x => x.vonderId === '000585899');
        return [e.finalPrice, e.sellPrice, e.ship.price, e.ship.fvFee, e.ship.type, e.ship.weight, Math.round(e.grossProfit), Math.round(e.amount), e.profitAssumed]; }), [48800, 49800, 50400, 600, 'home', 2, 1100, 472, false]);
      eq('طلبية بلا سعر شراء: فائدة افتراضية + مكتب', await page.evaluate(() => { const e = S.entries.find(x => x.vonderId === '000585888'); return [e.profitAssumed, e.ship.type, e.ship.price, e.sellPrice]; }), [true, 'desk', 45700, 45350]);

      await page.evaluate(() => { S.settings.autoPush = true; });
      const res = await page.evaluate(() => autoPush());
      eq('الرفع التلقائي: 2 طرد (منزل + مكتب)', res, { ok: 2, wait: 0 });
      const p1 = sent.find(x => x.order_id === '000585899'), p2 = sent.find(x => x.order_id === '000585888');
      eq('الطرد: Prix du colis = Prix de vente + Livraison gratuite', [p1.price, p1.freeshipping, p1.is_stopdesk, p1.to_wilaya_name, p1.to_commune_name, p1.contact_phone, p1.firstname, p1.familyname, p1.weight], [50400, true, false, 'Oran', 'Oran', '0557439912', 'nawal', 'fetouh', 2]);
      eq('طرد المكتب: المكتب وبلديته', [p2.is_stopdesk, p2.stopdesk_id, p2.to_commune_name, p2.price, p2.weight], [true, 26101, 'Médéa', 45700, 1]);
      eq('أرقام التتبع حُفظت', await page.evaluate(() => S.entries.map(e => e.tracking).sort()), ['yal-T000585888', 'yal-T000585899']);
      await page.unroute(/\/(wilayas|communes|centers|parcels)\//);
    }
  } catch (e) { failed++; console.error('✗ استثناء:', e); }
  await browser.close(); proxy.kill(); try { require('fs').unlinkSync(inboxFile); } catch {}
  console.log(`\n${passed} نجح • ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})();
