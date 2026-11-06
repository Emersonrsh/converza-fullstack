# Converza

Plataforma de vendas e atendimento no WhatsApp — CRM, inbox multiatendente, funil, fluxos, agentes de IA, disparos em massa, webhooks e dashboard. Projeto full-stack original.

```
converza/
├── backend/     API Node + Express + PostgreSQL (Drizzle) + Redis/BullMQ + Socket.IO + WhatsApp Cloud API
├── app/         Frontend React + TypeScript + Vite (consome a API)
└── index.html   Protótipo de interface (preview estático, sem backend)
```

## Subir o projeto completo (dev)

Pré-requisitos: Node 18+ e Docker.

```bash
# 1) Banco e Redis
cd backend
docker compose up -d

# 2) Backend
npm install
cp .env.example .env            # ajuste JWT_SECRET e tokens da Meta
npm run db:migrate              # cria as tabelas
npm run db:seed                 # (opcional) dados de demonstração
npm run dev                     # API em http://localhost:4000

# 3) Frontend (em outro terminal)
cd ../app
npm install
cp .env.example .env            # aponta para http://localhost:4000
npm run dev                     # app em http://localhost:5173
```

Abra `http://localhost:5173`, crie uma conta (ou use o login do seed: `demo@converza.app` / `converza123`) e navegue por todos os módulos.

## O que está funcional de ponta a ponta

- Cadastro/login, multi-conta (tenant) com papéis e troca de conta
- Contatos (CRM), funil Kanban com arrastar, inbox com envio e **recebimento em tempo real**
- Conexões de WhatsApp (Cloud API), dashboard com dados reais do banco
- Disparos em massa em fila com progresso ao vivo
- Fluxos (CRUD + ativar/pausar, executados pelo motor do backend)
- Agentes de IA (CRUD), webhooks de entrada (CRUD + receptor público), equipe, assinatura e configurações

## O que precisa das suas credenciais para ir "ao vivo"

Estão integrados no código e ativam quando você pluga as chaves/infra:

- **WhatsApp/Meta**: um app na Meta como Tech Provider (`META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`) e um webhook público no seu domínio. Com isso o cliente conecta o WhatsApp dele **em um clique** (Embedded Signup já implementado); sem isso, há o modo manual por token
- **Pagamento**: chaves de um gateway (Stripe/Pix) atrás do botão Assinar
- **IA**: chave de um provedor (OpenAI/Gemini/etc.) para a execução dos agentes
- **Deploy**: um servidor/host para publicar backend e frontend

## Próximos passos de produto

Construtor visual de fluxos (arrastar-e-soltar) ligado ao grafo salvo; execução dos agentes de IA sobre as conversas; reagendamento de `delay` nos fluxos via fila; assinatura HMAC do webhook da Meta e criptografia de tokens em repouso.
