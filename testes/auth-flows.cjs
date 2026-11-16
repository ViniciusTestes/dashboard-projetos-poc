/* Browser integration with the repository's REAL bundled Supabase SDK.
 * Every HTTP/WebSocket endpoint is intercepted; no real Auth, emails, SQL or project data.
 * npm install --no-save playwright; node testes/auth-flows.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = process.env.DASHBOARD_DIR || path.resolve(__dirname, '..');
const production = 'https://viniciustestes.github.io/dashboard-projetos-poc/';
const api = 'https://auth-test.supabase.co';
const chromiumPath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const results = [];
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: '00000000-0000-4000-8000-000000000001',
  exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), role: 'authenticated', aud: 'authenticated' }) + '.dGVzdA';
const fakeRefresh = 'fake-refresh-token-for-browser-test';
const password = 'Senha-ficticia-2026!';
const user = { id: '00000000-0000-4000-8000-000000000001', email: 'marcos-ficticio@example.test',
  aud: 'authenticated', role: 'authenticated', created_at: '2026-11-16T00:00:00Z',
  app_metadata: { provider: 'email' }, user_metadata: {} };
const source = Array.from({ length: 6 }, (_, i) => ({ salesforce_id: 'TEST-'+i, nome: 'Projeto fictício '+i,
  gerencia_responsavel: 'Gerência', gestor_projeto: 'Gestor', oportunidade_crm: 'OPP-'+i,
  fase_atual: 'Fase 1', atualizado_em: '2026-11-10', escopo: 'Escopo fictício '+i }));
function session() { return { access_token: jwt, refresh_token: fakeRefresh, token_type: 'bearer', expires_in: 3600, user }; }
function dataRequests(h) { return h.requests.filter(r=>r.path.startsWith('/rest/')); }
function updates(h) { return h.requests.filter(r=>r.path==='/auth/v1/user' && r.method==='PUT'); }
function authHash(type) { return '#'+new URLSearchParams({ access_token: jwt, refresh_token: fakeRefresh,
  expires_in: '3600', token_type: 'bearer', type }); }
async function harness(browser, suffix='', options={}) {
  const context = await browser.newContext(); const page=await context.newPage();
  const h={ context, page, requests:[], errors:[], edits: source.map(s=>({salesforce_id:s.salesforce_id,dados:{},versao:1,
    atualizado_em:'2026-11-16T00:00:00Z',atualizado_por:null})) };
  page.on('pageerror',e=>h.errors.push(e.message));
  page.on('dialog',d=>d.accept());
  await context.route('https://**',r=>{h.errors.push('Unexpected network blocked: '+new URL(r.request().url()).origin);return r.abort();});
  await context.route(api+'/**', async r=>{
    const req=r.request(),url=new URL(req.url());
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'};
    if(req.method()==='OPTIONS')return r.fulfill({status:200,headers});
    const body=req.postData()?req.postDataJSON():null;
    h.requests.push({path:url.pathname,method:req.method(),query:Object.fromEntries(url.searchParams),body});
    let response;
    if(url.pathname==='/auth/v1/token') {
      if(url.searchParams.get('grant_type')==='pkce')return r.fulfill({status:400,headers,contentType:'application/json',body:JSON.stringify({code:'bad_code_verifier',msg:'PKCE code verifier not found or invalid'})});
      response=session();
    } else if(url.pathname==='/auth/v1/user') {
      if(req.method()==='PUT' && options.passwordError)return r.fulfill({status:422,headers,contentType:'application/json',body:JSON.stringify({code:'weak_password',msg:'Password does not meet security requirements'})});
      response=user;
    } else if(url.pathname==='/auth/v1/verify') {
      if(options.verifyExpired)return r.fulfill({status:403,headers,contentType:'application/json',body:JSON.stringify({code:'otp_expired',msg:'Email link is invalid or has expired'})});
      response=session();
    } else if(url.pathname==='/auth/v1/logout')return r.fulfill({status:204,headers});
    else if(url.pathname==='/auth/v1/recover') {
      if(options.recoveryError)return r.fulfill({status:429,headers,contentType:'application/json',body:JSON.stringify({code:'over_email_send_rate_limit',msg:'For security purposes, you can only request this after 60 seconds.'})});
      response={};
    } else if(url.pathname==='/rest/v1/rpc/dashboard_participante_autorizado')response=true;
    else if(url.pathname==='/rest/v1/projetos_salesforce')response=source;
    else if(url.pathname==='/rest/v1/edicoes_dashboard') {
      if(req.method()==='PATCH') {
        const row=h.edits.find(e=>'eq.'+e.salesforce_id===url.searchParams.get('salesforce_id') && 'eq.'+e.versao===url.searchParams.get('versao'));
        if(row){assert.deepEqual(Object.keys(body),['dados']);row.dados=structuredClone(body.dados);row.versao++;row.atualizado_por=user.id;}response=row?[row]:[];
      }else response=h.edits;
    } else throw Error('Unexpected mocked endpoint: '+url.pathname);
    return r.fulfill({headers,contentType:'application/json',body:JSON.stringify(response)});
  });
  await context.routeWebSocket('wss://auth-test.supabase.co/**',ws=>ws.close());
  await context.route(production+'**',r=>{
    const name=new URL(r.request().url()).pathname.split('/').pop()||'index.html';
    if(name==='supabase-config.js')return r.fulfill({contentType:'application/javascript',body:
      `window.SUPABASE_CONFIG=Object.freeze({url:'${api}',publishableKey:'sb_publishable_fake_browser_test',pollIntervalMs:30000});`});
    const file=path.join(root,name);
    if(!fs.existsSync(file))return r.fulfill({status:404,body:'Not found'});
    return r.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/html',body:fs.readFileSync(file)});
  });
  await page.goto(production+suffix);
  return h;
}
async function login(h, withPassword=password) {
  await h.page.fill('#authEmail',user.email);await h.page.fill('#authPassword',withPassword);
  await h.page.click('#authForm button[type="submit"]');
  await h.page.waitForFunction(()=>document.querySelectorAll('#projects tr').length===6);
}
async function showPassword(h,title){
  await h.page.locator('#passwordForm').waitFor({state:'visible'});
  assert.equal(await h.page.locator('#authForm').isVisible(),false,'normal login must be hidden while defining a password');
  if(title)assert.match(await h.page.locator('#passwordTitle').textContent(),title);
  assert.equal(dataRequests(h).length,0,'no project/member data loaded before password definition');
  assert.equal(new URL(h.page.url()).hash,'','callback fragment sanitized');
  assert.equal(new URL(h.page.url()).searchParams.has('token_hash'),false,'token_hash sanitized');
}
async function setPassword(h,p=password,confirm=p){
  await h.page.fill('#newPassword',p);await h.page.fill('#confirmPassword',confirm);
  await h.page.click('#passwordForm button[type="submit"]');
}
async function successfulPassword(h){
  await setPassword(h);
  await h.page.waitForFunction(()=>/Senha salva com sucesso/i.test(document.getElementById('authFlowMsg').textContent));
  await h.page.locator('#authForm').waitFor({state:'visible'});
  assert.equal(updates(h).length,1);assert.equal(updates(h)[0].body.password,password);
  const logout=h.requests.find(r=>r.path==='/auth/v1/logout');assert.ok(logout,'password flow signs out before normal login');assert.equal(logout.query.scope,'local');
  assert.equal(await h.page.inputValue('#authEmail'),user.email);
  assert.equal(dataRequests(h).length,0,'password flow never auto-loads shared data');
  await login(h);assert.equal(await h.page.locator('#projects tr').count(),6);
}
function checkErrors(h){assert.deepEqual(h.errors,[],'no uncaught JavaScript or unintended network access');assert.ok(!h.requests.some(r=>/\/(signup|admin)\b/.test(r.path)),'no public signup or privileged Auth calls');}
async function test(browser,name,fn){await fn();results.push({name,result:'PASS'});console.log('PASS: '+name);}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:chromiumPath,args:['--no-sandbox']});
  try{
    await test(browser,'existing password login, six projects, save, browser reload persistence (mock)',async()=>{
      const h=await harness(browser);assert.equal(dataRequests(h).length,0);await login(h);
      await h.page.evaluate(()=>openProject(0));await h.page.fill('#scope','Persistido no backend simulado');await h.page.click('#m365Save2');
      await h.page.waitForFunction(()=>document.getElementById('m365Save').textContent.includes('Salvo no PostgreSQL'));
      assert.equal(h.edits[0].dados.overrides.escopo,'Persistido no backend simulado');
      await h.page.reload();await login(h);await h.page.evaluate(()=>openProject(0));assert.equal(await h.page.inputValue('#scope'),'Persistido no backend simulado');
      assert.equal(await h.page.evaluate(()=>localStorage.length),0);checkErrors(h);await h.context.close();
    });
    for(const type of ['invite','recovery'])await test(browser,type+' implicit session uses real SDK, defines password and allows normal login',async()=>{
      const h=await harness(browser,authHash(type));await showPassword(h,type==='invite'?/criar.*senha/i:/senha/i);
      await h.page.click('#m365Login');assert.equal(dataRequests(h).length,0,'toolbar login cannot bypass password definition');
      assert.equal(h.requests.filter(r=>r.path==='/auth/v1/token'&&r.query.grant_type==='password').length,0);
      await successfulPassword(h);checkErrors(h);await h.context.close();
    });
    await test(browser,'existing Disconnect cancels invitation, erases password fields and permits normal login',async()=>{
      const h=await harness(browser,authHash('invite'));await showPassword(h);
      await h.page.fill('#newPassword',password);await h.page.fill('#confirmPassword',password);
      await h.page.click('#m365Logout');await h.page.locator('#accessPanel').waitFor({state:'hidden'});
      assert.equal(await h.page.inputValue('#newPassword'),'');assert.equal(await h.page.inputValue('#confirmPassword'),'');
      assert.equal(await h.page.locator('#authForm').isVisible(),true);assert.equal(updates(h).length,0);assert.equal(dataRequests(h).length,0);
      await login(h);assert.equal(await h.page.locator('#projects tr').count(),6);checkErrors(h);await h.context.close();
    });
    for(const type of ['invite','recovery'])await test(browser,type+' token_hash calls official verifyOtp and then updateUser',async()=>{
      const h=await harness(browser,'?'+new URLSearchParams({token_hash:'fake-one-time-token',type}));await showPassword(h);
      const verify=h.requests.find(r=>r.path==='/auth/v1/verify');assert.ok(verify);assert.equal(verify.body.token_hash,'fake-one-time-token');assert.equal(verify.body.type,type);
      await successfulPassword(h);checkErrors(h);await h.context.close();
    });
    await test(browser,'password confirmation and length prevent unwanted updateUser calls',async()=>{
      const h=await harness(browser,authHash('invite'));await showPassword(h);await setPassword(h,password,'Diferente-2026!');assert.equal(updates(h).length,0);
      await setPassword(h,'curta','curta');assert.equal(updates(h).length,0);
      await h.page.evaluate(()=>{document.getElementById('newPassword').value='a'.repeat(73);document.getElementById('confirmPassword').value='a'.repeat(73);});
      await h.page.click('#passwordForm button[type="submit"]');assert.equal(updates(h).length,0);
      assert.equal(dataRequests(h).length,0);checkErrors(h);await h.context.close();
    });
    await test(browser,'forgot password calls official recovery with exact production redirect',async()=>{
      const h=await harness(browser);await h.page.click('#forgotPassword');await h.page.fill('#recoveryEmail',user.email);await Promise.all([h.page.waitForResponse(r=>new URL(r.url()).pathname==='/auth/v1/recover'),h.page.click('#recoveryEmailForm button[type="submit"]')]);
      const recover=h.requests.find(r=>r.path==='/auth/v1/recover');assert.ok(recover);assert.equal(recover.body.email,user.email);assert.equal(recover.query.redirect_to,production+'?auth=recovery');
      assert.equal(dataRequests(h).length,0);assert.ok(!h.requests.some(r=>r.path.includes('signup')));checkErrors(h);await h.context.close();
    });
    await test(browser,'recovery email rate limit shows an actionable message',async()=>{
      const h=await harness(browser,'',{recoveryError:true});await h.page.click('#forgotPassword');assert.equal(await h.page.locator('#authForm').isVisible(),false);
      await h.page.fill('#recoveryEmail',user.email);await h.page.click('#recoveryEmailForm button[type="submit"]');
      await h.page.waitForFunction(()=>/Muitas solicitações/i.test(document.getElementById('authFlowMsg').textContent));
      assert.equal(dataRequests(h).length,0);checkErrors(h);await h.context.close();
    });
    await test(browser,'expired callback error is explicit and URL credentials/errors are removed',async()=>{
      const h=await harness(browser,'#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
      await h.page.waitForFunction(()=>/expir|inválid/i.test(document.getElementById('authFlowMsg').textContent));
      assert.match(await h.page.locator('#authFlowMsg').textContent(),/expir|inválid/i);assert.equal(new URL(h.page.url()).hash,'');assert.equal(dataRequests(h).length,0);assert.equal(updates(h).length,0);checkErrors(h);await h.context.close();
    });
    await test(browser,'expired token_hash is rejected without opening projects',async()=>{
      const h=await harness(browser,'?token_hash=expired-token&type=invite',{verifyExpired:true});await h.page.waitForFunction(()=>/expir|inválid/i.test(document.getElementById('authFlowMsg').textContent));
      assert.match(await h.page.locator('#authFlowMsg').textContent(),/expir|inválid/i);assert.equal(dataRequests(h).length,0);assert.equal(updates(h).length,0);checkErrors(h);await h.context.close();
    });
    await test(browser,'incomplete invitation cannot create a password or load projects',async()=>{
      const h=await harness(browser,'#'+new URLSearchParams({access_token:jwt,type:'invite'}));await h.page.waitForFunction(()=>document.getElementById('authFlowMsg').textContent.length>0);
      assert.equal(await h.page.locator('#passwordForm').isVisible(),false);assert.equal(dataRequests(h).length,0);assert.equal(updates(h).length,0);checkErrors(h);await h.context.close();
    });
    await test(browser,'PKCE return without the original verifier shows a recoverable error',async()=>{
      const h=await harness(browser,'?code=fake-code&auth=recovery');await h.page.waitForFunction(()=>document.getElementById('authFlowMsg').textContent.length>0);
      assert.equal(await h.page.locator('#passwordForm').isVisible(),false);assert.equal(dataRequests(h).length,0);assert.equal(updates(h).length,0);assert.equal(new URL(h.page.url()).searchParams.has('code'),false);checkErrors(h);await h.context.close();
    });
    await test(browser,'Auth API password validation failure is visible and keeps the password form',async()=>{
      const h=await harness(browser,authHash('recovery'),{passwordError:true});await showPassword(h);await setPassword(h);
      await h.page.waitForFunction(()=>/recusou|seguran|forte/i.test(document.getElementById('authFlowMsg').textContent));
      assert.equal(await h.page.locator('#passwordForm').isVisible(),true);assert.equal(dataRequests(h).length,0);checkErrors(h);await h.context.close();
    });
    if(process.env.TEST_RESULTS_DIR){fs.mkdirSync(process.env.TEST_RESULTS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TEST_RESULTS_DIR,'auth-flows-result.json'),JSON.stringify({result:'PASS',sdk:'real bundled SDK',backend:'mock HTTP only',tests:results},null,2));}
    console.log('RESULT: PASS. Real SDK + mocked endpoints only; no real email/Auth/RLS/PostgreSQL validation.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
