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
   | `JWT_SECRET` | **obrigatório e forte**: pelo menos 32 letras e números aleatórios (gere com um gerenciador de senhas). A API **não sobe** em produção sem ele, com a chave de exemplo ou com menos de 24 caracteres — de propósito, porque com a chave padrão qualquer pessoa conseguiria forjar um login. Trocar a chave obriga todo mundo a entrar de novo. |
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
   | `HOUSE_EMAILS` / `HOUSE_INSTANCES` | (opcional) **conta da casa** — veja a Parte 10. |
   | `LEGAL_TRADE_NAME` / `LEGAL_COMPANY_NAME` / `LEGAL_CNPJ` / `LEGAL_ADDRESS` / `LEGAL_EMAIL` / `LEGAL_DPO_NAME` / `LEGAL_DPO_EMAIL` / `LEGAL_CITY` | dados da sua empresa (ou seus, se vende com CPF: `LEGAL_CNPJ` aceita CPF) nos **Termos de Uso**, na **Política de Privacidade** e na **Exclusão de dados** — veja a Parte 10. |
   | `WA_WEB_ENABLED` e demais `WA_WEB_*` | (opcional) **WhatsApp por QR Code** (API não oficial) — veja a Parte 11. |
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
A conta pode ser de **pessoa física (CPF)** ou de empresa (CNPJ): o Converza funciona igual. Com CPF, a Asaas não emite nota fiscal (isso é recurso da conta de empresa) e o cliente vê o seu nome como recebedor do Pix.

São **duas contas** na Asaas: a de **teste** (sandbox.asaas.com, cadastro separado, sem dinheiro de verdade — o Converza usa ela enquanto `ASAAS_ENV` não for `production`) e a **de verdade** (asaas.com). Os passos 2 e 3 são feitos nas duas.

1. **Conta de verdade:** envie os documentos e faça a **prova de vida** (selfie) quando a Asaas pedir — só depois da aprovação ela recebe pagamentos. Aprovada, cadastre uma **chave Pix** (menu **Pix › Cadastrar chave**; a **chave aleatória** não expõe seu CPF nem seu celular): sem chave, a Asaas demora mais para processar os recebimentos por Pix. A conta de teste é aprovada sozinha (se não for, ou se o Pix aparecer desabilitado, tire números e símbolos do nome do cadastro).
2. **Chave da API:** pelo **site** (o aplicativo não gera), com usuário administrador, em **Integrações › Chave de API › Gerar nova chave de API**. **Copie na hora**: a Asaas mostra a chave uma vez só (perdeu, gera outra). → `ASAAS_API_KEY`. A chave do sandbox não funciona na produção e vice-versa.
3. **Webhook:** em **Integrações › Webhooks**, adicione um:
   - **Nome:** Converza · **URL:** `https://converza-api.onrender.com/api/v1/billing-hooks/asaas` · **E-mail:** o seu (a Asaas avisa se o envio falhar)
   - **Versão da API:** v3 · **Fila de sincronização:** ativa · **Webhook:** ativo · **Tipo de envio:** sequencial
   - **Token de autenticação:** a Asaas exige um de 32 a 255 caracteres — use o botão de gerar ou invente um (letras e números). Copie → `ASAAS_WEBHOOK_TOKEN`. Use **o mesmo token** no webhook do sandbox e no da produção: na troca, só a chave muda.
   - **Eventos:** todos os de **Cobranças** e os de **Assinaturas**
4. **No Render** (converza-api › Environment): `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` → salve (o Render reinicia a API). Para **cobrar de verdade**: apague a empresa de teste (veja abaixo), troque `ASAAS_API_KEY` pela chave da produção, adicione `ASAAS_ENV=production` e desative o webhook do sandbox.
5. **Avisos da Asaas aos seus clientes:** por padrão a Asaas manda lembretes de cada cobrança por e-mail e SMS (antes e depois do vencimento) e cobra por isso — R$ 0,99 por cobrança avisada na tabela atual; confira em **Minha conta › Taxas**. Eles ajudam a lembrar de pagar a mensalidade por Pix (o Converza não manda esse lembrete); se não quiser, dá para desligar no cadastro de cada cliente na Asaas (**Clientes › cliente › Notificações**).
6. Opcional: `INSTANCE_PRICE_BRL` (padrão `127`) e `TOKEN_PRICE_BRL_PER_1000` (padrão `1` → 1.000 tokens = R$ 1,00).

### Paddle (pagamentos do exterior) — opcional
1. Crie a conta em paddle.com (Paddle Billing). A Paddle revisa o seu site antes de liberar vendas reais (ela costuma pedir domínio próprio com páginas de preços, termos, privacidade e reembolso). Para testar, use o **sandbox** (sandbox-vendors.paddle.com).
2. **Developer tools › Authentication:** crie uma **API key** → `PADDLE_API_KEY` e um **client-side token** → `PADDLE_CLIENT_TOKEN`.
3. **Catalog › Products:** crie o produto "Instância Converza" com um preço **recorrente mensal** em dólar (ex.: US$ 25) e copie o ID do preço (`pri_…`) → `PADDLE_PRICE_INSTANCE`. A tela de cobrança mostra o valor lido da própria Paddle.
4. **Checkout › Checkout settings:** em **Default payment link**, coloque `https://converza-fullstack.onrender.com/pagamento` (o endereço do **frontend** + `/pagamento`).
5. **Developer tools › Notifications:** crie um destino com a URL `https://converza-api.onrender.com/api/v1/billing-hooks/paddle` e os eventos `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.past_due`, `adjustment.created` e `adjustment.updated`. Copie o **secret key** do destino → `PADDLE_WEBHOOK_SECRET`.
6. Quando for cobrar de verdade: `PADDLE_ENV=production` com as chaves e o preço da conta de produção.
7. Opcional: `TOKEN_PRICE_USD_PER_1000` (padrão `0.2`) e `INSTANCE_PRICE_USD` (só aparece se a Paddle não responder).

### Testar sem gastar (sandbox)
Toda empresa precisa de assinatura ativa para conectar números e usar agentes de IA — menos as **contas da casa** (`HOUSE_EMAILS`, Parte 10), que não pagam e por isso não mostram o botão de assinar. Para testar a cobrança, **crie uma empresa de teste** no Converza com outro e-mail (no Gmail, `seunome+teste@gmail.com` chega na mesma caixa). Enquanto `ASAAS_ENV` não for `production`, tudo é de mentira:
1. Na empresa de teste, em **Cobranças**, assine 1 instância pagando por **Pix** (no sandbox, pode usar o seu CPF: nada é cobrado).
2. No painel do sandbox (sandbox.asaas.com), abra **Cobranças**, clique na cobrança e em **Confirmar pagamento**. Em segundos a Asaas avisa o Converza e a assinatura fica **Ativa**. (Não ficou? Abra os **logs do webhook** em **Integrações › Webhooks**: resposta 401 = o token do webhook é diferente do `ASAAS_WEBHOOK_TOKEN`; 503 = falta o `ASAAS_WEBHOOK_TOKEN` no Render.)
3. Os tokens de IA são comprados do mesmo jeito (Cobranças › **Adicionar tokens** → confirmar no sandbox). Cartão de teste da Asaas: `4444 4444 4444 4444`.
4. Terminou? **Apague a empresa de teste** (Configurações › Empresa › Excluir empresa) **antes** de trocar para a produção — a assinatura dela só existe no sandbox.

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

## Parte 10 — Termos, Privacidade e conta da casa

### Páginas legais (obrigatórias para vender e para a Meta)
O app já tem três páginas públicas (abrem sem login):
- `https://SEU-APP.onrender.com/termos` — Termos de Uso
- `https://SEU-APP.onrender.com/privacidade` — Política de Privacidade (LGPD)
- `https://SEU-APP.onrender.com/exclusao-de-dados` — instruções de exclusão de dados

1. Na API (converza-api › Environment), preencha: `LEGAL_COMPANY_NAME` (razão social), `LEGAL_CNPJ` (o CNPJ — o novo, com letras, também vale), `LEGAL_ADDRESS` (endereço completo), `LEGAL_EMAIL` (e-mail de contato), `LEGAL_DPO_NAME` e `LEGAL_DPO_EMAIL` (encarregado de dados — pode ser você), `LEGAL_CITY` (cidade do foro, ex.: `São Paulo/SP`) e, se a marca não for "Converza", `LEGAL_TRADE_NAME`. Enquanto faltar algo, a página mostra o dado marcado em amarelo e um aviso para você.
   - **Vende como pessoa física (sem CNPJ)?** Coloque o seu **nome completo** em `LEGAL_COMPANY_NAME` e o seu **CPF** em `LEGAL_CNPJ`: as páginas passam a dizer "pessoa física inscrita no CPF sob o nº…" e "com endereço em…" sozinhas. A lei do comércio eletrônico (Decreto 7.962/2013) pede que o site mostre o CPF ou CNPJ de quem vende e um endereço físico e um eletrônico — então seu CPF e o endereço ficam públicos nessas páginas (se não quiser expor a sua casa, use um endereço comercial ou escritório virtual). Quando abrir o CNPJ, é só trocar as duas variáveis.
   - Se o número não conferir (dígito errado), a página mostra um aviso para você corrigir.
2. No app da Meta (Meta for Developers › seu app › **Configurações do app › Básico**), cole o link de `/privacidade` em **URL da Política de Privacidade**, o de `/termos` em **URL dos Termos de Serviço** e o de `/exclusao-de-dados` em **Exclusão de dados do usuário › URL de instruções**. A Meta exige isso para publicar o app e para a Análise do App.
3. O cadastro de conta agora exige marcar "Li e aceito os Termos de Uso e a Política de Privacidade"; a data e a versão do aceite ficam gravadas.
4. **Registros de acesso:** o Converza guarda data, hora e IP de cada acesso por 6 meses (Marco Civil da Internet, art. 15) e apaga o que passar disso sozinho, uma vez por dia.

> Os textos foram escritos com cuidado para o que o Converza realmente faz, mas **não substituem um advogado**: antes de vender em escala, peça para um advogado revisar (principalmente limitação de responsabilidade, reembolso e a cláusula do QR Code).

### Conta da casa (suas próprias empresas sem pagar)
`HOUSE_EMAILS=voce@seudominio.com` (pode ter vários, separados por vírgula) e `HOUSE_INSTANCES=10` (quantos números cada empresa sua pode conectar).
- Toda empresa cujo **dono** tem um desses e-mails vira "conta da casa": assinatura ativa sem fatura, tokens de IA **sem limite** (o uso continua aparecendo em Configurações › Uso da IA) e as instâncias de `HOUSE_INSTANCES`.
- Vale para empresas que já existem e para as que você criar depois: o servidor confere ao ligar (o Render reinicia a API quando você salva as variáveis, e em ~1 minuto já vale), a cada hora e na hora de criar a conta ou a empresa.
- Tirou o e-mail da lista? A empresa volta a ser uma conta normal (sem assinatura) na próxima conferência.
- Em Cobranças e assinaturas aparece "Conta da casa · sem cobrança", sem botões de compra.

## Parte 11 — WhatsApp por QR Code (API não oficial)

A conexão por QR Code liga qualquer **WhatsApp ou WhatsApp Business** ao Converza como um "aparelho conectado" (o mesmo caminho do WhatsApp Web), sem Meta, sem app aprovado e sem cobrança por mensagem. Chats, fluxos, agentes de IA e disparos funcionam por ela.

> ⚠️ **Leia antes de oferecer:** isso **não é autorizado pela Meta** e vai contra os Termos do WhatsApp. O WhatsApp pode banir o número a qualquer momento, principalmente com disparos para quem não conhece a empresa. O app mostra esse aviso e exige que o dono marque que entendeu antes de conectar, e os Termos de Uso têm uma cláusula sobre isso. Para clientes que não podem perder o número, use a API oficial.

**O que precisa no Render:**
1. A API precisa ficar **sempre ligada**: use o plano **Starter (US$ 7/mês) ou maior**. No Free ela dorme depois de 15 minutos e a sessão do WhatsApp cai junto — as mensagens que chegarem nesse tempo só aparecem quando ela acordar (e até 3 dias depois).
2. **Memória:** cada número conectado por QR Code fica com uma sessão aberta na API, e isso gasta memória (em geral algumas dezenas de MB por número, mais nos números com muito movimento). O Starter (512 MB) aguenta poucos números (uns 3 a 5); acompanhe o gráfico de memória do serviço no Render e suba o plano quando passar de ~80%.
3. **Banco:** os arquivos que chegam pelo QR Code (fotos, áudios, PDFs) ficam guardados no Postgres por 31 dias (até 16 MB cada). Acompanhe o espaço do banco.

**Variáveis (todas opcionais):**
| Chave | Padrão | O que faz |
|---|---|---|
| `WA_WEB_ENABLED` | `true` | `false` esconde e desliga o QR Code no seu servidor |
| `WA_WEB_DISPATCH_MIN_GAP` / `WA_WEB_DISPATCH_MAX_GAP` | `15` / `45` | intervalo aleatório (em segundos) entre um contato e outro nos disparos pelo QR Code |
| `WA_WEB_DAILY_LIMIT` | `250` | máximo de contatos por dia (24 h) em disparos por número conectado por QR Code; ao bater, o disparo pausa e continua sozinho |
| `WA_WEB_MEDIA_MAX_MB` | `16` | arquivos recebidos maiores que isso não são baixados (a conversa avisa "abra no celular") |
| `WA_WEB_DEVICE_NAME` | `LEGAL_TRADE_NAME` ou `Converza` | nome que aparece em "Aparelhos conectados" no celular |
| `WA_WEB_DEBUG` | — | `1` mostra o log detalhado do protocolo (só para investigar problema) |

Nunca defina `WA_WEB_DRIVER` no Render: ele existe só para os testes automáticos (celular simulado) e é ignorado em produção.

**Como funciona para o cliente:** Conexões › Nova Conexão › **QR Code** → nome + aceite do risco → QR na tela (ou "Conectar com um código", sem câmera). Depois de conectado:
- o servidor guarda a sessão no banco: deploy ou reinício **não pede o QR de novo** (a API desliga com calma, solta a sessão e a nova versão religa sozinha em segundos);
- queda de internet: religa sozinho; se ficar mais de 3 minutos fora, a conexão fica vermelha e o dono recebe o e-mail de "número desconectado";
- botões, listas e carrosséis viram **opções numeradas** (o cliente responde 1, 2, 3…), o Pix vai como texto com a chave e o código copia e cola, e os modelos da Meta viram mensagem normal (não há janela de 24h no QR Code);
- grupos, status e canais são ignorados; mensagem de visualização única fica só no celular;
- o que for respondido pelo celular aparece no chat e pausa a automação daquela conversa (por isso: desligar a saudação/ausência automática do WhatsApp Business).

**Manutenção:** o QR Code usa a biblioteca Baileys (versão fixa no `package.json`). Quando o WhatsApp muda o protocolo, pode ser preciso atualizar essa biblioteca — se as conexões por QR começarem a cair todas ao mesmo tempo, me chame.

## Atualizações futuras

Toda vez que você (ou eu) mudar o código, é só dar **commit + push** no GitHub Desktop: o Render redeploya sozinho.

**Quando chegar um zip completo novo:** no GitHub Desktop, **Repository › Show in Explorer**. Apague tudo o que aparece na pasta (a pasta `.git` fica escondida e continua lá — é ela que guarda o histórico) e extraia o conteúdo do zip ali dentro, de forma que `backend`, `app` e `DEPLOY.md` fiquem direto na pasta. Assim nenhum arquivo antigo sobra para quebrar o build. Se você usa `backend/.env` para rodar no seu computador, copie-o para fora antes e devolva depois. Deixe o zip fora da pasta do repositório. Depois: **commit + push**.
