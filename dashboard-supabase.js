'use strict';
// Adaptador independente da interface: somente SELECT na origem e UPDATE de dados nas edições.
class SupabaseRepository {
  constructor(client) { this.client = client; }
  async requireUser() {
    const {data, error} = await this.client.auth.getUser();
    if (error || !data.user) throw new Error('Sessão ausente ou expirada. Entre novamente.');
    return data.user;
  }
  async load() {
    await this.requireUser();
    const {data: allowed, error: permissionError} = await this.client.rpc('dashboard_participante_autorizado');
    if (permissionError) throw permissionError;
    if (!allowed) throw new Error('Esta conta não é participante autorizado. Solicite autorização ao administrador.');
    const results = await Promise.all([
      this.client.from('projetos_salesforce').select('salesforce_id,nome,gerencia_responsavel,gestor_projeto,oportunidade_crm,fase_atual,atualizado_em,escopo').order('salesforce_id'),
      this.client.from('edicoes_dashboard').select('salesforce_id,dados,versao,atualizado_em,atualizado_por')
    ]);
    for (const r of results) if (r.error) throw r.error;
    const [sources, edits] = results.map(r=>r.data);
    const byId = new Map(edits.map(e=>[e.salesforce_id,e]));
    if (!sources.length) throw new Error('Nenhum projeto visível. Verifique os registros existentes e as políticas RLS do novo Script 02.');
    if (new Set(sources.map(s=>s.salesforce_id)).size !== sources.length || byId.size !== edits.length) throw new Error('Identificadores duplicados no banco.');
    return sources.map(source=>{
      const edit=byId.get(source.salesforce_id);
      if (!edit || edit.versao == null) throw new Error('Edição ou versão ausente: '+source.salesforce_id);
      return mapProject(source,edit);
    });
  }
  async save(id, version, payload) {
    await this.requireUser();
    const {data, error}=await this.client.from('edicoes_dashboard')
      .update({dados:payload}).eq('salesforce_id',id).eq('versao',version)
      .select('salesforce_id,dados,versao,atualizado_em,atualizado_por');
    if(error) throw error;
    if(data.length!==1) {const e=new Error('Conflito ou permissão de atualização negada: nenhuma linha atualizada. Copie suas alterações e recarregue antes de reaplicá-las.');e.conflict=true;throw e;}
    if(String(data[0].versao)===String(version)) throw new Error('Resposta recebida sem incremento de versão. Verifique o trigger SQL antes de continuar; recarregue os dados.');
    return data[0];
  }
}
const SOURCE_FIELDS={name:'nome',management:'gerencia_responsavel',manager:'gestor_projeto',crmOpportunity:'oportunidade_crm',phase:'fase_atual',updated:'atualizado_em',scope:'escopo'};
const GROUPS=['milestones','highlights','actions','next30','next90','deadlines','finance'];
function normalizeDados(raw) {
  const d=structuredClone(raw || {});
  if(typeof d!=='object'||Array.isArray(d)) throw new Error('JSONB dados deve ser um objeto.');
  for(const g of GROUPS) {
    if(Array.isArray(d[g])) continue;
    const nums=[...new Set(Object.keys(d).map(k=>k.match(new RegExp('^'+g+'_(\\d+)_'))).filter(Boolean).map(m=>Number(m[1])))].sort((a,b)=>a-b);
    d[g]=nums.map(n=>{
      const v=f=>d[`${g}_${n}_${f}`]??'';
      if(g==='milestones') return {name:v('name'),status:v('status'),date:v('date')};
      if(g==='finance') return [v('label')||v('name'),v('value')];
      return g==='actions'?[v('date'),v('text')]:[v('text')];
    }).filter(r=>Object.values(r).some(Boolean));
  }
  d.finance=d.finance.map(r=>Array.isArray(r)?r:[r.label??r.name??'',r.value??'']);
  return d;
}
function mapProject(source,edit) {
  const d=normalizeDados(edit.dados), p={salesforceId:source.salesforce_id,_source:source,_edit:edit};
  for(const [ui,db] of Object.entries(SOURCE_FIELDS)) {
    p[ui]=Object.hasOwn(d.overrides||{},db)?d.overrides[db]:(Object.hasOwn(d.overrides||{},ui)?d.overrides[ui]:source[db]);
    p[ui]=String(p[ui]??'');
    if(ui==='updated')p[ui]=p[ui].slice(0,10);
  }
  for(const g of GROUPS)p[g]=d[g];
  p.visual=/^data:image\/(png|jpeg|webp|gif);base64,/.test(d.visual||'')?d.visual:'';
  return p;
}
(function(){
  const $=id=>document.getElementById(id), config=window.SUPABASE_CONFIG||{};
  let client,repo,channel,pollTimer,refreshTimer,authenticated=false;
  let busy=false,dirty=false,opening=false,conflict=false,remotePending=false,imageLoading=false,backgroundLoading=false;
  let sessionEpoch=0,formEpoch=0,stateRevision=0;
  const msg=t=>$('m365Msg').textContent=t;
  const status=t=>$('m365Save').textContent=t;
  const isOpen=()=>!$('detail').classList.contains('hide');
  const originalOpen=openProject, originalShow=showPortfolio;
  function notice(text){$('sharedNoticeText').textContent=text;$('sharedNotice').classList.remove('hide');}
  function hideNotice(){remotePending=false;$('sharedNotice').classList.add('hide');}
  function stopSync(){
    clearInterval(pollTimer);clearTimeout(refreshTimer);pollTimer=null;refreshTimer=null;
    if(channel&&client)client.removeChannel(channel).catch(()=>{});
    channel=null;$('syncState').textContent='Desconectada';
  }
  function clear(){
    sessionEpoch++;formEpoch++;authenticated=false;stopSync();data=[];dirty=false;conflict=false;hideNotice();
    $('m365Conflict').classList.add('hide');originalShow();$('m365Acc').textContent='—';$('m365State').textContent='Desconectado';status('Não gravado');
    $('authForm').classList.remove('hide');
  }
  async function run(fn){
    if(busy)return false;busy=true;$('detail').inert=true;
    try{await fn();return true;}catch(e){
      msg('✖ '+e.message);status(e.conflict?'Conflito — não salvo':'Erro — confira os dados antes de tentar novamente');
      if(e.conflict){conflict=true;$('m365Conflict').classList.remove('hide');$('m365ConflictMsg').textContent=e.message;}
      return false;
    }finally{busy=false;$('detail').inert=false;if(remotePending&&!dirty&&!conflict)scheduleRefresh();}
  }
  function mark(){if(!opening&&isOpen()&&!busy){dirty=true;status('Alterações não salvas');}}
  openProject=function(i){
    if(busy||!data[i])return;
    if(dirty&&!confirm('Descartar alterações não salvas antes de abrir este projeto?'))return;
    opening=true;formEpoch++;originalOpen(i);dirty=false;opening=false;
  };
  showPortfolio=function(){
    if(busy)return;if((dirty||imageLoading)&&!confirm('Descartar alterações não salvas?'))return;
    formEpoch++;imageLoading=false;dirty=false;originalShow();if(remotePending)scheduleRefresh();
  };
  window.backToList=showPortfolio;
  function applyList(list){
    const openId=isOpen()?data[current]?.salesforceId:null;
    data=list;stateRevision++;dirty=false;conflict=false;hideNotice();$('m365Conflict').classList.add('hide');
    const index=list.findIndex(p=>p.salesforceId===openId);
    if(index>=0){opening=true;formEpoch++;originalOpen(index);opening=false;}else originalShow();
    $('m365State').textContent='Conectado';$('m365Last').textContent=new Date().toLocaleString('pt-BR');
  }
  async function load(discard=false){
    if(busy)return;
    if((dirty||imageLoading)&&!discard&&!confirm('Descartar alterações não salvas e buscar a versão do banco?'))return;
    await run(async()=>{
      if(!repo||!authenticated)throw new Error('Entre com sua conta autorizada primeiro.');
      const epoch=sessionEpoch,list=await repo.load();if(epoch!==sessionEpoch)return;
      formEpoch++;imageLoading=false;applyList(list);status('Dados lidos do PostgreSQL');msg(`${list.length} projetos carregados. Salvamento manual; atualizações compartilhadas são recebidas automaticamente.`);
    });
  }
  function differs(list){return JSON.stringify(list.map(p=>[p._source,p._edit]))!==JSON.stringify(data.map(p=>[p._source,p._edit]));}
  async function backgroundRefresh(){
    if(!authenticated||backgroundLoading)return;
    if(busy||dirty||imageLoading||conflict){
      if(remotePending)notice('Há atualização compartilhada. Suas alterações não salvas foram mantidas; salve ou baixe seu rascunho antes de recarregar.');
      return;
    }
    backgroundLoading=true;const epoch=sessionEpoch,revision=stateRevision;
    try{
      const list=await repo.load();if(epoch!==sessionEpoch||revision!==stateRevision)return;
      // Recheck AFTER the network response: typing may have started while the query was running.
      if(busy||dirty||imageLoading||conflict){if(differs(list)){remotePending=true;notice('Novos dados disponíveis. O formulário em edição foi preservado.');}return;}
      if(differs(list)){applyList(list);status('Dados sincronizados do PostgreSQL');msg('Atualizações compartilhadas carregadas.');}else hideNotice();
    }catch(e){if(epoch===sessionEpoch){$('syncState').textContent='Falha na consulta; tentando novamente';notice('Não foi possível verificar atualizações: '+e.message+'. Suas alterações foram mantidas.');}}
    finally{backgroundLoading=false;}
  }
  function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{refreshTimer=null;backgroundRefresh();},350);}
  function onRemote(){remotePending=true;if(dirty||busy||imageLoading||conflict)notice('Há atualização compartilhada. Seu formulário foi preservado. Recarregue após salvar ou copiar as alterações.');else scheduleRefresh();}
  function startSync(){
    stopSync();const epoch=sessionEpoch;
    channel=client.channel('dashboard-compartilhado')
      .on('postgres_changes',{event:'*',schema:'public',table:'edicoes_dashboard'},()=>{if(epoch===sessionEpoch)onRemote();})
      .on('postgres_changes',{event:'*',schema:'public',table:'projetos_salesforce'},()=>{if(epoch===sessionEpoch)onRemote();})
      .subscribe(state=>{
        if(epoch!==sessionEpoch)return;
        $('syncState').textContent=state==='SUBSCRIBED'?'Realtime + consulta periódica':'Consulta periódica (Realtime: '+state+')';
        if(state==='SUBSCRIBED')scheduleRefresh();
      });
    const interval=Math.max(10000,Number(config.pollIntervalMs)||30000);
    pollTimer=setInterval(()=>{if(!busy&&!dirty&&!conflict&&!imageLoading)backgroundRefresh();},interval);
  }
  function collectPayload(p){
    const payload=normalizeDados(p._edit.dados);payload.overrides={...(payload.overrides||{})};
    const ids={name:'projectName',management:'management',manager:'manager',crmOpportunity:'crmOpportunity',updated:'updated',phase:'phase',scope:'scope'};
    for(const [ui,db]of Object.entries(SOURCE_FIELDS)){
      const value=$(ids[ui]).value;let source=String(p._source[db]??'');if(ui==='updated')source=source.slice(0,10);
      delete payload.overrides[ui];if(value===source)delete payload.overrides[db];else payload.overrides[db]=value;
    }
    payload.milestones=getMiles();for(const g of GROUPS.filter(g=>!['milestones','finance'].includes(g)))payload[g]=getList(g);
    payload.finance=getFinance();payload.visual=currentVisual;return payload;
  }
  window.saveProject=async function(){
    if(!isOpen()||!data[current]||busy)return;
    if(imageLoading){msg('Aguarde a leitura da imagem antes de salvar.');return;}
    if(conflict){msg('Baixe suas alterações e recarregue o projeto para resolver o conflito antes de reaplicá-las.');return;}
    await run(async()=>{
      if(!authenticated)throw new Error('Entre novamente antes de salvar. Seu formulário foi mantido.');
      const p=data[current],payload=collectPayload(p),epoch=sessionEpoch;
      dirty=true;status('Salvando…');const edit=await repo.save(p.salesforceId,p._edit.versao,payload);
      if(epoch!==sessionEpoch)return;
      data[current]=mapProject(p._source,edit);stateRevision++;dirty=false;formEpoch++;originalShow();
      status('Salvo no PostgreSQL — versão '+edit.versao);msg('Atualização confirmada pelo Supabase: '+p.salesforceId+' / versão '+edit.versao);
    });
  };
  $('downloadDraft').onclick=()=>{
    if(!isOpen()||!data[current])return;
    const p=data[current],blob=new Blob([JSON.stringify({salesforce_id:p.salesforceId,versao_carregada:p._edit.versao,dados:collectPayload(p)},null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='rascunho-dashboard.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };
  $('detail').addEventListener('input',mark);$('detail').addEventListener('change',mark);
  $('detail').addEventListener('click',e=>{if(e.target.closest('.add,.danger'))mark();});
  const oldRemove=removeVisual;removeVisual=function(){oldRemove();mark();};
  onVisualChange=function(ev){
    const f=ev.target.files?.[0];if(!f)return;
    if(!/^image\/(png|jpeg|webp|gif)$/.test(f.type)||f.size>2*1024*1024){msg('Escolha PNG, JPEG, WebP ou GIF com até 2 MB.');return;}
    const epoch=formEpoch,r=new FileReader();imageLoading=true;mark();
    r.onload=()=>{if(epoch!==formEpoch)return;currentVisual=r.result;showVisualPreview(currentVisual);imageLoading=false;mark();};
    r.onerror=()=>{if(epoch!==formEpoch)return;imageLoading=false;msg('Não foi possível ler a imagem.');};r.readAsDataURL(f);
  };
  function initializeConnection(){
    if(client)return;
    const url=String(config.url||'').trim(),publishableKey=String(config.publishableKey||'').trim();
    if(!/^https:\/\//.test(url)||!/^sb_publishable_/.test(publishableKey))throw new Error('Configuração de conexão indisponível. Contate o administrador do dashboard.');
    if(!window.supabase)throw new Error('Biblioteca de conexão indisponível. Reabra o dashboard ou contate o administrador.');
    // Explicit in-memory storage avoids browser storage restrictions in file:// and public PCs.
    const memory=new Map();
    client=window.supabase.createClient(url,publishableKey,{auth:{persistSession:false,autoRefreshToken:true,detectSessionInUrl:false,storage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}}});
    repo=new SupabaseRepository(client);
    client.auth.onAuthStateChange(event=>{
      if(event==='SIGNED_OUT'&&authenticated){sessionEpoch++;authenticated=false;stopSync();
        if(dirty){msg('Sessão encerrada. Seu formulário não salvo foi mantido. Entre novamente para continuar.');$('authForm').classList.remove('hide');}
        else clear();
      }
    });
  }
  async function connect(ev){
    ev?.preventDefault();if(busy)return;if(authenticated){await load();return;}
    const ok=await run(async()=>{
      initializeConnection();
      const {error}=await client.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});
      $('authPassword').value='';if(error)throw error;
      const user=await repo.requireUser();
      const {data:allowed,error:permissionError}=await client.rpc('dashboard_participante_autorizado');
      if(permissionError)throw permissionError;if(!allowed)throw new Error('Esta conta não é participante autorizado. Solicite autorização ao administrador.');
      sessionEpoch++;authenticated=true;$('m365Acc').textContent=user.email;$('m365File').textContent='base-integrada-prototipo';$('m365State').textContent='Autenticado';
      $('authForm').classList.add('hide');
    });
    if(ok&&authenticated){if(!dirty)await load();else msg('Sessão restaurada. Seu formulário foi mantido; confira a versão antes de salvar.');startSync();}
  }
  $('authForm').onsubmit=connect;$('m365Login').onclick=connect;
  $('m365Load').onclick=()=>load();$('m365Refresh').onclick=()=>load();$('sharedRefresh').onclick=()=>load();
  $('m365Save2').onclick=saveProject;$('m365Retry').onclick=saveProject;
  $('m365Theirs').onclick=()=>{if(confirm('Descartar suas alterações e carregar a versão atual do banco?'))load(true);};
  $('m365Diag').onclick=()=>run(async()=>{
    if(!repo||!authenticated)throw new Error('Entre com uma conta autorizada primeiro.');
    const rows=await repo.load();msg(rows.map(p=>`${p.salesforceId}: versão ${p._edit.versao}; atualizado em ${p._edit.atualizado_em||'—'}`).join('\n'));
  });
  $('m365Logout').onclick=async()=>{
    if(busy)return;if((dirty||imageLoading)&&!confirm('Descartar alterações não salvas e desconectar?'))return;
    await run(async()=>{if(client){const {error}=await client.auth.signOut();if(error)throw error;}clear();msg('Desconectado. Entre para consultar os dados.');});
  };
  window.addEventListener('online',()=>{if(authenticated)scheduleRefresh();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&authenticated)scheduleRefresh();});
  window.addEventListener('beforeunload',e=>{if(dirty||busy){e.preventDefault();e.returnValue='';}});
  clear();
  try{
    initializeConnection();
    $('m365State').textContent='Aguardando login';
    msg('Entre com seu e-mail e senha para acessar os projetos compartilhados.');
  }catch(e){
    $('m365State').textContent='Conexão indisponível';
    msg('✖ '+e.message);
  }
})();
