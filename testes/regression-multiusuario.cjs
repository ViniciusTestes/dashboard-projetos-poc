/* Interface integration test with six isolated browsers and an in-memory mock backend.
 * Does not connect to Supabase or prove RLS/PostgreSQL persistence. Run from /workspace:
 * npm install playwright
 * node teste-multiusuario.cjs
 * Optional: CHROMIUM_PATH=/path/to/chromium DASHBOARD_DIR=/path/to/package node teste-multiusuario.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const deliverable = process.env.DASHBOARD_HTML || 'index.html';
const deliveryDir = process.env.DASHBOARD_DIR || (fs.existsSync(path.resolve(__dirname, '..', deliverable)) ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../output'));
const chromiumPath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const sourceRows = Array.from({ length: 6 }, (_, i) => ({
  salesforce_id: `SF-PROT-00${i + 1}`, nome: `Projeto fictício ${i + 1}`,
  gerencia_responsavel: `Gerência ${i % 3}`, gestor_projeto: `Gestor ${i + 1}`,
  oportunidade_crm: `OPP-${i + 1}`, fase_atual: 'Fase 1', atualizado_em: '2026-11-10',
  escopo: `Escopo fictício ${i + 1}`
}));
const originalSources = structuredClone(sourceRows);
const editRows = sourceRows.map(p => ({ salesforce_id: p.salesforce_id, dados: {}, versao: 1,
  atualizado_em: '2026-11-16T12:00:00Z', atualizado_por: null }));
const allPages = [];
const updateLog = [];
const errors = [];

function sdkInstall() {
  const handlers = [];
  let user = null; const authCallbacks = [];
  window.__mockNotifications = 0;
  window.__mockCreateCalls = 0;
  window.__mockAnonDataRequests = 0;
  window.__mockDataRequests = 0;
  window.__emitDatabase = payload => {
    window.__mockNotifications++;
    for (const h of handlers) if (h.kind === 'postgres_changes' && (!h.filter.table || h.filter.table === payload.table)) h.callback(payload);
  };
  window.supabase = {
    createClient(url, key) {
      window.__mockCreateCalls++;
      if(url !== 'https://test.supabase.co' || key !== 'sb_publishable_test')throw Error('The test must use the intercepted public configuration');
      const client = {
        auth: {
          async getUser() { return { data: { user }, error: user ? null : { message: 'No session' } }; },
          async getSession() { return { data: { session: user ? { access_token: `token-${user.id}`, user } : null } }; },
          async signInWithPassword({ email }) { user = { id: email.split('@')[0], email }; for(const cb of authCallbacks)cb('SIGNED_IN', { user, access_token: `token-${user.id}` }); return { data: { user, session: { user, access_token: `token-${user.id}` } }, error: null }; },
          onAuthStateChange(cb) { authCallbacks.push(cb); return { data: { subscription: { unsubscribe() { const i=authCallbacks.indexOf(cb);if(i>=0)authCallbacks.splice(i,1); } } } }; },
          async signOut() { user = null; for(const cb of authCallbacks)cb('SIGNED_OUT', null); return { error: null }; }
        },
        async rpc(name) { window.__mockDataRequests++;if(!user)window.__mockAnonDataRequests++;return { data: Boolean(user), error: null }; },
        from(table) {
          window.__mockDataRequests++;if(!user)window.__mockAnonDataRequests++;
          const filters = {};
          let payload, single = false;
          const query = {
            select() { return query; }, order() { return query; },
            eq(k, v) { filters[k] = v; return query; },
            update(value) { payload = value; return query; },
            single() { single = true; return query; }, maybeSingle() { single = true; return query; },
            then(resolve, reject) { return window.__mockDB({ table, filters, payload, single, user }).then(resolve, reject); }
          };
          return query;
        },
        channel(name) {
          const channel = { name,
            on(kind, filter, callback) { handlers.push({ kind, filter, callback, channel }); return channel; },
            subscribe(cb) { setTimeout(() => cb?.('SUBSCRIBED'), 0); return channel; },
            unsubscribe() { for (let i=handlers.length-1;i>=0;i--) if(handlers[i].channel===channel)handlers.splice(i,1); return Promise.resolve('ok'); }
          };
          return channel;
        },
        removeChannel(channel) { return channel.unsubscribe(); },
        removeAllChannels() { handlers.length = 0; return Promise.resolve([]); },
        realtime: { setAuth() {} }
      };
      return client;
    }
  };
}

async function emit(table, row, old) {
  const payload = { schema: 'public', table, eventType: 'UPDATE', new: structuredClone(row), old: structuredClone(old) };
  await Promise.all(allPages.filter(p => !p.isClosed()).map(p => p.evaluate(p => window.__emitDatabase?.(p), payload)));
}
function afterUpdate(table, row, old) {
  setTimeout(() => emit(table, row, old).catch(e => errors.push(e.message)), 25);
}
async function execute(request) {
  const { table, payload, filters, single, user } = request;
  if (!user) return { data: null, error: { message: 'Unauthenticated mock request' } };
  if (payload) {
    assert.equal(table, 'edicoes_dashboard', 'only edits table can be written');
    assert.deepEqual(Object.keys(payload), ['dados'], 'client must only write JSONB dados');
    assert.ok(Object.hasOwn(filters, 'salesforce_id'));
    assert.ok(Object.hasOwn(filters, 'versao'));
    const row = editRows.find(e => e.salesforce_id === filters.salesforce_id && String(e.versao) === String(filters.versao));
    updateLog.push({ table, filters: structuredClone(filters), payload: structuredClone(payload), user: user.id, applied: Boolean(row) });
    if (!row) return { data: single ? null : [], error: null };
    const old = structuredClone(row);
    row.dados = structuredClone(payload.dados); row.versao++; row.atualizado_em = new Date().toISOString(); row.atualizado_por = user.id;
    afterUpdate(table, row, old);
    return { data: single ? structuredClone(row) : [structuredClone(row)], error: null };
  }
  const rows = table === 'projetos_salesforce' ? sourceRows : table === 'edicoes_dashboard' ? editRows : [];
  const selected = rows.filter(row => Object.entries(filters).every(([k,v]) => row[k] === v));
  return { data: single ? structuredClone(selected[0] || null) : structuredClone(selected), error: null };
}

async function openProject(page, index) {
  await page.evaluate(index => openProject(index), index);
  await page.locator('#detail').waitFor({ state: 'visible' });
}
async function save(page) {
  await page.locator('button[onclick="saveProject()"], #m365Save2').first().click();
}
async function waitPortfolio(page) { await page.locator('#portfolio').waitFor({ state: 'visible' }); }
async function waitSave(page) {
  // Realtime may replace the transient success label before the browser assertion runs.
  // Returning from the open detail to the portfolio requires a successful save;
  // callers additionally verify applied updates and incremented versions in the shared mock.
  await page.locator('#portfolio').waitFor({state:'visible'});
}
async function forceRefresh(page) {
  await page.locator('#m365Refresh').click();
  await page.waitForFunction(() => !document.querySelector('#detail').inert);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox'] });
  try {
    for (let i=0;i<6;i++) {
      const context = await browser.newContext();
      await context.exposeBinding('__mockDB', async (_source, request) => execute(request));
      await context.route('https://**', route => { errors.push('Unexpected network access blocked: '+route.request().url()); return route.abort(); });
      await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ body: `(${sdkInstall.toString()})();`, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' } }));
      await context.route('http://dashboard.test/**', route => {
        const name = new URL(route.request().url()).pathname.split('/').pop();
        if(name === 'supabase-config.js')return route.fulfill({contentType:'application/javascript',body:"window.SUPABASE_CONFIG={url:'https://test.supabase.co',publishableKey:'sb_publishable_test',pollIntervalMs:30000};"});
        const file = path.join(deliveryDir, name === 'dashboard.html' ? deliverable : (name || deliverable));
        let body = fs.readFileSync(file, 'utf8');
        if (!name.endsWith('.js')) body = body.replace(/<script\b[^>]*id=[\"']supabaseSdk[\"'][^>]*>[\s\S]*?<\/script>/, `<script id=\"supabaseSdk\">(${sdkInstall.toString()})();</script>`);
        return route.fulfill({ body, contentType: name.endsWith('.js') ? 'application/javascript' : 'text/html' });
      });
      const page = await context.newPage(); allPages.push(page);
      page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR:',error.message); });
      page.on('dialog', dialog => dialog.accept());
      await page.goto('http://dashboard.test/repositorio/dashboard.html');
      assert.equal(await page.locator('#configPanel, #configUrl, #configKey').count(),0, 'configuration fields must be absent');
      assert.equal(await page.locator('#authEmail').isVisible(),true);
      assert.equal(await page.locator('#authPassword').isVisible(),true);
      assert.equal(await page.evaluate(() => window.__mockCreateCalls),1,'client initialized automatically before login');
      assert.equal(await page.evaluate(() => window.__mockDataRequests),0,'no anonymous project or participant queries');
      await page.fill('#authEmail', `participant${i + 1}@example.test`);
      await page.fill('#authPassword', `mock-password-${i + 1}`);
      await page.click('#authForm button[type="submit"]');
      await page.waitForFunction(() => document.querySelectorAll('#projects tr').length === 6);
    }
    console.log('PASS: six isolated authenticated sessions list six shared projects.');

    // Each participant writes a distinct existing project.
    await Promise.all(allPages.map(async (page, i) => {
      await openProject(page, i);
      await page.fill('#scope', `Alteração participante ${i + 1}`);
      await save(page); await waitSave(page);
    }));
    assert.equal(editRows.filter(r=>r.versao===2).length, 6);
    assert.equal(new Set(updateLog.filter(r=>r.applied).map(r=>r.user)).size, 6);
    assert.deepEqual(sourceRows, originalSources);
    console.log('PASS: all six participants save through JSONB-only updates with version filters; source rows unchanged.');

    // Everyone can reload every participant's successful change.
    for(let i=0;i<6;i++) {
      await forceRefresh(allPages[i]);
      for(let j=0;j<6;j++) {
        await openProject(allPages[i], j);
        assert.equal(await allPages[i].inputValue('#scope'), `Alteração participante ${j + 1}`);
        await allPages[i].evaluate(() => showPortfolio());
      }
    }
    console.log('PASS: shared changes become visible to all six sessions after reload.');

    const [a,b,c] = allPages;
    await openProject(c, 0);
    await openProject(b, 0);
    await b.fill('#scope', 'RASCUNHO B NÃO SALVO');
    const oldNotifications = await b.evaluate(() => window.__mockNotifications);
    await openProject(a, 0); await a.fill('#scope', 'NOVA VERSÃO SALVA POR A'); await save(a); await waitSave(a);
    await c.waitForFunction(() => document.getElementById('scope').value === 'NOVA VERSÃO SALVA POR A');
    console.log('PASS: clean open form receives shared Realtime update automatically.');
    await b.waitForFunction(n => window.__mockNotifications > n, oldNotifications);
    // Let the app debounce its remote-change handling before asserting draft retention.
    await b.waitForTimeout(1200);
    assert.equal(await b.inputValue('#scope'), 'RASCUNHO B NÃO SALVO');
    assert.equal(await b.locator('#detail').isVisible(), true);
    console.log('PASS: Realtime event does not erase an unsaved draft in another session.');

    await save(b);
    await b.waitForFunction(() => document.getElementById('m365Save').textContent.includes('Conflito'));
    assert.equal(await b.inputValue('#scope'), 'RASCUNHO B NÃO SALVO');
    assert.equal(editRows[0].dados.overrides.escopo, 'NOVA VERSÃO SALVA POR A');
    await b.locator('#m365Theirs').click();
    // Reload may keep details open or return to list; both satisfy explicit reload semantics.
    await b.waitForFunction(() => document.getElementById('m365Conflict').classList.contains('hide'));
    if(await b.locator('#portfolio').isVisible())await openProject(b, 0);
    assert.equal(await b.inputValue('#scope'), 'NOVA VERSÃO SALVA POR A');
    console.log('PASS: stale-version save is rejected, remote value preserved, and explicit reload resolves the conflict.');

    for(const page of allPages){assert.equal(await page.evaluate(() => localStorage.length), 0);assert.equal(await page.evaluate(() => window.__mockAnonDataRequests),0);}
    assert.deepEqual(errors, []);
    console.log('PASS: no localStorage persistence or uncaught JavaScript errors.');
    console.log('RESULT: PASS (mock backend only; no live Supabase/PostgreSQL/RLS validation).');
    if(process.env.TEST_RESULTS_DIR){fs.mkdirSync(process.env.TEST_RESULTS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TEST_RESULTS_DIR,'multiusuario-test-result.json'), JSON.stringify({ result:'PASS', backend:'mock only', users:6, successfulUpdates:updateLog.filter(x=>x.applied).length, rejectedUpdates:updateLog.filter(x=>!x.applied).length, sourceUnchanged:true, localStorageEmpty:true, automaticClientInitialization:true, configurationFieldsAbsent:true, anonymousDataRequests:0 }, null, 2));}
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
