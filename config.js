// ============================================================
// config.js — Configuracao da API (wz-api BFF) e Salesforce
// ============================================================

const API_CONFIG = {
  // URL de producao
  baseUrl: 'https://wz-api.grupocometa.com.br',

  // Bearer token compartilhado com o wz-api (campo API_BEARER_TOKEN no .env)
  // ATENCAO: precisa ser identico ao token gerado pelo deploy.sh no servidor
  apiToken: 'COLAR_AQUI_O_TOKEN_GERADO_PELO_DEPLOY_SH',

  endpoints: {
    saveLead:             '/api/leads',
    lookupLead:           '/api/leads/lookup',
    leadPicklist:         '/api/leads/picklist',
    registerConversation: '/api/conversations',
    createActivity:       '/api/activities',
    healthCheck:          '/api/health',
    logs:                 '/api/logs',
    authCheck:            '/api/auth/check',
    telemetry:            '/api/telemetry',
    disqualify:           '/api/disqualify',
    disqualifyPicklist:   '/api/disqualify/picklist',
  },

  url(endpoint) {
    const path = this.endpoints[endpoint] || endpoint;
    return `${this.baseUrl}${path}`;
  },

  timeout: 15000,
};

// Alias de compatibilidade — background.js usa WEBHOOK_CONFIG em alguns lugares
const WEBHOOK_CONFIG = API_CONFIG;

// ─── Salesforce OAuth 2.0 (PKCE) ────────────────────────────
const SF_CONFIG = {
  // Consumer Key da Connected App em PRODUCAO (cometa.my.salesforce.com)
  clientId: '3MVG9cHH2bfKACZby2CWjAoqzBlNUyD55Rc3.l7X8QSYV.WCmZl7YjovY2v2ZNIYjXQDHk2l9NDQtvzCJoZHl',

  // Segredo do Consumidor — DEIXAR VAZIO (extensao e cliente publico, usa PKCE)
  clientSecret: '',

  // URL de login (Producao My Domain)
  loginUrl: 'https://cometa.my.salesforce.com',

  // URL da org Lightning (producao). Usado pra abrir registros no SF.
  // Se for diferente, ajustar: tipicamente cometa.lightning.force.com
  orgUrl: 'https://cometa.lightning.force.com',

  // API version
  apiVersion: 'v59.0',

  // Scopes OAuth — Web Server Flow + PKCE.
  // refresh_token permite renovar o access_token sem novo login.
  scopes: 'api id chatter_api refresh_token',

  // Redirect URI — a extensao Chrome usa chrome.identity
  // O Salesforce precisa aceitar esse redirect na Connected App de producao
  get redirectUri() {
    return chrome.identity.getRedirectURL('salesforce');
  },
};
