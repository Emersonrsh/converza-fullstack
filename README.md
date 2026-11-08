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
- **Contatos (CRM)**: lista com contagem de ativos (conversaram nos últimos 30 dias) e leads (sem compra aprovada), busca por nome/telefone/e-mail, status e origem (WhatsApp, anúncio, importação, cadastro manual, integração), filtros avançados (datas, campo personalizado, etiquetas, etapa do funil, etapas do Kanban), ordenação e paginação; ficha do contato com dados, etiquetas, **campos personalizados**, anotações, Kanban e compras; novo contato com busca antes de criar (evita duplicado); ações em massa (etiquetar, remover etiqueta, Kanban, etapa, exportar, excluir); **exportar CSV** com as 3 últimas exportações guardadas e **importar CSV** (planilha modelo, `;` ou `,`, acentos do Excel, etiquetas padrão, erros por linha); o mesmo cliente com e sem o 9 do celular não vira contato duplicado
- Inbox com envio e **recebimento em tempo real**
- **Kanban**: vários quadros com colunas próprias (cor e tipo: em andamento, ganho ou perdido), cards de contatos (salvos, novos ou só título) com valor, responsável, prazo e anotações; arrastar e soltar cards e colunas, busca e filtro por responsável, indicadores (cards, valor no pipeline, conversões e taxa), tempo real entre a equipe; integrado ao Chats ao vivo e à ação "Colocar no Kanban" dos fluxos
- **Conexões** (API oficial do WhatsApp): contagem de conectadas/desconectadas, busca e filtro, um número por instância contratada e aviso de assinatura inativa; três jeitos de conectar — **Meta em 1 clique** (Embedded Signup: registra o número com um PIN de duas etapas), **WhatsApp Business do celular** (coexistência: o app continua funcionando, contatos e histórico de até 6 meses entram no Converza, o que é respondido pelo celular aparece no chat e pausa a automação) e **manual** (token próprio, com a chave secreta do app do cliente para conferir a assinatura dos webhooks); saúde do número (qualidade, limite de conversas, nome de exibição, inscrição nos webhooks, última mensagem) verificada sozinha e na hora em que um envio falha por token vencido ou bloqueio; detalhes com registrar com PIN, receber mensagens, perfil do WhatsApp (recado, descrição, e-mail, endereço, sites, categoria), trocar token, renomear e excluir (pausa o agente que atendia só aquele número)
- Dashboard com dados reais do banco
- **Facebook**: **Perfis e contas** (um login da Meta por perfil, cada um com as suas contas de anúncios; nada entra no painel sozinho; a mesma conta não entra duas vezes; aviso de login vencendo/vencido e de conta sem acesso); **Gerenciador** (campanhas → conjuntos → anúncios com investimento, impressões, cliques no link, CTR, CPC, CPM, conversas iniciadas, custo por conversa, leads e compras da Meta, orçamento e status, gráfico por dia, filtros de conta/período/status/busca, moedas separadas) cruzado com o Converza: leads que chegaram por cada anúncio de clique para o WhatsApp, vendas aprovadas, faturamento e ROAS real; o gasto das contas escolhidas entra sozinho no Dashboard (90 dias na hora, atualização a cada hora); **Pixel** (Meta pela API de Conversões, Meta pelo WhatsApp com o ctwa_clid e TikTok pela API de Eventos): ID e token conferidos na plataforma, eventos de lead novo, venda aprovada (com valor) e etapa do Kanban, uma vez só por conversão, dados do cliente em SHA-256, histórico com o que foi mandado e a resposta, evento de teste com código, novas tentativas automáticas, token vencido marcado e reenviar falhas
- **Disparos em massa**: envia um **fluxo** para muitos contatos de uma vez, com cota por ciclo da assinatura (1.000 contatos por instância contratada) e saldo extra que passa para o mês seguinte (pacotes de 1.000 e 10.000, comprados por Pix/cartão pela Asaas ou pela Paddle); público pelos mesmos filtros de Contatos (status, origem, etiquetas, etapas do funil e do Kanban, datas, campo personalizado) e opção de pular quem recebeu disparo nos últimos N dias; prévia da regra das 24h da Meta — quem falou com você nas últimas 24h recebe o fluxo na hora, os outros recebem um **modelo aprovado** (com variáveis do contato) e o fluxo começa quando responderem; agendar, velocidade por minuto, pausar, continuar, cancelar, duplicar e excluir; progresso ao vivo com fluxo iniciado, modelos enviados, entregues, lidos, responderam, falharam e ficaram de fora, e a lista de contatos por situação; pausa sozinho quando a cota acaba, a conexão cai ou o limite diário de conversas da Meta é atingido (e volta sozinho no último caso); só debita o que foi enviado de verdade; quem responde **SAIR** não recebe mais disparos (e volta com **VOLTAR** ou pela ficha do contato)
- **Fluxos**: editor visual (arrastar, conectar, zoom, minimapa, desfazer/refazer, copiar/colar), barra Ferramentas com 21 blocos editados em janela com Salvar/Cancelar (Mensagem com texto/imagem/vídeo/áudio/intervalo/contato/arquivo/sticker, Template WhatsApp, Etiquetas, Botão PIX, Menu, Carrossel, Aguarda Resposta, Controlador de Chat, Notificação, Condicional, Distribuidor, Conexão de Fluxo, Pixel, Intervalo Inteligente, Departamento, Integração com cURL e teste, Bloco de IA com chave própria e leitura de comprovante, Agente de IA, Kanban, Manipulador, Venda aprovada) — os blocos antigos continuam funcionando, pastas com cores, busca e filtros, simulador, estatísticas por bloco (entradas/avanços/taxa), compartilhar e importar por código, traduzir com IA, gerar fluxo com IA, arquivar
- **Chats ao vivo**: fila Aguardando / Atendendo / Resolvidos com contadores, busca (nome, telefone e texto das mensagens), filtros (conexão, responsável, etapa, etiqueta, data), Não lidas / Não respondidas; atender, transferir, assumir, devolver para a fila, resolver e reabrir (com histórico); texto com formatação do WhatsApp, emojis, respostas rápidas com `#atalho` (texto ou com anexos), notas internas, anexos (imagem, vídeo, áudio, documento), **mensagem de voz** gravada no navegador, responder citando, tiques de enviada/entregue/lida, mídias recebidas, janela de 24h e **modelos aprovados** (cabeçalho, variáveis, botões); painel do contato com etapa, valor, etiquetas, anotações, automação, fluxos em andamento e vendas
- **Agentes de IA**: modelos prontos (vendas, suporte, recuperação), **Criar com IA** (lê um fluxo, as conversas de uma etiqueta ou o site; observações por microfone), importar/compartilhar por código, 2 agentes por instância contratada; editor com perfil, jeito de falar, instruções, regras, conhecimento e perguntas frequentes, fluxo que ele dispara (checkout) com etiqueta, passar para a equipe, números e público (todos, anúncio ou etiqueta), espera para juntar mensagens seguidas, limite diário, **conversa de teste** sem enviar nada; no WhatsApp entende áudios do cliente (transcrição) e responde em texto ou **mensagem de voz**; aba **Vozes** para clonar uma voz com 1 a 3 áudios (anexar ou gravar), ouvir a prévia e aceitar; indicadores e atividade recente; nome do agente e transcrições no Chats ao vivo
- **Webhooks de entrada**: vários webhooks, cada um com a sua URL, conexão e mapeamento; consumo do mês (10 mil eventos por instância contratada — o que passar fica guardado para reprocessar); recebe JSON, formulário e GET com parâmetros; o primeiro evento aparece ao vivo e vira o exemplo, com o mapeamento detectado sozinho (Hotmart, Kiwify com valor em centavos, formulários) e campos escolhidos no JSON; condições ("só compras aprovadas"); ações: criar/atualizar o contato (campos personalizados), etiquetas, Kanban, venda no Dashboard, **modelo de mensagem** com variáveis do evento e **fluxo** (começa quando o cliente responder o modelo, se ele não falou nas últimas 24h); evento repetido pela plataforma não roda de novo; simular sem executar, executar com o exemplo, histórico com resultado de cada ação, reprocessar, nova URL, pausar, duplicar
- **Cobranças e assinaturas**: cobrança por **instância** (cada uma é um número de WhatsApp, R$ 127,00/mês) com **Asaas** (Pix e cartão, CPF/CNPJ conferido) e **Paddle** (exterior); o cliente paga na página segura do gateway e as instâncias são liberadas sozinhas quando o pagamento cai (aviso repetido não libera duas vezes); mais instâncias com proporcional até o vencimento, redução agendada para a renovação, cancelar no fim do período e reativar; **tokens de IA** avulsos (1.000 tokens = R$ 1,00, de 5 mil a 5 milhões) e pacotes de disparos extras; histórico de **faturas** e **reembolsos** com filtros, link para pagar ou ver o comprovante/PDF; reembolso feito no gateway desfaz o que a fatura liberou; 3 dias de tolerância na mensalidade atrasada e, depois disso, os números param de enviar até pagar
- **Configurações** (menu agrupado e recolhível): **Empresa** (dados, slug, fuso, aviso por e-mail quando um número cai ou é restringido, **departamentos/setores** com cor e pessoas, **horários de trabalho** por número com até 3 intervalos por dia, nova conta, sair e excluir a empresa); **Equipe** (função, setor, convites por e-mail que a pessoa aceita pelo link); **Convites para Plataforma** (indicação, com status); **Acesso de suporte** com prazo e revogação; **Traduções de fluxo** (reserva o saldo antes e devolve o que sobrar); **Uso da IA** por conversa; **Fluxos Padrões** (boas-vindas, fora do horário e resposta padrão por número); **Disparos em massa** (cota e regras); **Respostas Rápidas** com texto, imagem, vídeo, áudio, documento e figurinha (no Chats, `#atalho`); **Templates WhatsApp** (listar com status/motivo da Meta, criar com amostra de mídia, excluir); **Variáveis Globais** `{{g_nome}}` que os fluxos leem, definem, somam e subtraem; **Campos Personalizados** e variáveis do sistema; **Etiquetas** com cor (renomear atualiza contatos, agentes, fluxos, webhooks e disparos); **Integrações** (estado de tudo num lugar); **Trackeamento** (links rastreáveis para o WhatsApp com código: cliques, contatos, etiqueta e vendas por origem); **Produtos**; **Ferramentas MCP** (chave de API com ferramentas escolhidas para Claude, ChatGPT, Cursor ou n8n consultarem e agirem na conta)
- **Fila do setor**: fluxo, agente de IA ou alguém da equipe manda a conversa para um setor; ela fica em Aguardando só para quem é do setor (o dono e os administradores veem tudo)

## O que precisa das suas credenciais para ir "ao vivo"

Estão integrados no código e ativam quando você pluga as chaves/infra:

- **WhatsApp/Meta**: um app na Meta como Tech Provider (`META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`) e um webhook público no seu domínio. Com isso o cliente conecta o WhatsApp dele **em um clique** ou pelo **WhatsApp Business do celular** (Embedded Signup e coexistência já implementados); sem isso, há o modo manual por token. Veja os campos do webhook em DEPLOY.md
- **Pagamento**: conta na **Asaas** (Pix e cartão) e, para o exterior, na **Paddle** — chaves, webhooks e preço do catálogo (veja DEPLOY.md, Parte 8)
- **IA**: chave de um provedor (OpenAI/Gemini/etc.) para a execução dos agentes
- **Deploy**: um servidor/host para publicar backend e frontend

## Próximos passos de produto

Criptografia dos tokens em repouso; edição simultânea de um mesmo fluxo por várias pessoas.

## Testes

```bash
cd backend && npm test        # fluxos, dashboard, chats, kanban, contatos, agentes, cobranças e configurações (horários, etiquetas, variáveis globais, templates, fila do setor, links rastreáveis, MCP)
```
