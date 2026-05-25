// ============================================================
// WhatsApp → Salesforce (via n8n) | content.js
// Captura dados do WhatsApp Web e envia ao n8n
// ============================================================

const PANEL_ID = 'wzsf-panel';
const MODAL_ID = 'wzsf-modal';
const VERSION  = 'v2.2.0';
let debounceTimer = null;
let lastConversationKey = null;
let storeData = { phone: '', name: '', pushname: '', source: 'none' };
let webhookOnline = false;
let sfAuthenticated = false;
let sfUserName = '';
let sfUserId = '';  // OwnerId do usuário logado no SF (para checar ownership do lead)
let sellerPhone = ''; // Telefone do vendedor logado no WhatsApp
let currentLeadInfo = null;  // Dados do Lead encontrado no SF
let lookupInProgress = false; // Evita piscar durante a busca
let lastLookupPhone = null;  // Último telefone pesquisado (evita re-busca desnecessária)

// ─── Telemetry — reporta quando seletores/estratégias falham ───
// Permite detectar mudanças no HTML do WhatsApp antes dos usuários reclamarem.
// Throttle local: cada (type+context) só é reportado 1x por minuto.
const telemetrySeen = new Map();
const TELEMETRY_LOCAL_THROTTLE_MS = 60 * 1000;

function reportTelemetry(type, context, detail) {
  try {
    const key = `${type}|${context}`;
    const now = Date.now();
    const last = telemetrySeen.get(key);
    if (last && (now - last) < TELEMETRY_LOCAL_THROTTLE_MS) return;
    telemetrySeen.set(key, now);

    const event = {
      type,
      context,
      detail: detail || {},
      extensionVersion: VERSION,
      userAgent: navigator.userAgent.substring(0, 300),
      url: location.href.substring(0, 300),
    };
    chrome.runtime.sendMessage({ action: 'reportTelemetry', event }, () => {
      // Ignora erros (extension context invalidated, etc.)
      if (chrome.runtime.lastError) {/* silent */}
    });
  } catch (_) {/* silent */}
}

// ─── Injetar script no contexto da página (acessa window.Store) ──
function injectPageScript() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
  console.log('[WZ-SF] inject.js injetado no contexto da página');
}

// Escuta respostas do inject.js
let storeStatus = 'searching'; // 'searching' | 'found' | 'unavailable'

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'WZSF_RESPONSE') {
    storeData = event.data.data || storeData;
    // Captura telefone do vendedor quando o Store responde
    if (storeData.sellerPhone && !sellerPhone) {
      sellerPhone = storeData.sellerPhone;
      console.log(`[WZ-SF ${VERSION}] 📱 Vendedor: ${sellerPhone}`);
      saveSellerPhone(sellerPhone);
    }
    return;
  }

  if (event.data?.type === 'WZSF_RESPONSE_MESSAGES') {
    const cb = pendingMsgRequests.get(event.data.reqId);
    if (cb) {
      pendingMsgRequests.delete(event.data.reqId);
      cb(event.data.data);
    }
    return;
  }

  if (event.data?.type === 'WZSF_SELLER_PHONE') {
    if (event.data.phone && !sellerPhone) {
      sellerPhone = event.data.phone;
      console.log(`[WZ-SF ${VERSION}] 📱 Vendedor (direct): ${sellerPhone}`);
      saveSellerPhone(sellerPhone);
    }
    return;
  }

  if (event.data?.type === 'WZSF_STORE_STATUS') {
    storeStatus = event.data.status;
    console.log(`[WZ-SF ${VERSION}] Store: ${storeStatus} — ${event.data.detail}`);
    updateStoreIndicator();

    // Telemetry: store_found (sucesso) ou store_unavailable (precisou cair pra DOM)
    if (storeStatus === 'found') {
      reportTelemetry('store_found', event.data.detail || 'webpack', {});
    } else if (storeStatus === 'unavailable') {
      reportTelemetry('store_unavailable', event.data.detail || 'webpack', {
        attempts: event.data.attempts,
      });
    }
  }
});

function updateStoreIndicator() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const badge = panel.querySelector('.wzsf-store-badge');
  if (!badge) return;
  const labels = {
    searching:   '🔍 Store...',
    found:       '✅ Store',
    unavailable: '📡 DOM',
  };
  badge.textContent = labels[storeStatus] || storeStatus;
  badge.className = `wzsf-store-badge wzsf-store-${storeStatus}`;
}

// Pede dados ao inject.js
function requestStoreData() {
  window.postMessage({ type: 'WZSF_REQUEST' }, '*');
}

// Pede mensagens do chat ativo ao Store (Promise-based, timeout 2s)
const pendingMsgRequests = new Map();
let msgReqSeq = 0;

function requestStoreMessages(limit = 50) {
  return new Promise((resolve) => {
    const reqId = ++msgReqSeq;
    const timer = setTimeout(() => {
      pendingMsgRequests.delete(reqId);
      resolve({ messages: [], source: 'timeout' });
    }, 2000);
    pendingMsgRequests.set(reqId, (data) => {
      clearTimeout(timer);
      resolve(data || { messages: [], source: 'empty' });
    });
    window.postMessage({ type: 'WZSF_REQUEST_MESSAGES', limit, reqId }, '*');
  });
}

injectPageScript();

// ─── Telefone do vendedor ───────────────────────────────
// Persiste no storage para sobreviver a reloads da extensão
async function saveSellerPhone(phone) {
  try { await chrome.storage.local.set({ wzsf_seller_phone: phone }); } catch (_) {}
}

async function loadSellerPhone() {
  try {
    const r = await chrome.storage.local.get('wzsf_seller_phone');
    if (r.wzsf_seller_phone) {
      sellerPhone = r.wzsf_seller_phone;
      console.log(`[WZ-SF ${VERSION}] 📱 Vendedor (cache): ${sellerPhone}`);
    }
  } catch (_) {}
  // Pede ao inject.js também
  window.postMessage({ type: 'WZSF_REQUEST_SELLER' }, '*');
}

// ─── Verificar conexão com webhook (n8n) ───────────────────
function checkWebhookConnection() {
  try {
    chrome.runtime.sendMessage({ action: 'checkConnection' }, (resp) => {
      if (chrome.runtime.lastError) {
        webhookOnline = false;
        updateConnectionBadge();
        return;
      }
      webhookOnline = resp?.ok || false;
      updateConnectionBadge();
      console.log(`[WZ-SF ${VERSION}] Webhook: ${webhookOnline ? 'online' : 'offline'}`);
    });
  } catch (_) { /* extension context invalidated */ }
}

function updateConnectionBadge() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const tab = panel.querySelector('.wzsf-tab[data-tab="n8n"]');
  if (!tab) return;
  const dot = tab.querySelector('.wzsf-tab-dot');
  const label = tab.querySelector('.wzsf-tab-label');
  if (dot) {
    dot.className = `wzsf-tab-dot ${webhookOnline ? 'wzsf-dot-online' : 'wzsf-dot-offline'}`;
  }
  if (label) {
    label.textContent = webhookOnline ? 'n8n Online' : 'n8n Offline';
  }
}

// Verifica conexão a cada 60s (com guard contra context invalidated)
setInterval(() => {
  try { chrome.runtime.sendMessage({ action: '_ping' }); checkWebhookConnection(); }
  catch (_) { /* extension context invalidated — ignora */ }
}, 60000);

// ─── Verificar autenticação Salesforce ────────────────────────
function checkSfAuthStatus() {
  try { chrome.runtime.sendMessage({ action: 'sfCheckAuth' }, (resp) => {
    if (chrome.runtime.lastError) {
      sfAuthenticated = false;
      sfUserName = '';
      updateSfAuthIndicator();
      updatePanel();
      return;
    }
    sfAuthenticated = resp?.authenticated || false;
    sfUserName = resp?.userName || '';
    sfUserId   = resp?.userId   || '';
    updateSfAuthIndicator();
    updatePanel();
    console.log(`[WZ-SF ${VERSION}] SF Auth: ${sfAuthenticated ? 'conectado como ' + sfUserName + ' (ID: ' + sfUserId + ')' : 'não conectado'}`);
  }); } catch (_) { /* extension context invalidated */ }
}

function updateSfAuthIndicator() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const indicator = panel.querySelector('.wzsf-sf-auth');
  if (!indicator) return;

  const dot = indicator.querySelector('.wzsf-sf-auth-dot');
  const text = indicator.querySelector('.wzsf-sf-auth-text');
  const loginBtn = indicator.querySelector('#wzsf-sf-login');
  const logoutBtn = indicator.querySelector('#wzsf-sf-logout');

  if (sfAuthenticated) {
    dot.className = 'wzsf-sf-auth-dot wzsf-dot-online';
    text.textContent = sfUserName || 'SF Conectado';
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    dot.className = 'wzsf-sf-auth-dot wzsf-dot-offline';
    text.textContent = 'SF Desconectado';
    if (loginBtn) loginBtn.style.display = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

function triggerSfLogin() {
  const panel = document.getElementById(PANEL_ID);
  const loginBtn = panel?.querySelector('#wzsf-sf-login');
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.textContent = '⏳ Conectando...';
  }
  // Fire-and-forget: o OAuth abre uma aba e pode demorar > 30s.
  // O service worker MV3 pode ser suspendido nesse meio-tempo, fechando o canal
  // de sendMessage. Em vez de esperar a resposta, confiamos no onChanged do
  // chrome.storage (já registrado em content.js) — quando wzsf_auth muda, a UI atualiza.
  chrome.runtime.sendMessage({ action: 'sfLogin' }, (resp) => {
    // Callback opcional — pode nunca chegar se o SW reiniciou. Não tratamos como erro.
    if (chrome.runtime.lastError) {
      console.log(`[WZ-SF] sfLogin: canal fechou (service worker reiniciado) — aguardando storage update`);
      return;
    }
    if (resp?.ok) {
      console.log('[WZ-SF] Login Salesforce concluído! ✅');
    } else if (resp?.error) {
      console.warn(`[WZ-SF] SF Login falhou:`, resp.error);
      alert('Erro no login: ' + resp.error);
    }
  });

  // Polling de fallback: verifica auth a cada 2s por até 2 minutos.
  // Para o polling assim que detectar login ou ao expirar.
  let pollCount = 0;
  const maxPolls = 60; // 2 min @ 2s
  const pollInterval = setInterval(() => {
    pollCount++;
    chrome.storage.local.get('wzsf_auth', (r) => {
      if (r.wzsf_auth?.access_token) {
        clearInterval(pollInterval);
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = '🔐 Login SF';
        }
        checkSfAuthStatus();
        updatePanel();
      } else if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = '🔐 Login SF';
        }
      }
    });
  }, 2000);
}

// Verifica auth SF a cada 60s (com guard contra context invalidated)
setInterval(() => {
  try { checkSfAuthStatus(); } catch (_) { /* extension context invalidated */ }
}, 60000);

// Sincroniza login/logout: reage quando background salva ou remove o token
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('wzsf_auth' in changes || 'wzsf_logged_out' in changes) {
    // Logout: limpa estado imediatamente para feedback instantâneo
    if (changes.wzsf_logged_out || (changes.wzsf_auth && !changes.wzsf_auth.newValue)) {
      sfAuthenticated = false;
      sfUserName = '';
      updateSfAuthIndicator();
      updatePanel();
    } else {
      // Login: revalida via background para obter nome do usuário
      checkSfAuthStatus();
    }
  }
});

// ─── Consulta Lead no Salesforce pelo telefone ───────────────
async function lookupLeadByPhone(phone) {
  if (!phone || !sfAuthenticated) {
    currentLeadInfo = null;
    lookupInProgress = false;
    updateLeadBadge();
    return;
  }

  lastLookupPhone = phone; // Marca como consultado ANTES do await para evitar chamadas paralelas
  lookupInProgress = true;
  updateLeadBadge(); // Mostra "Carregando..."
  
  try {
    const result = await sendMessage({ action: 'lookupLead', data: { phone } });
    // wz-api retorna { ok, found, count, leads: [...] }
    const found = result?.ok && result?.found;
    const leadData = found && result.leads?.length > 0 ? result.leads[0] : null;
    if (found && leadData) {
      currentLeadInfo = leadData;
      console.log(`[WZ-SF ${VERSION}] 🔗 Lead encontrado: ${currentLeadInfo.leadName} (${currentLeadInfo.leadId}) | Owner: ${currentLeadInfo.ownerName} | Encerrado: ${currentLeadInfo.encerrado}`);
    } else {
      currentLeadInfo = null;
      console.log(`[WZ-SF ${VERSION}] ❌ Nenhum Lead para ${phone}`, result?.error || '');
    }
  } catch (e) {
    currentLeadInfo = null;
    console.warn(`[WZ-SF ${VERSION}] Erro ao buscar Lead:`, e.message);
  } finally {
    lookupInProgress = false;
    updateLeadBadge();
    updateFabLeadStatus();
  }
}

function updateLeadBadge() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  const card = panel.querySelector('.wzsf-card');
  if (!card) return;

  let badge = card.querySelector('.wzsf-lead-badge');

  // ── Carregando ───────────────────────────────────────────────
  if (lookupInProgress) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'wzsf-lead-badge';
      card.appendChild(badge);
    }
    badge.innerHTML = `
      <span class="wzsf-lead-dot wzsf-dot-loading"></span>
      <span class="wzsf-lead-text">Buscando Lead...</span>
    `;
    badge.style.display = 'flex';
    return;
  }

  // ── Lead encontrado ──────────────────────────────────────────
  if (currentLeadInfo) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'wzsf-lead-badge';
      card.appendChild(badge);
    }

    const isMyLead = !sfUserId || currentLeadInfo.ownerId === sfUserId;
    const encerrado = currentLeadInfo.encerrado || false;
    const opp = currentLeadInfo.opportunity;

    // Determina o dot de status do lead
    let dotClass, leadLabel;
    if (encerrado) {
      dotClass  = 'wzsf-dot-closed';
      leadLabel = '🔒 Lead Encerrado';
    } else if (!isMyLead) {
      dotClass  = 'wzsf-dot-other';
      leadLabel = '⚠️ Em atendimento';
    } else {
      dotClass  = 'wzsf-dot-online';
      leadLabel = 'Lead Ativo';
    }

    // Bloco de oportunidade (se convertido)
    let oppHtml = '';
    if (opp) {
      const faturada = opp.cotacaoFaturada ? '✅ Faturado' : '';
      const motivo   = opp.motivoPerda ? `❌ ${escHtml(opp.motivoPerda)}` : '';
      const status   = faturada || motivo || escHtml(opp.stageName || '');
      oppHtml = `
        <div class="wzsf-opp-block">
          <a href="#" class="wzsf-opp-link" data-opp-url="${escHtml(opp.oppUrl || '')}">
            <span class="wzsf-opp-icon">💼</span>
            <span class="wzsf-opp-name">${escHtml(opp.oppName || 'Oportunidade')}</span>
          </a>
          <span class="wzsf-opp-stage">${status}</span>
        </div>`;
    }

    // Aviso de outro vendedor
    let ownerWarning = '';
    if (!isMyLead) {
      ownerWarning = `<div class="wzsf-owner-warning">👤 Vendedor: ${escHtml(currentLeadInfo.ownerName || '')}</div>`;
    }

    badge.innerHTML = `
      <div class="wzsf-lead-row">
        <a href="#" class="wzsf-lead-link" title="Abrir Lead no Salesforce">
          <span class="wzsf-lead-dot ${dotClass}"></span>
          <span class="wzsf-lead-text">${leadLabel}: ${escHtml(currentLeadInfo.leadName || currentLeadInfo.leadId)}</span>
          <span class="wzsf-lead-status">${escHtml(currentLeadInfo.leadStatus || '')}</span>
        </a>
      </div>
      ${ownerWarning}
      ${oppHtml}
    `;
    badge.style.display = 'block';

    // Clique no lead → abre no SF
    const link = badge.querySelector('.wzsf-lead-link');
    link?.addEventListener('click', (e) => {
      e.preventDefault();
      if (currentLeadInfo?.leadUrl) {
        sendMessage({ action: 'openInSalesforce', leadUrl: currentLeadInfo.leadUrl });
      }
    });

    // Clique na oportunidade → abre no SF
    const oppLink = badge.querySelector('.wzsf-opp-link');
    oppLink?.addEventListener('click', (e) => {
      e.preventDefault();
      const url = oppLink.dataset.oppUrl;
      if (url) sendMessage({ action: 'openInSalesforce', leadUrl: url });
    });

    // Bloqueia/desbloqueia botões de ação
    const actionsEl = panel.querySelector('.wzsf-actions');
    if (actionsEl) {
      // "Salvar Lead" bloqueado se já existe lead ativo (qualquer dono)
      const leadBtn = actionsEl.querySelector('[data-action="lead"]');
      if (leadBtn) {
        const hasActiveLead = !encerrado; // lead existe e não está encerrado
        leadBtn.disabled = hasActiveLead;
        leadBtn.title = hasActiveLead ? 'Já existe lead ativo para este contato' : '';
        leadBtn.classList.toggle('wzsf-btn-blocked', hasActiveLead);
      }
      // Demais ações bloqueadas se não é meu lead ou está encerrado
      const blocked = !isMyLead || encerrado;
      actionsEl.querySelectorAll('[data-action="conversation"], [data-action="activity"], [data-action="open"]').forEach(btn => {
        btn.disabled = blocked;
        btn.title = encerrado
          ? 'Lead encerrado — ações bloqueadas'
          : (!isMyLead ? `Em atendimento por ${currentLeadInfo.ownerName}` : '');
        btn.classList.toggle('wzsf-btn-blocked', blocked);
      });
    }

  } else {
    // Nenhum Lead encontrado
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'wzsf-lead-badge';
      card.appendChild(badge);
    }
    badge.innerHTML = `
      <span class="wzsf-lead-dot wzsf-dot-offline"></span>
      <span class="wzsf-lead-text">Nenhum Lead encontrado</span>
    `;
    badge.style.display = 'flex';

    // Libera botões
    const actionsEl = panel.querySelector('.wzsf-actions');
    if (actionsEl) {
      actionsEl.querySelectorAll('[data-action]').forEach(btn => {
        btn.disabled = false;
        btn.title = '';
        btn.classList.remove('wzsf-btn-blocked');
      });
    }
  }
}

// ─── Seletores com fallback (WhatsApp muda data-testid frequentemente) ──
const SEL = {
  header: [
    '[data-testid="conversation-header"]',
    '[data-testid="chat-header"]',
    'header._amid',
    'header[data-testid]',
    '#main header',
  ],
  contactTitle: [
    '[data-testid="conversation-info-header"] span[title]',
    '[data-testid="chat-title"] span[title]',
    '#main header span[title]',
    '#main header span[dir="auto"]',
  ],
  contactSub: [
    '[data-testid="conversation-info-header"] div[title]',
    '#main header span[title] ~ span',
    '#main header div[title]',
  ],
  // Painel "Dados do contato" (drawer lateral direito) — abre ao clicar no nome
  // Esses seletores são muito mais estáveis que os do header
  drawerContactName: [
    '[data-testid="contact-info-subtitle"]',
    '[data-testid="contact-info-name"]',
    '[data-testid="conversation-info-header-chat-title"]',
  ],
  drawerContactPhone: [
    // O telefone aparece no painel como selectable-text dentro do drawer
    '[data-testid="selectable-text"]',
  ],
};

// Busca o primeiro seletor que encontra algo no DOM
function queryFirst(selectors) {
  if (typeof selectors === 'string') return document.querySelector(selectors);
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}
function queryAny(selectors) {
  if (typeof selectors === 'string') return document.querySelector(selectors);
  for (const sel of selectors) {
    if (document.querySelector(sel)) return true;
  }
  return false;
}

// ─── Extração de dados do DOM ────────────────────────────────

// ─── Container real da conversa ─────────────────────────────
// O WhatsApp às vezes tem um SVG com id="main" antes do painel real.
// Esta função encontra o container correto com mensagens dentro.
function getConversationContainer() {
  // 1) #main clássico — mas só se realmente tem conteúdo HTML (não SVG)
  const main = document.querySelector('#main');
  if (main && main.tagName !== 'rect' && main.tagName !== 'svg'
      && main.querySelectorAll('div').length > 0) {
    return main;
  }

  // 2) Seletores conhecidos do WhatsApp Web
  const alternatives = [
    '[data-testid="conversation-panel-body"]',
    '[data-testid="conversation-panel-messages"]',
    '[data-testid="conversation-compose-box-input"]',
    '[role="application"]',
  ];
  for (const sel of alternatives) {
    const el = document.querySelector(sel);
    if (el) {
      // Sobe até encontrar um container razoável
      let node = el;
      for (let i = 0; i < 8 && node.parentElement; i++) {
        node = node.parentElement;
        // Paramos quando achamos um container com bastante conteúdo
        if (node.querySelectorAll('div').length > 20) return node;
      }
      return el.parentElement || el;
    }
  }

  // 3) Acha pelo data-id das mensagens e sobe na árvore
  const msgEl = document.querySelector('[data-id*="@c.us"], [data-id*="@g.us"]');
  if (msgEl) {
    let node = msgEl;
    for (let i = 0; i < 10 && node.parentElement; i++) {
      node = node.parentElement;
      if (node.querySelectorAll('[data-id]').length > 1) return node;
    }
    return msgEl.parentElement || document.body;
  }

  // 4) Último recurso: document.body
  return document.body;
}

// Detecta se o chat atual é um grupo (@g.us) ou contato individual (@c.us)
function isGroupChat() {
  // 1) Store-first — definitivo, imune a mudanças no HTML
  if (storeStatus === 'found' && storeData.source === 'store') {
    return !!storeData.isGroup;
  }

  // 2) Fallback DOM: data-id das mensagens
  const mainEl = getConversationContainer();
  if (mainEl) {
    // Grupos usam @g.us nos data-id das mensagens
    if (mainEl.querySelector('[data-id*="@g.us"]')) {
      reportTelemetry('group_detection', 'fallback_dataid_gus', { isGroup: true });
      return true;
    }
    // Se tem @c.us é contato individual
    if (mainEl.querySelector('[data-id*="@c.us"]')) return false;
  }

  // 3) Fallback heurístico (frágil — strings localizadas)
  const subEl = queryFirst(SEL.contactSub);
  const sub = subEl?.getAttribute('title') || subEl?.textContent?.trim() || '';
  if (sub.includes('dados do grupo') || sub.includes('group info')) {
    reportTelemetry('group_detection', 'fallback_localized_string', { isGroup: true });
    return true;
  }
  // Lista de participantes: 2+ vírgulas e não é horário
  if ((sub.match(/,/g) || []).length >= 2 && !sub.includes(':')) {
    reportTelemetry('group_detection', 'fallback_comma_count', { isGroup: true });
    return true;
  }

  // 4) Último recurso: ícone de grupo no header
  const headerEl = queryFirst(SEL.header);
  if (headerEl) {
    const groupIcon = headerEl.querySelector('[data-testid="group"], [data-icon="group"], [data-testid="default-group"]');
    if (groupIcon) {
      reportTelemetry('group_detection', 'fallback_group_icon', { isGroup: true });
      return true;
    }
  }

  return false;
}

// Textos do WhatsApp que NÃO são nomes de contato
const STATUS_TEXTS = [
  'online', 'offline', 'digitando', 'typing', 'recording',
  'gravando', 'visto por', 'visto por último', 'last seen', 'clique para',
  'click to', 'dados do contato', 'dados do grupo',
  'contact info', 'group info', 'mostrar dados',
  'dados do perfil', 'profile info', 'profile data',
  // Strings de hora/data que podem aparecer no subtítulo
  'hoje às', 'ontem às', 'today at', 'yesterday at',
];

function isStatusText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return STATUS_TEXTS.some(s => lower.includes(s));
}

function extractPhoneFromDOM() {
  // 1ª tentativa: data-id das mensagens no chat aberto (mais confiável)
  // Formato: "false_5511999999999@c.us_HASH" ou "true_5511999999999@c.us_HASH"
  const mainEl = getConversationContainer();
  if (mainEl) {
    const msgEl = mainEl.querySelector('[data-id*="@c.us"]');
    if (msgEl) {
      const match = msgEl.getAttribute('data-id').match(/(\d{7,15})@c\.us/);
      if (match) return match[1];
    }
  }

  // 2ª tentativa: item ativo na barra lateral com data-id
  const activeSelectors = [
    '#pane-side [aria-selected="true"]',
    '[data-testid="cell-frame-container"][aria-selected="true"]',
    '[role="listitem"][aria-selected="true"]',
  ];
  for (const sel of activeSelectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    let node = el;
    while (node && node !== document.body) {
      const id = node.getAttribute('data-id');
      if (id) {
        const match = id.match(/(\d{7,15})@c\.us/);
        if (match) return match[1];
      }
      node = node.parentElement;
    }
  }

  // 3ª tentativa: qualquer elemento com data-id contendo @c.us no documento
  const anyEl = document.querySelector('[data-id*="@c.us"]');
  if (anyEl) {
    const match = anyEl.getAttribute('data-id').match(/(\d{7,15})@c\.us/);
    if (match) return match[1];
  }

  return '';
}

// ─── Auto-open do drawer "Dados do contato" para capturar telefone ───
// Quando o contato salvo na agenda não tem mensagens trocadas, não temos data-id.
// Solução: clicar programaticamente no header (que abre o drawer), ler o telefone,
// e fechar o drawer com Escape. Tudo em < 500ms.
//
// Anti-loop: cacheamos por nome — evita ficar abrindo/fechando o drawer toda hora.
const drawerCache = new Map(); // name -> { phone, ts }
const drawerAttempted = new Set(); // conversationKeys já tentadas (anti-loop)
const DRAWER_CACHE_TTL = 5 * 60 * 1000; // 5 min
let drawerOpenInProgress = false;

// Heurística extra forte para detectar grupo, independente do Store.
// Usada como segunda linha de defesa contra auto-open em grupos.
function isLikelyGroup(contact) {
  // 1) Se temos qualquer @g.us em data-id, é grupo
  if (document.querySelector('[data-id*="@g.us"]')) return true;

  // 2) Se o nome contém múltiplas vírgulas (participantes), provavelmente é grupo
  // ex: "João, Maria, Pedro, +5 outros"
  const commaCount = (contact.name?.match(/,/g) || []).length;
  if (commaCount >= 2) return true;

  // 3) Procura ícone de grupo no header
  const headerEl = queryFirst(SEL.header);
  if (headerEl) {
    // Ícones típicos de grupo no WhatsApp atual
    if (headerEl.querySelector('[data-icon="default-group"], [data-icon="default-group-refreshed"], [aria-label*="rupo"]')) {
      return true;
    }
  }

  return false;
}

function getDrawerCachedPhone(name) {
  if (!name) return null;
  const entry = drawerCache.get(name);
  if (!entry) return null;
  if (Date.now() - entry.ts > DRAWER_CACHE_TTL) {
    drawerCache.delete(name);
    return null;
  }
  return entry.phone;
}

function setDrawerCachedPhone(name, phone) {
  if (!name || !phone) return;
  drawerCache.set(name, { phone, ts: Date.now() });
  // Limita o tamanho do cache
  if (drawerCache.size > 100) {
    const oldestKey = drawerCache.keys().next().value;
    drawerCache.delete(oldestKey);
  }
}

// Abre o drawer programaticamente, lê o telefone, fecha.
// Retorna Promise<phone string ou ''>
async function openDrawerToReadPhone(contactName) {
  // Anti-concurrent: se já está abrindo, não tenta de novo
  if (drawerOpenInProgress) return '';
  drawerOpenInProgress = true;

  try {
    // 1) Encontra o header da conversa (área clicável que abre o drawer)
    const headerEl = queryFirst(SEL.header);
    if (!headerEl) return '';

    // 2) Encontra o elemento clicável que abre os dados do contato.
    // Geralmente é o nome ou avatar no topo da conversa.
    // Procura por divs/spans clicáveis dentro do header.
    let clickTarget = null;
    // Estratégia 1: o nome em si (geralmente role="button" ou tem cursor pointer)
    const possibleTargets = headerEl.querySelectorAll('div[role="button"], [data-testid*="header"], div._aou3, div.x1n2onr6');
    for (const el of possibleTargets) {
      const text = (el.textContent || '').trim();
      if (text && text.includes(contactName.split(' ')[0])) {
        clickTarget = el;
        break;
      }
    }
    // Fallback: clica direto no headerEl ou no primeiro filho
    if (!clickTarget) clickTarget = headerEl.firstElementChild || headerEl;

    // 3) Clica para abrir o drawer
    clickTarget.click();

    // 4) Espera o drawer renderizar (poll rápido até 500ms)
    const phone = await new Promise(resolve => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const drawerData = extractFromContactDrawer();
        if (drawerData.phone) {
          clearInterval(interval);
          resolve(drawerData.phone);
          return;
        }
        if (attempts >= 25) { // 25 * 20ms = 500ms
          clearInterval(interval);
          resolve('');
        }
      }, 20);
    });

    // 5) Fecha o drawer imediatamente (Escape) — sem delay artificial
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
    }));

    return phone;
  } catch (e) {
    console.warn('[WZ-SF] openDrawerToReadPhone falhou:', e.message);
    return '';
  } finally {
    drawerOpenInProgress = false;
  }
}

// Extrai dados do painel "Dados do contato" (drawer lateral).
// Esse painel usa data-testid mais estáveis que o header.
// Retorna { name, phone } — vazios se o painel não estiver aberto/visível.
function extractFromContactDrawer() {
  const result = { name: '', phone: '' };

  // Tenta data-testid="contact-info-subtitle" — esse é o nome no drawer
  for (const sel of SEL.drawerContactName) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const text = (el.textContent || '').trim();
    if (text && !isStatusText(text) && text.length >= 2 && text.length <= 80) {
      result.name = text;
      break;
    }
  }

  // Procura telefones (formato BR ou internacional) em selectable-text spans
  // Restringe a busca: precisa estar perto de um drawerContactName se possível
  document.querySelectorAll('[data-testid="selectable-text"]').forEach(el => {
    if (result.phone) return;
    const text = (el.textContent || '').trim();
    // Telefone: começa com + ou tem dígitos formatados (XX XXX-XXXX)
    if (!/^[\+\d\s()\-]{7,25}$/.test(text)) return;
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) {
      result.phone = digits;
    }
  });

  return result;
}

// Extrai nome do contato do header — robusto contra mudanças do WhatsApp.
// Estratégia: percorre todos os candidatos (spans/divs com texto) no header,
// filtra textos de status, e escolhe o que provavelmente é o nome.
function extractContactNameFromHeader() {
  const headerEl = queryFirst(SEL.header);
  if (!headerEl) return { name: '', source: 'no-header' };

  // 1) Coleta TODOS os candidatos: spans/divs com title OU com texto curto
  const candidates = [];
  const seenTexts = new Set();

  // Estratégia 1: elementos com [title]
  headerEl.querySelectorAll('span[title], div[title]').forEach(el => {
    const title = (el.getAttribute('title') || '').trim();
    const text = (el.textContent || '').trim();
    if (!title) return;
    if (seenTexts.has(title)) return;
    seenTexts.add(title);
    candidates.push({
      text: title,
      domText: text,
      hasTitle: true,
      tag: el.tagName,
      cls: el.className || '',
      el,
    });
  });

  // Estratégia 2: SEMPRE roda também — pega spans-folha com texto.
  // O nome do contato no WhatsApp atual NÃO tem [title], só textContent.
  headerEl.querySelectorAll('span').forEach(el => {
    const text = (el.textContent || '').trim();
    if (!text || text.length < 2 || text.length > 80) return;
    if (seenTexts.has(text)) return;
    // Ignora spans com filhos (queremos folhas — onde o texto realmente está)
    if (el.children.length > 0) return;
    seenTexts.add(text);
    candidates.push({
      text,
      domText: text,
      hasTitle: false,
      tag: el.tagName,
      cls: el.className || '',
      el,
    });
  });

  // 2) Filtra: descarta status, telefone vazio, datas, etc.
  const filtered = candidates.filter(c => {
    if (isStatusText(c.text)) return false;
    // Descarta strings que parecem horários (ex: "07:59")
    if (/^\d{1,2}:\d{2}$/.test(c.text)) return false;
    // Descarta strings curtas demais
    if (c.text.length < 2) return false;
    return true;
  });

  if (filtered.length === 0) {
    return { name: '', source: 'no-candidate', candidates };
  }

  // 3) Heurística de escolha: prefere o PRIMEIRO candidato (header costuma
  // ter nome antes do status). Se o texto parece um número de telefone,
  // ainda assim retorna — pode ser contato sem nome salvo.
  const chosen = filtered[0];
  return {
    name: chosen.text,
    source: chosen.hasTitle ? 'header-title' : 'header-text',
    candidates,
  };
}

function extractContactInfo() {
  // Pede dados frescos ao inject.js (Store)
  requestStoreData();

  const nameEl = queryFirst(SEL.contactTitle);
  const subEl  = queryFirst(SEL.contactSub);

  // Telemetry: se o Store não retornou nada mas o DOM achou algo, registrar fallback
  const storeHasPhone = !!storeData.phone;
  const storeHasName = !!(storeData.name || storeData.pushname);

  // Estratégia 1: painel "Dados do contato" (drawer) — seletores mais estáveis
  const drawerData = extractFromContactDrawer();

  // Estratégia 2: header — extração robusta via candidatos
  const headerExtract = extractContactNameFromHeader();

  // Nome: drawer > header
  const domName = drawerData.name || headerExtract.name;

  // Store > DOM (filtrado)
  const storeName = storeData.name || storeData.pushname || '';
  const name = (isStatusText(storeName) ? '' : storeName) || domName;

  // Telefone: Store > drawer > DOM data-id > subtítulo
  let phone = storeData.phone || '';
  let phoneSource = storeHasPhone ? 'store' : '';

  // Estratégia drawer — painel "Dados do contato" abre com o telefone visível
  if (!phone && drawerData.phone) {
    phone = drawerData.phone;
    phoneSource = 'drawer';
  }

  if (!phone) {
    phone = extractPhoneFromDOM();
    if (phone) phoneSource = 'dom-dataid';
  }

  if (!phone) {
    const sub = subEl?.getAttribute('title') || subEl?.textContent?.trim() || '';
    const phoneRaw = sub.match(/[\+\d][\d\s\-().]{7,}/)?.[0] || '';
    phone = phoneRaw.replace(/\D/g, '');
    if (phone) phoneSource = 'dom-subtitle';
  }

  // Se o telefone ainda não foi encontrado mas o nome parece um número
  // (ex: "+55 65 9605-4118" ou "11 98598-6627"), extrai os dígitos do nome
  if (!phone && name) {
    const digitsFromName = name.replace(/\D/g, '');
    if (digitsFromName.length >= 8) {
      phone = digitsFromName;
      phoneSource = 'name-digits';
    }
  }

  // Reporta fallback quando Store estava pronto mas não retornou dados
  if (isConversationOpen()) {
    if (storeStatus === 'found' && !storeHasPhone && phone) {
      reportTelemetry('selector_fallback', 'contact_phone_via_' + phoneSource, {
        storeReady: true,
        storeHasName,
      });
    }
    if (storeStatus === 'found' && !storeHasName && name) {
      reportTelemetry('selector_fallback', 'contact_name_via_dom', {
        storeReady: true,
        domHadTitle: !!nameEl?.getAttribute('title'),
      });
    }
    if (!phone && !name) {
      // Dump dados ricos para identificar qual seletor novo usar
      const headerCandidates = (headerExtract.candidates || []).slice(0, 8).map(c => ({
        text: c.text.substring(0, 60),
        domText: c.domText.substring(0, 60),
        hasTitle: c.hasTitle,
        tag: c.tag,
        cls: (c.cls || '').substring(0, 80),
      }));
      const nameInfo = nameEl ? {
        tag: nameEl.tagName,
        cls: nameEl.className?.substring?.(0, 80) || '',
        hasTitle: !!nameEl.getAttribute('title'),
        title: (nameEl.getAttribute('title') || '').substring(0, 60),
        text: (nameEl.textContent || '').substring(0, 60),
        parentCls: nameEl.parentElement?.className?.substring?.(0, 80) || '',
      } : null;
      const subInfo = subEl ? {
        tag: subEl.tagName,
        cls: subEl.className?.substring?.(0, 80) || '',
        hasTitle: !!subEl.getAttribute('title'),
        title: (subEl.getAttribute('title') || '').substring(0, 60),
        text: (subEl.textContent || '').substring(0, 60),
      } : null;
      const headerEl = queryFirst(SEL.header);
      const headerInfo = headerEl ? {
        tag: headerEl.tagName,
        cls: headerEl.className?.substring?.(0, 80) || '',
        spanCount: headerEl.querySelectorAll('span').length,
        spansWithTitle: Array.from(headerEl.querySelectorAll('span[title]'))
          .slice(0, 5)
          .map(s => ({
            title: (s.getAttribute('title') || '').substring(0, 40),
            text: (s.textContent || '').substring(0, 40),
            cls: (s.className || '').substring(0, 60),
          })),
      } : null;

      // Dump dos data-testid disponíveis na página (descobrir nomes vivos)
      const liveTestIds = Array.from(
        new Set(
          Array.from(document.querySelectorAll('[data-testid]'))
            .slice(0, 200)
            .map(el => el.getAttribute('data-testid'))
            .filter(id => id && id.length < 60)
        )
      ).slice(0, 40);

      reportTelemetry('extraction_failed', 'contact_info', {
        storeStatus,
        nameElFound: !!nameEl,
        subElFound: !!subEl,
        drawerName: drawerData.name,
        drawerPhone: drawerData.phone,
        headerExtractSource: headerExtract.source,
        headerCandidates,
        liveTestIds,
        nameInfo,
        subInfo,
        headerInfo,
      });
    }
  }

  return { name, phone };
}

// Sobe na árvore DOM a partir de 'el' até 'root' buscando direção da mensagem
function detectDirection(el, root) {
  let node = el;
  while (node && node !== root) {
    const dataId = node.getAttribute?.('data-id') || '';
    if (dataId) return dataId.startsWith('true_') ? 'out' : 'in';
    const cls = typeof node.className === 'string' ? node.className : '';
    if (cls.includes('message-out')) return 'out';
    if (cls.includes('message-in'))  return 'in';
    node = node.parentElement;
  }
  return 'in'; // default: recebida
}

// Extrai o texto limpo de um elemento — percorre seletores por prioridade
function extractTextFromMsgEl(el) {
  const candidates = [
    el.querySelector('span.selectable-text.copyable-text'),
    el.querySelector('span.selectable-text'),
    el.querySelector('.copyable-text'),
    el.querySelector('span[dir="ltr"]'),
    el.querySelector('span[dir="auto"]'),
    el,
  ];
  for (const node of candidates) {
    if (!node) continue;
    const text = node.textContent?.trim();
    if (text && text.length > 0 && text.length < 4000) return text;
  }
  return null;
}

// ─── Conversa via Store (primário) ────────────────────────────
// Tenta primeiro o Store via inject.js; cai pro DOM se falhar.
async function extractConversation() {
  // 1) Store-first — imune a mudanças no HTML
  if (storeStatus === 'found') {
    try {
      const storeResult = await requestStoreMessages(100);
      if (storeResult?.messages?.length > 0) {
        console.log(`[WZ-SF] Conversa: ${storeResult.messages.length} msgs via Store ✅`);
        reportTelemetry('strategy_used', 'conversation_store', {
          count: storeResult.messages.length,
        });
        // Limpa _diag (não foi DOM)
        extractConversation._diag = { source: 'store', count: storeResult.messages.length };
        return storeResult.messages.map(m => ({ text: m.text, direction: m.direction }));
      }
      // Store respondeu mas vazio — reporta e cai pro DOM
      reportTelemetry('selector_fallback', 'conversation_store_empty', {
        source: storeResult?.source || 'unknown',
      });
    } catch (e) {
      reportTelemetry('selector_fallback', 'conversation_store_error', {
        error: e.message?.substring(0, 100),
      });
    }
  }

  // 2) Fallback DOM (estratégias 1-6)
  return extractConversationFromDOM();
}

function extractConversationFromDOM() {
  const msgs = [];
  const seen = new Set();
  const mainEl = getConversationContainer();
  if (!mainEl) return msgs;

  // ── Diagnóstico — contagem de elementos por seletor ──────────
  // Este objeto será anexado ao payload para vermos no n8n
  const diag = {
    hasMain: !!mainEl,
    mainTag: mainEl.tagName,
    mainId: mainEl.id || '(none)',
    mainDivCount: mainEl.querySelectorAll('div').length,
    prePlainText: mainEl.querySelectorAll('[data-pre-plain-text]').length,
    dataIdCus: mainEl.querySelectorAll('[data-id*="@c.us"]').length,
    dataIdGus: mainEl.querySelectorAll('[data-id*="@g.us"]').length,
    msgContainer: mainEl.querySelectorAll('[data-testid="msg-container"]').length,
    msgBubble: mainEl.querySelectorAll('[data-testid="msg-bubble"]').length,
    messageIn: mainEl.querySelectorAll('[class*="message-in"]').length,
    messageOut: mainEl.querySelectorAll('[class*="message-out"]').length,
    selectableText: mainEl.querySelectorAll('span.selectable-text').length,
    copyableText: mainEl.querySelectorAll('.copyable-text').length,
    spanDirLtr: mainEl.querySelectorAll('span[dir="ltr"]').length,
    spanDirAuto: mainEl.querySelectorAll('span[dir="auto"]').length,
    allDivs: mainEl.querySelectorAll('div').length,
    allSpans: mainEl.querySelectorAll('span').length,
  };

  // Captura amostra: primeiras 3 tags+atributos dos filhos do scrollable
  try {
    const scrollable = mainEl.querySelector('[role="application"]')
      || mainEl.querySelector('[data-testid="conversation-panel-messages"]')
      || mainEl.querySelector('[tabindex]');
    if (scrollable) {
      diag.scrollableTag = scrollable.tagName;
      diag.scrollableRole = scrollable.getAttribute('role');
      const rows = scrollable.children;
      diag.scrollableChildCount = rows.length;
      diag.sampleRows = [];
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        const r = rows[i];
        const attrs = {};
        for (const a of r.attributes) attrs[a.name] = a.value.substring(0, 80);
        diag.sampleRows.push({ tag: r.tagName, attrs, childCount: r.children.length,
          innerTextSnippet: (r.innerText || '').substring(0, 120) });
      }
    } else {
      diag.scrollableFound = false;
      // fallback: peek first few children of #main
      diag.mainChildCount = mainEl.children.length;
      diag.mainChildren = [];
      for (let i = 0; i < Math.min(5, mainEl.children.length); i++) {
        const c = mainEl.children[i];
        const attrs = {};
        for (const a of c.attributes) attrs[a.name] = a.value.substring(0, 80);
        diag.mainChildren.push({ tag: c.tagName, attrs });
      }
    }
  } catch (_) { /* ignore */ }

  // Salva diag para ser incluído no payload
  extractConversation._diag = diag;
  extractConversationFromDOM._diag = diag;
  console.log('[WZ-SF] DOM Diagnóstico:', JSON.stringify(diag, null, 2));

  function pushMsg(text, direction) {
    const key = direction + ':' + text;
    if (!text || seen.has(key)) return;
    seen.add(key);
    msgs.push({ text, direction });
  }

  // ── Estratégia 1: data-pre-plain-text ────────────────────────
  const byPrePlain = mainEl.querySelectorAll('[data-pre-plain-text]');
  if (byPrePlain.length > 0) {
    byPrePlain.forEach(el => {
      const text = extractTextFromMsgEl(el);
      if (!text) return;
      const dir = detectDirection(el, mainEl);
      pushMsg(text, dir);
    });
    if (msgs.length > 0) {
      console.log(`[WZ-SF] Conversa: ${msgs.length} msgs via data-pre-plain-text ✅`);
      reportTelemetry('strategy_used', 'conversation_data-pre-plain-text', { count: msgs.length });
      return msgs;
    }
  }

  // ── Estratégia 2: data-id com @c.us ou @g.us ─────────────────
  const byDataId = mainEl.querySelectorAll('[data-id*="@c.us"], [data-id*="@g.us"]');
  if (byDataId.length > 0) {
    byDataId.forEach(el => {
      const text = extractTextFromMsgEl(el);
      if (!text) return;
      const isOut = (el.getAttribute('data-id') || '').startsWith('true_');
      pushMsg(text, isOut ? 'out' : 'in');
    });
    if (msgs.length > 0) {
      console.log(`[WZ-SF] Conversa: ${msgs.length} msgs via data-id ✅`);
      reportTelemetry('strategy_used', 'conversation_data-id', { count: msgs.length });
      return msgs;
    }
  }

  // ── Estratégia 3: data-testid msg ────────────────────────────
  mainEl.querySelectorAll('[data-testid="msg-container"], [data-testid="msg-bubble"]')
    .forEach(el => {
      const text = extractTextFromMsgEl(el);
      if (!text) return;
      const isOut = !!el.querySelector('[data-testid*="dblcheck"], [data-testid*="check"], [data-icon*="dblcheck"], [data-icon*="check"]');
      pushMsg(text, isOut ? 'out' : 'in');
    });
  if (msgs.length > 0) {
    console.log(`[WZ-SF] Conversa: ${msgs.length} msgs via data-testid ✅`);
    reportTelemetry('selector_fallback', 'conversation_data-testid', { count: msgs.length });
    return msgs;
  }

  // ── Estratégia 4: message-in / message-out ────────────────────
  mainEl.querySelectorAll('[class*="message-in"], [class*="message-out"]')
    .forEach(el => {
      const text = extractTextFromMsgEl(el);
      if (!text) return;
      const isOut = Array.from(el.classList).some(c => c.includes('message-out'));
      pushMsg(text, isOut ? 'out' : 'in');
    });
  if (msgs.length > 0) {
    console.log(`[WZ-SF] Conversa: ${msgs.length} msgs via class ✅`);
    reportTelemetry('selector_fallback', 'conversation_class-message-in-out', { count: msgs.length });
    return msgs;
  }

  // ── Estratégia 5 (último recurso): span.selectable-text direto ─
  // Busca todos os spans de texto selecionável e sobe no DOM para achar direção
  mainEl.querySelectorAll('span.selectable-text, span[dir="ltr"], span[dir="auto"]')
    .forEach(el => {
      const text = el.innerText?.trim() || el.textContent?.trim();
      if (!text || text.length < 2 || text.length > 4000) return;
      const dir = detectDirection(el, mainEl);
      pushMsg(text, dir);
    });
  if (msgs.length > 0) {
    console.log(`[WZ-SF] Conversa: ${msgs.length} msgs via span direto ✅`);
    reportTelemetry('selector_fallback', 'conversation_span-selectable', { count: msgs.length });
    return msgs;
  }

  // ── Estratégia 6 (nuclear): innerText de divs com role="row" ──
  mainEl.querySelectorAll('[role="row"]').forEach(el => {
    const text = el.innerText?.trim();
    if (!text || text.length < 2 || text.length > 4000) return;
    const dir = detectDirection(el, mainEl);
    pushMsg(text, dir);
  });

  if (msgs.length > 0) {
    reportTelemetry('selector_fallback', 'conversation_role-row', { count: msgs.length });
  } else {
    reportTelemetry('extraction_failed', 'conversation_all_strategies', {
      diag: extractConversation._diag,
    });
  }

  console.log(`[WZ-SF] Conversa: ${msgs.length} msgs (todas as estratégias esgotadas)`);
  return msgs;
}

function buildConversationSummary(msgs) {
  if (!msgs.length) return '';
  return msgs
    .slice(-20)
    .map(m => `${m.direction === 'out' ? 'Vendedor' : 'Cliente'}: ${m.text}`)
    .join('\n');
}

// ─── Painel flutuante ────────────────────────────────────────
function isConversationOpen() {
  return !!queryAny(SEL.header);
}

function updatePanel() {
  let panel = document.getElementById(PANEL_ID);
  let fab = document.getElementById('wzsf-fab');

  // Cria painel + FAB se não existir
  if (!panel) {
    panel = createPanel();
    document.body.appendChild(panel);
    fab = createFAB();
    document.body.appendChild(fab);
    console.log('[WZ-SF] Painel + FAB criados ✅');
  }

  if (!isConversationOpen()) {
    panel.querySelector('.wzsf-contact-name').textContent = 'Aguardando...';
    panel.querySelector('.wzsf-contact-phone').textContent = 'Abra uma conversa no WhatsApp';
    panel.querySelectorAll('[data-action]').forEach(b => b.disabled = true);
    lastConversationKey = null;
    return;
  }

  // Habilita botões apenas se: conversa aberta + NÃO é grupo + SF autenticado
  const isGroup = isGroupChat();
  const shouldDisable = isGroup || !sfAuthenticated;
  panel.querySelectorAll('[data-action]').forEach(b => {
    b.disabled = shouldDisable;
    b.title = shouldDisable ? (isGroup ? 'Grupos não suportados' : 'Faça login no Salesforce') : '';
  });

  if (isGroup) {
    const nameEl = queryFirst(SEL.contactTitle);
    const groupName = nameEl?.getAttribute('title') || nameEl?.textContent?.trim() || 'Grupo';
    panel.querySelector('.wzsf-contact-name').textContent = groupName;
    panel.querySelector('.wzsf-contact-phone').textContent = '👥 Grupo — sem envio';
    panel.querySelector('.wzsf-status').textContent = '';
    panel.querySelector('.wzsf-status').className = 'wzsf-status';
    lastConversationKey = 'group_' + groupName;
    return;
  }

  const contact = extractContactInfo();
  const conversationKey = contact.name + contact.phone;

  if (conversationKey !== lastConversationKey) {
    lastConversationKey = conversationKey;
    panel.querySelector('.wzsf-contact-name').textContent  = contact.name  || 'Contato';
    panel.querySelector('.wzsf-contact-phone').textContent = contact.phone ? `+${contact.phone}` : 'Número não detectado';
    panel.querySelector('.wzsf-status').textContent = '';
    panel.querySelector('.wzsf-status').className = 'wzsf-status';
    // Limpa dados do contato anterior imediatamente
    currentLeadInfo = null;
    lastLookupPhone = null;
    updateLeadBadge();
    updateFabLeadStatus();
    // Limpa cache de tentativas — evita crescimento infinito.
    // Quando muda de conversa, mantém só as últimas 20 tentativas.
    if (drawerAttempted.size > 20) {
      drawerAttempted.clear();
    }
    console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${contact.phone}`);
  }

  // Se não há telefone mas temos nome, tenta abrir o drawer (uma vez) para capturar.
  // Cacheamos por nome para não ficar abrindo/fechando.
  // PROTEÇÕES anti-loop:
  //   1) NÃO faz em grupos (isGroupChat)
  //   2) Marca tentativas falhas para não retentar (cache negativo)
  //   3) Limite global de 1 tentativa por conversationKey
  if (!contact.phone && contact.name && !isGroupChat() && !isLikelyGroup(contact)) {
    const cached = getDrawerCachedPhone(contact.name);
    if (cached) {
      contact.phone = cached;
      panel.querySelector('.wzsf-contact-phone').textContent = `+${contact.phone}`;
      console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${contact.phone} (cache drawer)`);
    } else if (!drawerOpenInProgress && !drawerAttempted.has(conversationKey)) {
      // Marca ANTES de chamar — se falhar, não tenta de novo nesta conversa
      drawerAttempted.add(conversationKey);
      // Abre o drawer programaticamente em background
      openDrawerToReadPhone(contact.name).then(phone => {
        if (!phone) return;
        setDrawerCachedPhone(contact.name, phone);
        // Re-renderiza painel se o contato ainda for o mesmo
        const stillSameContact = lastConversationKey?.startsWith(contact.name);
        if (stillSameContact) {
          const phoneEl = panel.querySelector('.wzsf-contact-phone');
          if (phoneEl) phoneEl.textContent = `+${phone}`;
          console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${phone} (auto-drawer)`);
          if (sfAuthenticated && phone !== lastLookupPhone && !lookupInProgress) {
            lookupLeadByPhone(phone, true);
          }
        }
      });
    }
  }

  // Se ainda não há telefone, garante que badge fique vazio
  if (!contact.phone) {
    if (currentLeadInfo !== null) {
      currentLeadInfo = null;
      updateLeadBadge();
      updateFabLeadStatus();
    }
    return;
  }

  // Lookup controlado SOMENTE pelo telefone — o nome pode mudar sem disparar nova busca
  if (sfAuthenticated && contact.phone !== lastLookupPhone && !lookupInProgress) {
    currentLeadInfo = null;
    updateLeadBadge();
    lookupLeadByPhone(contact.phone, true);
  }
}

function createPanel() {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <!-- HEADER -->
    <div class="wzsf-header">
      <div class="wzsf-header-left">
        <div class="wzsf-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <div>
          <span class="wzsf-title">SF Sync</span>
          <span class="wzsf-version">${VERSION}</span>
        </div>
      </div>
      <div class="wzsf-header-actions">
        <button class="wzsf-btn-header" id="wzsf-minimize" title="Minimizar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
        </button>
        <button class="wzsf-btn-header" id="wzsf-close" title="Fechar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>



    <!-- CONTENT -->
    <div class="wzsf-content">
      <div class="wzsf-tab-content">
        <div class="wzsf-sf-auth">
          <div class="wzsf-sf-auth-status">
            <span class="wzsf-sf-auth-dot wzsf-dot-offline"></span>
            <span class="wzsf-sf-auth-text">SF Desconectado</span>
          </div>
          <button id="wzsf-sf-login" class="wzsf-sf-login-btn" title="Login Salesforce">🔐 Login SF</button>
          <button id="wzsf-sf-logout" class="wzsf-sf-logout-btn" title="Sair do Salesforce" style="display:none;">🚪 Sair</button>
        </div>

        <!-- Card Contato -->
        <div class="wzsf-card">
          <div class="wzsf-avatar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0D9488" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
          <div class="wzsf-contact-info">
            <div class="wzsf-contact-name">Contato</div>
            <div class="wzsf-contact-phone">—</div>
          </div>
          <button class="wzsf-btn-chevron" title="Detalhes">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>

        <!-- Ações -->
        <div class="wzsf-actions">
          <button class="wzsf-btn-primary" data-action="lead">
            <span class="wzsf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
            Salvar como Lead
          </button>
          <button class="wzsf-btn-secondary" data-action="conversation">
            <span class="wzsf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg></span>
            Registrar Contato
          </button>
          <button class="wzsf-btn-secondary" data-action="activity">
            <span class="wzsf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg></span>
            Criar Atividade
          </button>
          <button class="wzsf-btn-ghost" data-action="open">
            <span class="wzsf-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>
            Abrir no Salesforce
          </button>
        </div>

        <!-- Status -->
        <div class="wzsf-status"></div>
      </div>


    </div>

    <!-- FOOTER -->
    <div class="wzsf-footer">
      <span class="wzsf-footer-text">Pressione</span>
      <span class="wzsf-kbd">Esc</span>
      <span class="wzsf-footer-text">para fechar</span>
    </div>
  `;



  // ─── Header buttons (minimize/close) ────────────────────────
  const minimizeBtn = panel.querySelector('#wzsf-minimize');
  const closeBtn = panel.querySelector('#wzsf-close');

  minimizeBtn.addEventListener('click', () => {
    panel.classList.add('wzsf-hidden');
    const fab = document.getElementById('wzsf-fab');
    fab?.classList.remove('wzsf-hidden');
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.add('wzsf-hidden');
    const fab = document.getElementById('wzsf-fab');
    fab?.classList.add('wzsf-hidden');
  });

  // ─── Arrastar o painel ─────────────────────────────────────
  makeDraggable(panel);

  // ─── Botão SF Login ──────────────────────────────────────────
  const sfLoginBtn = panel.querySelector('#wzsf-sf-login');
  if (sfLoginBtn) {
    sfLoginBtn.addEventListener('click', triggerSfLogin);
  }

  // ─── Botão SF Logout ─────────────────────────────────────────
  const sfLogoutBtn = panel.querySelector('#wzsf-sf-logout');
  if (sfLogoutBtn) {
    sfLogoutBtn.addEventListener('click', () => {
      sfLogoutBtn.disabled = true;
      sfLogoutBtn.textContent = '⏳ Saindo...';
      chrome.runtime.sendMessage({ action: 'sfLogout' }, (resp) => {
        sfLogoutBtn.disabled = false;
        sfLogoutBtn.textContent = '🚪 Sair';
        if (chrome.runtime.lastError) return;
        sfAuthenticated = false;
        sfUserName = '';
        updateSfAuthIndicator();
        updatePanel();
      });
    });
  }

  // ─── Botões de ação ────────────────────────────────────────
  panel.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const contact = extractContactInfo();
      // Para "open" e "lead", não precisa da conversa — evita request desnecessário
      const needsConversation = btn.dataset.action === 'conversation';
      const conversation = needsConversation ? await extractConversation() : [];
      handleAction(btn.dataset.action, contact, conversation, panel);
    });
  });

  return panel;
}

// ─── FAB (Floating Action Button) ──────────────────────────────
function createFAB() {
  const fab = document.createElement('button');
  fab.id = 'wzsf-fab';
  fab.className = 'wzsf-fab wzsf-hidden';
  fab.title = 'SF Sync (Alt+S)';
  fab.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';

  fab.addEventListener('click', () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.classList.remove('wzsf-hidden');
      fab.classList.add('wzsf-hidden');
    }
  });

  return fab;
}

// Atualiza a cor do FAB conforme o status do lead atual
// amarelo = sem lead | verde = lead meu ativo | laranja = lead de outro | cinza = encerrado
function updateFabLeadStatus() {
  const fab = document.getElementById('wzsf-fab');
  if (!fab) return;

  fab.classList.remove('wzsf-fab-no-lead', 'wzsf-fab-my-lead', 'wzsf-fab-other-lead', 'wzsf-fab-closed');

  if (lookupInProgress) return; // não muda cor enquanto busca

  if (!currentLeadInfo || currentLeadInfo.encerrado) {
    fab.classList.add('wzsf-fab-no-lead');   // amarelo — sem lead ou encerrado
    fab.title = currentLeadInfo?.encerrado
      ? 'SF Sync — Lead encerrado (disponível)'
      : 'SF Sync — Sem Lead cadastrado';
  } else if (sfUserId && currentLeadInfo.ownerId !== sfUserId) {
    fab.classList.add('wzsf-fab-other-lead'); // laranja
    fab.title = `SF Sync — Em atendimento por ${currentLeadInfo.ownerName || 'outro vendedor'}`;
  } else {
    fab.classList.add('wzsf-fab-my-lead');   // verde
    fab.title = `SF Sync — Lead: ${currentLeadInfo.leadName || ''}`;
  }
}

// ─── Ações — Envia ao n8n via webhooks ────────────────────────
async function handleAction(action, contact, conversation, panel) {
  const status = panel.querySelector('.wzsf-status');

  // "Abrir no Salesforce" — usa o link direto do Lead se disponível
  if (action === 'open') {
    if (currentLeadInfo?.leadUrl) {
      await sendMessage({ action: 'openInSalesforce', leadUrl: currentLeadInfo.leadUrl });
    } else {
      await sendMessage({ action: 'openInSalesforce', phone: contact.phone });
    }
    return;
  }

  const confirmed = await showConfirmModal(contact, action);
  if (!confirmed) return;

  const now = new Date().toISOString();
  const nowBR = new Date().toLocaleString('pt-BR');
  const [first, ...rest] = (confirmed.name || 'Desconhecido').split(' ');

  // Validação client-side antes de enviar à API
  if (!confirmed.phone || confirmed.phone.replace(/\D/g, '').length < 8) {
    setStatus(status, 'error', '❌ Telefone inválido ou não detectado. Corrija o número no modal.');
    return;
  }

  disableButtons(panel, true);
  setStatus(status, 'loading', '⏳ Enviando ao n8n...');

  try {
    let msgAction, msgData;

    if (action === 'lead') {
      msgAction = 'saveLead';
      msgData = {
        firstName: first,
        lastName: rest.join(' ') || '(via WhatsApp)',
        phone: confirmed.phone,
        name: confirmed.name,
        interesse: confirmed.interesse || undefined,
        description: `Lead capturado via WhatsApp em ${nowBR}`,
        sellerPhone,
      };

    } else if (action === 'conversation') {
      msgAction = 'registerConversation';
      msgData = {
        phone: confirmed.phone,
        name: confirmed.name,
        messages: conversation,
        messageCount: conversation.length,
        summary: buildConversationSummary(conversation),
        capturedAt: nowBR,
        sellerPhone,
        _debug: extractConversation._diag || null,
      };

    } else if (action === 'activity') {
      const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      msgAction = 'createActivity';
      msgData = {
        phone: confirmed.phone,
        name: confirmed.name,
        subject: `Lembrete: contatar ${confirmed.name || confirmed.phone}`,
        dueDate: futureDate,
        priority: 'Normal',
        description: `Atividade criada via WhatsApp em ${nowBR}`,
        sellerPhone,
      };
    }

    const result = await sendMessage({ action: msgAction, data: msgData });

    if (result?.ok) {
      setStatus(status, 'success', '✅ Enviado com sucesso!');
      // Refresh automático após criação de lead
      if (action === 'lead' && confirmed.phone) {
        lastLookupPhone = null;
        currentLeadInfo = null;
        updateLeadBadge();
        setTimeout(() => lookupLeadByPhone(confirmed.phone), 1500);
      }
    } else if (result?.duplicate) {
      setStatus(status, 'error', '⚠️ Já enviado nas últimas 24h');
      disableButtons(panel, false);
      const force = confirm('⚠️ Este registro já foi enviado nas últimas 24h.\n\nDeseja enviar novamente?');
      if (force) {
        disableButtons(panel, true);
        setStatus(status, 'loading', '⏳ Reenviando...');
        const retry = await sendMessage({ action: msgAction + '_force', data: msgData });
        if (retry?.ok) {
          setStatus(status, 'success', '✅ Reenviado!');
        } else {
          setStatus(status, 'error', `❌ ${retry?.error || 'Erro'}`);
        }
      }
    } else {
      setStatus(status, 'error', `❌ ${result?.error || 'Erro desconhecido'}`);
    }
  } catch (e) {
    setStatus(status, 'error', `❌ ${e.message}`);
  } finally {
    disableButtons(panel, false);
    setTimeout(() => clearStatus(status), 6000);
  }
}

// Promisifica chrome.runtime.sendMessage
function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message || '';
          // "Extension context invalidated" = extensão recarregada, basta recarregar a página
          if (err.includes('Extension context invalidated') || err.includes('context invalidated')) {
            resolve({ ok: false, error: 'Extensão atualizada. Recarregue a página (F5).' });
          } else {
            resolve({ ok: false, error: err });
          }
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      resolve({ ok: false, error: 'Extensão atualizada. Recarregue a página (F5).' });
    }
  });
}

function setStatus(el, type, msg) {
  el.className = `wzsf-status wzsf-status-${type}`;
  el.textContent = msg;
}
function clearStatus(el) {
  el.className = 'wzsf-status';
  el.textContent = '';
}
function disableButtons(panel, disable) {
  panel.querySelectorAll('[data-action]').forEach(b => b.disabled = disable);
}

// ─── Modal de confirmação ────────────────────────────────────
function showConfirmModal(contact, action) {
  return new Promise(async resolve => {
    document.getElementById(MODAL_ID)?.remove();

    // Busca picklist Interesse_em__c apenas para criar lead
    let interestOptions = [];
    if (action === 'lead') {
      try {
        const pkResult = await sendMessage({ action: 'getPicklist', data: { field: 'Interesse_em__c' } });
        if (pkResult?.ok && pkResult?.values) interestOptions = pkResult.values;
      } catch (_) {}
    }

    const interestHtml = action === 'lead' && interestOptions.length > 0 ? `
      <label class="wzsf-label">
        Interesse em
        <div class="wzsf-custom-select" id="wzsf-custom-select" tabindex="0">
          <div class="wzsf-custom-select__trigger" id="wzsf-select-trigger">
            <span id="wzsf-select-label">-- Selecione --</span>
            <svg class="wzsf-custom-select__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="wzsf-custom-select__dropdown" id="wzsf-select-dropdown">
            <div class="wzsf-custom-select__option wzsf-custom-select__option--placeholder" data-value="">-- Selecione --</div>
            ${interestOptions.map(v => `<div class="wzsf-custom-select__option" data-value="${escHtml(v.value)}">${escHtml(v.label)}</div>`).join('')}
          </div>
        </div>
      </label>` : '';

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="wzsf-overlay">
        <div class="wzsf-modal-box">
          <div class="wzsf-modal-title">Confirmar contato</div>
          <label class="wzsf-label">
            Nome
            <input id="wzsf-inp-name" type="text" value="${escHtml(contact.name)}" placeholder="Nome do contato" />
          </label>
          <label class="wzsf-label">
            Telefone
            <input id="wzsf-inp-phone" type="text" value="${escHtml(contact.phone)}" placeholder="Ex: 5511999999999" />
          </label>
          ${interestHtml}
          <div class="wzsf-modal-actions">
            <button id="wzsf-cancel" class="wzsf-btn-ghost">Cancelar</button>
            <button id="wzsf-confirm" class="wzsf-btn-primary">Confirmar</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // ── Custom select logic ──
    const customSelect = modal.querySelector('#wzsf-custom-select');
    if (customSelect) {
      let selectedValue = '';
      const trigger = customSelect.querySelector('#wzsf-select-trigger');
      const labelEl = customSelect.querySelector('#wzsf-select-label');
      const dropdown = customSelect.querySelector('#wzsf-select-dropdown');
      const options = dropdown.querySelectorAll('.wzsf-custom-select__option');

      const open = () => {
        customSelect.classList.add('wzsf-custom-select--open');
        trigger.focus();
      };
      const close = () => customSelect.classList.remove('wzsf-custom-select--open');
      const toggle = () => customSelect.classList.contains('wzsf-custom-select--open') ? close() : open();

      trigger.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      customSelect.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        if (e.key === 'Escape') close();
      });
      document.addEventListener('click', (e) => {
        if (!customSelect.contains(e.target)) close();
      }, { capture: true });

      options.forEach(opt => {
        opt.addEventListener('click', () => {
          selectedValue = opt.dataset.value;
          labelEl.textContent = opt.textContent;
          options.forEach(o => o.classList.remove('wzsf-custom-select__option--selected'));
          if (selectedValue) opt.classList.add('wzsf-custom-select__option--selected');
          close();
        });
      });

      // Expose value via getter on the container
      customSelect._getValue = () => selectedValue;
    }
    modal.querySelector('#wzsf-cancel').addEventListener('click', () => {
      modal.remove(); resolve(null);
    });
    modal.querySelector('.wzsf-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) { modal.remove(); resolve(null); }
    });
    modal.querySelector('#wzsf-confirm').addEventListener('click', () => {
      const name  = modal.querySelector('#wzsf-inp-name').value.trim();
      const phone = modal.querySelector('#wzsf-inp-phone').value.trim().replace(/\D/g, '');
      const customSel = modal.querySelector('#wzsf-custom-select');
      const interesse = customSel ? (customSel._getValue?.() || '') : '';
      modal.remove();
      resolve({ name, phone, interesse: interesse || undefined });
    });

    // Foco no campo de nome
    setTimeout(() => modal.querySelector('#wzsf-inp-name')?.focus(), 50);
  });
}

function escHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── Arrastar o painel ───────────────────────────────────────
function makeDraggable(el) {
  const header = el.querySelector('.wzsf-header');
  let ox = 0, oy = 0, sx = 0, sy = 0;

  header.style.cursor = 'grab';
  header.addEventListener('mousedown', e => {
    if (e.target.classList.contains('wzsf-toggle')) return;
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    header.style.cursor = 'grabbing';

    const onMove = e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      el.style.left = `${ox + dx}px`;
      el.style.top  = `${oy + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    const onUp = () => {
      header.style.cursor = 'grab';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── MutationObserver robusto ────────────────────────────────
// Observa apenas mudanças de filhos (não atributos) para performance
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(updatePanel, 400);
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: false,
  characterData: false,
});

// Checagem inicial (aguarda um pouco para o inject.js carregar)
console.log(`[WZ-SF] Extensão carregada no WhatsApp Web 🚀 ${VERSION}`);
setTimeout(() => {
  checkSfAuthStatus();
  checkWebhookConnection();
  loadSellerPhone();
  updatePanel();
}, 1500);
