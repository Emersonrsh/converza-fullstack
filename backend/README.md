# Converza — Backend

API de vendas e atendimento no WhatsApp. Node + TypeScript, Express, PostgreSQL (Drizzle ORM), Redis + BullMQ e Socket.IO. Integração com a **WhatsApp Cloud API** oficial da Meta.

## Stack

- **Express** — API REST (`/api/v1`)
- **PostgreSQL + Drizzle ORM** — dados, multi-tenant (uma base para várias contas)
- **Redis + BullMQ** — fila de disparos em massa com throttle anti-bloqueio
- **Socket.IO** — inbox em tempo real
- **WhatsApp Cloud API** — envio e recebimento de mensagens

## Como rodar (desenvolvimento)

```bash
# 1. Suba Postgres e Redis
docker compose up -d

# 2. Instale as dependências
npm install

# 3. Configure o ambiente
cp .env.example .env   # ajuste JWT_SECRET e os tokens da Meta

# 4. Crie as tabelas
npm run db:generate    # gera o SQL das migrations a partir do schema
npm run db:migrate     # aplica no banco
#   (alternativa rápida em dev: npm run db:push)

# 5. (opcional) Popule dados de demonstração
npm run db:seed

# 6. Suba a API (worker de disparo roda junto em dev)
npm run dev
```

A API sobe em `http://localhost:4000`. Teste: `GET /api/v1/health`.

## Autenticação

Todas as rotas de negócio exigem dois cabeçalhos:

- `Authorization: Bearer <token>` — obtido em `/auth/login` ou `/auth/register`
- `x-account-id: <uuid>` — a conta (tenant) na qual você está operando

```bash
# registrar
curl -X POST localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Você","email":"voce@exemplo.com","password":"senhaForte1","companyName":"Minha Loja"}'

# listar contatos
curl localhost:4000/api/v1/contacts \
  -H "Authorization: Bearer $TOKEN" -H "x-account-id: $ACCOUNT_ID"
```

## Endpoints principais

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · GET `/auth/me` | Conta e sessão |
| GET/POST/PATCH | `/contacts` | CRM de contatos |
| GET | `/conversations` | Lista de conversas do inbox |
| GET | `/conversations/:id/messages` | Histórico de uma conversa |
| POST | `/conversations/:id/messages` | Envia mensagem (via WhatsApp) |
| GET/POST/DELETE | `/connections` | Números de WhatsApp (Cloud API) |
| GET | `/dashboard?start=&end=` | KPIs e séries |
| GET/POST | `/dispatch` | Campanhas de disparo em massa |
| GET/POST | `/webhooks/whatsapp` | Verificação e recebimento (chamado pela Meta) |

## WhatsApp Cloud API

1. No [Meta for Developers](https://developers.facebook.com/), crie um app WhatsApp e pegue o `phone_number_id`, o `WABA id` e um `access token`.
2. Cadastre a conexão: `POST /connections` com `{ name, phoneNumberId, wabaId, displayPhone, accessToken }`.
3. Configure o webhook na Meta apontando para `https://SEU_DOMINIO/api/v1/webhooks/whatsapp`, usando o `WHATSAPP_VERIFY_TOKEN` do `.env`. Em desenvolvimento, exponha a porta com um túnel (ex.: `ngrok http 4000`).

As mensagens recebidas entram no inbox, atualizam o contato e disparam os fluxos ativos cujo gatilho seja "mensagem recebida".

### Embedded Signup (conexão em um clique — modelo BSP)

Como **operador**, você vira Tech Provider na Meta e seus clientes conectam o WhatsApp deles sem mexer em tokens:

1. Crie um app na Meta, adicione o produto WhatsApp e configure um fluxo de **Embedded Signup** (gera um `config_id`).
2. Preencha no `.env`: `META_APP_ID`, `META_APP_SECRET` e `META_EMBEDDED_SIGNUP_CONFIG_ID`.
3. Aponte o webhook da Meta para o **seu** domínio (`/api/v1/webhooks/whatsapp`). Todas as contas usam o mesmo webhook — o roteamento é feito pelo `phone_number_id`.

Com isso, no app o botão "Conectar WhatsApp" abre o popup da Meta. O frontend devolve o `code` + `phone_number_id` + `waba_id` para `POST /connections/embedded-signup/exchange`, que troca o `code` por token, inscreve o app no WABA do cliente, registra o número e salva a conexão. Sem essas variáveis, o app cai no modo manual (token por conexão).

## Tempo real (Socket.IO)

Conecte com `auth: { token, accountId }`. Eventos emitidos: `message:new`, `campaign:progress`, `campaign:done`.

## Eventos em fila

O disparo em massa é enfileirado no BullMQ e enviado com intervalo (`THROTTLE_MS`) entre mensagens. Para escalar, rode o worker em processo separado: `npm run worker` (e suba a API com `START_WORKER=false`).

## Estado atual e próximos passos

Implementado e funcional: auth multi-conta, contatos, inbox com envio/recebimento, conexões, dashboard, disparos em fila, motor básico de fluxos e tempo real.

Fundacional (pronto para evoluir): o motor de fluxos ainda não reagenda nós de `delay` via fila nem trata laços; os agentes de IA têm modelo de dados mas não a execução; falta validação de assinatura HMAC do webhook da Meta e criptografia do `accessToken` em repouso. São os próximos passos naturais.
