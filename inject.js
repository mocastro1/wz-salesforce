// ============================================================
// inject.js — Roda no contexto da PÁGINA (main world)
// Intercepta webpack require para encontrar o Store interno
// ============================================================

(function () {
  'use strict';

  const WZStore = {
    Chat: null,
    Contact: null,
    Conn: null,
    Msg: null,
    ready: false,
  };

  // Telefone do vendedor (usuário logado no WhatsApp)
  let sellerPhone = '';

  // ─── Buscar módulos do webpack por propriedade ─────────────
  function findModule(require, filter) {
    const cache = require.c || {};
    for (const id in cache) {
      try {
        const mod = cache[id]?.exports;
        if (!mod) continue;
        if (filter(mod)) return mod;
        if (mod.default && filter(mod.default)) return mod.default;
      } catch (_) {}
    }
    return null;
  }

  // ─── Interceptar webpack push para obter require ──────────
  function hookWebpack() {
    const chunkNames = [
      'webpackChunkwhatsapp_web_client',
      'webpackChunkbuild',
    ];

    let chunkArray = null;
    for (const name of chunkNames) {
      if (window[name] && Array.isArray(window[name])) {
        chunkArray = window[name];
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
    WZStore.Chat = findModule(require, (m) =>
      m.getActive && m.models && m.find
    ) || findModule(require, (m) =>
      m.Chat?.getActive
    )?.Chat;

    // Buscar Contact
    WZStore.Contact = findModule(require, (m) =>
      m.models && m.get && m.getMeContact
    ) || findModule(require, (m) =>
      m.Contact?.get
    )?.Contact;

    // Buscar Conn (dados do usuário logado — contém o telefone do vendedor)
    WZStore.Conn = findModule(require, (m) =>
      m.me && m.platform !== undefined
    ) || findModule(require, (m) =>
      m.Conn?.me !== undefined
    )?.Conn || findModule(require, (m) =>
      typeof m.getAuthState === 'function' && m.me
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
    WZStore.Msg = findModule(require, (m) =>
      m.models && m.get && m.getQuotedMsgObj
    );

    if (WZStore.Chat) {
      WZStore.ready = true;
      console.log('[WZ-SF inject] ✅ Store encontrado!');
      console.log('[WZ-SF inject]   Chat:', !!WZStore.Chat);
      console.log('[WZ-SF inject]   Contact:', !!WZStore.Contact);
    } else {
      // Tentativa alternativa: buscar por padrões mais genéricos
      WZStore.Chat = findModule(require, (m) => {
        try {
          return typeof m.getActive === 'function' &&
                 typeof m.find === 'function' &&
                 m._models !== undefined;
        } catch (_) { return false; }
      }) || findModule(require, (m) => {
        try {
          return typeof m.getActive === 'function' &&
                 typeof m.serialize === 'function';
        } catch (_) { return false; }
      });

      if (WZStore.Chat) {
        WZStore.ready = true;
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
    const result = { phone: '', name: '', pushname: '', source: 'none' };

    if (!WZStore.ready || !WZStore.Chat) return result;

    try {
      const chat = WZStore.Chat.getActive?.();
      if (!chat) return result;

      // Extrair telefone do ID
      const chatId = chat.id?.user ||
                     chat.id?._serialized?.split('@')?.[0] ||
                     String(chat.id || '').split('@')[0] || '';
      result.phone = chatId.replace(/\D/g, '');

      // Extrair nome
      result.name = chat.contact?.name ||
                    chat.contact?.verifiedName ||
                    chat.contact?.formattedName ||
                    chat.name || '';
      result.pushname = chat.contact?.pushname || '';

      if (result.phone) {
        result.source = 'store';
      }
    } catch (e) {
      console.warn('[WZ-SF inject] Erro ao ler chat ativo:', e.message);
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
    }
  });

  // ─── Notificar content script do status do Store ───────────
  function notifyStoreStatus(status, detail) {
    window.postMessage({
      type: 'WZSF_STORE_STATUS',
      status,   // 'searching' | 'found' | 'unavailable'
      detail,
    }, '*');
  }

  // ─── Inicializar com retry exponencial ─────────────────────
  const RETRY_DELAYS = [3000, 5000, 8000, 13000, 21000]; // ~50s total

  function init() {
    let attempt = 0;

    function tryHook() {
      hookWebpack();

      if (WZStore.ready) {
        notifyStoreStatus('found', 'Store encontrado');
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
        notifyStoreStatus('unavailable', 'Usando fallback DOM');
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
