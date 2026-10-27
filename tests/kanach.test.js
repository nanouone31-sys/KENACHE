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
  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'kanach-proxy.js')], { env: { ...process.env, PORT } });
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
    eq('calcVonder: سعر الزبون', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, extra: 0 }); return [c.totalCost, c.finalPrice, c.sellPrice]; }), [12802, 13850, 15000]);
    eq('calcVonder: التوصيل على البائع يُخصم', await page.evaluate(() => calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, fee: 850, payer: 'me' }).netProfit), 198);
    eq('calcVonder: التوصيل على الزبون لا يُخصم', await page.evaluate(() => { const c = calcVonder({ price: 11700, qty: 1, myProfit: 1048, seller: 1150, fee: 850, payer: 'customer' }); return [c.netProfit, c.customerPays]; }), [1048, 15850]);
    eq('الحاسبة العكسية', await page.evaluate(() => Math.round(solveCalc({ mode: 'rev', sell: 15000, price: 11700, qty: 1, seller: 1150, extra: 0, wid: '', type: 'home' }).mpPiece)), 1048);
    eq('أقصى سعر للمنتج', await page.evaluate(() => Math.round(solveCalc({ mode: 'max', sell: 15000, target: 1048, qty: 1, seller: 1150, extra: 0, wid: '', type: 'home' }).price)), 11700);
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
    await page.evaluate(() => { S.entries = []; S.deleted = {}; resetSigs(); S.settings.feePayer = 'me'; persist(); render(); });
    await page.click('#fab');
    await page.click('summary:has-text("لصق رسالة الزبون")');
    await page.fill('[data-f=paste]', 'الاسم: سمير\nالهاتف: 0770112233\nالولاية: وهران');
    eq('النموذج: الوصف من الرسالة', await page.inputValue('[data-f=desc]'), 'سمير 0770112233');
    eq('النموذج: الولاية من الرسالة', await page.inputValue('select[data-f=wid]'), '31');
    await page.click('#formSave');
    eq('الطلبية المحفوظة', await page.evaluate(() => { const e = S.entries[0]; return [e.ship.wilaya, e.yalidineInfo.phone, e.grossProfit, Math.round(e.amount)]; }), ['Oran', '0770112233', 1048, 198]);

    // ---- الحفظ في IndexedDB يبقى بعد إعادة التحميل ----
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForFunction(() => typeof S !== 'undefined' && S.entries.length > 0);
    eq('IndexedDB بعد إعادة التحميل', await page.evaluate(() => S.entries[0].desc), 'سمير 0770112233');

    // ---- المعايرة ----
    eq('calibrateFees يكتشف خصم التوصيل', await page.evaluate(() => {
      for (let i = 0; i < 4; i++) S.entries.push({ id: 'c' + i, type: 'vonder', status: 'delivered', isActualProfit: true, netSource: 'excel', sellPrice: 15000, netClient: 14150 - (i % 2) * 10, date: iso(), ship: { wilaya: 'Oran', type: 'home' } });
      const c = calibrateFees(); return [c.n, c.verdict, c.clean];
    }), [4, 'me', true]);

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
      await p2.evaluate(() => localStorage.setItem('dailyEntries_v2', JSON.stringify([{ id: 'old1', type: 'vonder', status: 'pending', date: '2026-10-01', desc: 'قديمة', amount: 1048, myProfit: 1048, quantity: 1 }])));
      await p2.goto(URL);
      await p2.waitForFunction(() => typeof S !== 'undefined' && S.entries.length);
      eq('ترحيل localStorage ← IndexedDB', await p2.evaluate(async () => [S.entries[0].id, (await IDB.get('entries'))[0].id, Math.round(S.entries[0].amount)]), ['old1', 'old1', 1048]);
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
  } catch (e) { failed++; console.error('✗ استثناء:', e); }
  await browser.close(); proxy.kill();
  console.log(`\n${passed} نجح • ${failed} فشل`);
  process.exit(failed ? 1 : 0);
})();
