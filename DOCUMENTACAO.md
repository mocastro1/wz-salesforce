# WZ Salesforce Sync — Documentação Técnica

> **Versão:** 2.2.0  
> **Última atualização:** Julho 2025  
> **Autor:** Equipe WZ / Inovação

---

## 1. Objetivo

O **WZ Salesforce Sync** é um sistema composto por uma extensão Chrome e uma API intermediária que integra o **WhatsApp Web** ao **Salesforce CRM**. O objetivo é permitir que vendedores capturem leads, registrem conversas e criem atividades diretamente a partir do WhatsApp, sem precisar alternar entre aplicativos.

---

## 2. Arquitetura

```
┌──────────────────────────────────────────┐
│         WhatsApp Web (browser)           │
│  ┌────────────────────────────────────┐  │
│  │   Extensão Chrome (wz-salesforce) │  │
│  │   content.js · background.js      │  │
│  │   auth.js · inject.js             │  │
│  └──────────────┬─────────────────────┘  │
└─────────────────┼────────────────────────┘
                  │ REST (Bearer token)
                  │ X-SF-Access-Token header
                  ▼
┌──────────────────────────────────────────┐
│           wz-api (Next.js 14)            │
│   BFF (Backend for Frontend)             │
│   Rotas: /api/leads, /api/auth/check,    │
│   /api/conversations, /api/activities,   │
│   /api/leads/lookup, /api/leads/picklist │
└──────────────────┬───────────────────────┘
                   │ jsforce (OAuth token)
                   ▼
┌──────────────────────────────────────────┐
│       Salesforce (Sandbox/Prod)          │
│   Objetos: Lead, User, Opportunity,      │
│   Contact, Task, Account                 │
└──────────────────────────────────────────┘
```

### Componentes

| Componente | Tecnologia | Localização |
|---|---|---|
| Extensão Chrome | JavaScript MV3 | `wz-salesforce/` |
| API BFF | Next.js 14 + TypeScript | `wz-api/` |
| ORM Salesforce | jsforce v3 | `wz-api/src/lib/salesforce.ts` |
| Validação | Zod | `wz-api/src/lib/schemas.ts` |
| Logger | Buffer circular | `wz-api/src/lib/logger.ts` |

---

## 3. Autenticação

### 3.1 OAuth 2.0 User-Agent Flow (Extensão → Salesforce)

O usuário autentica diretamente com o Salesforce através do **OAuth 2.0 User-Agent Flow** (Implicit Flow com PKCE). O token de acesso é armazenado no `chrome.storage.local` e nunca exposto ao servidor da extensão.

**Fluxo:**
1. Usuário clica em "Entrar no Salesforce" no popup
2. `background.js` inicia o fluxo OAuth via `chrome.identity.launchWebAuthFlow`
3. Salesforce retorna `access_token` no fragmento da URL de redirect
4. `auth.js` parseia e salva o token em `chrome.storage.local`
5. Após login, `background.js` busca dados adicionais do User SF (concessionária)

**Chaves de storage:**
| Chave | Conteúdo |
|---|---|
| `wzsf_auth` | `{ access_token, instance_url, userId, userName, issued_at }` |
| `wzsf_user_data` | `{ userId, concessionariaRef }` |
| `wzsf_sent_cache` | Cache 24h de itens já enviados (prevenção de duplicatas) |
| `wzsf_seller_phone` | Telefone do vendedor (WhatsApp) |
| `wzsf_logged_out` | Flag de logout explícito |

### 3.2 Bearer Token (Extensão → wz-api)

Todas as chamadas da extensão para a `wz-api` incluem:
```
Authorization: Bearer <API_BEARER_TOKEN>
X-SF-Access-Token: <access_token_salesforce>
X-SF-Instance-Url: <instance_url_salesforce>
```

O `API_BEARER_TOKEN` é configurado via `.env` na `wz-api` e em `config.js` na extensão.

---

## 4. Funcionalidades

### 4.1 Painel SF Sync (FAB + Painel lateral)

Ativado ao abrir uma conversa no WhatsApp Web. O painel exibe:
- Nome e telefone do contato
- Status do lead no Salesforce (com cor indicativa)
- Botões de ação contextual

**Estados do FAB (botão flutuante):**
| Cor | Significado |
|---|---|
| 🟡 Amarelo | Sem lead ativo (ou lead encerrado) — pode criar novo |
| 🟢 Verde | Lead ativo — dono: este vendedor |
| 🟠 Laranja | Lead ativo — dono: outro vendedor |

### 4.2 Lookup de Lead

Ao mudar de conversa, a extensão busca automaticamente se o contato já possui um lead no Salesforce pelo telefone.

- Normalização de número (BR: adiciona 9 e código 55 se necessário)
- Busca por `Phone` e `MobilePhone`
- Retorna: dados do lead, nome do dono, se está encerrado, dados da oportunidade vinculada

**Campos consultados:**
```
Id, Name, FirstName, LastName, Phone, MobilePhone, Status, LeadSource,
Company, OwnerId, Owner.Name, IsConverted, ConvertedOpportunityId,
Motivo_de_Perda__c
```

### 4.3 Criar Lead

Abre modal de confirmação com os campos:
- **Nome** (editável — pré-preenchido com nome do WhatsApp)
- **Telefone** (editável — pré-preenchido com número do WhatsApp)
- **Interesse em** (dropdown — valores carregados dinamicamente do Salesforce)

Campos preenchidos automaticamente (não exibidos ao usuário):
- `Status`: `'Novo'`
- `LeadSource`: `'Redes sociais do vendedor'`
- `Concessionaria_Ref__c`: valor do campo `Apelido_Concessionaria__c` do User SF
- `Company`: `'Pessoa Física'` (default)

**Regra de bloqueio:** O botão "Salvar como Lead" fica desabilitado se já existir qualquer lead ativo para o contato.

### 4.4 Registrar Contato (Conversa)

Registra o resumo da conversa do WhatsApp como nota/contato no lead do Salesforce.

- Extrai mensagens do DOM do WhatsApp
- Gera resumo (últimas N mensagens)
- Associa ao lead existente por telefone

### 4.5 Criar Atividade (Task)

Cria uma tarefa (Task) no Salesforce vinculada ao lead:
- Assunto: `"Lembrete: contatar <nome>"`
- Data: 7 dias a partir de hoje
- Prioridade: Normal
- Tipo: WhatsApp

### 4.6 Abrir no Salesforce

Abre diretamente o registro do Lead no Salesforce (Lightning) em uma nova aba.

### 4.7 Valores de Picklist Dinâmicos

A rota `GET /api/leads/picklist?field=<campo>` retorna os valores ativos de qualquer campo picklist do objeto Lead diretamente do Salesforce (via `describe`). Sem hardcode de valores.

---

## 5. Endpoints da wz-api

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/health` | Health check da API |
| GET | `/api/auth/check` | Valida token SF + dados do User |
| POST | `/api/leads` | Cria Lead no Salesforce |
| POST | `/api/leads/lookup` | Busca Lead por telefone |
| GET | `/api/leads/picklist?field=X` | Valores de picklist de um campo |
| POST | `/api/conversations` | Registra conversa no Lead |
| POST | `/api/activities` | Cria Task (atividade) |
| POST | `/api/contacts` | Cria/atualiza Contato |
| GET | `/api/logs` | Logs da API em memória |
| DELETE | `/api/logs` | Limpa buffer de logs |

### Headers obrigatórios

```
Authorization: Bearer <API_BEARER_TOKEN>
X-SF-Access-Token: <token_oauth_salesforce>
X-SF-Instance-Url: <url_instancia_salesforce>
Content-Type: application/json
```

---

## 6. Campos Customizados do Salesforce

| Objeto | Campo | Tipo | Uso |
|---|---|---|---|
| `Lead` | `Concessionaria_Ref__c` | Lookup (Account) | Vincula lead à concessionária |
| `Lead` | `Motivo_de_Perda__c` | Text | Lead encerrado por perda |
| `Lead` | `Interesse_em__c` | Picklist | Interesse do lead (veículo, etc.) |
| `User` | `Apelido_Concessionaria__c` | Text | Código da concessionária do vendedor |
| `Opportunity` | `COTACAO_FATURADA__C` | Checkbox | Indica oportunidade faturada |
| `Opportunity` | `MOTIVO_DE_PERDA__C` | Text | Motivo de perda na oportunidade |

---

## 7. Segurança

### 7.1 Autenticação e Autorização

- **Bearer token** em todas as chamadas extensão → wz-api (`API_BEARER_TOKEN`)
- **Token Salesforce** nunca armazenado no servidor — sempre em `chrome.storage.local` no lado do cliente
- **Validação de token** em todas as rotas da API (middleware `validateApiToken`)
- **Credenciais SF em headers** dedicados (`X-SF-Access-Token`, `X-SF-Instance-Url`), nunca no corpo da requisição

### 7.2 Prevenção de Injeção SOQL

- IDs do Salesforce usados em queries SOQL são sanitizados via `sanitizeSfId()` — valida formato de 15 ou 18 caracteres alfanuméricos
- Valores string em SOQL escapados via `sanitizeSoqlString()` (escapa aspas simples)
- A rota genérica `/api/soql` foi **removida** — todas as queries SOQL agora são feitas apenas por rotas especializadas (lookup, picklist, etc.)

### 7.3 CORS Restrito

- Em vez de `Access-Control-Allow-Origin: *`, a API aceita apenas origens específicas:
  - Extensões Chrome (`chrome-extension://`)
  - `localhost` (desenvolvimento)
  - Origens adicionais via variável de ambiente `ALLOWED_ORIGINS`

### 7.4 Validação de Input (Zod)

- Todos os payloads recebidos pela API são validados por schemas Zod antes do processamento
- Campos de tipo, comprimento mínimo e defaults definidos explicitamente

### 7.5 Prevenção de Duplicatas

- Cache local de 24 horas (`wzsf_sent_cache`) previne envio duplicado acidental
- Chave de cache baseada em `userId + ação + telefone + nome` (isolamento por vendedor)
- Usuário pode forçar reenvio com confirmação explícita

### 7.6 Controle de Propriedade de Lead

- A extensão verifica `OwnerId` do lead contra `userId` do vendedor logado
- Ações de negócio (registrar conversa, criar atividade) bloqueadas para leads de outros vendors
- Criação de lead bloqueada se já existe lead ativo para o contato

### 7.7 Logging

- API mantém buffer circular de 200 logs em memória
- Logs incluem rota, nível (info/warn/error/debug), dados sanitizados
- Campos sensíveis (`access_token`, `Authorization`, etc.) redactados automaticamente
- Endpoint `GET /api/logs` protegido por Bearer token

---

## 8. Configuração e Deploy

### 8.1 Variáveis de Ambiente (wz-api/.env)

```env
# Salesforce
SF_CLIENT_ID=<Consumer Key da Connected App>
SF_LOGIN_URL=https://test.salesforce.com   # ou https://login.salesforce.com para prod

# Segurança
API_BEARER_TOKEN=<token compartilhado com a extensão>
NEXTAUTH_SECRET=<secret aleatório>

# Opcional
SF_API_VERSION=v59.0
ALLOWED_ORIGINS=https://meudominio.com
```

### 8.2 Configuração da Extensão (config.js)

```javascript
const API_CONFIG = {
  baseUrl: 'https://wz-api.meudominio.com', // URL de produção
  apiToken: '<mesmo valor de API_BEARER_TOKEN>',
  // ...
};

const SF_CONFIG = {
  clientId: '<Consumer Key>',
  loginUrl: 'https://test.salesforce.com',
  orgUrl: 'https://minhaorg.sandbox.lightning.force.com',
};
```

### 8.3 Connected App no Salesforce

A extensão requer uma Connected App configurada com:
- **OAuth Scopes:** `api`, `id`, `chatter_api`
- **Callback URL:** `https://<id-extensao>.chromiumapp.org/salesforce`
- **IP Relaxation:** Relax IP restrictions (para extensão Chrome)
- **User-Agent Flow:** habilitado (Implicit Flow)

### 8.4 Instalação da Extensão

1. Acesse `chrome://extensions`
2. Ative "Modo do desenvolvedor"
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `wz-salesforce/`

### 8.5 Deploy com Docker (wz-api)

A `wz-api` inclui suporte a Docker para deploy em produção.

**Build e execução:**
```bash
cd wz-api

# Build e start com docker-compose
docker compose up -d --build

# Ou build manual
docker build -t wz-api .
docker run -d -p 3000:3000 --env-file .env wz-api
```

**Arquivos Docker:**
| Arquivo | Descrição |
|---|---|
| `Dockerfile` | Multi-stage build (deps → build → runner) com Node 20 Alpine |
| `docker-compose.yml` | Orquestra o container com variáveis de ambiente via `.env` |
| `.dockerignore` | Exclui node_modules, .next, .git do contexto de build |

**Características:**
- Build multi-stage para imagem final mínima (~150 MB)
- Next.js `output: 'standalone'` — só inclui arquivos necessários
- Executa como usuário não-root (`nextjs:nodejs`)
- Porta padrão 3000 (configurável via `PORT` no `.env`)

### 7.8 Renovação Automática de Token SF

- `apiFetch()` (background.js): ao receber HTTP 401 da wz-api, tenta renovar o token SF via `refreshAccessToken()` e repete a chamada automaticamente
- `checkSfAuth()` (auth.js): ao receber 401 do Salesforce, tenta refresh antes de retornar `{authenticated: false}`
- Se o refresh falhar (User-Agent Flow geralmente não fornece `refresh_token`), o usuário é solicitado a refazer o login OAuth

---

## 9. Fluxo Principal de Uso

```
1. Vendedor abre o WhatsApp Web
2. Extensão injeta o painel SF Sync
3. Vendedor faz login no Salesforce (OAuth)
   └── Background busca dados do User SF (Concessionaria_Ref__c)
4. Ao selecionar uma conversa:
   └── Lookup automático por telefone no SF
       ├── Lead encontrado → exibe nome, status, dono
       │   ├── Lead meu e ativo → botões liberados
       │   ├── Lead de outro → conversa/atividade bloqueada
       │   └── Lead encerrado → FAB amarelo, pode criar novo
       └── Sem lead → FAB amarelo, "Salvar como Lead" disponível
5. Criar Lead:
   └── Abre modal com Nome, Telefone, Interesse em
       ├── Carrega picklist do SF dinamicamente
       └── Envia para /api/leads com Status, LeadSource, Concessionaria_Ref__c
6. Registrar Contato → extrai mensagens e envia para /api/conversations
7. Criar Atividade → cria Task com lembrete para 7 dias
8. "Abrir no Salesforce" → abre Lightning na aba do lead
```

---

## 10. Decisões Técnicas

| Decisão | Justificativa |
|---|---|
| Next.js como BFF | Evita expor token SF na extensão; adiciona validação, logs e tipagem |
| OAuth User-Agent Flow | Extensões Chrome não suportam Authorization Code Flow sem servidor |
| Chatter API para userId | `/services/oauth2/userinfo` não retorna `user_id` em sandboxes |
| Normalização de telefone BR | WhatsApp omite o dígito "9" em números com 12 dígitos (ex: 5565XXXXXXXX) |
| Buffer circular para logs | Memória controlada, sem dependência de banco de dados |
| Zod para validação | Type-safe, integração nativa com TypeScript, mensagens de erro claras |
| sanitizeSfId() | Defesa em profundidade — IDs SF têm formato fixo e previsível |
