'use strict';
// Isolated invite/recovery UI. Project data, RLS, Realtime and versioning stay in the existing dashboard.
window.DashboardAuthAccess = function (client) {
  const $ = id => document.getElementById(id);
  const PRODUCTION_URL = 'https://viniciustestes.github.io/dashboard-projetos-poc/';
  let mode = 'login', working = false, linkSession = false, callbackCanceled = false;
  const message = text => { $('authFlowMsg').textContent = text; };
  const show = next => {
    mode = next;
    $('authForm').classList.toggle('hide', next !== 'login');
    $('accessPanel').classList.toggle('hide', next === 'login');
    $('recoveryEmailForm').classList.toggle('hide', next !== 'request');
    $('passwordForm').classList.toggle('hide', next !== 'invite' && next !== 'recovery');
  };
  function linkError(error) {
    const detail = String(error?.message || error || '');
    if (/verifier|pkce|flow.state/i.test(detail)) return 'Não foi possível validar este link neste navegador. Solicite um novo e-mail e use o link completo recebido.';
    if (/expired|invalid|otp|token|access.denied|used/i.test(detail)) return 'Este link é inválido, expirou ou já foi utilizado. Peça um novo convite ao administrador ou solicite outro e-mail de recuperação.';
    return 'Não foi possível validar o link de acesso. Peça um novo convite ao administrador ou solicite outro e-mail de recuperação.';
  }
  async function closeLinkSession() {
    if (!linkSession) return;
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    linkSession = false;
  }
  function cleanUrl(url) {
    const sensitive = ['access_token','refresh_token','token_hash','token','code','type','token_type','expires_in','expires_at','error','error_code','error_description','auth','provider_token','provider_refresh_token'];
    const hash = new URLSearchParams(url.hash.slice(1));
    for (const key of sensitive) { url.searchParams.delete(key); hash.delete(key); }
    url.hash = hash.toString() ? '#' + hash.toString() : '';
    // Remove bearer credentials before any asynchronous request. Never print callback tokens.
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  async function processLink() {
    const url = new URL(window.location.href), query = url.searchParams, hash = new URLSearchParams(url.hash.slice(1));
    const has = key => hash.has(key) || query.has(key);
    if (!['access_token','refresh_token','token_hash','code','error','error_code','error_description','auth'].some(has)) return;
    const type = hash.get('type') || query.get('type') || query.get('auth');
    const accessToken = hash.get('access_token'), refreshToken = hash.get('refresh_token');
    const tokenHash = query.get('token_hash'), code = query.get('code');
    const returnedError = hash.get('error_description') || query.get('error_description') || hash.get('error') || query.get('error') || (has('error_code') ? 'invalid link' : '');
    working = true; show('processing'); message('Validando link de acesso…');
    try {
      cleanUrl(url);
      if (returnedError) throw new Error(returnedError);
      if (type !== 'invite' && type !== 'recovery') throw new Error('invalid link purpose');
      let result;
      if (accessToken || refreshToken) {
        if (!accessToken || !refreshToken) throw new Error('invalid incomplete tokens');
        result = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      } else if (tokenHash) {
        result = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      } else if (code) {
        // For explicitly identified PKCE callbacks only. Missing verifier is reported without changing storage/auth settings.
        result = await client.auth.exchangeCodeForSession(code);
      } else throw new Error('invalid missing token');
      if (result.error) throw result.error;
      if (callbackCanceled) {
        await client.auth.signOut({ scope: 'local' });
        show('login'); message('Sessão temporária encerrada. Abra um novo link para definir a senha.'); return;
      }
      const session = result.data?.session;
      if (!session?.user) throw new Error('invalid missing session');
      linkSession = true;
      $('authEmail').value = session.user.email || '';
      $('passwordTitle').textContent = type === 'invite' ? 'Criar minha senha' : 'Definir nova senha';
      $('newPassword').value = ''; $('confirmPassword').value = '';
      show(type); message('Defina sua senha e confirme abaixo.'); $('newPassword').focus();
    } catch (error) {
      show('login'); message(linkError(error));
    } finally { working = false; }
  }
  $('forgotPassword').onclick = () => {
    if (working) return;
    $('recoveryEmail').value = $('authEmail').value.trim();
    show('request'); message('Informe seu e-mail para receber o link de recuperação.'); $('recoveryEmail').focus();
  };
  $('recoveryEmailForm').onsubmit = async event => {
    event.preventDefault(); if (working) return;
    const email = $('recoveryEmail').value.trim();
    if (!$('recoveryEmail').reportValidity()) return;
    working = true; $('recoveryEmailForm').inert = true;
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: PRODUCTION_URL + '?auth=recovery' });
      if (error) throw error;
      // Same response whether or not the address exists.
      message('Se este e-mail estiver cadastrado, você receberá um link de recuperação. Confira também a pasta de spam.');
    } catch (error) {
      message(error.status === 429 || /rate|429|too.many/i.test((error.code || '') + ' ' + (error.message || '')) ? 'Muitas solicitações. Aguarde alguns minutos e tente novamente.' : 'Não foi possível solicitar a recuperação. Confira sua conexão e tente novamente.');
    } finally { working = false; $('recoveryEmailForm').inert = false; }
  };
  $('passwordForm').onsubmit = async event => {
    event.preventDefault(); if (working || !linkSession) return;
    const password = $('newPassword').value, confirmation = $('confirmPassword').value;
    if (password.length < 8 || password.length > 72) { message('Use uma senha com 8 a 72 caracteres.'); return; }
    if (password !== confirmation) { message('As senhas não coincidem. Confira a confirmação.'); return; }
    working = true; $('passwordForm').inert = true;
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      $('newPassword').value = ''; $('confirmPassword').value = ''; $('authPassword').value = '';
      try { await closeLinkSession(); } catch (_) {
        show('login'); message('Senha salva. Não foi possível encerrar a sessão temporária; entre com seu e-mail e a nova senha para continuar.'); return;
      }
      show('login'); message('Senha salva com sucesso. Entre com seu e-mail e a nova senha.'); $('authPassword').focus();
    } catch (error) {
      const detail = String(error.message || '');
      message(/expired|invalid.*token|session.*missing|not.*authenticated/i.test(detail) ? linkError(error) : /weak|password|same.*password/i.test(detail) ? 'O Supabase recusou esta senha. Use uma senha mais forte e diferente da anterior.' : 'Não foi possível salvar sua senha. Confira a conexão e tente novamente.');
    } finally { working = false; $('passwordForm').inert = false; }
  };
  $('backToLogin').onclick = async () => {
    if (working) return;
    working = true;
    try {
      await closeLinkSession();
      $('newPassword').value = ''; $('confirmPassword').value = '';
      show('login'); message(''); $('authEmail').focus();
    } catch (_) { message('Não foi possível encerrar a sessão temporária. Confira a conexão e tente novamente.'); }
    finally { working = false; }
  };
  // Keep the existing dashboard logout usable while a temporary access session is open.
  // This callback is deliberately synchronous: no Auth calls under the SDK event lock.
  client.auth.onAuthStateChange(event => {
    if (event !== 'SIGNED_OUT') return;
    linkSession = false;
    if (mode === 'processing') callbackCanceled = true;
    if (mode !== 'login') {
      $('newPassword').value = ''; $('confirmPassword').value = '';
      show('login'); message('Sessão temporária encerrada. Entre ou solicite um novo link.');
    }
  });
  const ready = processLink();
  return {
    ready,
    get allowsLogin() { return mode === 'login' && !working; },
    focus() { (mode === 'request' ? $('recoveryEmail') : $('newPassword')).focus(); }
  };
};
