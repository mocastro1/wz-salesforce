// ============================================================
// WhatsApp → Salesforce | content.js
// Captura dados do WhatsApp Web e envia ao Salesforce via wz-api
// ============================================================

const PANEL_ID = 'wzsf-panel';
const MODAL_ID = 'wzsf-modal';
const VERSION  = 'v2.7.0';

// ─── UI helpers ──────────────────────────────────────────────
// Formata telefone BR para exibição: +55 65 9 9640-2200 / +55 65 9640-2200.
// Fallback: prefixa "+" nos dígitos.
function formatPhoneDisplay(raw) {
  if (raw === null || raw === undefined) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `+${digits}`;
}

// Iniciais (até 2 caracteres maiúsculos) a partir do nome.
function getInitials(name) {
  if (!name) return '—';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Aplica nome, iniciais e telefone formatado no card do painel de uma só vez.
function setContactDisplay(panel, name, phoneDigits) {
  if (!panel) return;
  const nameEl = panel.querySelector('.wzsf-contact-name');
  const phoneEl = panel.querySelector('.wzsf-contact-phone');
  const initialsEl = panel.querySelector('.wzsf-avatar-initials');
  if (nameEl) nameEl.textContent = name || 'Aguardando contato...';
  if (phoneEl) {
    phoneEl.textContent = phoneDigits ? formatPhoneDisplay(phoneDigits) : '—';
  }
  if (initialsEl) initialsEl.textContent = name ? getInitials(name) : '—';
}
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

// ─── Verificar conexão com a API ───────────────────────────
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
    label.textContent = webhookOnline ? 'API Online' : 'API Offline';
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
    text.textContent = sfUserName || 'Salesforce conectado';
    if (loginBtn) loginBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = '';
  } else {
    dot.className = 'wzsf-sf-auth-dot wzsf-dot-offline';
    text.textContent = 'Salesforce desconectado';
    if (loginBtn) loginBtn.style.display = '';
    if (logoutBtn) logoutBtn.style.display = 'none';
  }
}

function triggerSfLogin() {
  const panel = document.getElementById(PANEL_ID);
  const loginBtn = panel?.querySelector('#wzsf-sf-login');
  if (loginBtn) {
    loginBtn.disabled = true;
    const t = loginBtn.querySelector('.wzsf-btn-text');
    if (t) t.textContent = 'Conectando...';
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
          const t = loginBtn.querySelector('.wzsf-btn-text');
          if (t) t.textContent = 'Entrar';
        }
        checkSfAuthStatus();
        updatePanel();
      } else if (pollCount >= maxPolls) {
        clearInterval(pollInterval);
        if (loginBtn) {
          loginBtn.disabled = false;
          const t = loginBtn.querySelector('.wzsf-btn-text');
          if (t) t.textContent = 'Entrar';
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

  // Trava forte: se já está rodando OU é o mesmo telefone, NÃO dispara de novo
  if (lookupInProgress) {
    console.log(`[WZ-SF ${VERSION}] ⏭️ Lookup já em andamento para ${lastLookupPhone}, ignorando ${phone}`);
    return;
  }
  if (phone === lastLookupPhone && currentLeadInfo !== undefined) {
    console.log(`[WZ-SF ${VERSION}] ⏭️ Telefone ${phone} já consultado, usando cache em memória`);
    return;
  }

  console.log(`[WZ-SF ${VERSION}] 🔍 Iniciando lookup para ${phone}`);
  lastLookupPhone = phone; // Marca como consultado ANTES do await para evitar chamadas paralelas
  lookupInProgress = true;
  updateLeadBadge(); // Mostra "Carregando..."
  
  try {
    const result = await sendMessage({ action: 'lookupLead', data: { phone } });
    // wz-api retorna { ok, found, count, leads: [...], opportunities: [...] }
    const found = result?.ok && result?.found;
    const leadData = found && result.leads?.length > 0 ? result.leads[0] : null;
    const oppData  = found && result.opportunities?.length > 0 ? result.opportunities[0] : null;

    if (leadData) {
      currentLeadInfo = leadData;
      console.log(`[WZ-SF ${VERSION}] 🔗 Lead ATIVO: ${currentLeadInfo.leadName} (${currentLeadInfo.leadId}) | Owner: ${currentLeadInfo.ownerName}`);
    } else if (oppData) {
      // Apenas Oportunidade ativa (sem Lead ativo) — cria um shim sem leadId
      currentLeadInfo = {
        leadId:      null,
        leadName:    oppData.oppName || 'Oportunidade ativa',
        leadStatus:  oppData.stageName || '',
        ownerId:     oppData.ownerId,
        ownerName:   oppData.ownerName,
        leadUrl:     oppData.oppUrl,
        encerrado:   false,
        opportunity: oppData,
      };
      console.log(`[WZ-SF ${VERSION}] 💼 Oportunidade ATIVA: ${oppData.oppName} (${oppData.oppId})`);
    } else {
      currentLeadInfo = null;
      console.log(`[WZ-SF ${VERSION}] ❌ Nenhum Lead/Oportunidade ATIVO para ${phone}`, result?.error || '');
    }
  } catch (e) {
    currentLeadInfo = null;
    console.warn(`[WZ-SF ${VERSION}] Erro ao buscar Lead:`, e.message);
  } finally {
    lookupInProgress = false;
    updateLeadBadge();
    updateActionButtons(); // só atualiza botões quando lookup termina
    updateFabLeadStatus();
  }
}

// ─── Atualiza estado dos botões de ação ──────────────────────
// Chamada SOMENTE quando o lookup termina — evita flickering.
function updateActionButtons() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const actionsEl = panel.querySelector('.wzsf-actions');
  if (!actionsEl) return;

  if (!currentLeadInfo) {
    // Nenhum lead/opp — habilita tudo
    actionsEl.querySelectorAll('[data-action]').forEach(btn => {
      btn.disabled = false;
      btn.title = '';
      btn.classList.remove('wzsf-btn-blocked');
    });
    return;
  }

  const isMyLead = !sfUserId || currentLeadInfo.ownerId === sfUserId;

  // "Salvar Lead" bloqueado se já existe Lead ativo
  const leadBtn = actionsEl.querySelector('[data-action="lead"]');
  if (leadBtn) {
    const hasActiveLead = !!currentLeadInfo.leadId;
    leadBtn.disabled = hasActiveLead;
    leadBtn.title = hasActiveLead ? 'Já existe lead ativo para este contato' : '';
    leadBtn.classList.toggle('wzsf-btn-blocked', hasActiveLead);
  }

  // Demais ações: bloqueadas se lead é de outro vendedor
  const blocked = !!currentLeadInfo.leadId && !isMyLead;
  actionsEl.querySelectorAll('[data-action="conversation"], [data-action="activity"], [data-action="open"]').forEach(btn => {
    btn.disabled = blocked;
    btn.title = blocked ? `Em atendimento por ${currentLeadInfo.ownerName}` : '';
    btn.classList.toggle('wzsf-btn-blocked', blocked);
  });
}

function updateLeadBadge() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;

  // Atualiza visibilidade do botão Desqualificar sempre que o badge muda
  updateDisqualifyButton();

  const card = panel.querySelector('.wzsf-card');
  if (!card) return;

  let badge = card.querySelector('.wzsf-lead-badge');

  // ── Carregando — desabilita todos os botões até ter resultado ─
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
    badge.style.display = 'inline-flex';
    // Desabilita todos os botões durante a busca — evita flickering
    const actionsEl = panel.querySelector('.wzsf-actions');
    if (actionsEl) {
      actionsEl.querySelectorAll('[data-action]').forEach(btn => {
        btn.disabled = true;
        btn.title = 'Aguardando verificação no Salesforce...';
      });
    }
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

    // Determina o dot de status do lead/oportunidade
    const hasLead = !!currentLeadInfo.leadId;
    let dotClass, leadLabel;
    if (!hasLead) {
      // Só oportunidade ativa (sem lead)
      dotClass  = 'wzsf-dot-online';
      leadLabel = '💼 Oportunidade Ativa';
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

  } else {
    // Nenhum Lead encontrado
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'wzsf-lead-badge';
      card.appendChild(badge);
    }
    badge.innerHTML = `
      <svg class="wzsf-lead-icon" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="wzsf-lead-text">Sem leads vinculados</span>
    `;
    badge.style.display = 'inline-flex';
  }
  // Botões são gerenciados exclusivamente por updateActionButtons()
  // para evitar flickering — não alterar disabled aqui.
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

  // Fallback final: cache do auto-drawer
  // (foi populado por chamada anterior do openDrawerToReadPhone)
  if (!phone && name) {
    const cached = getDrawerCachedPhone(name);
    if (cached) {
      phone = cached;
      phoneSource = 'drawer-cache';
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
        return storeResult.messages.map(m => {
          // timestamp ISO -> "HH:MM" (hora local do navegador)
          let time;
          if (m.timestamp) {
            const d = new Date(m.timestamp);
            if (!isNaN(d.getTime())) {
              time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            }
          }
          return { text: m.text, direction: m.direction, time };
        });
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
  // Este objeto será anexado ao payload para diagnóstico
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
    setContactDisplay(panel, 'Aguardando contato...', null);
    panel.querySelector('.wzsf-contact-phone').textContent = 'Abra uma conversa no WhatsApp';
    panel.querySelectorAll('[data-action]').forEach(b => {
      b.disabled = true;
      b.title = '';
      b.classList.remove('wzsf-btn-blocked');
    });
    lastConversationKey = null;
    lastLookupPhone = null;
    lookupInProgress = false;
    currentLeadInfo = null;
    return;
  }

  // Habilita/desabilita botões por grupo ou auth — mas NÃO toca se lookup estiver rodando
  // (updateActionButtons cuida dos botões durante e após o lookup)
  const isGroup = isGroupChat();
  const shouldDisable = isGroup || !sfAuthenticated;
  if (!lookupInProgress) {
    panel.querySelectorAll('[data-action]').forEach(b => {
      b.disabled = shouldDisable;
      b.title = shouldDisable ? (isGroup ? 'Grupos não suportados' : 'Faça login no Salesforce') : '';
    });
  }

  if (isGroup) {
    const nameEl = queryFirst(SEL.contactTitle);
    const groupName = nameEl?.getAttribute('title') || nameEl?.textContent?.trim() || 'Grupo';
    setContactDisplay(panel, groupName, null);
    panel.querySelector('.wzsf-contact-phone').textContent = 'Grupo — sem envio';
    setStatus(panel.querySelector('.wzsf-status'), 'idle', 'Grupo não suportado');
    lastConversationKey = 'group_' + groupName;
    return;
  }

  const contact = extractContactInfo();
  // Chave de conversa baseada APENAS no nome — assim quando o phone aparece depois
  // (via drawer ou atualização do WA), não disparamos um segundo lookup achando
  // que mudou de conversa.
  const conversationKey = contact.name || '(sem nome)';

  // Detecta mudança real de conversa (nome diferente)
  if (conversationKey !== lastConversationKey) {
    lastConversationKey = conversationKey;
    setContactDisplay(panel, contact.name || 'Contato', contact.phone);
    if (!contact.phone) {
      panel.querySelector('.wzsf-contact-phone').textContent = 'Aguardando número...';
    }
    clearStatus(panel.querySelector('.wzsf-status'));
    // Limpa dados do contato anterior imediatamente
    currentLeadInfo = null;
    lastLookupPhone = null;
    updateLeadBadge();
    updateFabLeadStatus();
    // Limpa cache de tentativas — evita crescimento infinito.
    if (drawerAttempted.size > 20) {
      drawerAttempted.clear();
    }
    console.log(`[WZ-SF ${VERSION}] 📞 Conversa mudou para: ${contact.name} | ${contact.phone || '(sem phone ainda)'}`);
  } else if (contact.phone && panel.querySelector('.wzsf-contact-phone').textContent !== formatPhoneDisplay(contact.phone)) {
    // Mesmo contato mas o phone agora apareceu (vindo do drawer ou atualização do WA)
    panel.querySelector('.wzsf-contact-phone').textContent = formatPhoneDisplay(contact.phone);
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
      panel.querySelector('.wzsf-contact-phone').textContent = formatPhoneDisplay(contact.phone);
      console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${contact.phone} (cache drawer)`);
    } else if (!drawerOpenInProgress && !drawerAttempted.has(conversationKey)) {
      // Marca ANTES de chamar — se falhar, não tenta de novo nesta conversa
      drawerAttempted.add(conversationKey);
      // Abre o drawer programaticamente em background
      openDrawerToReadPhone(contact.name).then(phone => {
        if (!phone) return;
        setDrawerCachedPhone(contact.name, phone);
        // Re-renderiza painel se o contato ainda for o mesmo
        const stillSameContact = lastConversationKey === contact.name;
        if (stillSameContact) {
          const phoneEl = panel.querySelector('.wzsf-contact-phone');
          if (phoneEl) phoneEl.textContent = formatPhoneDisplay(phone);
          console.log(`[WZ-SF ${VERSION}] 📞 ${contact.name} | ${phone} (auto-drawer) — disparando lookup`);
          // Único ponto de disparo de lookup do drawer
          if (sfAuthenticated) {
            lookupLeadByPhone(phone);
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

  // Lookup: busca sempre que muda de contato
  // (lastLookupPhone foi resetado ao trocar de conversa — garante busca fresca sempre)
  if (sfAuthenticated && !lookupInProgress) {
    if (contact.phone !== lastLookupPhone) {
      currentLeadInfo = null;
      // Desabilita todos os botões imediatamente — sem flickering
      const actionsEl = panel.querySelector('.wzsf-actions');
      if (actionsEl) {
        actionsEl.querySelectorAll('[data-action]').forEach(btn => {
          btn.disabled = true;
          btn.title = 'Aguardando verificação no Salesforce...';
          btn.classList.remove('wzsf-btn-blocked');
        });
      }
      updateLeadBadge();
      lookupLeadByPhone(contact.phone);
    }
  }
}

function createPanel() {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  const IS_MAC = navigator.platform.toUpperCase().includes('MAC');
  const MOD = IS_MAC ? '⌘' : 'Ctrl';
  const SHIFT_KEY = IS_MAC ? '⇧' : 'Shift';
  panel.innerHTML = `
    <!-- HEADER -->
    <div class="wzsf-header">
      <div class="wzsf-header-left">
        <div class="wzsf-logo" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <div>
          <span class="wzsf-title">SF Sync</span>
          <span class="wzsf-version">${VERSION}</span>
        </div>
      </div>
      <div class="wzsf-header-actions">
        <button class="wzsf-btn-header" id="wzsf-minimize" aria-label="Minimizar" title="Minimizar">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
        </button>
        <button class="wzsf-btn-header" id="wzsf-close" aria-label="Fechar" title="Fechar (Esc)">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>

    <!-- CONTENT -->
    <div class="wzsf-content">
      <div class="wzsf-tab-content">
        <div class="wzsf-sf-auth">
          <div class="wzsf-sf-auth-status">
            <span class="wzsf-sf-auth-dot wzsf-dot-offline" aria-hidden="true"></span>
            <span class="wzsf-sf-auth-text">Salesforce desconectado</span>
          </div>
          <button id="wzsf-sf-login" class="wzsf-sf-login-btn" title="Entrar no Salesforce">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
            <span class="wzsf-btn-text">Entrar</span>
          </button>
          <button id="wzsf-sf-logout" class="wzsf-sf-logout-btn" title="Sair do Salesforce" style="display:none;">
            <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span class="wzsf-btn-text">Sair</span>
          </button>
        </div>

        <!-- Card Contato -->
        <div class="wzsf-card">
          <div class="wzsf-card-row">
            <div class="wzsf-avatar" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            </div>
            <div class="wzsf-contact-info">
              <div class="wzsf-contact-name">Aguardando contato...</div>
              <div class="wzsf-contact-phone">—</div>
            </div>
            <button class="wzsf-btn-chevron" id="wzsf-refresh" aria-label="Atualizar status" title="Atualizar status do Lead/Oportunidade">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
            </button>
          </div>
        </div>

        <!-- Ações -->
        <div class="wzsf-actions">
          <button class="wzsf-btn-primary" data-action="lead" data-shortcut="lead">
            <span class="wzsf-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg></span>
            <span class="wzsf-btn-label">Criar lead</span>
            <span class="wzsf-kbd-group" aria-hidden="true"><span class="wzsf-kbd">${MOD}</span><span class="wzsf-kbd">L</span></span>
          </button>
          <button class="wzsf-btn-secondary" data-action="conversation" data-shortcut="conversation">
            <span class="wzsf-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
            <span class="wzsf-btn-label">Registrar contato</span>
            <span class="wzsf-kbd-group" aria-hidden="true"><span class="wzsf-kbd">${MOD}</span><span class="wzsf-kbd">R</span></span>
          </button>
          <button class="wzsf-btn-secondary" data-action="activity" data-shortcut="activity">
            <span class="wzsf-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg></span>
            <span class="wzsf-btn-label">Criar lembrete</span>
            <span class="wzsf-kbd-group" aria-hidden="true"><span class="wzsf-kbd">${MOD}</span><span class="wzsf-kbd">D</span></span>
          </button>
          <button class="wzsf-btn-ghost" data-action="open">
            <span class="wzsf-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>
            <span class="wzsf-btn-label">Abrir no Salesforce</span>
          </button>
          <div class="wzsf-actions-divider" role="separator"></div>
          <button class="wzsf-btn-danger" data-action="disqualify" data-shortcut="disqualify" id="wzsf-btn-disqualify" disabled>
            <span class="wzsf-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></span>
            <span class="wzsf-btn-label">Desqualificar lead</span>
            <span class="wzsf-kbd-group" aria-hidden="true"><span class="wzsf-kbd">${SHIFT_KEY}</span><span class="wzsf-kbd">X</span></span>
          </button>
        </div>
      </div>
    </div>

    <!-- STATUS BAR (rodapé persistente) -->
    <div class="wzsf-status">
      <div class="wzsf-status-left">
        <span class="wzsf-status-dot loading" aria-hidden="true"></span>
        <span class="wzsf-status-text">Conectando...</span>
      </div>
      <div class="wzsf-status-hint">
        <span>Pressione</span>
        <span class="wzsf-kbd">Esc</span>
        <span>para fechar</span>
      </div>
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
      const lt = sfLogoutBtn.querySelector('.wzsf-btn-text');
      if (lt) lt.textContent = 'Saindo...';
      chrome.runtime.sendMessage({ action: 'sfLogout' }, (resp) => {
        sfLogoutBtn.disabled = false;
        if (lt) lt.textContent = 'Sair';
        if (chrome.runtime.lastError) return;
        sfAuthenticated = false;
        sfUserName = '';
        updateSfAuthIndicator();
        updatePanel();
      });
    });
  }

  // ─── Botão Refresh — força nova busca no SF ──────────────────
  const refreshBtn = panel.querySelector('#wzsf-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (!sfAuthenticated || lookupInProgress) return;
      const contact = extractContactInfo();
      if (!contact.phone) return;
      // Força re-lookup resetando o cache do telefone
      lastLookupPhone = null;
      currentLeadInfo = null;
      updateLeadBadge();
      updateFabLeadStatus();
      // Animação de rotação enquanto carrega
      refreshBtn.classList.add('wzsf-spinning');
      lookupLeadByPhone(contact.phone, true).finally(() => {
        refreshBtn.classList.remove('wzsf-spinning');
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

  // ─── Atalhos de teclado ────────────────────────────────────
  // Disparam os botões correspondentes. Ignorados quando há modal aberto,
  // o painel está oculto, ou o foco está em input/textarea/contenteditable.
  setupPanelShortcuts(panel);

  return panel;
}

function setupPanelShortcuts(panel) {
  if (window.__wzsfShortcutsBound) return;
  window.__wzsfShortcutsBound = true;

  document.addEventListener('keydown', (e) => {
    // Ignora se o painel está escondido ou se há um modal aberto
    if (panel.classList.contains('wzsf-hidden')) return;
    if (document.querySelector('.wzsf-overlay')) return;

    // Ignora se o usuário está digitando em outro lugar
    const target = e.target;
    if (target) {
      const tag = (target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
    }

    // Esc fecha o painel (e mostra o FAB)
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      panel.classList.add('wzsf-hidden');
      const fab = document.getElementById('wzsf-fab');
      fab?.classList.remove('wzsf-hidden');
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    let action = null;
    if (mod && e.key.toLowerCase() === 'l') action = 'lead';
    else if (mod && e.key.toLowerCase() === 'r') action = 'conversation';
    else if (mod && e.key.toLowerCase() === 'd') action = 'activity';
    else if (e.shiftKey && !mod && e.key.toLowerCase() === 'x') action = 'disqualify';

    if (action) {
      const btn = panel.querySelector(`[data-action="${action}"]`);
      if (btn && !btn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        btn.click();
      }
    }
  }, true);
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

// ─── Ações — Envia ao Salesforce via wz-api ───────────────────
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

  // "Desqualificar" — abre modal de desqualificação
  if (action === 'disqualify') {
    await handleDisqualify(panel);
    return;
  }

  // "Registrar Contato" — usa o Lead/Opp atual do badge, sem modal de confirmação
  if (action === 'conversation') {
    await handleRegisterConversation(panel, contact, conversation);
    return;
  }

  // "Criar Atividade" — lembrete com data/hora, vinculado ao Lead/Opp atual
  if (action === 'activity') {
    await handleCreateReminder(panel, contact);
    return;
  }

  const confirmed = await showConfirmModal(contact, action);
  if (!confirmed) return;

  const now = new Date().toISOString();
  const nowBR = new Date().toLocaleString('pt-BR');
  const [first, ...rest] = (confirmed.name || 'Desconhecido').split(' ');

  // Validação client-side antes de enviar à API
  if (!confirmed.phone || confirmed.phone.replace(/\D/g, '').length < 8) {
    setStatus(status, 'error', 'Telefone inválido ou não detectado.');
    return;
  }

  disableButtons(panel, true);
  setStatus(status, 'loading', 'Enviando ao Salesforce...');

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

    }

    const result = await sendMessage({ action: msgAction, data: msgData });

    if (result?.ok) {
      setStatus(status, 'success', 'Lead criado com sucesso');
      // Refresh automático após criação de lead
      if (action === 'lead' && confirmed.phone) {
        lastLookupPhone = null;
        currentLeadInfo = null;
        updateLeadBadge();
        setTimeout(() => lookupLeadByPhone(confirmed.phone), 1500);
      }
    } else if (result?.duplicate) {
      setStatus(status, 'error', 'Já enviado nas últimas 24h');
      disableButtons(panel, false);
      const force = confirm('⚠️ Este registro já foi enviado nas últimas 24h.\n\nDeseja enviar novamente?');
      if (force) {
        disableButtons(panel, true);
        setStatus(status, 'loading', 'Reenviando...');
        const retry = await sendMessage({ action: msgAction + '_force', data: msgData });
        if (retry?.ok) {
          setStatus(status, 'success', 'Reenviado');
        } else {
          setStatus(status, 'error', retry?.error || 'Erro ao reenviar');
        }
      }
    } else {
      setStatus(status, 'error', result?.error || 'Erro desconhecido');
    }
  } catch (e) {
    setStatus(status, 'error', e.message);
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

// Status bar estruturado: atualiza dot + texto, mantém rodapé persistente.
// type: 'loading' | 'success' | 'error' | 'idle'
function setStatus(el, type, msg) {
  if (!el) return;
  const textEl = el.querySelector('.wzsf-status-text');
  const dotEl  = el.querySelector('.wzsf-status-dot');
  if (!textEl || !dotEl) {
    el.textContent = msg || '';
    return;
  }
  const dotClass = type === 'error' ? 'error'
                 : type === 'loading' ? 'loading'
                 : type === 'idle' ? 'offline'
                 : 'online';
  dotEl.className = `wzsf-status-dot ${dotClass}`;
  textEl.className = type && type !== 'idle' ? `wzsf-status-text wzsf-status-${type}` : 'wzsf-status-text';
  textEl.textContent = msg || '';
}
function clearStatus(el) {
  setStatus(el, 'success', 'Sincronizado');
}
function disableButtons(panel, disable) {
  panel.querySelectorAll('[data-action]').forEach(b => b.disabled = disable);
}

// ─── Habilita/desabilita botão Desqualificar ─────────────────
// Sempre visível, mas só fica habilitado quando há Lead OU Oportunidade ATIVOS.
// "Ativos" aqui = a API já retornou apenas registros ativos (filtro server-side).
function updateDisqualifyButton() {
  const btn = document.querySelector('#wzsf-btn-disqualify');
  if (!btn) return;

  const hasActiveLead = !!currentLeadInfo?.leadId;
  const hasActiveOpp  = !!currentLeadInfo?.opportunity?.oppId;

  btn.disabled = !(hasActiveLead || hasActiveOpp);
}

// ─── Registrar conversa como Task no Salesforce ──────────────
// Usa o Lead/Opp atual do badge (currentLeadInfo) e o histórico
// já extraído do WhatsApp. Sem modal de confirmação.
async function handleRegisterConversation(panel, contact, conversation) {
  const status = panel.querySelector('.wzsf-status');

  const hasLead = !!currentLeadInfo?.leadId;
  const hasOpp  = !!currentLeadInfo?.opportunity?.oppId;

  if (!hasLead && !hasOpp) {
    setStatus(status, 'error', 'Nenhum Lead/Oportunidade ativo para vincular');
    setTimeout(() => clearStatus(status), 4000);
    return;
  }

  if (!conversation || conversation.length === 0) {
    setStatus(status, 'error', 'Nenhuma mensagem encontrada na conversa');
    setTimeout(() => clearStatus(status), 4000);
    return;
  }

  // Opp tem prioridade (mesmo critério da desqualificação)
  const recordType = hasOpp ? 'Opportunity' : 'Lead';
  const recordId   = hasOpp ? currentLeadInfo.opportunity.oppId : currentLeadInfo.leadId;

  // Mapeia direction (in/out) -> actor (Cliente/Vendedor)
  const messages = conversation.map(m => ({
    actor: m.direction === 'out' ? 'Vendedor' : 'Cliente',
    text:  m.text,
    time:  m.time || undefined,
  }));

  disableButtons(panel, true);
  setStatus(status, 'loading', `Registrando conversa no ${recordType}...`);

  try {
    const resp = await sendMessage({
      action: 'registerConversation',
      data: {
        recordId,
        recordType,
        participantName:  contact.name || currentLeadInfo.leadName || 'Cliente',
        conversationDate: new Date().toISOString().split('T')[0],
        messages,
      },
    });

    if (resp?.ok) {
      setStatus(status, 'success', `Conversa registrada · ${messages.length} mensagens`);
    } else {
      setStatus(status, 'error', resp?.error || 'Erro ao registrar conversa');
    }
  } catch (e) {
    setStatus(status, 'error', e.message);
  } finally {
    disableButtons(panel, false);
    setTimeout(() => clearStatus(status), 6000);
  }
}

// ─── Criar lembrete (Task) com data/hora ─────────────────────
const REMINDER_MODAL_ID = 'wzsf-reminder-modal';

async function handleCreateReminder(panel, contact) {
  const status = panel.querySelector('.wzsf-status');

  const hasLead = !!currentLeadInfo?.leadId;
  const hasOpp  = !!currentLeadInfo?.opportunity?.oppId;

  if (!hasLead && !hasOpp) {
    setStatus(status, 'error', 'Nenhum Lead/Oportunidade ativo para o lembrete');
    setTimeout(() => clearStatus(status), 4000);
    return;
  }

  const recordType = hasOpp ? 'Opportunity' : 'Lead';
  const recordId   = hasOpp ? currentLeadInfo.opportunity.oppId : currentLeadInfo.leadId;
  const participantName = contact.name || currentLeadInfo.leadName || 'Cliente';

  const result = await showReminderModal(participantName);
  if (!result) return; // cancelado

  disableButtons(panel, true);
  setStatus(status, 'loading', 'Criando lembrete...');

  try {
    const resp = await sendMessage({
      action: 'createActivity',
      data: {
        recordId,
        recordType,
        participantName,
        reminderDate: result.date,
        reminderTime: result.time,
        description:  result.description || undefined,
      },
    });

    if (resp?.ok) {
      const [y, m, d] = result.date.split('-');
      setStatus(status, 'success', `Lembrete criado · ${d}/${m}/${y} às ${result.time}`);
    } else {
      setStatus(status, 'error', resp?.error || 'Erro ao criar lembrete');
    }
  } catch (e) {
    setStatus(status, 'error', e.message);
  } finally {
    disableButtons(panel, false);
    setTimeout(() => clearStatus(status), 6000);
  }
}

// Modal de data/hora para lembrete. Data padrão = hoje, hora padrão = 09:00.
function showReminderModal(participantName) {
  return new Promise(resolve => {
    document.getElementById(REMINDER_MODAL_ID)?.remove();

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    // Slots de 30min cobrindo o dia todo (00:00 → 23:30)
    const timeSlots = [];
    for (let h = 0; h < 24; h++) {
      for (const min of ['00', '30']) {
        timeSlots.push(`${String(h).padStart(2, '0')}:${min}`);
      }
    }

    const modal = document.createElement('div');
    modal.id = REMINDER_MODAL_ID;
    modal.innerHTML = `
      <div class="wzsf-overlay" id="wzsf-rm-overlay" role="dialog" aria-modal="true" aria-labelledby="wzsf-rm-title">
        <div class="wzsf-modal-box">
          <div class="wzsf-modal-header">
            <div class="wzsf-modal-icon wzsf-modal-icon--primary" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>
            </div>
            <div class="wzsf-modal-titles">
              <h2 class="wzsf-modal-title" id="wzsf-rm-title">Criar lembrete</h2>
              <div class="wzsf-modal-subtitle">Para ${escHtml(participantName)}.</div>
            </div>
          </div>
          <div class="wzsf-modal-body">
            <label class="wzsf-label">Data
              <input type="date" id="wzsf-rm-date" class="wzsf-input" value="${todayStr}" min="${todayStr}">
            </label>
            <label class="wzsf-label">Hora
              <div class="wzsf-custom-select" id="wzsf-rm-time-select" tabindex="0">
                <div class="wzsf-custom-select__trigger" id="wzsf-rm-time-trigger">
                  <span id="wzsf-rm-time-label">09:00</span>
                  <svg class="wzsf-custom-select__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
                <div class="wzsf-custom-select__dropdown" id="wzsf-rm-time-dropdown">
                  ${timeSlots.map(t => `<div class="wzsf-custom-select__option ${t === '09:00' ? 'wzsf-custom-select__option--selected' : ''}" data-value="${t}">${t}</div>`).join('')}
                </div>
              </div>
            </label>
            <label class="wzsf-label">Observação (opcional)
              <input type="text" id="wzsf-rm-desc" class="wzsf-input" placeholder="Ex: retornar sobre proposta">
            </label>
          </div>
          <div class="wzsf-modal-footer">
            <button id="wzsf-rm-cancel" class="wzsf-btn-ghost" type="button">Cancelar</button>
            <button id="wzsf-rm-confirm" class="wzsf-btn-primary" type="button">Criar lembrete</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let selectedTime = '09:00';
    const trapRelease = trapFocus(modal);

    const cleanup = () => {
      document.removeEventListener('keydown', escHandler, true);
      document.removeEventListener('click', outsideClickHandler);
      trapRelease?.();
      modal.remove();
    };
    const escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); } };
    document.addEventListener('keydown', escHandler, true);

    // Custom-select da hora (mesmo padrão da desqualificação — imune ao tema do navegador)
    const timeSelect   = modal.querySelector('#wzsf-rm-time-select');
    const timeTrigger  = modal.querySelector('#wzsf-rm-time-trigger');
    const timeLabel    = modal.querySelector('#wzsf-rm-time-label');
    const timeDropdown = modal.querySelector('#wzsf-rm-time-dropdown');
    const timeOptions  = timeDropdown.querySelectorAll('.wzsf-custom-select__option');

    timeTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      timeSelect.classList.toggle('wzsf-custom-select--open');
      // Rola até a opção selecionada ao abrir
      if (timeSelect.classList.contains('wzsf-custom-select--open')) {
        const sel = timeDropdown.querySelector('.wzsf-custom-select__option--selected');
        if (sel) sel.scrollIntoView({ block: 'center' });
      }
    });
    const outsideClickHandler = (e) => {
      if (!timeSelect.contains(e.target)) timeSelect.classList.remove('wzsf-custom-select--open');
    };
    document.addEventListener('click', outsideClickHandler);

    timeOptions.forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedTime = opt.dataset.value;
        timeLabel.textContent = selectedTime;
        timeOptions.forEach(o => o.classList.remove('wzsf-custom-select__option--selected'));
        opt.classList.add('wzsf-custom-select__option--selected');
        timeSelect.classList.remove('wzsf-custom-select--open');
      });
    });

    modal.querySelector('#wzsf-rm-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) { cleanup(); resolve(null); }
    });
    modal.querySelector('#wzsf-rm-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
    modal.querySelector('#wzsf-rm-confirm').addEventListener('click', () => {
      const date = modal.querySelector('#wzsf-rm-date').value;
      const description = modal.querySelector('#wzsf-rm-desc').value.trim();
      if (!date || !selectedTime) return;
      cleanup();
      resolve({ date, time: selectedTime, description });
    });
  });
}

// ─── Modal de desqualificação ─────────────────────────────────
const DISQUALIFY_MODAL_ID = 'wzsf-disqualify-modal';

async function handleDisqualify(panel) {
  const status = panel.querySelector('.wzsf-status');

  // Decide O QUE vai ser desqualificado.
  // Regra: Opp tem prioridade — se há Opp ativa, desqualifica ela (mesmo com Lead).
  const hasLead = !!currentLeadInfo?.leadId;
  const hasOpportunity = !!currentLeadInfo?.opportunity?.oppId;

  if (!hasLead && !hasOpportunity) {
    setStatus(status, 'error', 'Nenhum Lead/Oportunidade ativo para desqualificar');
    setTimeout(() => clearStatus(status), 4000);
    return;
  }

  const objectType = hasOpportunity ? 'Opportunity' : 'Lead';
  const recordId   = hasOpportunity
    ? currentLeadInfo.opportunity.oppId
    : currentLeadInfo.leadId;

  // Modal carrega picklist filtrado pelo LeadSource do registro
  const result = await showDisqualifyModal(objectType, recordId);
  if (!result) return; // cancelado
  const motivoDePerda = result.motivoDePerda;

  disableButtons(panel, true);
  setStatus(status, 'loading', `Desqualificando ${objectType}...`);

  try {
    const resp = await sendMessage({
      action: 'disqualify',
      data: { objectType, recordId, motivoDePerda },
    });

    if (resp?.ok) {
      setStatus(status, 'success', `${objectType} desqualificado`);
      // Atualiza o badge/lead info
      lastLookupPhone = null;
      currentLeadInfo = null;
      updateLeadBadge();
      const contact = extractContactInfo();
      if (contact.phone) setTimeout(() => lookupLeadByPhone(contact.phone), 1500);
    } else {
      setStatus(status, 'error', resp?.error || 'Erro ao desqualificar');
    }
  } catch (e) {
    setStatus(status, 'error', e.message);
  } finally {
    disableButtons(panel, false);
    setTimeout(() => clearStatus(status), 7000);
  }
}

// Modal de motivo de perda — carrega picklist filtrado pelo LeadSource do registro
function showDisqualifyModal(objectType, recordId) {
  return new Promise(async resolve => {
    document.getElementById(DISQUALIFY_MODAL_ID)?.remove();

    let selectedMotivo = '';

    const titleMap = {
      Lead: {
        title: 'Desqualificar lead',
        subtitleHtml: 'Status será alterado para <code>Não qualificado</code>.',
        confirmLabel: 'Desqualificar lead',
      },
      Opportunity: {
        title: 'Desqualificar oportunidade',
        subtitleHtml: 'Etapa será alterada para <code>Negociação perdida</code>.',
        confirmLabel: 'Desqualificar oportunidade',
      },
    };
    const ui = titleMap[objectType] || titleMap.Lead;

    // ── Estrutura fixa do modal — renderizada UMA vez ──────────
    const modal = document.createElement('div');
    modal.id = DISQUALIFY_MODAL_ID;
    modal.innerHTML = `
      <div class="wzsf-overlay" id="wzsf-dq-overlay" role="dialog" aria-modal="true" aria-labelledby="wzsf-dq-title">
        <div class="wzsf-disqualify-box">
          <div class="wzsf-modal-header">
            <div class="wzsf-modal-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            </div>
            <div class="wzsf-modal-titles">
              <h2 class="wzsf-modal-title" id="wzsf-dq-title">${ui.title}</h2>
              <div class="wzsf-modal-subtitle">${ui.subtitleHtml}</div>
            </div>
          </div>
          <div class="wzsf-modal-body">
            <div id="wzsf-dq-body">
              <div class="wzsf-disqualify-loading">
                <span class="wzsf-loading-spinner" aria-hidden="true"></span>
                Carregando motivos...
              </div>
            </div>
          </div>
          <div class="wzsf-modal-footer">
            <button id="wzsf-dq-cancel" class="wzsf-btn-ghost" type="button">Cancelar</button>
            <button id="wzsf-dq-confirm" class="wzsf-btn-danger" type="button" disabled>${ui.confirmLabel}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const trapRelease = trapFocus(modal);

    // Fecha o modal e remove TODOS os listeners de document (evita vazamento)
    const cleanup = () => {
      document.removeEventListener('keydown', escHandler, true);
      document.removeEventListener('click', outsideClickHandler);
      trapRelease?.();
      modal.remove();
    };
    const escHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
    };
    // Placeholder — só é usado depois que o select é renderizado
    let outsideClickHandler = () => {};

    // ── Eventos fixos (overlay, cancel, confirm, esc) ──────────
    modal.querySelector('#wzsf-dq-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) { cleanup(); resolve(null); }
    });
    modal.querySelector('#wzsf-dq-cancel').addEventListener('click', () => {
      cleanup(); resolve(null);
    });
    modal.querySelector('#wzsf-dq-confirm').addEventListener('click', () => {
      if (!selectedMotivo) return;
      cleanup();
      resolve({ motivoDePerda: selectedMotivo });
    });
    document.addEventListener('keydown', escHandler);

    // ── Carrega picklist e atualiza só o body ──────────────────
    try {
      const resp = await sendMessage({
        action: 'getDisqualifyPicklist',
        data: { objectType, recordId },
      });

      const body = modal.querySelector('#wzsf-dq-body');
      const confirmBtn = modal.querySelector('#wzsf-dq-confirm');

      if (resp?.ok && resp?.values?.length > 0) {
        const values = resp.values;

        // Injeta o select no body
        body.innerHTML = `
          <label class="wzsf-label">
            Motivo de Perda
            <div class="wzsf-custom-select" id="wzsf-dq-select" tabindex="0">
              <div class="wzsf-custom-select__trigger" id="wzsf-dq-trigger">
                <span id="wzsf-dq-label">Selecione um motivo...</span>
                <svg class="wzsf-custom-select__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
              <div class="wzsf-custom-select__dropdown" id="wzsf-dq-dropdown">
                <div class="wzsf-custom-select__option wzsf-custom-select__option--placeholder" data-value="">Selecione um motivo...</div>
                ${values.map(v => `<div class="wzsf-custom-select__option" data-value="${escHtml(v.value)}">${escHtml(v.label)}</div>`).join('')}
              </div>
            </div>
          </label>`;

        // Eventos do select — registrados UMA vez no body já populado
        const dqSelect = body.querySelector('#wzsf-dq-select');
        const trigger  = body.querySelector('#wzsf-dq-trigger');
        const labelEl  = body.querySelector('#wzsf-dq-label');
        const dropdown = body.querySelector('#wzsf-dq-dropdown');
        const options  = dropdown.querySelectorAll('.wzsf-custom-select__option');

        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          dqSelect.classList.toggle('wzsf-custom-select--open');
        });

        // Fecha dropdown ao clicar fora — listener removido pelo cleanup()
        outsideClickHandler = (e) => {
          if (!dqSelect.contains(e.target)) {
            dqSelect.classList.remove('wzsf-custom-select--open');
          }
        };
        document.addEventListener('click', outsideClickHandler);

        options.forEach(opt => {
          opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const val = opt.dataset.value || '';
            if (!val) return; // ignora placeholder
            selectedMotivo = val;
            labelEl.textContent = opt.textContent.trim();
            options.forEach(o => o.classList.remove('wzsf-custom-select__option--selected'));
            opt.classList.add('wzsf-custom-select__option--selected');
            dqSelect.classList.remove('wzsf-custom-select--open');
            confirmBtn.disabled = false;
          });
        });

      } else {
        const msg = resp?.error || `Nenhum motivo encontrado para ${objectType}`;
        body.innerHTML = `<div class="wzsf-disqualify-error">${escHtml(msg)}</div>`;
      }

    } catch (e) {
      const body = modal.querySelector('#wzsf-dq-body');
      body.innerHTML = `<div class="wzsf-disqualify-error">⚠️ ${escHtml(e.message)}</div>`;
    }
  });
}

// ─── Modal de confirmação ────────────────────────────────────
function showConfirmModal(contact, action) {
  return new Promise(async resolve => {
    document.getElementById(MODAL_ID)?.remove();

    // Listener para fechar dropdown ao clicar fora — guardado para cleanup
    let outsideClickHandler = null;

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
            <span id="wzsf-select-label">Selecione um produto...</span>
            <svg class="wzsf-custom-select__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="wzsf-custom-select__dropdown" id="wzsf-select-dropdown">
            <div class="wzsf-custom-select__option wzsf-custom-select__option--placeholder" data-value="">Selecione um produto...</div>
            ${interestOptions.map(v => `<div class="wzsf-custom-select__option" data-value="${escHtml(v.value)}">${escHtml(v.label)}</div>`).join('')}
          </div>
        </div>
      </label>` : '';

    // Ícone e título por ação
    const headerMap = {
      lead: {
        iconClass: 'wzsf-modal-icon--primary',
        iconSvg: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
        title: 'Criar lead',
        subtitle: 'Confirme os dados do contato.',
        confirmLabel: 'Confirmar',
      },
      conversation: {
        iconClass: '',
        iconSvg: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        title: 'Registrar contato',
        subtitle: 'Confirme os dados do contato.',
        confirmLabel: 'Registrar',
      },
    };
    const head = headerMap[action] || headerMap.lead;

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="wzsf-overlay" role="dialog" aria-modal="true" aria-labelledby="wzsf-confirm-title">
        <div class="wzsf-modal-box">
          <div class="wzsf-modal-header">
            <div class="wzsf-modal-icon ${head.iconClass}" aria-hidden="true">${head.iconSvg}</div>
            <div class="wzsf-modal-titles">
              <h2 class="wzsf-modal-title" id="wzsf-confirm-title">${head.title}</h2>
              <div class="wzsf-modal-subtitle">${head.subtitle}</div>
            </div>
          </div>
          <div class="wzsf-modal-body">
            <label class="wzsf-label">
              Nome
              <input id="wzsf-inp-name" type="text" value="${escHtml(contact.name)}" placeholder="Nome do contato" autocomplete="off" />
            </label>
            <label class="wzsf-label">
              Telefone
              <input id="wzsf-inp-phone" type="text" value="${escHtml(contact.phone)}" placeholder="Ex: 5511999999999" readonly />
            </label>
            ${interestHtml}
          </div>
          <div class="wzsf-modal-footer">
            <button id="wzsf-cancel" class="wzsf-btn-ghost" type="button">Cancelar</button>
            <button id="wzsf-confirm" class="wzsf-btn-primary" type="button">${head.confirmLabel}</button>
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
      outsideClickHandler = (e) => {
        if (!customSelect.contains(e.target)) close();
      };
      document.addEventListener('click', outsideClickHandler, { capture: true });

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

    // Fecha o modal removendo todos os listeners de document
    const cleanup = () => {
      if (outsideClickHandler) {
        document.removeEventListener('click', outsideClickHandler, { capture: true });
      }
      modal.__cleanupHooks?.();
      modal.remove();
    };

    modal.querySelector('#wzsf-cancel').addEventListener('click', () => {
      cleanup(); resolve(null);
    });
    modal.querySelector('.wzsf-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) { cleanup(); resolve(null); }
    });
    const confirmBtn = modal.querySelector('#wzsf-confirm');
    const nameInput  = modal.querySelector('#wzsf-inp-name');

    // Habilita Confirmar só quando há nome
    const syncEnabled = () => { confirmBtn.disabled = !nameInput.value.trim(); };
    nameInput.addEventListener('input', syncEnabled);
    syncEnabled();

    confirmBtn.addEventListener('click', () => {
      const name  = nameInput.value.trim();
      const phone = modal.querySelector('#wzsf-inp-phone').value.trim().replace(/\D/g, '');
      const customSel = modal.querySelector('#wzsf-custom-select');
      const interesse = customSel ? (customSel._getValue?.() || '') : '';
      cleanup();
      resolve({ name, phone, interesse: interesse || undefined });
    });

    // Esc fecha + focus trap
    const escHandler = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
    };
    document.addEventListener('keydown', escHandler, true);
    const trapRelease = trapFocus(modal);
    modal.__cleanupHooks = () => {
      document.removeEventListener('keydown', escHandler, true);
      trapRelease?.();
    };

    setTimeout(() => nameInput?.focus(), 50);
  });
}

// ─── Focus trap: mantém o tab dentro do modal ─────────────────
function trapFocus(modal) {
  const focusable = 'button:not([disabled]), [href], input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const items = modal.querySelectorAll(focusable);
    if (items.length === 0) return;
    const first = items[0];
    const last  = items[items.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', handler, true);
  return () => document.removeEventListener('keydown', handler, true);
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
// Observa mudanças de filhos (não atributos) para performance.
// IGNORA mudanças dentro do próprio painel e FAB — evita loop de re-render
// causado pelas atualizações do badge/botões que o próprio código faz.
const observer = new MutationObserver((mutations) => {
  const panelEl = document.getElementById(PANEL_ID);
  const fabEl   = document.getElementById('wzsf-fab');
  const hasExternalChange = mutations.some((m) => {
    const t = m.target;
    return (
      (!panelEl || (!panelEl.contains(t) && t !== panelEl)) &&
      (!fabEl   || (!fabEl.contains(t)   && t !== fabEl))
    );
  });
  if (!hasExternalChange) return;
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
