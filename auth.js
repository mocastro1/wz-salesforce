// ============================================================
// auth.js — OAuth 2.0 PKCE para Salesforce (Manifest V3)
// Usa chrome.tabs + chrome.tabs.onUpdated para o login
// (mais confiável que chrome.identity.launchWebAuthFlow)
// ============================================================

const AUTH_STORAGE_KEY = 'wzsf_auth';

// ─── PKCE helpers ────────────────────────────────────────────
function generateCodeVerifier() {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ─── Login OAuth (User-Agent Flow — sem Client Secret) ────────
async function oauthLogin() {
  const redirectUri = chrome.identity.getRedirectURL('salesforce');

  console.group('[WZ-SF] 🔐 Iniciando OAuth Salesforce (User-Agent Flow)');
  console.log('Client ID:', SF_CONFIG.clientId);
  console.log('Login URL:', SF_CONFIG.loginUrl);
  console.log('Redirect URI (EXATO):', redirectUri);
  console.log('Scopes:', SF_CONFIG.scopes);
  console.groupEnd();

  // User-Agent Flow — token retorna direto na URL, sem trocar por código
  const authUrl = `${SF_CONFIG.loginUrl}/services/oauth2/authorize?` +
    `response_type=token` +
    `&client_id=${encodeURIComponent(SF_CONFIG.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SF_CONFIG.scopes)}` +
    `&prompt=login`;

  return new Promise((resolve, reject) => {
    // Abre aba de login
    chrome.tabs.create({ url: authUrl }, (tab) => {
      const tabId = tab.id;

      // Escuta mudanças de URL nesta aba
      function onTabUpdated(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || !changeInfo.url) return;

        const currentUrl = changeInfo.url;

        // Verifica se o Salesforce redirecionou para nosso redirect URI
        if (!currentUrl.startsWith(redirectUri)) return;

        // Encontrou o redirect! Limpa listener e fecha a aba
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        chrome.tabs.onRemoved.removeListener(onTabRemoved);
        chrome.tabs.remove(tabId).catch(() => {});

        try {
          const url = new URL(currentUrl);
          const accessToken = url.hash.substring(1); // Remove o #
          const params = new URLSearchParams(accessToken);

          const token = params.get('access_token');
          const error = params.get('error');

          if (error) {
            const desc = params.get('error_description') || '';
            return reject(new Error(`Salesforce: ${error} — ${desc}`));
          }
          if (!token) {
            return reject(new Error('Access token não recebido'));
          }

          console.log('[WZ-SF] ✅ Access token recebido (User-Agent Flow)');

          // Extrai instance_url e outros dados do hash
          const sfInstanceUrl = params.get('instance_url') || '';
          console.log('[WZ-SF] Instance URL do hash:', sfInstanceUrl);

          parseAndSaveToken(token, sfInstanceUrl)
            .then(resolve)
            .catch(reject);

        } catch (e) {
          reject(e);
        }
      }

      // Se o usuário fechar a aba antes de completar
      function onTabRemoved(removedTabId) {
        if (removedTabId !== tabId) return;
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        chrome.tabs.onRemoved.removeListener(onTabRemoved);
        reject(new Error('Login cancelado — aba fechada'));
      }

      chrome.tabs.onUpdated.addListener(onTabUpdated);
      chrome.tabs.onRemoved.addListener(onTabRemoved);
    });
  });
}

// Extrai dados do token, busca userId via userinfo e salva
async function parseAndSaveToken(accessToken, instanceUrl) {
  // Usa instance_url do hash, ou fallback para my.salesforce.com (API URL, não Lightning)
  const apiUrl = (instanceUrl || 'https://cometa--crm.sandbox.my.salesforce.com')
    .replace('.lightning.force.com', '.my.salesforce.com')
    .replace(/\/$/, '');

  const tokens = {
    access_token: accessToken,
    token_type: 'Bearer',
    instance_url: apiUrl,
    issued_at: String(Date.now()),
    userId: '',
    userName: '',
  };

  // Busca userId e nome via Chatter API (mais confiável que /userinfo em Sandbox)
  try {
    const resp = await fetch(`${apiUrl}/services/data/${SF_CONFIG.apiVersion}/chatter/users/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (resp.ok) {
      const me = await resp.json();
      tokens.userId   = me.id || '';
      tokens.userName = me.name || me.displayName || '';
      console.log('[WZ-SF] 👤 Usuário SF:', tokens.userName, '| ID:', tokens.userId);
    } else {
      console.warn('[WZ-SF] Chatter /me falhou:', resp.status);
    }
  } catch (e) {
    console.warn('[WZ-SF] Chatter /me erro (não crítico):', e.message);
  }

  await saveTokens(tokens);
  console.log('[WZ-SF] 💾 Token salvo. Instance URL:', apiUrl);
  return tokens;
}

// ─── Troca code por tokens ───────────────────────────────────
async function exchangeCodeForTokens(code, codeVerifier, redirectUri) {
  const params = {
    grant_type: 'authorization_code',
    code,
    client_id: SF_CONFIG.clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  // Inclui client_secret se configurado
  if (SF_CONFIG.clientSecret) {
    params.client_secret = SF_CONFIG.clientSecret;
  }
  const body = new URLSearchParams(params);

  console.log('[WZ-SF] 🔄 Trocando código por token...');
  console.log('[WZ-SF] Token URL:', `${SF_CONFIG.loginUrl}/services/oauth2/token`);
  console.log('[WZ-SF] Client Secret configurado:', !!SF_CONFIG.clientSecret);

  const resp = await fetch(`${SF_CONFIG.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let err = {};
    try {
      err = JSON.parse(text);
    } catch (_) {}
    
    console.group('[WZ-SF] ❌ Erro na troca de token');
    console.log('Status:', resp.status);
    console.log('Response:', text);
    console.log('Parsed:', err);
    console.groupEnd();
    
    throw new Error(`Token error: ${err.error_description || err.error || resp.status}`);
  }

  return resp.json();
}

// ─── Refresh token ───────────────────────────────────────────
async function refreshAccessToken() {
  const auth = await getStoredAuth();
  if (!auth?.refresh_token) throw new Error('Sem refresh token — faça login');

  const refreshParams = {
    grant_type: 'refresh_token',
    client_id: SF_CONFIG.clientId,
    refresh_token: auth.refresh_token,
  };
  if (SF_CONFIG.clientSecret) {
    refreshParams.client_secret = SF_CONFIG.clientSecret;
  }
  const body = new URLSearchParams(refreshParams);

  const resp = await fetch(`${SF_CONFIG.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    await clearAuth();
    throw new Error(`Refresh falhou: ${err.error_description || err.error || resp.status}`);
  }

  const data = await resp.json();
  // refresh_token não vem no refresh response, mantém o anterior
  data.refresh_token = auth.refresh_token;
  await saveTokens(data);
  return data;
}

// ─── Token válido (com auto-refresh) ─────────────────────────
async function getValidAccessToken() {
  const auth = await getStoredAuth();
  if (!auth?.access_token) throw new Error('Não autenticado');

  // Testa se o token ainda funciona
  try {
    const resp = await fetch(`${auth.instance_url}/services/data/${SF_CONFIG.apiVersion}/chatter/users/me`, {
      headers: { 'Authorization': `Bearer ${auth.access_token}` },
    });
    if (resp.ok) return auth;
    if (resp.status === 401) {
      return await refreshAccessToken();
    }
    throw new Error(`SF API erro: ${resp.status}`);
  } catch (e) {
    if (e.message.includes('Refresh falhou') || e.message.includes('Não autenticado')) throw e;
    return await refreshAccessToken();
  }
}

// ─── Storage helpers ─────────────────────────────────────────
async function saveTokens(data) {
  await chrome.storage.local.set({
    [AUTH_STORAGE_KEY]: {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      instance_url:  data.instance_url,
      token_type:    data.token_type || 'Bearer',
      issued_at:     data.issued_at || String(Date.now()),
      id:            data.id || '',
      userId:        data.userId   || '',
      userName:      data.userName || '',
    }
  });
}

async function getStoredAuth() {
  const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  return result[AUTH_STORAGE_KEY] || null;
}

async function clearAuth() {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}

// ─── Logout ──────────────────────────────────────────────────
async function oauthLogout() {
  const auth = await getStoredAuth();
  if (auth?.access_token) {
    try {
      await fetch(`${SF_CONFIG.loginUrl}/services/oauth2/revoke?token=${encodeURIComponent(auth.access_token)}`, {
        method: 'POST',
      });
    } catch (_) { /* ignore */ }
  }
  await clearAuth();
  // Marca logout para sincronizar em outras abas/janelas da extensão
  try {
    await chrome.storage.local.set({ wzsf_logged_out: Date.now() });
  } catch (_) {
    // ignore
  }
}

// ─── Status check (sem refresh) ──────────────────────────────
async function checkSfAuth() {
  const auth = await getStoredAuth();
  if (!auth?.access_token) {
    console.log('[WZ-SF] checkSfAuth: sem token salvo');
    return { authenticated: false };
  }

  console.log('[WZ-SF] checkSfAuth: testando token...', auth.instance_url);

  try {
    const resp = await fetch(`${auth.instance_url}/services/data/${SF_CONFIG.apiVersion}/chatter/users/me`, {
      headers: { 'Authorization': `Bearer ${auth.access_token}` },
    });
    console.log('[WZ-SF] checkSfAuth: status', resp.status);
    if (resp.ok) {
      const user = await resp.json();
      const userId = user.id || auth.userId || '';
      const userName = user.name || user.displayName || auth.userName || '';
      console.log('[WZ-SF] checkSfAuth: usuário', userName, '| ID:', userId);
      // Atualiza storage com userId se estava vazio
      if (userId && !auth.userId) {
        auth.userId = userId;
        auth.userName = userName;
        await saveTokens(auth);
      }
      return {
        authenticated: true,
        userName,
        userId,
        instanceUrl: auth.instance_url,
      };
    }
    if (resp.status === 401) {
      console.log('[WZ-SF] checkSfAuth: token expirado (401), tentando refresh…');
      try {
        const refreshed = await refreshAccessToken();
        if (refreshed?.access_token) {
          return {
            authenticated: true,
            userName: refreshed.userName || auth.userName || 'SF Conectado',
            userId: refreshed.userId || auth.userId || '',
            instanceUrl: refreshed.instance_url || auth.instance_url,
          };
        }
      } catch (refreshErr) {
        console.warn('[WZ-SF] checkSfAuth: refresh falhou', refreshErr.message);
      }
      return { authenticated: false };
    }
    console.log('[WZ-SF] checkSfAuth: erro', resp.status);
    return { authenticated: false };
  } catch (e) {
    console.warn('[WZ-SF] checkSfAuth: erro de rede', e.message);
    // Se deu erro de rede mas temos token, considera autenticado
    return { authenticated: true, userName: auth.userName || 'SF Conectado', userId: auth.userId || '', instanceUrl: auth.instance_url };
  }
}
