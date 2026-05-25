// ============================================================
// inject.js — Roda no contexto da PÁGINA (main world)
// Intercepta webpack require para encontrar o Store interno
// Fonte primária de TODOS os dados (chat, mensagens, contato, grupo)
// ============================================================

(function () {
  'use strict';

  const WZStore = {
    Chat: null,
    Contact: null,
    Conn: null,
    Msg: null,
    GroupMetadata: null,
    ready: false,
  };

  // Telefone do vendedor (usuário logado no WhatsApp)
  let sellerPhone = '';

  // ─── Cache de filtros que funcionaram (localStorage) ─────────
  // Salva o ID do módulo webpack para tentar primeiro na próxima sessão.
  // Atualizações da Meta às vezes só renomeiam — manter o ID acelera bootstrap.
  const CACHE_KEY = 'wzsf_store_module_cache';
  const CACHE_VERSION = 1;

  function loadModuleCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed.version !== CACHE_VERSION) return {};
      return parsed.modules || {};
    } catch (_) { return {}; }
  }

  function saveModuleCache(modules) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        version: CACHE_VERSION,
        modules,
        ts: Date.now(),
      }));
    } catch (_) {}
  }

  let moduleCache = loadModuleCache();

  // ─── Buscar módulos do webpack por propriedade ─────────────
  function findModule(require, filter, cacheKey) {
    const cache = require.c || {};

    // Tenta o ID em cache primeiro (rápido se ainda válido)
    if (cacheKey && moduleCache[cacheKey]) {
      try {
        const cached = cache[moduleCache[cacheKey]]?.exports;
        if (cached) {
          if (filter(cached)) return { mod: cached, id: moduleCache[cacheKey] };
          if (cached.default && filter(cached.default)) return { mod: cached.default, id: moduleCache[cacheKey] };
        }
      } catch (_) {}
      // Cache inválido — remove
      delete moduleCache[cacheKey];
    }

    for (const id in cache) {
      try {
        const mod = cache[id]?.exports;
        if (!mod) continue;
        if (filter(mod)) {
          if (cacheKey) { moduleCache[cacheKey] = id; }
          return { mod, id };
        }
        if (mod.default && filter(mod.default)) {
          if (cacheKey) { moduleCache[cacheKey] = id; }
          return { mod: mod.default, id };
        }
      } catch (_) {}
    }
    return null;
  }

  // Helper para retornar só o módulo (compat com código existente)
  function findModuleSimple(require, filter, cacheKey) {
    const r = findModule(require, filter, cacheKey);
    return r ? r.mod : null;
  }

  // ─── Interceptar webpack push para obter require ──────────
  function hookWebpack() {
    const chunkNames = [
      'webpackChunkwhatsapp_web_client',
      'webpackChunkbuild',
    ];

    let chunkArray = null;
    let chunkName = null;
    for (const name of chunkNames) {
      if (window[name] && Array.isArray(window[name])) {
        chunkArray = window[name];
        chunkName = name;
        break;
      }
    }

    if (!chunkArray) return;

    // Salva o push original e intercepta
    const originalPush = chunkArray.push.bind(chunkArray);

    // Hook no push para capturar novos módulos
    chunkArray.push = function (chunk) {
      const result = originalPush(chunk);
      // Tenta extrair do chunk se tem factory com require
      if (chunk && chunk[1]) {
        const factories = chunk[1];
        for (const id in factories) {
          const origFactory = factories[id];
          factories[id] = function (module, exports, require) {
            origFactory(module, exports, require);
            if (require && require.c && !WZStore.ready) {
              try { extractStore(require); } catch (_) {}
            }
          };
        }
      }
      return result;
    };

    // Também tenta com os chunks já carregados
    // Injeta módulo para capturar require
    const moduleId = '__wzsf_' + Date.now();
    try {
      originalPush([[moduleId], {
        [moduleId]: function (module, exports, require) {
          try {
            extractStore(require);
          } catch (e) {
            console.warn('[WZ-SF inject] Erro ao extrair Store:', e.message);
          }
        }
      }, [[moduleId]]]);
    } catch (_) {}

    return { chunkName };
  }

  // ─── Extrair Store dos módulos webpack ─────────────────────
  function extractStore(require) {
    if (!require || !require.c) {
      console.log('[WZ-SF inject] require.c não disponível');
      return;
    }

    const numModules = Object.keys(require.c).length;
    console.log('[WZ-SF inject] Escaneando ' + numModules + ' módulos...');

    // Buscar Chat (coleção de chats)
    WZStore.Chat = findModuleSimple(require, (m) =>
      m.getActive && m.models && m.find, 'Chat'
    ) || findModuleSimple(require, (m) =>
      m.Chat?.getActive, 'Chat.alt'
    )?.Chat;

    // Buscar Contact
    WZStore.Contact = findModuleSimple(require, (m) =>
      m.models && m.get && m.getMeContact, 'Contact'
    ) || findModuleSimple(require, (m) =>
      m.Contact?.get, 'Contact.alt'
    )?.Contact;

    // Buscar Conn (dados do usuário logado — contém o telefone do vendedor)
    WZStore.Conn = findModuleSimple(require, (m) =>
      m.me && m.platform !== undefined, 'Conn'
    ) || findModuleSimple(require, (m) =>
      m.Conn?.me !== undefined, 'Conn.alt'
    )?.Conn || findModuleSimple(require, (m) =>
      typeof m.getAuthState === 'function' && m.me, 'Conn.alt2'
    );

    // Tentar extrair telefone do vendedor
    if (!sellerPhone) {
      try {
        const connMe = WZStore.Conn?.me;
        const rawId = connMe?.user || connMe?._serialized?.split('@')?.[0] ||
                      String(connMe || '').split('@')[0] || '';
        if (rawId) {
          sellerPhone = rawId.replace(/\D/g, '');
          console.log('[WZ-SF inject] 📱 Telefone do vendedor:', sellerPhone);
        }
      } catch (_) {}

      // Fallback DOM: URL da foto de perfil do usuário logado contém o número
      if (!sellerPhone) {
        try {
          const meImg = document.querySelector(
            '[data-testid="menu-bar-icon-clip"] img, ' +
            'header [data-testid="default-user"] ~ img, ' +
            '#side header img[src*="profile"]'
          );
          const src = meImg?.src || '';
          const match = src.match(/(\d{8,15})/);
          if (match) sellerPhone = match[1];
        } catch (_) {}
      }
    }

    // Buscar Msg
    WZStore.Msg = findModuleSimple(require, (m) =>
      m.models && m.get && m.getQuotedMsgObj, 'Msg'
    );

    // Buscar GroupMetadata (detecção confiável de grupo)
    WZStore.GroupMetadata = findModuleSimple(require, (m) =>
      m.models && m.get && (m.find?.toString?.()?.includes('group') ||
                            m.models?.[0]?.participants !== undefined), 'GroupMetadata'
    );

    if (WZStore.Chat) {
      WZStore.ready = true;
      saveModuleCache(moduleCache);
      console.log('[WZ-SF inject] ✅ Store encontrado!');
      console.log('[WZ-SF inject]   Chat:', !!WZStore.Chat);
      console.log('[WZ-SF inject]   Contact:', !!WZStore.Contact);
      console.log('[WZ-SF inject]   Msg:', !!WZStore.Msg);
      console.log('[WZ-SF inject]   GroupMetadata:', !!WZStore.GroupMetadata);
    } else {
      // Tentativa alternativa: buscar por padrões mais genéricos
      WZStore.Chat = findModuleSimple(require, (m) => {
        try {
          return typeof m.getActive === 'function' &&
                 typeof m.find === 'function' &&
                 m._models !== undefined;
        } catch (_) { return false; }
      }, 'Chat.gen1') || findModuleSimple(require, (m) => {
        try {
          return typeof m.getActive === 'function' &&
                 typeof m.serialize === 'function';
        } catch (_) { return false; }
      }, 'Chat.gen2');

      if (WZStore.Chat) {
        WZStore.ready = true;
        saveModuleCache(moduleCache);
        console.log('[WZ-SF inject] ✅ Store encontrado (método alternativo)!');
      } else {
        console.log('[WZ-SF inject] ⚠️ Chat collection não encontrada');

        // Log dos módulos com getActive para debug
        const cache = require.c;
        for (const id in cache) {
          try {
            const mod = cache[id]?.exports;
            const target = mod?.default || mod;
            if (target && typeof target.getActive === 'function') {
              console.log('[WZ-SF inject] Módulo com getActive:', id, Object.keys(target).slice(0, 10));
            }
          } catch (_) {}
        }
      }
    }
  }

  // ─── Extrair dados do chat ativo ───────────────────────────
  function getActiveChatData() {
    const result = {
      phone: '',
      name: '',
      pushname: '',
      isGroup: false,
      source: 'none',
    };

    if (!WZStore.ready || !WZStore.Chat) return result;

    try {
      const chat = WZStore.Chat.getActive?.();
      if (!chat) return result;

      // Detectar se é grupo via Store (mais confiável que strings localizadas)
      // chat.id tem propriedade `server`: 'g.us' para grupo, 'c.us' para contato
      const server = chat.id?.server || '';
      const serialized = chat.id?._serialized || '';
      result.isGroup = server === 'g.us' || serialized.includes('@g.us') || !!chat.groupMetadata;

      // Extrair telefone do ID (só para contatos individuais)
      const chatId = chat.id?.user ||
                     chat.id?._serialized?.split('@')?.[0] ||
                     String(chat.id || '').split('@')[0] || '';

      if (!result.isGroup) {
        result.phone = chatId.replace(/\D/g, '');
      }

      // Extrair nome
      result.name = chat.contact?.name ||
                    chat.contact?.verifiedName ||
                    chat.contact?.formattedName ||
                    chat.name || '';
      result.pushname = chat.contact?.pushname || '';

      if (result.phone || result.isGroup) {
        result.source = 'store';
      }
    } catch (e) {
      console.warn('[WZ-SF inject] Erro ao ler chat ativo:', e.message);
    }

    return result;
  }

  // ─── Extrair mensagens do chat ativo via Store ─────────────
  // Retorna até `limit` mensagens recentes, em ordem cronológica.
  // Imune a mudanças no HTML — usa apenas o estado interno do WhatsApp.
  function getActiveChatMessages(limit) {
    const max = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const result = { messages: [], source: 'none' };

    if (!WZStore.ready || !WZStore.Chat) return result;

    try {
      const chat = WZStore.Chat.getActive?.();
      if (!chat) return result;

      // chat.msgs é a coleção de mensagens carregadas
      const msgCollection = chat.msgs || chat.messages;
      const models = msgCollection?.models || msgCollection?._models || [];

      if (!models.length) {
        return result;
      }

      // Pega as últimas `max` mensagens
      const slice = models.slice(-max);

      for (const m of slice) {
        try {
          // Tipos suportados: chat (texto), image/video/audio (legenda)
          const type = m.type || '';
          let text = m.body || m.caption || '';

          // Mensagens não textuais sem legenda — registra placeholder
          if (!text) {
            if (type === 'image') text = '[imagem]';
            else if (type === 'video') text = '[vídeo]';
            else if (type === 'audio' || type === 'ptt') text = '[áudio]';
            else if (type === 'document') text = '[documento]';
            else if (type === 'sticker') text = '[figurinha]';
            else if (type === 'location') text = '[localização]';
            else continue;
          }

          if (text.length > 4000) text = text.substring(0, 4000);

          const isOut = !!(m.id?.fromMe || m.fromMe);
          const ts = m.t ? new Date(m.t * 1000).toISOString() : null;
          const author = m.author?._serialized || m.from?._serialized || '';

          result.messages.push({
            text,
            direction: isOut ? 'out' : 'in',
            type,
            timestamp: ts,
            author: author || undefined,
          });
        } catch (_) { /* mensagem corrompida — pula */ }
      }

      if (result.messages.length > 0) result.source = 'store';
    } catch (e) {
      console.warn('[WZ-SF inject] Erro ao extrair mensagens:', e.message);
    }

    return result;
  }

  // ─── Escuta pedidos do content script ──────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'WZSF_REQUEST') {
      const data = getActiveChatData();
      data.sellerPhone = sellerPhone;
      window.postMessage({ type: 'WZSF_RESPONSE', data }, '*');
      return;
    }

    if (event.data?.type === 'WZSF_REQUEST_SELLER') {
      window.postMessage({ type: 'WZSF_SELLER_PHONE', phone: sellerPhone }, '*');
      return;
    }

    if (event.data?.type === 'WZSF_REQUEST_MESSAGES') {
      const limit = event.data.limit || 50;
      const reqId = event.data.reqId;
      const data = getActiveChatMessages(limit);
      window.postMessage({
        type: 'WZSF_RESPONSE_MESSAGES',
        reqId,
        data,
      }, '*');
      return;
    }
  });

  // ─── Notificar content script do status do Store ───────────
  function notifyStoreStatus(status, detail, extra) {
    window.postMessage({
      type: 'WZSF_STORE_STATUS',
      status,   // 'searching' | 'found' | 'unavailable'
      detail,
      ...extra,
    }, '*');
  }

  // ─── Inicializar com retry exponencial ─────────────────────
  const RETRY_DELAYS = [3000, 5000, 8000, 13000, 21000]; // ~50s total

  function init() {
    let attempt = 0;

    function tryHook() {
      const hookResult = hookWebpack();

      if (WZStore.ready) {
        notifyStoreStatus('found', hookResult?.chunkName || 'Store encontrado', {
          attempts: attempt + 1,
        });
        console.log('[WZ-SF inject] ✅ Store pronto na tentativa ' + (attempt + 1));
        return;
      }

      attempt++;
      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`[WZ-SF inject] Tentativa ${attempt}/${RETRY_DELAYS.length} falhou. Retry em ${delay / 1000}s...`);
        notifyStoreStatus('searching', `Tentativa ${attempt + 1}/${RETRY_DELAYS.length}...`);
        setTimeout(tryHook, delay);
      } else {
        console.log('[WZ-SF inject] Store não disponível após ' + attempt + ' tentativas. Fallback DOM ativo.');
        notifyStoreStatus('unavailable', 'Usando fallback DOM', { attempts: attempt });
      }
    }

    notifyStoreStatus('searching', 'Buscando Store...');
    tryHook();
  }

  // Espera o DOM carregar completamente
  if (document.readyState === 'complete') {
    setTimeout(init, 3000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 3000));
  }

  console.log('[WZ-SF inject] Script injetado no contexto da página 🔌');
})();
