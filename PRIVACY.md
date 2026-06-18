# Política de Privacidade — WZ Conecta | Grupo Cometa

**Última atualização:** 12 de junho de 2026
**Extensão:** WZ Conecta — Grupo Cometa (Chrome Extension)
**Responsável:** Grupo Cometa — Inovação

Esta extensão é uma ferramenta de **uso corporativo autorizado**, destinada a vendedores
do Grupo Cometa para integrar o WhatsApp Web ao CRM Salesforce da própria organização.
Não é um produto de consumo geral e não comercializa, vende ou compartilha dados com
terceiros para fins de publicidade ou análise.

Esta extensão **não é afiliada, endossada ou patrocinada** pelo WhatsApp/Meta nem pela
Salesforce. "WhatsApp" e "Salesforce" são marcas de seus respectivos titulares, citadas
aqui apenas de forma descritiva, para indicar compatibilidade.

---

## 1. Quais dados são acessados

A extensão funciona **exclusivamente** em `https://web.whatsapp.com/` e acessa, durante o uso:

| Dado | Origem | Finalidade |
|------|--------|------------|
| Telefone do contato | Conversa aberta no WhatsApp Web | Localizar/criar Lead ou Oportunidade no Salesforce |
| Nome do contato | Conversa aberta no WhatsApp Web | Preencher o Lead e exibir no painel |
| Texto das mensagens recentes | Conversa aberta (apenas quando o vendedor clica em "Registrar Contato") | Registrar o histórico da conversa como atividade no Salesforce |
| Telefone do vendedor logado | Sessão do WhatsApp Web | Atribuir o registro ao vendedor responsável |
| Identidade Salesforce (nome, ID, concessionária) | API do Salesforce, após login | Vincular os registros criados ao usuário correto |

A extensão **não** lê conversas de terceiros automaticamente, **não** envia mensagens,
**não** automatiza ações no WhatsApp e **não** acessa contatos fora da conversa aberta pelo
próprio vendedor.

---

## 2. Onde os dados ficam armazenados

### Localmente, no seu navegador (`chrome.storage.local`)
Os seguintes dados ficam **apenas no seu dispositivo** e nunca são persistidos em servidor:

- `wzsf_auth` — token de acesso e *refresh token* do Salesforce, URL da instância, nome e ID do usuário
- `wzsf_user_data` — ID do usuário e referência da concessionária
- `wzsf_seller_phone` — telefone do vendedor logado no WhatsApp
- `wzsf_sent_cache` — cache de 24h que evita registros duplicados
- `wzsf_logged_out` — sinalizador de logout entre abas

Os tokens do Salesforce **não são persistidos em nenhum servidor**. Eles são enviados — sob
HTTPS — como cabeçalho de autorização (`X-SF-Access-Token`) ao wz-api, que os utiliza para
executar, em seu nome, as operações no Salesforce. O wz-api não armazena o token de forma
persistente (ver item 3).

### No CRM Salesforce
Os Leads, Oportunidades, atividades e registros de conversa criados pela extensão são
gravados no **Salesforce da própria organização** (Grupo Cometa), sujeitos às políticas de
retenção e segurança do CRM corporativo.

---

## 3. Para onde os dados são enviados

A extensão se comunica com dois destinos, ambos via **HTTPS**:

1. **wz-api** (`https://wzapi.viacometa.com.br`) — serviço intermediário (BFF) do próprio
   Grupo Cometa. Recebe os dados da extensão, valida e os encaminha ao Salesforce. Não
   armazena dados de negócio de forma persistente (os logs operacionais são mantidos em
   memória, de forma temporária, com dados sensíveis mascarados).
2. **Salesforce** (`https://*.salesforce.com`, `https://*.force.com`) — login OAuth 2.0 e
   destino final dos registros.

**Não há** envio de dados para serviços de publicidade, redes de rastreamento ou qualquer
terceiro não listado acima.

### Telemetria técnica
A extensão envia ao wz-api eventos de **diagnóstico técnico** (ex.: falha ao localizar um
elemento da página) para detectar quando o WhatsApp Web muda de estrutura. Cada evento inclui:
a versão da extensão, o **User-Agent do navegador** (identifica navegador, versão e sistema
operacional), a **URL da página** no momento da falha (sempre dentro de `web.whatsapp.com`) e,
eventualmente, o identificador do contato em processamento. Esses dados são usados
**exclusivamente** para manutenção da ferramenta — nunca para perfilamento, rastreamento
publicitário ou marketing.

---

## 4. Autenticação

O acesso ao Salesforce usa **OAuth 2.0 com PKCE** (fluxo de cliente público, sem segredo
embutido). Você se autentica diretamente no Salesforce; a extensão recebe um token de acesso
de escopo limitado. Nenhuma senha do Salesforce é vista, armazenada ou transmitida pela
extensão.

---

## 5. Permissões e por que são necessárias

| Permissão | Motivo |
|-----------|--------|
| `storage` | Guardar token e cache localmente no navegador |
| `identity` | Gerar a URL de redirecionamento do login OAuth |
| `tabs` | Abrir o fluxo de login e focar a aba do WhatsApp Web |
| `host_permissions` (web.whatsapp.com, wzapi.viacometa.com.br, *.salesforce.com, *.force.com) | Ler a conversa, falar com o BFF e autenticar no CRM |

---

## 6. Retenção e exclusão

- **Dados locais:** removidos ao fazer **logout** na extensão ou ao **desinstalá-la**.
- **Dados no Salesforce:** regidos pela política de retenção do CRM corporativo do Grupo Cometa.
- **Logs do wz-api:** temporários, mantidos em memória (buffer limitado) e com dados sensíveis
  mascarados; perdidos a cada reinício do serviço.

Para solicitar a exclusão de dados gravados no Salesforce, contate o administrador do CRM do
Grupo Cometa.

---

## 7. Conformidade

- A extensão destina-se a **uso interno autorizado**. O uso pressupõe consentimento da conta
  WhatsApp do vendedor e conformidade com as políticas internas do Grupo Cometa.
- Não coletamos dados de menores nem categorias especiais de dados de forma intencional.
- Não vendemos nem compartilhamos dados pessoais com terceiros.

---

## 8. Contato

Dúvidas sobre esta política ou sobre tratamento de dados:
**Grupo Cometa — Inovação** · maycon.castro@viacometa.com.br

---

*Esta política pode ser atualizada conforme a extensão evolui. A data no topo indica a
última revisão.*
