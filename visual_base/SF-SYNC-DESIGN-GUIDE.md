# Guia de Implementacao - SF Sync Panel v2.0

Design system profissional para o painel flutuante da extensao SF Sync.

---

## Paleta de Cores

| Token | Valor HEX | RGB | Uso |
|-------|-----------|-----|-----|
| `teal-600` | `#0D9488` | `13, 148, 136` | Header gradiente (from) |
| `teal-500` | `#14B8A6` | `20, 184, 166` | Header gradiente (to), botao primario |
| `teal-400` | `#2DD4BF` | `45, 212, 191` | Hover botao primario |
| `teal-700` | `#0F766E` | `15, 118, 110` | Fundo tabs (30% opacidade) |
| `teal-100` | `#CCFBF1` | `204, 251, 241` | Textos secundarios header, avatar bg |
| `slate-800` | `#1E293B` | `30, 41, 59` | Texto principal (titulos) |
| `slate-700` | `#334155` | `51, 65, 85` | Texto botoes secundarios |
| `slate-500` | `#64748B` | `100, 116, 139` | Texto secundario, descricoes |
| `slate-400` | `#94A3B8` | `148, 163, 184` | Texto terciario, icones inativos |
| `slate-200` | `#E2E8F0` | `226, 232, 240` | Bordas, kbd background |
| `slate-100` | `#F1F5F9` | `241, 245, 249` | Bordas sutis, dividers |
| `slate-50` | `#F8FAFC` | `248, 250, 252` | Fundos de cards (50% opacidade) |
| `white` | `#FFFFFF` | `255, 255, 255` | Fundo principal, botoes secundarios |
| `emerald-400` | `#34D399` | `52, 211, 153` | Indicador online |
| `amber-400` | `#FBBF24` | `251, 191, 36` | Indicador offline |

---

## Tipografia

| Elemento | Font-size | Font-weight | Line-height |
|----------|-----------|-------------|-------------|
| Titulo header | 14px | 600 (semibold) | 1.25 |
| Versao | 10px | 400 (normal) | 1 |
| Tabs | 12px | 500 (medium) | 1.25 |
| Nome contato | 14px | 600 (semibold) | 1.25 |
| Telefone | 12px | 400 (normal) | 1.25 |
| Botoes | 14px | 500 (medium) | 1.25 |
| Footer/kbd | 10px/9px | 400 (normal) | 1 |

### Fonte Recomendada

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

---

## Espacamento (Base 4px)

| Elemento | Propriedade | Valor |
|----------|-------------|-------|
| Painel largura | `width` | 288px |
| Header | `padding` | 12px 16px |
| Tabs container | `padding` | 0 8px 8px |
| Tabs interno | `padding` | 4px |
| Content | `padding` | 12px |
| Card contato | `padding` | 12px |
| Card contato | `margin-bottom` | 12px |
| Botoes | `padding` | 10px 12px |
| Gap entre botoes | `margin-top` | 8px |
| Footer | `padding` | 8px 16px |
| Avatar | `width/height` | 40px |
| Icones botoes | `width/height` | 16px |
| Gap icone-texto | `margin-left` | 8px |

---

## Border Radius

| Elemento | Valor |
|----------|-------|
| Painel principal | 12px |
| Header logo | 8px |
| Tab container | 8px |
| Tab item | 6px |
| Card contato | 12px |
| Avatar | 9999px (circular) |
| Botoes | 8px |
| Botoes header (min/close) | 6px |
| Botao minimizado (FAB) | 12px |

---

## Sombras

### Painel Principal

```css
box-shadow: 0 25px 50px -12px rgba(226, 232, 240, 0.5);
border: 1px solid rgba(226, 232, 240, 0.6);
```

### Botao Primario (Teal)

```css
box-shadow: 0 4px 6px -1px rgba(20, 184, 166, 0.2);
```

### Botao Secundario (Branco)

```css
box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
```

### Botao Minimizado (FAB)

```css
box-shadow: 0 10px 15px -3px rgba(20, 184, 166, 0.25);
border: 1px solid rgba(255, 255, 255, 0.2);
```

---

## Transicoes e Animacoes

### Padrao para Elementos Interativos

```css
transition: all 150ms ease-out;
```

### Botao Minimizado (FAB)

```css
transition: all 200ms ease-out;
```

### Estados de Interacao

```css
/* Hover - botao minimizado */
transform: scale(1.05);

/* Active/Click - todos os botoes */
transform: scale(0.98);

/* Active - botao minimizado */
transform: scale(0.95);
```

---

## Posicionamento

### Painel Aberto

```css
position: fixed;
top: 80px;
right: 16px;
z-index: 9999;
```

### Botao Minimizado (FAB)

```css
position: fixed;
top: 80px;
right: 16px;
width: 44px;
height: 44px;
z-index: 9999;
```

---

## CSS Completo - Estrutura Base

```css
/* =============================================
   SF SYNC PANEL - CSS BASE
   ============================================= */

/* Reset para extensao */
.wzsf-panel *,
.wzsf-panel *::before,
.wzsf-panel *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* Container Principal */
.wzsf-panel {
  position: fixed;
  top: 80px;
  right: 16px;
  width: 288px;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 25px 50px -12px rgba(226, 232, 240, 0.5);
  border: 1px solid rgba(226, 232, 240, 0.6);
  overflow: hidden;
  z-index: 9999;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* =============================================
   HEADER
   ============================================= */

.wzsf-header {
  background: linear-gradient(to right, #0D9488, #14B8A6);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.wzsf-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wzsf-logo {
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.wzsf-logo svg {
  width: 18px;
  height: 18px;
  color: #ffffff;
}

.wzsf-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
}

.wzsf-version {
  font-size: 10px;
  color: #CCFBF1;
  margin-left: 4px;
}

.wzsf-header-actions {
  display: flex;
  gap: 4px;
}

.wzsf-btn-header {
  width: 28px;
  height: 28px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 6px;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 150ms ease-out;
}

.wzsf-btn-header:hover {
  background: rgba(255, 255, 255, 0.2);
}

.wzsf-btn-header:active {
  transform: scale(0.98);
}

.wzsf-btn-header svg {
  width: 14px;
  height: 14px;
}

/* =============================================
   TABS
   ============================================= */

.wzsf-tabs-container {
  padding: 0 8px 8px;
  background: linear-gradient(to bottom, #0D9488, #14B8A6);
}

.wzsf-tabs {
  background: rgba(15, 118, 110, 0.3);
  border-radius: 8px;
  padding: 4px;
  display: flex;
}

.wzsf-tab {
  flex: 1;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 150ms ease-out;
}

.wzsf-tab:hover {
  color: #ffffff;
}

.wzsf-tab.active {
  background: #ffffff;
  color: #0D9488;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.wzsf-tab svg {
  width: 14px;
  height: 14px;
}

/* =============================================
   CONTENT
   ============================================= */

.wzsf-content {
  padding: 12px;
}

/* Card Contato */
.wzsf-card {
  background: rgba(248, 250, 252, 0.5);
  border: 1px solid #F1F5F9;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.wzsf-avatar {
  width: 40px;
  height: 40px;
  background: #CCFBF1;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.wzsf-avatar svg {
  width: 20px;
  height: 20px;
  color: #0D9488;
}

.wzsf-contact-info {
  flex: 1;
}

.wzsf-contact-name {
  font-size: 14px;
  font-weight: 600;
  color: #1E293B;
}

.wzsf-contact-phone {
  font-size: 12px;
  color: #64748B;
  margin-top: 2px;
}

/* Status Indicator */
.wzsf-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #64748B;
}

.wzsf-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
}

.wzsf-status-dot.online {
  background: #34D399;
}

.wzsf-status-dot.offline {
  background: #FBBF24;
}

/* =============================================
   BOTOES
   ============================================= */

.wzsf-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Botao Primario */
.wzsf-btn-primary {
  width: 100%;
  padding: 10px 12px;
  background: linear-gradient(to right, #0D9488, #14B8A6);
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 4px 6px -1px rgba(20, 184, 166, 0.2);
  transition: all 150ms ease-out;
}

.wzsf-btn-primary:hover {
  background: linear-gradient(to right, #14B8A6, #2DD4BF);
  box-shadow: 0 6px 10px -2px rgba(20, 184, 166, 0.3);
}

.wzsf-btn-primary:active {
  transform: scale(0.98);
}

.wzsf-btn-primary svg {
  width: 16px;
  height: 16px;
}

/* Botao Secundario */
.wzsf-btn-secondary {
  width: 100%;
  padding: 10px 12px;
  background: #ffffff;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #334155;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  transition: all 150ms ease-out;
}

.wzsf-btn-secondary:hover {
  background: #F8FAFC;
  border-color: #CBD5E1;
}

.wzsf-btn-secondary:active {
  transform: scale(0.98);
}

.wzsf-btn-secondary svg {
  width: 16px;
  height: 16px;
  color: #64748B;
}

/* Botao Ghost */
.wzsf-btn-ghost {
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #64748B;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 150ms ease-out;
}

.wzsf-btn-ghost:hover {
  background: #F1F5F9;
  color: #334155;
}

.wzsf-btn-ghost:active {
  transform: scale(0.98);
}

.wzsf-btn-ghost svg {
  width: 16px;
  height: 16px;
}

/* =============================================
   FOOTER
   ============================================= */

.wzsf-footer {
  padding: 8px 16px;
  border-top: 1px solid #F1F5F9;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.wzsf-footer-text {
  font-size: 10px;
  color: #94A3B8;
}

.wzsf-kbd {
  font-size: 9px;
  font-family: monospace;
  background: #E2E8F0;
  color: #64748B;
  padding: 2px 6px;
  border-radius: 4px;
}

/* =============================================
   BOTAO MINIMIZADO (FAB)
   ============================================= */

.wzsf-fab {
  position: fixed;
  top: 80px;
  right: 16px;
  width: 44px;
  height: 44px;
  background: linear-gradient(to bottom right, #14B8A6, #0D9488);
  border-radius: 12px;
  border: none;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 15px -3px rgba(20, 184, 166, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.2);
  transition: all 200ms ease-out;
  z-index: 9999;
}

.wzsf-fab:hover {
  transform: scale(1.05);
  box-shadow: 0 20px 25px -5px rgba(20, 184, 166, 0.3);
}

.wzsf-fab:active {
  transform: scale(0.95);
}

.wzsf-fab svg {
  width: 22px;
  height: 22px;
}

/* =============================================
   UTILITARIOS
   ============================================= */

/* Divider */
.wzsf-divider {
  height: 1px;
  background: #F1F5F9;
  margin: 8px 0;
}

/* Hidden */
.wzsf-hidden {
  display: none !important;
}
```

---

## Icones SVG Recomendados

```html
<!-- Salesforce / Cloud -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
</svg>

<!-- n8n / Workflow -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M3 3v18h18"/>
  <path d="m19 9-5 5-4-4-3 3"/>
</svg>

<!-- DOM / Code -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <polyline points="16 18 22 12 16 6"/>
  <polyline points="8 6 2 12 8 18"/>
</svg>

<!-- User -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
  <circle cx="12" cy="7" r="4"/>
</svg>

<!-- User Plus (Salvar Lead) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
  <circle cx="9" cy="7" r="4"/>
  <line x1="19" x2="19" y1="8" y2="14"/>
  <line x1="22" x2="16" y1="11" y2="11"/>
</svg>

<!-- Message (Registrar Conversa) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
</svg>

<!-- Calendar (Criar Atividade) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M8 2v4"/>
  <path d="M16 2v4"/>
  <rect width="18" height="18" x="3" y="4" rx="2"/>
  <path d="M3 10h18"/>
</svg>

<!-- External Link (Abrir no Salesforce) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M15 3h6v6"/>
  <path d="M10 14 21 3"/>
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
</svg>

<!-- Minimize -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M5 12h14"/>
</svg>

<!-- Close (X) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M18 6 6 18"/>
  <path d="m6 6 12 12"/>
</svg>

<!-- Keyboard -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <rect width="20" height="16" x="2" y="4" rx="2"/>
  <path d="M6 8h.001"/>
  <path d="M10 8h.001"/>
  <path d="M14 8h.001"/>
  <path d="M18 8h.001"/>
  <path d="M8 12h.001"/>
  <path d="M12 12h.001"/>
  <path d="M16 12h.001"/>
  <path d="M7 16h10"/>
</svg>
```

---

## Estrutura HTML

```html
<!-- Painel Aberto -->
<div class="wzsf-panel" id="wzsf-panel">
  <!-- Header -->
  <div class="wzsf-header">
    <div class="wzsf-header-left">
      <div class="wzsf-logo">
        <!-- SVG Cloud icon -->
      </div>
      <div>
        <span class="wzsf-title">SF Sync</span>
        <span class="wzsf-version">v2.0.0</span>
      </div>
    </div>
    <div class="wzsf-header-actions">
      <button class="wzsf-btn-header" id="wzsf-minimize" title="Minimizar">
        <!-- SVG Minimize icon -->
      </button>
      <button class="wzsf-btn-header" id="wzsf-close" title="Fechar">
        <!-- SVG Close icon -->
      </button>
    </div>
  </div>

  <!-- Tabs -->
  <div class="wzsf-tabs-container">
    <div class="wzsf-tabs">
      <button class="wzsf-tab active" data-tab="n8n">
        <!-- SVG icon --> n8n Offline
      </button>
      <button class="wzsf-tab" data-tab="dom">
        <!-- SVG icon --> DOM
      </button>
    </div>
  </div>

  <!-- Content -->
  <div class="wzsf-content">
    <!-- Card Contato -->
    <div class="wzsf-card">
      <div class="wzsf-avatar">
        <!-- SVG User icon -->
      </div>
      <div class="wzsf-contact-info">
        <div class="wzsf-contact-name">Contato</div>
        <div class="wzsf-contact-phone">+556599685875</div>
      </div>
    </div>

    <!-- Acoes -->
    <div class="wzsf-actions">
      <button class="wzsf-btn-primary">
        <!-- SVG UserPlus icon --> Salvar como Lead
      </button>
      <button class="wzsf-btn-secondary">
        <!-- SVG Message icon --> Registrar Conversa
      </button>
      <button class="wzsf-btn-secondary">
        <!-- SVG Calendar icon --> Criar Atividade
      </button>
      <button class="wzsf-btn-ghost">
        <!-- SVG ExternalLink icon --> Abrir no Salesforce
      </button>
    </div>
  </div>

  <!-- Footer -->
  <div class="wzsf-footer">
    <span class="wzsf-footer-text">Atalho:</span>
    <span class="wzsf-kbd">Alt + S</span>
  </div>
</div>

<!-- Botao Minimizado -->
<button class="wzsf-fab wzsf-hidden" id="wzsf-fab">
  <!-- SVG Cloud icon -->
</button>
```

---

## JavaScript - Toggle Minimizar

```javascript
const panel = document.getElementById('wzsf-panel');
const fab = document.getElementById('wzsf-fab');
const minimizeBtn = document.getElementById('wzsf-minimize');
const closeBtn = document.getElementById('wzsf-close');

// Minimizar
minimizeBtn.addEventListener('click', () => {
  panel.classList.add('wzsf-hidden');
  fab.classList.remove('wzsf-hidden');
});

// Reabrir
fab.addEventListener('click', () => {
  fab.classList.add('wzsf-hidden');
  panel.classList.remove('wzsf-hidden');
});

// Fechar completamente
closeBtn.addEventListener('click', () => {
  panel.classList.add('wzsf-hidden');
  fab.classList.add('wzsf-hidden');
});
```

---

## Checklist de Implementacao

- [ ] Aplicar paleta de cores teal/slate
- [ ] Configurar tipografia com font-weights corretos
- [ ] Implementar espacamentos consistentes (base 4px)
- [ ] Adicionar border-radius em todos elementos
- [ ] Configurar sombras em camadas
- [ ] Adicionar transicoes de 150ms ease-out
- [ ] Implementar estados hover/active
- [ ] Adicionar botoes minimizar/fechar no header
- [ ] Criar FAB para estado minimizado
- [ ] Testar responsividade do posicionamento fixo
