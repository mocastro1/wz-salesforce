// ============================================================
// background.js — Service Worker
// Envia dados ao wz-api (BFF Next.js) via REST
// ============================================================

importScripts('config.js', 'auth.js');

// ─── Cache local (evita duplicatas em 24h) ───────────────────
const CACHE_KEY = 'wzsf_sent_cache';
const CACHE_TTL = 24 * 60 * 60 * 1000;

async function getCache() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const cache = result[CACHE_KEY] || {};
    const now = Date.now();
    for (const key in cache) {
      if (now - cache[key] > CACHE_TTL) delete cache[key];
    }
    return cache;
  } catch (_) {
    return {};
  }
}

async function cacheKey(action, data) {
  const phone = data.phone || data.Phone || '';
  const name = data.name || data.Name || data.FirstName || '';
  const uid = sfUserData.userId || 'anon';
  return `${uid}:${action}:${phone}:${name}`;
}

async function isDuplicate(action, data) {
  const cache = await getCache();
  const key = await cacheKey(action, data);
  return !!cache[key];
}

async function markSent(action, data) {
  const cache = await getCache();
  const key = await cacheKey(action, data);
  cache[key] = Date.now();
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// ─── Chamada genérica à wz-api ────────────────────────────────
async function apiFetch(endpoint, payload, method = 'POST') {
  const url = API_CONFIG.url(endpoint);

  async function doFetch(authOverride) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.timeout);

    const auth = authOverride || await getStoredAuth().catch(() => null);

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_CONFIG.apiToken}`,
    };
    if (auth?.access_token) headers['X-SF-Access-Token'] = auth.access_token;
    if (auth?.instance_url) headers['X-SF-Instance-Url'] = auth.instance_url;

    try {
      const opts = { method, headers, signal: controller.signal };
      if (method !== 'GET') opts.body = JSON.stringify(payload);

      const resp = await fetch(url, opts);
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { ok: false, error: `API erro ${resp.status}: ${text}`, status: resp.status };
      }

      const data = await resp.json().catch(() => ({}));
      return { ok: true, ...data };
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        return { ok: false, error: 'Timeout — wz-api não respondeu a tempo' };
      }
      return { ok: false, error: `Erro de rede: ${e.message}` };
    }
  }

  // Primeira tentativa
  const result = await doFetch();

  // Se 401, tenta refresh do token SF e repete
  if (result.status === 401) {
    console.log('[WZ-SF] apiFetch: 401 recebido, tentando refresh do token SF…');
    try {
      const refreshed = await refreshAccessToken();
      if (refreshed?.access_token) {
        console.log('[WZ-SF] apiFetch: token renovado, repetindo chamada');
        return await doFetch(refreshed);
      }
    } catch (refreshErr) {
      console.warn('[WZ-SF] apiFetch: refresh falhou', refreshErr.message);
    }
  }

  return result;
}

// ─── Obter credencial SF (access token + instance URL) ────────
async function getSfCredentials() {
  try {
    const auth = await getValidAccessToken();
    return {
      sfAccessToken: auth.access_token,
      sfInstanceUrl: auth.instance_url,
    };
  } catch (e) {
    return null;
  }
}

// ─── Health check da wz-api ──────────────────────────────────
async function checkWebhookHealth() {
  try {
    const url = API_CONFIG.url('healthCheck');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_CONFIG.apiToken}` },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (resp.ok) return { ok: true, status: 'online' };
    return { ok: false, error: `Status ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

// ─── Handlers de ações → wz-api REST ─────────────────────────

// Dados do usuário SF (persistidos no storage para reutilizar)
let sfUserData = { userId: '', concessionariaRef: '' };

async function loadSfUserData() {
  try {
    const r = await chrome.storage.local.get('wzsf_user_data');
    if (r.wzsf_user_data) sfUserData = r.wzsf_user_data;
  } catch (_) {}
}
async function saveSfUserData(data) {
  sfUserData = { ...sfUserData, ...data };
  try { await chrome.storage.local.set({ wzsf_user_data: sfUserData }); } catch (_) {}
}

// Busca dados do User SF via wz-api /api/auth/check
async function fetchSfUserData() {
  try {
    const result = await apiFetch('authCheck', null, 'GET');
    if (result?.ok && result?.authenticated) {
      await saveSfUserData({
        userId: result.userId || '',
        concessionariaRef: result.concessionariaRef || '',
      });
      console.log('[WZ-SF bg] User data:', sfUserData);
    }
  } catch (e) {
    console.warn('[WZ-SF bg] Erro ao buscar user data:', e.message);
  }
}

// Carrega dados do usuário ao iniciar
loadSfUserData();

// ─── Cache de picklists SF ────────────────────────────────────
let picklistCache = {};

async function getPicklist(fieldName) {
  if (picklistCache[fieldName]) return { ok: true, values: picklistCache[fieldName] };
  try {
    // Monta path com query params; apiFetch usa o valor diretamente quando não está no mapa de endpoints
    const path = API_CONFIG.endpoints.leadPicklist + '?field=' + encodeURIComponent(fieldName);
    const result = await apiFetch(path, null, 'GET');
    if (result?.ok && result?.values) {
      picklistCache[fieldName] = result.values;
      return { ok: true, values: result.values };
    }
    return { ok: false, error: result?.error || 'Erro ao buscar picklist' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function saveLead(data) {
  // Mapeia campos do DOM para o schema do wz-api
  const payload = {
    FirstName:   data.firstName || data.FirstName || (data.name || '').split(' ')[0] || 'Desconhecido',
    LastName:    data.lastName  || data.LastName  || (data.name || '').split(' ').slice(1).join(' ') || 'WhatsApp',
    Company:     data.company   || data.Company   || 'Pessoa Física',
    Phone:       data.phone     || data.Phone     || '',
    MobilePhone: data.phone     || data.Phone     || undefined,
    Status:      'Novo',
    LeadSource:  'Redes sociais do vendedor',
    Concessionaria_Ref__c: 'BL', // TODO: usar sfUserData.concessionariaRef quando User.Apelido_Concessionaria__c tiver Account correspondente
    Interesse_em__c: data.interesse || data.Interesse_em__c || undefined,
    Description: data.description || undefined,
    sellerPhone: data.sellerPhone || undefined,
  };
  console.log('[WZ-SF bg] saveLead payload:', JSON.stringify(payload));
  console.log('[WZ-SF bg] sfUserData:', JSON.stringify(sfUserData));
  return apiFetch('saveLead', payload);
}

async function registerConversation(data) {
  const payload = {
    phone:       data.phone || data.Phone || '',
    contactName: data.name  || data.contactName || 'Contato',
    summary:     data.summary || data.description || undefined,
    leadId:      data.leadId  || undefined,
  };
  return apiFetch('registerConversation', payload);
}

async function createActivity(data) {
  const payload = {
    Subject:      data.subject || data.Subject || `WhatsApp — ${data.name || data.contactName || 'Contato'}`,
    Description:  data.description || data.Description || undefined,
    WhoId:        data.leadId || data.WhoId || undefined,
    Priority:     data.priority || 'Normal',
    Status:       'Not Started',
    Type:         'WhatsApp',
    ActivityDate: data.activityDate || new Date().toISOString().split('T')[0],
  };
  return apiFetch('createActivity', payload);
}

async function lookupLead(data) {
  const sfCreds = await getSfCredentials();
  if (!sfCreds) return { ok: false, error: 'Não autenticado no Salesforce' };
  return apiFetch('lookupLead', { phone: data.phone });
}

// ─── Desqualificação de Lead ou Oportunidade ─────────────────
async function disqualifyRecord(data) {
  // data = { objectType: 'Lead'|'Opportunity', recordId, motivoDePerda }
  return apiFetch('disqualify', {
    objectType:    data.objectType,
    recordId:      data.recordId,
    motivoDePerda: data.motivoDePerda,
  });
}

async function getDisqualifyPicklist(data) {
  // Busca picklist de motivo de perda filtrado pelo LeadSource do registro
  const objectName = data?.objectType || 'Lead';
  const recordId   = data?.recordId   || '';
  let path = API_CONFIG.endpoints.disqualifyPicklist + '?object=' + encodeURIComponent(objectName);
  if (recordId) path += '&recordId=' + encodeURIComponent(recordId);
  return apiFetch(path, null, 'GET');
}

// ─── Telemetry — batch de eventos para detectar mudanças do WA ────
// Acumula eventos e envia em lote a cada 30s ou quando atinge 20 eventos.
// Dedup por (type+context) em janela de 5 min para evitar spam.
const TELEMETRY_FLUSH_INTERVAL_MS = 30000;
const TELEMETRY_MAX_BATCH = 20;
const TELEMETRY_DEDUP_WINDOW_MS = 5 * 60 * 1000;

let telemetryQueue = [];
let telemetryDedup = new Map(); // key -> timestamp
let telemetryFlushTimer = null;

function telemetryDedupKey(ev) {
  return `${ev.type}|${ev.context}`;
}

function enqueueTelemetry(ev) {
  if (!ev || !ev.type) return;
  const key = telemetryDedupKey(ev);
  const now = Date.now();
  const lastSeen = telemetryDedup.get(key);
  if (lastSeen && (now - lastSeen) < TELEMETRY_DEDUP_WINDOW_MS) return;
  telemetryDedup.set(key, now);

  // Limpa entradas antigas do dedup
  if (telemetryDedup.size > 200) {
    for (const [k, ts] of telemetryDedup) {
      if (now - ts > TELEMETRY_DEDUP_WINDOW_MS) telemetryDedup.delete(k);
    }
  }

  telemetryQueue.push({ ...ev, ts: new Date().toISOString() });

  if (telemetryQueue.length >= TELEMETRY_MAX_BATCH) {
    flushTelemetry();
  } else if (!telemetryFlushTimer) {
    telemetryFlushTimer = setTimeout(flushTelemetry, TELEMETRY_FLUSH_INTERVAL_MS);
  }
}

async function flushTelemetry() {
  if (telemetryFlushTimer) {
    clearTimeout(telemetryFlushTimer);
    telemetryFlushTimer = null;
  }
  if (telemetryQueue.length === 0) return;

  const batch = telemetryQueue.splice(0, telemetryQueue.length);
  try {
    const url = API_CONFIG.url('telemetry');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_CONFIG.apiToken}`,
      },
      body: JSON.stringify({ events: batch }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (e) {
    // Telemetry é best-effort — não bloqueia o fluxo principal
    console.warn('[WZ-SF bg] Telemetry flush falhou:', e.message);
  }
}

// ─── Listener de mensagens ───────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    checkConnection: () => checkWebhookHealth(),

    saveLead:      () => handleWithCache('saveLead', msg.data, saveLead),
    saveLead_force: () => forceCreate('saveLead', msg.data, saveLead),

    registerConversation:       () => handleWithCache('registerConversation', msg.data, registerConversation),
    registerConversation_force: () => forceCreate('registerConversation', msg.data, registerConversation),

    createActivity:       () => handleWithCache('createActivity', msg.data, createActivity),
    createActivity_force: () => forceCreate('createActivity', msg.data, createActivity),

    lookupLead: () => lookupLead(msg.data || { phone: msg.phone }),

    openInSalesforce: () => {
      // Se tiver leadUrl direto, abre ele; senão busca por telefone
      if (msg.leadUrl) {
        chrome.tabs.create({ url: msg.leadUrl });
        return Promise.resolve({ ok: true });
      }
      const phone = encodeURIComponent(msg.phone || '');
      const url = `${SF_CONFIG.orgUrl}/lightning/o/Lead/list?filterName=__Recent&q=${phone}`;
      chrome.tabs.create({ url });
      return Promise.resolve({ ok: true });
    },

    getConfig: () => Promise.resolve({
      ok: true,
      webhookUrl: WEBHOOK_CONFIG.baseUrl,
      sfOrgUrl: SF_CONFIG.orgUrl,
    }),

    // ─── Salesforce Auth handlers ──────────────────────────
    sfLogin: async () => {
      await oauthLogin();
      // Após login, busca dados do User SF (concessionaria, etc)
      await fetchSfUserData();
      return { ok: true };
    },
    sfLogout: () => oauthLogout().then(() => ({ ok: true })),
    sfCheckAuth: () => checkSfAuth().then(status => ({ ok: true, ...status })),
    sfGetToken: () => getValidAccessToken().then(auth => ({ ok: true, auth })),
    getUserData: async () => {
      if (!sfUserData.userId) await fetchSfUserData();
      return { ok: true, ...sfUserData };
    },
    getPicklist: (msg) => getPicklist(msg?.data?.field || msg?.field || 'Interesse_em__c'),

    disqualify:            () => disqualifyRecord(msg.data || {}),
    getDisqualifyPicklist: () => getDisqualifyPicklist(msg.data || {}),

    reportTelemetry: () => {
      const events = Array.isArray(msg.events) ? msg.events : (msg.event ? [msg.event] : []);
      events.forEach(enqueueTelemetry);
      return Promise.resolve({ ok: true, queued: events.length });
    },
  };

  const handler = handlers[msg.action];
  if (handler) {
    handler().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// Cache wrapper
async function handleWithCache(action, data, apiFn) {
  if (await isDuplicate(action, data)) {
    return {
      ok: false,
      duplicate: true,
      error: `Já enviado nas últimas 24h. Deseja enviar novamente?`,
    };
  }
  const result = await apiFn(data);
  if (result.ok) {
    await markSent(action, data);
  }
  return result;
}

async function forceCreate(action, data, apiFn) {
  const result = await apiFn(data);
  if (result.ok) {
    await markSent(action, data);
  }
  return result;
}

console.log('[WZ-SF bg] Service worker carregado ✅');
