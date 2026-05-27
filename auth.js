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

// ─── Login OAuth (Web Server Flow + PKCE — emite refresh_token) ──
async function oauthLogin() {
  const redirectUri = chrome.identity.getRedirectURL('salesforce');

  console.log('[WZ-SF] 🔐 Iniciando OAuth Salesforce (Web Server Flow + PKCE)');

  // PKCE: gera verifier (guardado) e challenge (enviado na URL)
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // response_type=code → troca por token depois (com refresh_token)
  const authUrl = `${SF_CONFIG.loginUrl}/services/oauth2/authorize?` +
    `response_type=code` +
    `&client_id=${encodeURIComponent(SF_CONFIG.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(SF_CONFIG.scopes)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256` +
    `&prompt=login`;

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: authUrl }, (tab) => {
      const tabId = tab.id;

      function onTabUpdated(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || !changeInfo.url) return;

        const currentUrl = changeInfo.url;
        if (!currentUrl.startsWith(redirectUri)) return;

        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        chrome.tabs.onRemoved.removeListener(onTabRemoved);
        chrome.tabs.remove(tabId).catch(() => {});

        try {
          const url = new URL(currentUrl);
          // Web Server Flow → code vem na QUERY (?code=...), não no hash
          const code  = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            const desc = url.searchParams.get('error_description') || '';
            return reject(new Error(`Salesforce: ${error} — ${desc}`));
          }
          if (!code) {
            return reject(new Error('Código de autorização não recebido'));
          }

          console.log('[WZ-SF] ✅ Código recebido, trocando por token...');

          // Troca o code por access_token + refresh_token
          exchangeCodeForTokens(code, codeVerifier, redirectUri)
            .then((tokens) => parseAndSaveToken(
              tokens.access_token,
              tokens.instance_url,
              tokens.refresh_token,
            ))
            .then(resolve)
            .catch(reject);

        } catch (e) {
          reject(e);
        }
      }

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
async function parseAndSaveToken(accessToken, instanceUrl, refreshToken) {
  // Usa instance_url do hash, ou fallback para my.salesforce.com (API URL, não Lightning)
  const apiUrl = (instanceUrl || 'https://cometa--crm.sandbox.my.salesforce.com')
    .replace('.lightning.force.com', '.my.salesforce.com')
    .replace(/\/$/, '');

  const tokens = {
    access_token: accessToken,
    refresh_token: refreshToken || '',
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
      console.log('[WZ-SF] 👤 Usuário SF autenticado');
    } else {
      console.warn('[WZ-SF] Chatter /me falhou:', resp.status);
    }
  } catch (e) {
    console.warn('[WZ-SF] Chatter /me erro (não crítico):', e.message);
  }

  await saveTokens(tokens);
  console.log('[WZ-SF] 💾 Token salvo');
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

  const resp = await fetch(`${SF_CONFIG.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let err = {};
    try { err = JSON.parse(text); } catch (_) {}
    console.warn('[WZ-SF] ❌ Erro na troca de token:', resp.status, err.error || '');
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
