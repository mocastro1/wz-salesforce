// ============================================================
// config.js — Configuração da API (wz-api BFF) e Salesforce
// ============================================================

const API_CONFIG = {
  // Troque pela URL de produção quando publicar
  baseUrl: 'http://localhost:3000',

  // Bearer token compartilhado com o wz-api (campo API_BEARER_TOKEN no .env)
  apiToken: 'meu-token-secreto',

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
  // Cole aqui o Consumer Key da sua Connected App
  clientId: '3MVG9bjNVlqB8yGFZloAO1fWFeqVDWCHAiAidVUivMvMowz6vsLAc_ry03jimsCe6UAPjO2HcLRVno9Es1HNY',

  // Cole aqui o Consumer Secret (Segredo do Consumidor)
  // Setup → App Manager → Sua App → Chave e segredo do consumidor → Segredo do Consumidor
  clientSecret: '',

  // URL de login (Sandbox) — test.salesforce.com para auth, My Domain para app
  loginUrl: 'https://test.salesforce.com',

  // URL da org (Lightning)
  orgUrl: 'https://cometa--crm.sandbox.lightning.force.com',

  // API version
  apiVersion: 'v59.0',

  // Scopes OAuth — User-Agent Flow (sem refresh_token nem offline_access)
  scopes: 'api id chatter_api',

  // Redirect URI — a extensão Chrome usa chrome.identity
  // O Salesforce precisa aceitar esse redirect
  get redirectUri() {
    return chrome.identity.getRedirectURL('salesforce');
  },
};
