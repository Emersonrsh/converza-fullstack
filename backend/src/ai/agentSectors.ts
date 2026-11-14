/**
 * Modelos da criação por etapas: o setor da empresa e a função do agente preenchem
 * objetivo, instruções, etapas da conversa e automações sugeridas. Tudo editável depois.
 */
import type { AgentAutomation, AgentRole, AgentStage } from './agentBrain';

type Kind = 'sales' | 'schedule' | 'support' | 'retention' | 'faq' | 'recovery';

export interface SectorFunction {
  id: string;
  name: string;
  description: string;
  idealFor: string;
  popular?: boolean;
  role: AgentRole;
  systemPrompt: string;
  stages: AgentStage[];
  automations: AgentAutomation[];
  handoffWhen: string;
}

export interface Sector { id: string; name: string; functions: SectorFunction[] }

const ROLE: Record<Kind, AgentRole> = { sales: 'sales', schedule: 'sales', support: 'support', retention: 'recovery', faq: 'support', recovery: 'recovery' };

const STAGES: Record<Kind, (noun: string) => AgentStage[]> = {
  sales: (n) => [
    { name: 'Boas-vindas', goal: 'Cumprimente, apresente-se e pergunte como pode ajudar.', advanceWhen: 'a pessoa disser o que procura' },
    { name: 'Entender a necessidade', goal: `Descubra o que a pessoa quer resolver e o que é importante para ela na escolha de ${n}. Uma pergunta por vez.`, advanceWhen: 'você entender o objetivo dela' },
    { name: 'Apresentar a solução', goal: `Indique a opção de ${n} que combina com o que ela contou, pelos benefícios, usando só o que você sabe.` },
    { name: 'Tirar as dúvidas', goal: 'Responda objeções de preço, prazo e confiança com calma e com fatos, sem pressionar.' },
    { name: 'Fechamento', goal: 'Quando a pessoa decidir, conduza para o próximo passo (pagamento, reserva ou equipe).' },
  ],
  schedule: (n) => [
    { name: 'Boas-vindas', goal: 'Cumprimente e pergunte o que a pessoa procura.' },
    { name: 'Entender o que precisa', goal: `Descubra qual ${n} interessa e se é a primeira vez.`, advanceWhen: 'souber o que ela quer' },
    { name: 'Explicar como funciona', goal: 'Tire as dúvidas sobre valores, duração e preparo com base no que você sabe.' },
    { name: 'Coletar os dados', goal: 'Peça o nome completo e a preferência de dia e horário.', advanceWhen: 'tiver nome e preferência de horário' },
    { name: 'Confirmar o agendamento', goal: 'Resuma o pedido e encaminhe para confirmar o horário.' },
  ],
  support: () => [
    { name: 'Acolher', goal: 'Cumprimente e peça para a pessoa contar o que aconteceu.' },
    { name: 'Identificar o caso', goal: 'Peça o número do pedido, e-mail ou nome usado na compra, se precisar.', advanceWhen: 'entender o problema' },
    { name: 'Resolver', goal: 'Explique a solução passo a passo com base no que você sabe.' },
    { name: 'Confirmar', goal: 'Pergunte se ficou resolvido antes de encerrar.' },
  ],
  retention: (n) => [
    { name: 'Retomar o contato', goal: 'Cumprimente pelo nome e mostre que sentiram falta da pessoa, sem cobrança.' },
    { name: 'Entender o motivo', goal: `Pergunte, com leveza, o que fez a pessoa se afastar de ${n}.`, advanceWhen: 'souber o motivo' },
    { name: 'Mostrar o que mudou', goal: 'Conte novidades e benefícios que respondem ao motivo, só com o que você sabe.' },
    { name: 'Convite para voltar', goal: 'Faça um convite simples para o próximo passo.' },
  ],
  faq: () => [
    { name: 'Saudação', goal: 'Cumprimente e pergunte qual é a dúvida.' },
    { name: 'Responder', goal: 'Responda de forma direta usando só o que você sabe.' },
    { name: 'Oferecer mais ajuda', goal: 'Pergunte se ficou mais alguma dúvida.' },
  ],
  recovery: () => [
    { name: 'Retomar', goal: 'Pergunte com naturalidade se ficou alguma dúvida sobre a compra.' },
    { name: 'Descobrir o que travou', goal: 'Preço, forma de pagamento, confiança ou momento: uma pergunta simples.', advanceWhen: 'souber o que travou' },
    { name: 'Ajudar a decidir', goal: 'Responda à dúvida com o que você sabe, sem inventar desconto.' },
    { name: 'Concluir', goal: 'Se a pessoa quiser, conduza para o pagamento; se não, agradeça e encerre.' },
  ],
};

const PROMPT: Record<Kind, string> = {
  sales: 'Atenda com interesse genuíno: entenda antes de oferecer, uma pergunta por mensagem, e leve a pessoa ao próximo passo sem pressionar.',
  schedule: 'Seu objetivo é transformar interesse em agendamento: tire as dúvidas e colete nome e preferência de horário. Não confirme horário que você não conhece: a equipe confirma.',
  support: 'Resolva com paciência e clareza. Casos fora do padrão (reembolso, defeito, cobrança errada, reclamação) vão para a equipe.',
  retention: 'Converse com quem se afastou com leveza e sem cobrança. Se a pessoa disser que não quer, agradeça e encerre com educação.',
  faq: 'Responda dúvidas de forma curta e precisa, usando somente o que você sabe. Se não souber, diga que vai confirmar com a equipe.',
  recovery: 'Retome com quem não concluiu a compra: descubra o que travou e ajude a decidir, sem pressão e sem inventar condição especial.',
};

const HANDOFF: Record<Kind, string> = {
  sales: 'quando a pessoa pedir para falar com alguém, estiver irritada, ou perguntar algo que você não sabe responder com segurança',
  schedule: 'quando a pessoa já tiver passado nome e preferência de horário, pedir para falar com alguém, ou perguntar algo que você não sabe',
  support: 'quando o caso envolver reembolso, cancelamento, defeito, cobrança errada ou reclamação, ou quando a pessoa pedir para falar com alguém',
  retention: 'quando a pessoa quiser voltar e precisar de ajuda para isso, pedir para falar com alguém ou reclamar',
  faq: 'quando a pessoa pedir para falar com alguém ou fizer uma pergunta que você não sabe responder',
  recovery: 'quando a pessoa pedir para falar com alguém, reclamar ou tiver um problema com o pagamento',
};

const INTENTS: Record<Kind, AgentAutomation[]> = {
  sales: [{ key: 'auto_buy', trigger: 'intent', when: 'a pessoa decidir comprar, pedir o link ou perguntar como pagar', action: 'flow', flowId: null }],
  schedule: [{ key: 'auto_sched', trigger: 'intent', when: 'a pessoa quiser marcar um horário', action: 'tag', tag: 'quer agendar' }],
  support: [{ key: 'auto_refund', trigger: 'intent', when: 'a pessoa pedir reembolso ou cancelamento', action: 'tag', tag: 'reembolso' }],
  retention: [{ key: 'auto_back', trigger: 'intent', when: 'a pessoa disser que quer voltar', action: 'tag', tag: 'quer voltar' }],
  faq: [],
  recovery: [{ key: 'auto_pay', trigger: 'intent', when: 'a pessoa quiser concluir a compra ou pedir a forma de pagamento', action: 'flow', flowId: null }],
};

function fn(kind: Kind, id: string, name: string, description: string, idealFor: string, noun: string, popular = false): SectorFunction {
  return {
    id, name, description, idealFor, popular, role: ROLE[kind], systemPrompt: PROMPT[kind], stages: STAGES[kind](noun),
    automations: structuredClone(INTENTS[kind]), handoffWhen: HANDOFF[kind],
  };
}

export const SECTORS: Sector[] = [
  { id: 'infoproduto', name: 'Infoprodutos e cursos online', functions: [
    fn('sales', 'info-vendas', 'Vendas do produto', 'Atende quem veio do anúncio, mostra o conteúdo e leva ao checkout', 'Lançamentos, perpétuos e low ticket', 'o produto', true),
    fn('recovery', 'info-recuperacao', 'Recuperação de carrinho', 'Retoma quem gerou boleto ou Pix e não pagou', 'Quem tem muito boleto e Pix pendente', 'o produto'),
    fn('support', 'info-suporte', 'Suporte ao aluno', 'Ajuda com acesso à área de membros, certificados e garantia', 'Cursos com muitos alunos', 'o curso'),
  ] },
  { id: 'loja', name: 'Loja virtual e varejo', functions: [
    fn('sales', 'loja-vendas', 'Vendedor da loja', 'Ajuda a escolher produto, tamanho e forma de pagamento', 'Lojas com catálogo variado', 'o produto', true),
    fn('support', 'loja-pos', 'Pós-venda e entregas', 'Responde sobre rastreio, trocas e devoluções', 'Lojas com muitos pedidos', 'o pedido'),
    fn('recovery', 'loja-carrinho', 'Carrinho abandonado', 'Conversa com quem parou na finalização da compra', 'Lojas com tráfego pago', 'o pedido'),
  ] },
  { id: 'saude', name: 'Clínica e saúde', functions: [
    fn('schedule', 'saude-agenda', 'Agendamento de consultas', 'Tira dúvidas sobre especialidades e coleta dados para agendar', 'Clínicas, consultórios e laboratórios', 'a consulta ou exame', true),
    fn('faq', 'saude-faq', 'Dúvidas e informações', 'Responde convênios, endereço, preparo de exames e horários', 'Clínicas com alto volume de mensagens', 'o atendimento'),
    fn('retention', 'saude-retorno', 'Retorno de pacientes', 'Lembra quem precisa voltar e incentiva o retorno', 'Tratamentos contínuos e check-ups', 'o acompanhamento'),
  ] },
  { id: 'beleza', name: 'Estética e beleza', functions: [
    fn('schedule', 'beleza-agenda', 'Agendamento de procedimentos', 'Apresenta procedimentos, valores e coleta horário', 'Salões, estúdios e clínicas de estética', 'o procedimento', true),
    fn('sales', 'beleza-pacotes', 'Venda de pacotes', 'Indica pacotes e planos de acordo com o objetivo da cliente', 'Quem vende pacotes de sessões', 'o pacote'),
    fn('retention', 'beleza-retorno', 'Retorno de clientes', 'Chama de volta quem não agenda há algum tempo', 'Serviços recorrentes', 'os cuidados'),
  ] },
  { id: 'academia', name: 'Academia e esporte', functions: [
    fn('sales', 'academia-captacao', 'Captação de alunos', 'Apresenta planos e modalidades e agenda aula experimental', 'Academias, studios e escolas de esporte', 'o plano', true),
    fn('retention', 'academia-retencao', 'Retenção de alunos', 'Conversa com alunos sumidos e incentiva a volta aos treinos', 'Academias com muitos cancelamentos', 'os treinos'),
    fn('faq', 'academia-faq', 'Dúvidas e informações', 'Responde horários, modalidades, endereço e regras', 'Academias com muitas perguntas repetidas', 'a academia'),
  ] },
  { id: 'restaurante', name: 'Restaurante e delivery', functions: [
    fn('sales', 'rest-pedidos', 'Pedidos e cardápio', 'Apresenta o cardápio, sugere combos e encaminha o pedido', 'Delivery e pedidos pelo WhatsApp', 'o pedido', true),
    fn('schedule', 'rest-reservas', 'Reservas', 'Tira dúvidas e coleta dados para reservar mesa', 'Restaurantes com reserva', 'a reserva'),
    fn('faq', 'rest-faq', 'Dúvidas e informações', 'Horário, área de entrega, formas de pagamento e taxas', 'Quem recebe muitas perguntas', 'o restaurante'),
  ] },
  { id: 'imoveis', name: 'Imobiliária e construtora', functions: [
    fn('sales', 'imoveis-leads', 'Atendimento de leads', 'Entende o perfil do comprador e apresenta os imóveis', 'Imobiliárias e lançamentos', 'o imóvel', true),
    fn('schedule', 'imoveis-visitas', 'Agendamento de visitas', 'Coleta dados e preferência para visitar o imóvel', 'Corretores com muitos interessados', 'a visita'),
    fn('faq', 'imoveis-faq', 'Dúvidas do empreendimento', 'Responde metragem, valores, financiamento e documentação', 'Lançamentos com muitas perguntas', 'o empreendimento'),
  ] },
  { id: 'servicos', name: 'Serviços e consultoria', functions: [
    fn('sales', 'serv-vendas', 'Qualificação e proposta', 'Entende a necessidade e encaminha para orçamento', 'Agências, consultorias e prestadores', 'o serviço', true),
    fn('schedule', 'serv-agenda', 'Agendamento de reunião', 'Coleta dados e horário para uma conversa com a equipe', 'Quem vende por reunião', 'a reunião'),
    fn('support', 'serv-suporte', 'Suporte ao cliente', 'Atende dúvidas de quem já é cliente', 'Serviços recorrentes', 'o serviço'),
  ] },
  { id: 'educacao', name: 'Escola e educação', functions: [
    fn('sales', 'edu-matriculas', 'Matrículas', 'Apresenta cursos, turmas e valores e leva à matrícula', 'Escolas, cursos livres e faculdades', 'o curso', true),
    fn('faq', 'edu-faq', 'Secretaria e dúvidas', 'Responde calendário, documentos e mensalidades', 'Instituições com secretaria lotada', 'a escola'),
    fn('retention', 'edu-rematricula', 'Rematrícula', 'Conversa com alunos para renovar a matrícula', 'Cursos com renovação periódica', 'os estudos'),
  ] },
  { id: 'outro', name: 'Outro setor', functions: [
    fn('sales', 'outro-vendas', 'Vendas', 'Tira dúvidas e leva o cliente ao próximo passo', 'Qualquer negócio que vende pelo WhatsApp', 'o produto ou serviço', true),
    fn('support', 'outro-suporte', 'Suporte', 'Resolve dúvidas e problemas de quem já é cliente', 'Pós-venda', 'o pedido'),
    fn('faq', 'outro-faq', 'Dúvidas e informações', 'Responde perguntas frequentes com base no que você ensinar', 'Alto volume de perguntas repetidas', 'o negócio'),
  ] },
];
