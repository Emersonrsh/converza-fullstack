# Deploy do Converza (passo a passo)

Guia para colocar o Converza no ar com um domínio público fixo — o que o WhatsApp (webhook e Embedded Signup) exige. Usaremos o **Render**, que hospeda a API, o Postgres, o Redis e o frontend no mesmo lugar, com deploy direto do GitHub.

> Custo: dá para começar nos planos gratuitos do Render para testar. Mas os serviços grátis "dormem" após inatividade e o Postgres grátis expira — para um SaaS de verdade (que recebe webhooks a qualquer hora) use os planos pagos mais baratos (Starter, ~US$7/mês por serviço). O Key Value/Redis tem camada gratuita.

## Parte 1 — Subir o código para o GitHub

O Render faz deploy a partir de um repositório. Sem instalar Git pela linha de comando:

1. Crie uma conta em **github.com**.
2. Baixe e instale o **GitHub Desktop** (desktop.github.com) e faça login com sua conta.
3. No GitHub Desktop: **File → Add Local Repository** e aponte para a pasta `converza-fullstack`.
   - Ele vai dizer que não é um repositório Git ainda e oferecer **"create a repository"** — aceite.
4. Em "Publish repository", desmarque "Keep this code private" se quiser, e clique **Publish**. Pronto, seu código está no GitHub.

> Já existe um `.gitignore`? Se não, crie um arquivo `.gitignore` na raiz com as linhas `node_modules`, `dist` e `.env` antes de publicar, para não subir lixo nem segredos.

## Parte 2 — Banco e Redis no Render

1. Crie conta em **render.com** (pode entrar com o GitHub).
2. **New + → Postgres**. Nome: `converza-db`. Região: escolha uma perto (ex.: Ohio/Oregon). Crie. Depois, na página do banco, copie a **Internal Database URL**.
3. **New + → Key Value** (é o Redis do Render). Nome: `converza-redis`. Crie e copie a **Internal URL**.

## Parte 3 — API (backend)

1. **New + → Web Service** → conecte seu repositório do GitHub.
2. Configure:
   - **Name:** `converza-api`
   - **Root Directory:** `backend`
   - **Language/Runtime:** Docker (o Render detecta o `Dockerfile` automaticamente)
   - **Instance Type:** Free para testar, ou Starter para produção.
3. Em **Environment**, adicione as variáveis:
   | Chave | Valor |
   |---|---|
   | `DATABASE_URL` | a Internal Database URL do Postgres |
   | `REDIS_URL` | a Internal URL do Key Value |
   | `JWT_SECRET` | qualquer frase longa e secreta |
   | `APP_ORIGIN` | o endereço do frontend, ex.: `https://converza-fullstack.onrender.com` (veja Parte 4) |
   | `WHATSAPP_VERIFY_TOKEN` | um texto à sua escolha (anote, usa no Meta) |
   | `GRAPH_API_VERSION` | `v21.0` |
   | `META_APP_ID` / `META_APP_SECRET` / `META_EMBEDDED_SIGNUP_CONFIG_ID` | (deixe vazio por enquanto; preenche quando criar o app Meta). Com o `META_APP_SECRET` preenchido, a API passa a recusar webhooks sem a assinatura da Meta — use a "Chave secreta do app" do **mesmo** app onde o webhook está cadastrado. |
   | `OPENAI_API_KEY` | sua chave do OpenRouter `sk-or-...` (sem ela os agentes não respondem) |
   | `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
4. Crie o serviço. O Render builda a imagem, roda as migrations e sobe a API. A URL final será algo como `https://converza-api.onrender.com`.

## Parte 4 — Frontend (app)

1. **New + → Static Site** → mesmo repositório.
2. Configure:
   - **Name:** `converza-app`
   - **Root Directory:** `app`
   - **Build Command:** `npm install --include=dev && npm run build`
   - **Publish Directory:** `dist`
3. Em **Environment**, adicione:
   | Chave | Valor |
   |---|---|
   | `VITE_API_URL` | `https://converza-api.onrender.com/api/v1` |
   | `VITE_SOCKET_URL` | `https://converza-api.onrender.com` |
4. (Opcional) Em **Redirects/Rewrites**, adicione a regra **Source** `/*` → **Destination** `/index.html` → **Rewrite**. Não é obrigatório: o build já gera um `404.html` igual ao `index.html`, então atualizar a página em qualquer tela (ex.: `/flows/...`) abre o app normalmente.
5. Crie. A URL aparece no topo da página do serviço (ex.: `https://converza-fullstack.onrender.com`) — é ela que vai no `APP_ORIGIN` da API.

## Parte 5 — Amarrar as pontas

1. Confirme que o `APP_ORIGIN` da API é exatamente a URL do frontend (sem barra no fim). Se precisou ajustar, salve e o Render redeploya.
2. Abra a URL do frontend, crie sua conta e entre.
3. **Base para o WhatsApp:** seu webhook agora é `https://converza-api.onrender.com/api/v1/webhooks/whatsapp` e o token de verificação é o `WHATSAPP_VERIFY_TOKEN` que você definiu. Use esses valores ao configurar o app na Meta.

## Atualizações futuras

Toda vez que você (ou eu) mudar o código, é só dar **commit + push** no GitHub Desktop: o Render redeploya sozinho.
