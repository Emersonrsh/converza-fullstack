import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { cx } from '../components/ui';

interface Tutorial {
  id: string; icon: string; title: string; module: string; route: string; minutes: number;
  steps: string[]; tip?: string;
}

const TUTORIALS: Tutorial[] = [
  {
    id: 'whatsapp', icon: 'plug', title: 'Conectar seu WhatsApp', module: 'Conexões', route: '/connections', minutes: 3,
    steps: [
      'Abra **Conexões** e clique em **Nova Conexão**.',
      'Número novo na API: escolha **Conectar com a Meta**, entre com o Facebook do dono do negócio, escolha a conta do WhatsApp Business e o número e confirme o código por SMS.',
      'Quer continuar usando o app no celular? Escolha **WhatsApp Business do celular**: leia o QR code que a Meta manda no celular e os contatos e as conversas dos últimos meses chegam aqui.',
      'Pronto: o número aparece como **Conectada** e as mensagens chegam em **Chats ao vivo**. Em **Detalhes** você vê a qualidade, o limite de conversas e edita o perfil do WhatsApp.',
    ],
    tip: 'Já tem um app na Meta for Developers? Use **Manual** com o Phone Number ID, o WABA ID, o token permanente e a chave secreta do app. Se um número cair, o card fica vermelho na hora e mostra o motivo.',
  },
  {
    id: 'qrcode', icon: 'qr', title: 'Conectar pelo QR Code (API não oficial)', module: 'Conexões', route: '/connections', minutes: 2,
    steps: [
      'Em **Conexões**, clique em **Nova Conexão** e escolha **QR Code**. Leia o aviso: essa conexão não é autorizada pela Meta e o WhatsApp pode banir o número.',
      'Dê um nome, marque que entendeu os riscos e clique em **Gerar QR Code**.',
      'No celular, abra o WhatsApp (ou WhatsApp Business) › **Aparelhos conectados** › **Conectar um aparelho** e aponte a câmera para o QR. Sem câmera? Use **Conectar com um código** e digite o código no celular.',
      'Pronto: chats, fluxos, agentes e disparos funcionam por esse número. Botões e listas chegam como opções numeradas (o cliente responde 1, 2, 3…) e não existe a janela de 24h nem modelos da Meta.',
    ],
    tip: 'Disparos pelo QR Code saem devagar de propósito (intervalo aleatório e limite por dia) para diminuir o risco de banimento. Desligue a mensagem de saudação/ausência do WhatsApp Business no celular — o que o celular manda sozinho pausa a automação da conversa.',
  },
  {
    id: 'fluxo', icon: 'flow', title: 'Criar seu primeiro fluxo', module: 'Fluxos', route: '/flows', minutes: 5,
    steps: [
      'Em **Fluxos**, clique em **Novo fluxo** — ou em **Criar com IA** e descreva o que o fluxo deve fazer.',
      'Clique duas vezes no bloco **Início** e escolha quando o fluxo começa: qualquer mensagem, palavra-chave ou primeira mensagem do contato.',
      'Com o Início selecionado, clique nos blocos da barra **Ferramentas** (ou busque: “pix”, “menu”, “IA”…): cada bloco novo já sai conectado no anterior e abre o editor.',
      'No editor, preencha o bloco e clique em **Salvar** (para editar de novo, clique duas vezes no bloco). Use o botão {} para inserir variáveis como {{primeiro_nome}}.',
      'Teste em **Simular** e, quando estiver tudo certo, clique em **Ativar**.',
    ],
    tip: 'O botão **Problemas** mostra blocos sem texto, sem link ou soltos antes de você ativar.',
  },
  {
    id: 'simular', icon: 'play', title: 'Testar um fluxo sem enviar nada', module: 'Fluxos', route: '/flows', minutes: 2,
    steps: [
      'Abra o fluxo e clique em **Simular**.',
      'Clique em **Iniciar** ou escreva uma mensagem como se fosse o cliente.',
      'Responda às perguntas e toque nas opções dos menus, carrosséis e templates — o bloco em execução fica destacado no canvas. Em esperas com prazo, **Simular “sem resposta”** testa o caminho de quem não respondeu.',
      'Nos pagamentos, use **Aprovado** ou **Não pagou** para testar os dois caminhos.',
    ],
    tip: 'Na simulação nada vai para o WhatsApp. Só os blocos de IA consomem tokens.',
  },
  {
    id: 'chats', icon: 'chats', title: 'Atender no Chats ao vivo', module: 'Chats ao vivo', route: '/inbox', minutes: 2,
    steps: [
      'Abra **Chats ao vivo**: em **Aguardando** ficam as conversas novas, em **Atendendo** as que alguém assumiu e em **Resolvidos** as finalizadas.',
      'Clique na conversa e em **Atender**: ela passa a ser sua, a automação pausa e o cliente recebe as suas respostas no WhatsApp.',
      'Digite **#** (ou **/**) para usar respostas rápidas — com anexos, elas mandam tudo de uma vez —, use o clipe para anexar, o microfone para mandar áudio e **Nota interna** para recados que o cliente não vê.',
      'Passou de 24h sem o cliente escrever? O WhatsApp só aceita **modelo de mensagem aprovado**: clique em **Enviar modelo**.',
      'Terminou? Clique em **Resolver**. Se o cliente escrever de novo, a conversa volta sozinha para **Aguardando**.',
    ],
    tip: 'No painel da direita você muda etapa, valor, etiquetas e anotações do contato, liga/desliga a automação e para fluxos em andamento.',
  },
  {
    id: 'agente', icon: 'bot', title: 'Criar um agente de IA', module: 'Agentes de IA', route: '/agents', minutes: 4,
    steps: [
      'Em **Agentes de IA**, comece por **Modelos** (vendas, suporte ou recuperação), por **Criar com IA** (a IA lê um fluxo, as conversas de uma etiqueta ou o seu site) ou por **Novo agente**.',
      'No editor, preencha **O que ele sabe**: produtos, preços, formas de pagamento, prazos e garantia. Ele nunca inventa o que não está ali.',
      'Em **Ações**, escolha o fluxo de checkout: quando a pessoa topar comprar, o agente dispara o fluxo, que manda o link ou o Pix. Diga também quando ele deve **passar para a equipe**.',
      'Use **Testar** à direita para conversar com ele como se fosse um cliente — nada vai para o WhatsApp.',
      'Ligue **Ativo** e salve. Ele responde as mensagens que nenhum fluxo tratou e para quando alguém da equipe assume a conversa.',
      'Na aba **Vozes**, grave ou anexe de 1 a 3 áudios para criar uma voz. Aceita a voz, o agente pode responder em mensagem de voz.',
    ],
    tip: 'Cada resposta desconta tokens de IA (áudio também) — o saldo aparece no rodapé da barra lateral e você compra mais em Cobranças e assinaturas. Cada instância contratada libera 2 agentes.',
  },
  {
    id: 'webhooks', icon: 'webhook', title: 'Receber vendas da Hotmart, Kiwify e outras', module: 'Webhooks de entrada', route: '/webhooks', minutes: 3,
    steps: [
      'Em **Webhooks de entrada**, clique em **Novo webhook**, dê um nome (ex.: Hotmart Vendas), escolha a **conexão** e clique em **Salvar e continuar**.',
      'Copie a **URL do webhook** e cole na plataforma (Hotmart, Kiwify, Eduzz, N8N, Make, formulário do site…). Mande um teste por lá: o evento aparece na hora.',
      'Confira o **Mapeamento** (o Converza já acha telefone, nome, e-mail e venda sozinho) e, se quiser, uma **condição** — ex.: só compras aprovadas.',
      'Escolha as **ações**: etiquetas, Kanban, registrar a venda, mandar um **modelo de mensagem** e disparar um **fluxo**. Use **Simular** para ver o que vai acontecer antes.',
    ],
    tip: 'Para lead que nunca falou com você, mande um modelo de mensagem: o fluxo começa sozinho quando ele responder. Venda aprovada também libera quem está no bloco **Pagamento** de um fluxo.',
  },
  {
    id: 'disparos', icon: 'send', title: 'Enviar um disparo em massa', module: 'Disparos em massa', route: '/dispatch', minutes: 3,
    steps: [
      'Antes, crie e **ative** o fluxo que vai ser enviado (em **Fluxos**). Ele começa no primeiro bloco depois do gatilho; use **{{disparo}}** para citar o nome do disparo.',
      'Em **Disparos em massa**, clique em **Novo disparo em massa**, dê um nome e escolha a **conexão** e o **fluxo**.',
      'Em **Quem recebe**, use os mesmos filtros de Contatos (status, origem, etiquetas, Kanban…). A prévia mostra quantos recebem o fluxo na hora e quantos precisam de um modelo de mensagem.',
      'Escolha um **modelo aprovado** para quem não falou com você nas últimas 24h e preencha as variáveis com os dados do contato (ex.: {{primeiro_nome}}).',
      'Defina **quando** (agora ou agendado) e a **velocidade**, confira o resumo e clique em **Criar disparo**. Acompanhe ao vivo e pause, continue ou cancele quando quiser.',
    ],
    tip: 'Cada contato que recebe de verdade usa 1 disparo da cota do ciclo; quando acaba, o disparo pausa e continua depois. A Meta cobra cada modelo enviado direto na sua conta do WhatsApp Business. Quem responder SAIR não recebe mais disparos.',
  },
  {
    id: 'contatos', icon: 'users', title: 'Organizar e importar contatos', module: 'Contatos', route: '/contacts', minutes: 3,
    steps: [
      'Em **Contatos** você vê todos os clientes: quem chegou pelo WhatsApp, por anúncio, por integração, importado ou cadastrado à mão. No topo: total, **ativos** (conversaram nos últimos 30 dias) e **leads** (ainda sem compra aprovada).',
      'Clique em **Novo Contato**: primeiro busque pelo nome, telefone ou e-mail para não duplicar; se não existir, use **Criar novo contato**.',
      'Para trazer uma lista, vá em **Importar CSV**, baixe a **planilha modelo**, preencha e envie. Contatos que já existem (mesmo telefone) são atualizados e as etiquetas, somadas.',
      'Em **Configurações › Campos personalizados** crie campos como CPF, Plano ou Data de nascimento. Eles aparecem na ficha, no Chats ao vivo, na importação e nos fluxos como **{{campos.cpf}}**.',
      'Use **Filtros** (datas, campo, etiquetas, etapas do Kanban) e marque os contatos para etiquetar, colocar no Kanban, mudar a etapa ou **Exportar CSV**. As 3 últimas exportações ficam em **Recentes**.',
    ],
    tip: 'No Excel, deixe a coluna telefone como Texto: número grande vira notação científica (5,5E+12) e perde dígitos. A importação avisa quando isso acontece.',
  },
  {
    id: 'kanban', icon: 'kanban', title: 'Organizar vendas no Kanban', module: 'Kanban', route: '/kanban', minutes: 2,
    steps: [
      'Em **Kanban**, clique em **Novo Kanban** e dê um nome: o quadro já vem com as colunas Novo, Qualificação e Ganho.',
      'Use **Adicionar card** numa coluna para colocar um contato salvo, um contato novo ou só um título, com valor, responsável e prazo.',
      'Arraste os cards entre as colunas (e as colunas pelo cabeçalho). No menu da coluna você muda nome, cor e tipo: **Ganho** conta como conversão, **Perdido** sai do valor do pipeline.',
      'No Chats ao vivo, o painel do contato mostra em que quadro ele está e deixa mudar a coluna sem sair da conversa.',
      'Nos fluxos, o bloco **Kanban** adiciona, move ou tira o contato de um quadro sozinho.',
    ],
    tip: 'Clique no ícone de conversa do card para abrir o chat do contato. O número no ícone são as mensagens não lidas.',
  },
  {
    id: 'facebook', icon: 'megaphone', title: 'Ver seus anúncios e mandar conversões para a Meta', module: 'Facebook', route: '/meta', minutes: 4,
    steps: [
      'Em **Facebook › Perfis e contas**, clique em **Conectar novo perfil** e entre com o Facebook que gerencia os anúncios. Para outro perfil, repita e entre com o outro usuário quando a Meta pedir a senha.',
      'Ligue as **contas de anúncios** que entram no painel. Nada liga sozinho: só as contas ligadas aparecem no Gerenciador e no gasto do Dashboard (o Converza puxa os últimos 90 dias e atualiza a cada hora).',
      'No **Gerenciador**, veja campanhas, conjuntos e anúncios com investimento, cliques, conversas e — do lado do Converza — os leads que chegaram por cada anúncio de clique para o WhatsApp, as vendas aprovadas deles e o **ROAS real**.',
      'Em **Pixel**, clique em **Novo Pixel**, escolha a plataforma (Meta, Meta pelo WhatsApp ou TikTok), cole o **ID** e o **Access Token** do Gerenciador de Eventos e clique em **Criar**.',
      'No pixel, escolha os **Eventos**: lead novo (só de anúncio, do WhatsApp ou de tudo), venda aprovada (vai com o valor) e etapa do Kanban. Use **Testar** com o código de teste e acompanhe tudo em **Histórico**.',
    ],
    tip: 'Para a Meta otimizar campanhas de clique para o WhatsApp por vendas, use o pixel do tipo “Meta — WhatsApp”: ele manda a compra com o identificador do clique (ctwa_clid). O login do perfil vale cerca de 60 dias — o Converza avisa quando precisar reconectar.',
  },
  {
    id: 'cobranca', icon: 'card', title: 'Assinar, mudar instâncias e comprar tokens', module: 'Cobranças e assinaturas', route: '/billing', minutes: 3,
    steps: [
      'Em **Cobranças e assinaturas**, clique em **Assinar agora**, escolha quantas **instâncias** quer (cada uma é um número de WhatsApp, com 2 agentes de IA, 1.000 disparos por ciclo e 10.000 eventos de webhook por mês).',
      'Escolha **Brasil** (Pix ou cartão, pela Asaas — informe o CPF ou CNPJ) ou **Exterior** (Paddle) e clique em **Ir para o pagamento**. Pague na página segura que abre: a tela do Converza atualiza sozinha quando o pagamento cai.',
      'Para ter mais números, use **Alterar instâncias**: você paga só o proporcional até o próximo vencimento. Para ter menos, a mudança vale a partir do próximo vencimento.',
      'Tokens de IA são uma compra à parte: **Adicionar tokens**, arraste a barra ou digite a quantidade (1.000 tokens = R$ 1,00) e pague. Eles não vencem e valem para a conta inteira.',
      'Em **Ver todas** ficam as faturas (com filtros e o link para pagar ou ver o comprovante) e em **Reembolsos**, o que foi devolvido.',
    ],
    tip: 'Se a mensalidade atrasar, há 3 dias de tolerância. Depois disso os números param de enviar mensagens (as recebidas continuam chegando) até a fatura ser paga — pagou, volta na hora. Cancelar não corta nada antes do fim do período já pago.',
  },
  {
    id: 'equipe', icon: 'users', title: 'Montar a equipe e os setores', module: 'Configurações', route: '/settings/equipe', minutes: 3,
    steps: [
      'Em **Configurações › Equipe**, clique em **Convidar membro**, digite o e-mail e escolha **Membro** (atende) ou **Administrador** (configura). A pessoa recebe o convite por e-mail e entra quando aceitar.',
      'Quem ainda não tem conta no Converza recebe primeiro um convite para criar a conta (**Convites para Plataforma**). Depois é só convidar para a equipe.',
      'Em **Configurações › Empresa › Departamentos**, crie os setores (Comercial, Suporte…) com uma cor e marque quem faz parte de cada um.',
      'No Chats ao vivo, **Transferir › Para um setor** manda a conversa para a fila do setor: ela fica em **Aguardando** só para quem é do setor, e quem pegar primeiro atende. O bloco **Departamento** dos fluxos e os agentes de IA também podem mandar para um setor.',
    ],
    tip: 'O proprietário e os administradores sempre veem todas as filas. Para tirar alguém da equipe, use os três pontinhos na linha da pessoa.',
  },
  {
    id: 'horarios', icon: 'clock', title: 'Horário de atendimento e mensagens automáticas', module: 'Configurações', route: '/settings/empresa', minutes: 3,
    steps: [
      'Em **Configurações › Empresa › Horários de Trabalho**, escolha o número, ligue o **Status** e marque os dias e horários (até 3 intervalos por dia, ex.: 09:00–12:00 e 13:00–18:00). Salve.',
      'Crie em **Fluxos** as mensagens: boas-vindas, "estamos fechados" e uma resposta padrão para quando ninguém entendeu.',
      'Em **Configurações › Fluxos Padrões**, escolha para cada número o fluxo de **Boas-vindas** (primeira mensagem de um contato novo), **Fora do horário** e **Resposta padrão**.',
    ],
    tip: 'Fora do horário, o aviso vai no máximo uma vez a cada 12 horas para cada contato. Fluxos com palavra-chave continuam valendo antes de tudo.',
  },
  {
    id: 'respostas', icon: 'bolt', title: 'Respostas rápidas com anexos', module: 'Configurações', route: '/settings/respostas-rapidas', minutes: 2,
    steps: [
      'Em **Configurações › Respostas Rápidas**, clique em **Nova resposta** e dê um atalho (ex.: **#catalogo**).',
      'Adicione as ações na ordem em que devem chegar: texto (com {{primeiro_nome}}, {{saudacao}}…), imagem, vídeo, áudio, documento ou figurinha.',
      'No Chats ao vivo, digite **#cat** e aperte Enter. Só texto vira rascunho para você ajustar; com anexos, tudo é enviado na hora.',
    ],
    tip: 'Cada empresa tem até 200 MB de anexos. O WhatsApp aceita imagens até 5 MB e vídeos, áudios e documentos até 16 MB.',
  },
  {
    id: 'trackeamento', icon: 'target', title: 'Saber de onde vem cada cliente', module: 'Configurações', route: '/settings/trackeamento', minutes: 3,
    steps: [
      'Em **Configurações › Trackeamento**, crie um **link rastreável** para cada lugar onde você divulga (bio do Instagram, Google, panfleto…), com a mensagem que o cliente vai mandar e as etiquetas.',
      'Use o link curto no lugar do seu wa.me: ele conta o clique e abre o WhatsApp com a mensagem pronta e um código no final.',
      'Quando o cliente manda a mensagem, o contato fica marcado com o link e ganha as etiquetas. Na tabela aparecem os cliques, os contatos e as vendas de cada link.',
    ],
    tip: 'Se a pessoa apagar o código antes de enviar, a origem não é marcada. Robôs que geram prévia do link (WhatsApp, Facebook) não contam como clique.',
  },
  {
    id: 'variaveis', icon: 'braces', title: 'Variáveis globais nos fluxos', module: 'Configurações', route: '/settings/variaveis', minutes: 2,
    steps: [
      'Em **Configurações › Variáveis Globais**, crie uma variável (ex.: **g_cupom** com o cupom do mês, ou **g_vagas** do tipo número).',
      'Use nos textos de qualquer fluxo como {{g_cupom}}. Mudou o valor aqui, muda em todos os fluxos na hora.',
      'No bloco **Ação**, o fluxo pode definir, somar ou subtrair (ex.: tirar 1 vaga a cada inscrição). No bloco **Condição**, compare o valor (ex.: vagas menor que 1 → "esgotado").',
    ],
  },
  {
    id: 'mcp', icon: 'key', title: 'Conectar um assistente de IA (MCP)', module: 'Configurações', route: '/settings/mcp', minutes: 3,
    steps: [
      'Em **Configurações › Ferramentas MCP**, clique em **Nova chave**, dê um nome e marque o que o assistente pode fazer (só consultar, ou também mandar mensagens, etiquetar e iniciar fluxos).',
      'Copie a chave na hora: ela aparece só uma vez. A própria tela mostra como colar no Claude Code, Cursor, Claude Desktop, n8n ou em clientes que pedem só a URL.',
      'Pronto: o assistente consulta contatos, conversas, vendas e produtos e age dentro das regras do WhatsApp. As chamadas aparecem em **Últimas chamadas**; para cortar o acesso, revogue a chave.',
    ],
    tip: 'Crie uma chave para cada assistente ou automação — assim dá para revogar um sem mexer nos outros.',
  },
];

/** "texto **negrito** texto" → JSX */
function rich(s: string): ReactNode[] {
  return s.split('**').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

export function Tutorials() {
  const nav = useNavigate();
  const [open, setOpen] = useState<string | null>(TUTORIALS[0].id);

  return (
    <div className="fade grid" style={{ maxWidth: 900, gap: 12 }}>
      {TUTORIALS.map((t) => {
        const isOpen = open === t.id;
        return (
          <div key={t.id} className="card" style={{ overflow: 'hidden' }}>
            <button type="button" onClick={() => setOpen(isOpen ? null : t.id)} aria-expanded={isOpen}
              style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '14px 16px', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'var(--text)', fontFamily: 'inherit' }}>
              <span style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--primary-50)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                <Icon name={t.icon} size={20} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 14.5 }}>{t.title}</b>
                <span className="faint" style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{t.module} · {t.minutes} min</span>
              </span>
              <span className={cx('faint')} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s', display: 'flex' }}>
                <Icon name="chevron" size={18} />
              </span>
            </button>
            {isOpen && (
              <div className="fade" style={{ padding: '0 16px 16px 70px' }}>
                <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, fontSize: 13.5, lineHeight: 1.55 }}>
                  {t.steps.map((s, i) => <li key={i}>{rich(s)}</li>)}
                </ol>
                {t.tip && <div className="note" style={{ marginTop: 12 }}><Icon name="bolt" size={15} /><span>{rich(t.tip)}</span></div>}
                <button type="button" className="btn sm primary" style={{ marginTop: 14 }} onClick={() => nav(t.route)}>
                  Abrir {t.module}<Icon name="arrowRight" size={14} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
