// ============================================================
// popup.js — Status da API + Login Salesforce OAuth
// ============================================================

const VERSION = 'v2.1.0';

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('version').textContent = VERSION;

  // Busca config do background
  chrome.runtime.sendMessage({ action: 'getConfig' }, (resp) => {
    if (resp?.ok) {
      document.getElementById('webhook-url').textContent = resp.webhookUrl || '—';
      document.getElementById('org-url').textContent = resp.sfOrgUrl || '—';
    }
  });

  checkConnection();
  checkSfAuthStatus();

  document.getElementById('btn-refresh').addEventListener('click', () => {
    checkConnection();
    checkSfAuthStatus();
  });

  document.getElementById('btn-open-sf').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'getConfig' }, (resp) => {
      const url = resp?.sfOrgUrl || SF_CONFIG.orgUrl;
      chrome.tabs.create({ url });
    });
  });

  // ─── Salesforce Login/Logout ─────────────────────────────
  document.getElementById('btn-sf-login').addEventListener('click', () => {
    const btn = document.getElementById('btn-sf-login');
    btn.disabled = true;
    btn.textContent = '⏳ Abrindo...';
    setSfAuthUI('checking', 'Aguardando login...', 'Complete na aba aberta e reabra o popup');

    // Delega ao background service worker — o popup fecha ao abrir nova aba
    // e perderia o listener OAuth se chamasse oauthLogin() diretamente.
    chrome.runtime.sendMessage({ action: 'sfLogin' }, (resp) => {
      if (chrome.runtime.lastError) {
        // Popup foi fechado durante o OAuth — normal, token já foi salvo pelo background
        return;
      }
      btn.disabled = false;
      btn.textContent = '🔐 Login Salesforce';
      if (resp?.ok) {
        checkSfAuthStatus();
      } else if (resp?.error) {
        setSfAuthUI('disconnected', 'Erro no login', resp.error);
      }
    });
  });

  document.getElementById('btn-sf-logout').addEventListener('click', async () => {
    await oauthLogout();
    await checkSfAuthStatus();
  });

  // Sincroniza login/logout: atualiza UI quando background salva/remove token
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // wzsf_auth mudou (login ou logout) OU flag de logout foi setada
    if ('wzsf_auth' in changes || 'wzsf_logged_out' in changes) {
      checkSfAuthStatus();
    }
  });
});

// ─── Webhook status ──────────────────────────────────────────
function checkConnection() {
  setStatusUI('checking', 'Verificando...', 'Testando conexão com a API...');

  chrome.runtime.sendMessage({ action: 'checkConnection' }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatusUI('disconnected', 'Erro', chrome.runtime.lastError.message);
      return;
    }
    if (resp?.ok) {
      setStatusUI('connected', 'API Online', 'Serviço respondendo');
    } else {
      setStatusUI('disconnected', 'API Offline', resp?.error || 'Serviço não respondeu');
    }
  });
}

function setStatusUI(state, text, detail) {
  const card = document.getElementById('status-card');
  const dot = card.querySelector('.status-dot');
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-detail').textContent = detail;
  card.className = `status-card status-${state}`;
  dot.className = `status-dot dot-${state === 'connected' ? 'green' : state === 'disconnected' ? 'red' : 'gray'}`;
}

// ─── Salesforce auth status ──────────────────────────────────
async function checkSfAuthStatus() {
  setSfAuthUI('checking', 'Verificando...', '');

  try {
    const status = await checkSfAuth();
    if (status.authenticated) {
      const name = status.userName || 'Conectado';
      setSfAuthUI('connected', `✅ ${name}`, status.instanceUrl || '');
      document.getElementById('btn-sf-login').style.display = 'none';
      document.getElementById('btn-sf-logout').style.display = '';
    } else {
      setSfAuthUI('disconnected', 'Não conectado', 'Clique em Login');
      document.getElementById('btn-sf-login').style.display = '';
      document.getElementById('btn-sf-logout').style.display = 'none';
    }
  } catch (_) {
    setSfAuthUI('disconnected', 'Não conectado', 'Clique em Login');
    document.getElementById('btn-sf-login').style.display = '';
    document.getElementById('btn-sf-logout').style.display = 'none';
  }
}

function setSfAuthUI(state, text, detail) {
  const card = document.getElementById('sf-auth-status');
  const dot = card.querySelector('.status-dot');
  document.getElementById('sf-auth-text').textContent = text;
  document.getElementById('sf-auth-detail').textContent = detail;
  card.className = `status-card status-${state}`;
  dot.className = `status-dot dot-${state === 'connected' ? 'green' : state === 'disconnected' ? 'red' : 'gray'}`;
}
