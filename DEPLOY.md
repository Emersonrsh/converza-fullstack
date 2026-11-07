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
3. **New + → Key Value** (é o Redis do Render). Nome: `converza-redis`. Em **Maxmemory Policy**, escolha **`noeviction`**: o Redis guarda a fila de tarefas (disparos, esperas dos fluxos, webhooks) e, com outra opção, apaga tarefas quando enche. Crie e copie a **Internal URL**. Já tinha criado? A política dá para trocar depois, na página do Key Value.
   > O Key Value grátis não grava em disco: se ele reiniciar, as tarefas que estavam na fila somem. Para produção, use um plano pago.

## Parte 3 — API (backend)

1. **New + → Web Service** → conecte seu repositório do GitHub.
2. Configure:
   - **Name:** `converza-api`
   - **Root Directory:** `backend`
   - **Language/Runtime:** Docker (o Render detecta o `Dockerfile` automaticamente)
   - **Instance Type:** Free para testar, ou Starter para produção. No Free, a API dorme depois de 15 minutos sem acesso (webhooks e tarefas esperam ela acordar, ~1 minuto) e não consegue enviar e-mail pelas portas 465 e 587 — veja a Parte 9.
3. Em **Environment**, adicione as variáveis:
   | Chave | Valor |
   |---|---|
   | `DATABASE_URL` | a Internal Database URL do Postgres |
   | `REDIS_URL` | a Internal URL do Key Value |
   | `JWT_SECRET` | qualquer frase longa e secreta |
   | `APP_ORIGIN` | o endereço do frontend, ex.: `https://converza-fullstack.onrender.com` (veja Parte 4) |
   | `WHATSAPP_VERIFY_TOKEN` | um texto à sua escolha (anote, usa no Meta) |
   | `GRAPH_API_VERSION` | `v24.0` (a Meta desliga cada versão uns 2 anos depois do lançamento; a v24.0 vale até 18/02/2028 e a v21.0, até 21/01/2027) |
   | `META_APP_ID` / `META_APP_SECRET` / `META_EMBEDDED_SIGNUP_CONFIG_ID` / `META_ADS_CONFIG_ID` | (deixe vazio por enquanto; preenche quando criar o app Meta — Partes 6 e 7). Com o `META_APP_SECRET` preenchido, a API passa a recusar webhooks sem a assinatura da Meta — use a "Chave secreta do app" do **mesmo** app onde o webhook está cadastrado. |
   | `OPENAI_API_KEY` | sua chave do OpenRouter `sk-or-...` (sem ela os agentes não respondem) |
   | `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
   | `ELEVENLABS_API_KEY` | (opcional) chave da ElevenLabs — libera a aba **Vozes**, respostas em áudio dos agentes e a transcrição dos áudios dos clientes. Clonar voz exige o plano Starter ou acima da ElevenLabs. |
   | `PARTNER_COMMISSION_PERCENT` | (opcional) comissão mostrada no banner de parceiros — padrão `40` |
   | `PARTNER_CONTACT_URL` | (opcional) link para os parceiros falarem com você, ex.: `https://wa.me/55119...` |
   | `ASAAS_*` / `PADDLE_*` / `SUPPORT_URL` | (deixe vazio por enquanto; preenche na Parte 8 — cobrança por Pix/cartão e internacional). Sem elas, os botões de pagar ficam desligados com um aviso. |
   | `PUBLIC_API_URL` | o endereço da própria API, ex.: `https://converza-api.onrender.com` (sem barra no fim). É o que aparece nos **links rastreáveis** (`/t/...`) e no endereço das **Ferramentas MCP**. |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | (opcional, mas recomendado) envio de e-mail — veja a Parte 9. Sem isso, os convites mostram um link para você copiar. |
   | `SUPPORT_EMAILS` | (opcional) e-mails da sua equipe de suporte, separados por vírgula — veja a Parte 9. |
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

## Parte 6 — App da Meta (WhatsApp em 1 clique e WhatsApp Business do celular)

Sem esta parte, seus clientes só conseguem a conexão **manual** (token próprio). Com ela, aparecem os botões **Conectar com a Meta** e **WhatsApp Business do celular** em Conexões.

1. Em [developers.facebook.com](https://developers.facebook.com) crie um app do tipo **Empresa** e adicione o produto **WhatsApp**. Para atender outras empresas você precisa ser **Tech Provider** (o próprio painel guia a verificação do negócio).
2. Em **Configurações do app › Básico** copie o **ID do app** → `META_APP_ID` e a **Chave secreta do app** → `META_APP_SECRET` (na API do Render).
3. Em **WhatsApp › Embedded Signup › Configurações** (ou **Facebook Login for Business › Configurações**) crie uma configuração com as permissões `whatsapp_business_management` e `whatsapp_business_messaging`. Copie o **ID da configuração** → `META_EMBEDDED_SIGNUP_CONFIG_ID`. Para o WhatsApp Business do celular, a configuração precisa ter a opção de integrar o app existente (coexistência) ativada.
4. Em **Facebook Login › Configurações**, adicione o domínio do frontend (ex.: `converza-fullstack.onrender.com`) em **Domínios permitidos para o SDK do JavaScript**.
5. Em **WhatsApp › Configuração › Webhook**: URL de retorno `https://converza-api.onrender.com/api/v1/webhooks/whatsapp`, token de verificação = `WHATSAPP_VERIFY_TOKEN`. Depois, em **Campos do webhook**, assine:
   - `messages` (mensagens e status de entrega — obrigatório);
   - `smb_message_echoes`, `history` e `smb_app_state_sync` (WhatsApp Business do celular: respostas feitas pelo app, histórico e contatos);
   - `account_update` (avisa quando o número é desconectado pelo app ou restrito pela Meta).
6. Salve as variáveis no Render (a API redeploya sozinha) e teste: **Conexões › Nova Conexão**.
7. **Publique o app (modo Ao vivo / Live).** Em desenvolvimento, a Meta pode não mandar os webhooks das mensagens de clientes de verdade — só de quem tem função no app ou é número de teste. Para publicar, em **Configurações do app › Básico** ela pede a URL da sua **Política de Privacidade** (e dos Termos de Uso) — o Converza ainda não tem essas páginas, então use as do seu site.

> O número conectado pelo WhatsApp Business do celular tem limite de 20 mensagens por segundo e não recebe grupos, listas de transmissão nem chamadas — eles continuam só no app. O pedido de contatos e histórico só funciona nas primeiras 24 horas depois de conectar (o Converza pede sozinho na hora).

## Parte 7 — Facebook (anúncios e pixel)

Usa o **mesmo app da Meta** da Parte 6 (`META_APP_ID` e `META_APP_SECRET`).

1. **Login dos perfis (Gerenciador e gasto no Dashboard):** no app, em **Facebook Login for Business › Configurações**, crie uma configuração do tipo **token de acesso do usuário** com as permissões `ads_read` e `business_management`. Copie o **ID da configuração** → `META_ADS_CONFIG_ID` (na API do Render). Se o seu app não for do tipo Empresa, deixe vazio: o Converza pede as permissões direto no login.
2. Para clientes de fora da sua empresa, a Meta exige **Acesso avançado** a `ads_read` e `business_management` (Análise do app) e o nível de acesso da **Marketing API**. Antes disso, só quem tem função no app (administrador, desenvolvedor ou testador) consegue conectar.
3. **Pixel pelo WhatsApp (clique para o WhatsApp):** o token da conexão precisa da permissão `whatsapp_business_manage_events` (peça na Análise do app). Os pixels comuns da Meta e do TikTok usam o token que o cliente gera no próprio Gerenciador de Eventos — não precisa configurar nada no servidor.
4. Opcional: `META_ADS_API_VERSION` (padrão `v26.0`) — a versão da Marketing API, que a Meta aposenta mais rápido que a do WhatsApp.

## Parte 8 — Cobranças e assinaturas (Asaas e Paddle)

O cliente paga por **instância** (cada instância = um número de WhatsApp; padrão R$ 127,00/mês) e compra **tokens de IA** à parte. Ninguém digita cartão no Converza: o pagamento acontece na página segura da **Asaas** (Pix e cartão, no Brasil) ou da **Paddle** (exterior), e as instâncias, tokens e disparos extras só são liberados quando o gateway avisa que o pagamento caiu.

### Asaas (Pix e cartão — Brasil)
1. Crie a conta em asaas.com e envie os documentos pedidos — só depois da aprovação a conta recebe pagamentos de verdade. Para testar sem dinheiro, crie também uma conta no **sandbox** (sandbox.asaas.com): é ela que o Converza usa enquanto `ASAAS_ENV` não for `production`.
2. No painel da Asaas, em **Integrações**, gere a **chave da API** → `ASAAS_API_KEY` (a chave do sandbox e a de produção são diferentes).
3. Ainda em **Integrações › Webhooks**, adicione um webhook:
   - **URL:** `https://converza-api.onrender.com/api/v1/billing-hooks/asaas`
   - **Token de autenticação:** invente uma senha longa (por exemplo, 40 letras e números) e coloque a mesma em `ASAAS_WEBHOOK_TOKEN`
   - **Versão da API:** v3 · **Fila de sincronização:** ligada · **E-mail:** o seu (a Asaas avisa se o envio falhar)
   - **Eventos:** todos os de **Cobranças** e os de **Assinaturas**
4. Na API do Render: `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` e, quando for cobrar de verdade, `ASAAS_ENV=production` (troque também a chave e o webhook para os da conta de produção).
5. Opcional: `INSTANCE_PRICE_BRL` (padrão `127`) e `TOKEN_PRICE_BRL_PER_1000` (padrão `1` → 1.000 tokens = R$ 1,00).

### Paddle (pagamentos do exterior) — opcional
1. Crie a conta em paddle.com (Paddle Billing). A Paddle revisa o seu site antes de liberar vendas reais (ela costuma pedir domínio próprio com páginas de preços, termos, privacidade e reembolso). Para testar, use o **sandbox** (sandbox-vendors.paddle.com).
2. **Developer tools › Authentication:** crie uma **API key** → `PADDLE_API_KEY` e um **client-side token** → `PADDLE_CLIENT_TOKEN`.
3. **Catalog › Products:** crie o produto "Instância Converza" com um preço **recorrente mensal** em dólar (ex.: US$ 25) e copie o ID do preço (`pri_…`) → `PADDLE_PRICE_INSTANCE`. A tela de cobrança mostra o valor lido da própria Paddle.
4. **Checkout › Checkout settings:** em **Default payment link**, coloque `https://converza-fullstack.onrender.com/pagamento` (o endereço do **frontend** + `/pagamento`).
5. **Developer tools › Notifications:** crie um destino com a URL `https://converza-api.onrender.com/api/v1/billing-hooks/paddle` e os eventos `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `adjustment.created` e `adjustment.updated`. Copie o **secret key** do destino → `PADDLE_WEBHOOK_SECRET`.
6. Quando for cobrar de verdade: `PADDLE_ENV=production` com as chaves e o preço da conta de produção.
7. Opcional: `TOKEN_PRICE_USD_PER_1000` (padrão `0.2`) e `INSTANCE_PRICE_USD` (só aparece se a Paddle não responder).

### Testar sem gastar (sandbox)
Toda empresa precisa de assinatura ativa para conectar números e usar agentes de IA — inclusive a sua. Enquanto `ASAAS_ENV` não for `production`, tudo é de mentira:
1. No Converza, em **Cobranças**, assine 1 instância pagando por **Pix** (no sandbox, pode usar o seu CPF: nada é cobrado).
2. No painel do sandbox (sandbox.asaas.com), abra **Cobranças**, clique na cobrança e em **Confirmar pagamento**. Em segundos a Asaas avisa o Converza e a assinatura fica **Ativa**.
3. Os tokens de IA são comprados do mesmo jeito (Cobranças › **Adicionar tokens** → confirmar no sandbox).

### Suporte
`SUPPORT_URL` é o link do botão **Falar com Suporte** (ex.: `https://wa.me/5511999999999`). Se ficar vazio, usa o `PARTNER_CONTACT_URL`.

### Como fica para o cliente
- **Assinar:** escolhe quantas instâncias, Brasil (Pix ou cartão) ou exterior, informa CPF/CNPJ (a Asaas exige) e paga na página do gateway. A tela atualiza sozinha quando o pagamento cai.
- **Mais instâncias:** paga só o proporcional até o próximo vencimento (mínimo R$ 5,00). **Menos:** vale a partir do próximo vencimento (é preciso desconectar números/apagar agentes que passarem do novo limite).
- **Mensalidade atrasada:** 3 dias de tolerância; depois a assinatura fica "pagamento pendente" e os números param de enviar mensagens (as recebidas continuam chegando), assim como disparos, agentes de IA e webhooks — tudo volta quando a fatura é paga.
- **Cancelar:** nada mais é cobrado e tudo funciona até o fim do período pago.
- **Reembolso** (feito por você no painel da Asaas ou da Paddle): o Converza desfaz o que a fatura liberou — tira os tokens e os disparos extras que sobraram, volta a quantidade de instâncias, e o reembolso da mensalidade do mês em curso encerra a assinatura.
- **Contas ativadas antes desta versão** (sem pagamento por trás): continuam funcionando até o fim do período (no mínimo 7 dias depois do deploy) e não renovam sozinhas — aparece "Não renova" com o botão para assinar.

## Parte 9 — E-mail, suporte e Configurações

### E-mail (SMTP)
Os convites de equipe e para a plataforma, o aviso de **número desconectado/restrito** (Configurações › Empresa) e o aviso de **acesso de suporte** saem por e-mail. Qualquer provedor SMTP serve:
1. Crie uma conta num provedor (ex.: Brevo, Resend, SendGrid) e confirme o domínio/remetente.
2. Na API, preencha `SMTP_HOST`, `SMTP_PORT` (normalmente `587`), `SMTP_USER`, `SMTP_PASS` e `EMAIL_FROM` (ex.: `Converza <no-reply@seudominio.com>`). Use `SMTP_SECURE=true` só se o provedor mandar usar a porta `465`.
   > **API no plano Free do Render:** ele bloqueia as portas 25, 465 e 587. Use a porta **`2525`** (com `SMTP_SECURE=false`) — a Brevo (`smtp-relay.brevo.com`) e a SendGrid aceitam — ou passe a API para o Starter.
3. Teste: em Configurações › Convites para Plataforma, convide o seu próprio e-mail. Se o envio falhar, o app mostra o link do convite para copiar (nada se perde).

### Equipe de suporte
`SUPPORT_EMAILS=voce@seudominio.com,outra@seudominio.com` — essas pessoas criam uma conta normal no Converza. Quando uma empresa libera o acesso em **Configurações › Acesso de suporte** (24 h, 3 ou 7 dias), ela aparece no seletor de empresas da pessoa de suporte com o selo 🛟. O suporte entra como administrador, mas não paga, não exclui a empresa, não libera o próprio acesso e não cria chaves de API. A empresa pode revogar a qualquer momento.

### Links rastreáveis e MCP
Os dois usam o endereço da API (`PUBLIC_API_URL`): o link rastreável fica `https://converza-api.onrender.com/t/<endereço>` e o servidor MCP, `https://converza-api.onrender.com/mcp`. Se você usar um domínio próprio para a API, coloque-o em `PUBLIC_API_URL`.

## Atualizações futuras

Toda vez que você (ou eu) mudar o código, é só dar **commit + push** no GitHub Desktop: o Render redeploya sozinho.

**Quando chegar um zip completo novo:** no GitHub Desktop, **Repository › Show in Explorer**. Apague tudo o que aparece na pasta (a pasta `.git` fica escondida e continua lá — é ela que guarda o histórico) e extraia o conteúdo do zip ali dentro, de forma que `backend`, `app` e `DEPLOY.md` fiquem direto na pasta. Assim nenhum arquivo antigo sobra para quebrar o build. Se você usa `backend/.env` para rodar no seu computador, copie-o para fora antes e devolva depois. Deixe o zip fora da pasta do repositório. Depois: **commit + push**.
