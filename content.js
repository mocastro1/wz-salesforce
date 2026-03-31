// ============================================================
// WhatsApp → Salesforce (via n8n) | content.js
// Captura dados do WhatsApp Web e envia ao n8n
// ============================================================

const PANEL_ID = 'wzsf-panel';
const MODAL_ID = 'wzsf-modal';
const VERSION  = 'v2.1.0';
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
  chrome.runtime.sendMessage({ action: 'sfLogin' }, (resp) => {
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = '🔐 Login SF';
    }
    if (chrome.runtime.lastError) {
      console.warn(`[WZ-SF] SF Login falhou:`, chrome.runtime.lastError?.message);
      return;
    }
    if (!resp?.ok) {
      console.warn(`[WZ-SF] SF Login falhou:`, resp?.error);
      alert('Erro no login: ' + (resp?.error || 'Tente novamente'));
      return;
    }
    console.log('[WZ-SF] Login Salesforce concluído! ✅');
    // Aguarda um pouco para garantir que o token foi salvo
    setTimeout(() => {
      checkSfAuthStatus();
      updatePanel();
    }, 1000);
  });
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
  const mainEl = getConversationContainer();
  if (mainEl) {
    // Grupos usam @g.us nos data-id das mensagens
    if (mainEl.querySelector('[data-id*="@g.us"]')) return true;
    // Se tem @c.us é contato individual
    if (mainEl.querySelector('[data-id*="@c.us"]')) return false;
  }

  // Fallback: subtítulo com vírgulas (lista de participantes) indica grupo
  const subEl = queryFirst(SEL.contactSub);
  const sub = subEl?.getAttribute('title') || subEl?.textContent?.trim() || '';
  // "clique para mostrar dados do grupo" é texto fixo de grupo
  if (sub.includes('dados do grupo') || sub.includes('group info')) return true;
  // Lista de participantes: 2+ vírgulas e não é horário
  if ((sub.match(/,/g) || []).length >= 2 && !sub.includes(':')) return true;

  // Header: nome do chat com ícone de grupo ou "participantes"
  const headerEl = queryFirst(SEL.header);
  if (headerEl) {
    const groupIcon = headerEl.querySelector('[data-testid="group"], [data-icon="group"], [data-testid="default-group"]');
    if (groupIcon) return true;
  }

  return false;
}

// Textos do WhatsApp que NÃO são nomes de contato
const STATUS_TEXTS = [
  'online', 'offline', 'digitando', 'typing', 'recording',
  'gravando', 'visto por', 'last seen', 'clique para',
  'click to', 'dados do contato', 'dados do grupo',
  'contact info', 'group info', 'mostrar dados',
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

function extractContactInfo() {
  // Pede dados frescos ao inject.js (Store)
  requestStoreData();

  const nameEl = queryFirst(SEL.contactTitle);
  const subEl  = queryFirst(SEL.contactSub);

  // Nome: pega do DOM e filtra textos de status
  const rawDomName = nameEl?.getAttribute('title') || nameEl?.textContent?.trim() || '';
  const domName = isStatusText(rawDomName) ? '' : rawDomName;

  // Store > DOM (filtrado)
  const storeName = storeData.name || storeData.pushname || '';
  const name = (isStatusText(storeName) ? '' : storeName) || domName;

  // Telefone: Store > DOM data-id > subtítulo
  let phone = storeData.phone || '';

  if (!phone) {
    phone = extractPhoneFromDOM();
  }

  if (!phone) {
    const sub = subEl?.getAttribute('title') || subEl?.textContent?.trim() || '';
    const phoneRaw = sub.match(/[\+\d][\d\s\-().]{7,}/)?.[0] || '';
    phone = phoneRaw.replace(/\D/g, '');
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

function extractConversation() {
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
    return msgs;
  }

  // ── Estratégia 6 (nuclear): innerText de divs com role="row" ──
  mainEl.querySelectorAll('[role="row"]').forEach(el => {
    const text = el.innerText?.trim();
    if (!text || text.length < 2 || text.length > 4000) return;
    const dir = detectDirection(el, mainEl);
    pushMsg(text, dir);
  });

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
    console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${contact.phone}`);
  }

  // Se não há telefone, garante que badge fique vazio (sem dados do contato anterior)
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
    btn.addEventListener('click', () => {
      const contact = extractContactInfo();
      const conversation = extractConversation();
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
