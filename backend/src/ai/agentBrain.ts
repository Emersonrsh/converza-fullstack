/**
 * "Cérebro" do agente de IA, sem banco nem rede (testável sozinho): monta as instruções,
 * lê a resposta do modelo (mensagens + ação), escolhe qual agente atende e traz os modelos prontos.
 */
import { extractJson } from '../flows/aiTools';

export type AgentRole = 'sales' | 'support' | 'recovery' | 'custom';
export type ReplyAudio = 'never' | 'when_audio' | 'always';
export type AgentAction = 'flow' | 'handoff' | null;

export interface FaqItem { q: string; a: string }

/** O que o agente precisa saber para responder (vem da linha `agents` + nome do fluxo). */
export interface AgentPersona {
  name: string;
  role: string;
  tone: string;
  systemPrompt: string;
  knowledge: string;
  faq: FaqItem[];
  rules: string;
  flowName: string | null;
  flowWhen: string;
  handoffWhen: string;
}

export interface ContactFacts {
  name: string;
  tags: string[];
  /** campos personalizados já com o rótulo: { CPF: "123" } */
  fields: Record<string, string>;
  fromAd?: boolean;
}

export const ROLE_LABEL: Record<AgentRole, string> = {
  sales: 'Vendas', support: 'Suporte', recovery: 'Recuperação', custom: 'Personalizado',
};

const ROLE_GOAL: Record<AgentRole, string> = {
  sales: 'Atender quem tem interesse, tirar as dúvidas com base no que você sabe e levar a pessoa a comprar — sem pressionar.',
  support: 'Resolver dúvidas de pedidos, entregas, trocas e uso do produto com paciência e clareza.',
  recovery: 'Retomar a conversa com quem demonstrou interesse e não concluiu a compra: entender o que travou e ajudar a decidir, sem pressão e sem inventar desconto.',
  custom: 'Atender bem o cliente seguindo as instruções abaixo.',
};

export const DEFAULT_FLOW_WHEN = 'quando a pessoa disser que quer comprar, pedir o link, o Pix ou perguntar como pagar';
export const DEFAULT_HANDOFF_WHEN = 'quando a pessoa pedir para falar com alguém da equipe, estiver irritada, reclamar, ou perguntar algo que você não sabe responder com segurança';

const clean = (s: string | null | undefined) => String(s ?? '').trim();
const asRole = (r: string): AgentRole => (r in ROLE_GOAL ? (r as AgentRole) : 'custom');

/** Instruções completas (mensagem "system") do agente. */
export function buildAgentPrompt(a: AgentPersona, c: ContactFacts, opts: {
  company: string; now: Date; timeZone: string; speakAsAudio: boolean; customerSentAudio: boolean; channel?: 'whatsapp' | 'test';
}): string {
  const role = asRole(a.role);
  const parts: string[] = [];
  parts.push(`Você é ${clean(a.name) || 'o atendente'}, atendente da empresa ${clean(opts.company) || 'que você representa'} no WhatsApp. Fale sempre em português do Brasil, a não ser que o cliente escreva em outro idioma.`);
  parts.push(`OBJETIVO\n${ROLE_GOAL[role]}`);
  parts.push(`JEITO DE FALAR\n${clean(a.tone) || 'Simpático, humano e objetivo. Frases curtas, como numa conversa de WhatsApp. Uma pergunta por vez.'}`);
  if (clean(a.systemPrompt)) parts.push(`COMO ATENDER\n${clean(a.systemPrompt)}`);

  const knowledge = clean(a.knowledge);
  parts.push(`O QUE VOCÊ SABE (sua única fonte sobre produtos, preços, prazos e condições)\n${knowledge || '(nada foi informado ainda — não fale de preços, prazos ou condições; diga que vai confirmar com a equipe)'}`);
  const faq = (a.faq ?? []).filter((f) => clean(f.q) && clean(f.a));
  if (faq.length) parts.push(`PERGUNTAS FREQUENTES\n${faq.map((f) => `- P: ${clean(f.q)}\n  R: ${clean(f.a)}`).join('\n')}`);

  const rules = [
    'Nunca invente preço, prazo, desconto, link, endereço, telefone ou qualquer informação que não esteja acima.',
    'Se não souber a resposta, diga com naturalidade que vai confirmar com a equipe.',
    'Não diga que é uma inteligência artificial a menos que perguntem diretamente; se perguntarem, seja honesto.',
    'Nunca peça senha, número de cartão ou código de verificação.',
  ];
  if (clean(a.rules)) rules.push(...clean(a.rules).split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean));
  parts.push(`REGRAS (nunca quebre)\n${rules.map((r) => `- ${r}`).join('\n')}`);

  const actions: string[] = [];
  if (a.flowName) {
    actions.push(`- "fluxo": dispara o fluxo “${a.flowName}”, que cuida do pagamento/checkout. Use ${clean(a.flowWhen) || DEFAULT_FLOW_WHEN}. Não mande link de pagamento por conta própria: o fluxo envia. Junto com a ação, mande uma mensagem curta avisando que vai enviar.`);
  }
  actions.push(`- "humano": passa a conversa para a equipe e você para de responder. Use ${clean(a.handoffWhen) || DEFAULT_HANDOFF_WHEN}.`);
  parts.push(`AÇÕES QUE VOCÊ PODE TOMAR\n${actions.join('\n')}`);

  const facts: string[] = [`- Nome: ${clean(c.name) || 'não informado'}`];
  if (c.tags.length) facts.push(`- Etiquetas: ${c.tags.join(', ')}`);
  for (const [k, v] of Object.entries(c.fields ?? {})) if (clean(v)) facts.push(`- ${k}: ${clean(v)}`);
  if (c.fromAd) facts.push('- Chegou por um anúncio.');
  parts.push(`DADOS DO CLIENTE\n${facts.join('\n')}`);

  const when = opts.now.toLocaleString('pt-BR', { timeZone: opts.timeZone, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  parts.push(`AGORA\n${when}`);

  if (opts.customerSentAudio) parts.push('As mensagens do cliente que começam com [áudio] são transcrições de mensagens de voz.');
  if (opts.speakAsAudio) parts.push('SUAS MENSAGENS VÃO COMO ÁUDIO: escreva como quem fala — frases curtas e naturais, sem emojis, sem listas, sem *negrito* e sem links.');

  parts.push([
    'FORMATO DA RESPOSTA',
    'Responda SOMENTE com um JSON, sem nada antes ou depois:',
    '{"mensagens": ["primeira mensagem", "segunda (opcional)"], "acao": null, "motivo": ""}',
    '- "mensagens": de 1 a 3 mensagens curtas de WhatsApp (pode usar *negrito* e emojis com moderação). Só deixe vazio se a ação já disser tudo.',
    `- "acao": null${a.flowName ? ', "fluxo"' : ''} ou "humano".`,
    '- "motivo": em poucas palavras, por que escolheu a ação (a equipe vê isso).',
  ].join('\n'));
  return parts.join('\n\n');
}

export interface ParsedReply { messages: string[]; action: AgentAction; reason: string }

const ACTIONS: Record<string, AgentAction> = {
  fluxo: 'flow', flow: 'flow', checkout: 'flow', pagamento: 'flow',
  humano: 'handoff', human: 'handoff', handoff: 'handoff', equipe: 'handoff', transferir: 'handoff',
};

const tidy = (s: string) => s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);

/** Lê a resposta do modelo. Aceita o JSON combinado; se vier texto solto, usa o texto como mensagem. */
export function parseAgentReply(raw: string): ParsedReply {
  const text = String(raw ?? '').trim();
  let j: any = null;
  try { j = extractJson(text); } catch { j = null; }
  if (j && typeof j === 'object') {
    const m = j.mensagens ?? j.messages ?? j.resposta ?? j.reply ?? j.mensagem ?? j.message;
    const list = (Array.isArray(m) ? m : m == null ? [] : [m]).map((x) => tidy(String(x ?? ''))).filter(Boolean).slice(0, 3);
    const actKey = String(j.acao ?? j.ação ?? j.action ?? '').toLowerCase().trim();
    return { messages: list, action: ACTIONS[actKey] ?? null, reason: String(j.motivo ?? j.reason ?? '').trim().slice(0, 300) };
  }
  // JSON quebrado: tenta salvar as mensagens; nunca manda chaves/aspas de JSON para o cliente
  if (/"mensagens"\s*:/.test(text)) {
    const inside = text.slice(text.indexOf('"mensagens"'));
    const arr = /\[([\s\S]*?)\]/.exec(inside)?.[1] ?? '';
    const msgs = [...arr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => tidy(x[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'))).filter(Boolean).slice(0, 3);
    const act = /"acao"\s*:\s*"(\w+)"/.exec(text)?.[1]?.toLowerCase() ?? '';
    return { messages: msgs, action: ACTIONS[act] ?? null, reason: '' };
  }
  const plain = tidy(text.replace(/```[a-z]*\n?|```/gi, ''));
  return { messages: plain ? [plain] : [], action: null, reason: '' };
}

/* --------------------------------------------------- qual agente atende */

export interface AgentScope { id: string; enabled: boolean; connectionIds: string[]; audience: string; audienceTags: string[]; createdAt: Date | string }

/**
 * Agentes ativos que podem atender esta conversa, do mais específico para o mais geral:
 * por etiqueta > quem veio de anúncio > todos; empate: o mais antigo.
 */
export function eligibleAgents<T extends AgentScope>(agents: T[], ctx: { connectionId: string | null; tags: string[]; fromAd: boolean }): T[] {
  const tags = new Set(ctx.tags.map((t) => t.toLowerCase()));
  const rank = (a: T) => (a.audience === 'tags' ? 0 : a.audience === 'ads' ? 1 : 2);
  return agents
    .filter((a) => a.enabled)
    .filter((a) => !a.connectionIds?.length || (ctx.connectionId != null && a.connectionIds.includes(ctx.connectionId)))
    .filter((a) => (a.audience === 'tags' ? (a.audienceTags ?? []).some((t) => tags.has(t.toLowerCase())) : a.audience === 'ads' ? ctx.fromAd : true))
    .sort((x, y) => rank(x) - rank(y) || new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());
}

/** Responde em áudio? (o modo do agente + se o cliente mandou áudio por último) */
export function shouldSpeak(mode: string, customerSentAudio: boolean, voiceReady: boolean): boolean {
  if (!voiceReady) return false;
  return mode === 'always' || (mode === 'when_audio' && customerSentAudio);
}

/** Texto para virar fala: tira formatação do WhatsApp, emojis e links. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* --------------------------------------------------------- modelos prontos */

export interface AgentTemplate {
  id: string; name: string; role: AgentRole; avatar: string; description: string;
  tone: string; systemPrompt: string; rules: string; flowWhen: string; handoffWhen: string; handoffMessage: string;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'vendas', name: 'Bia', role: 'sales', avatar: 'teal',
    description: 'Atende quem chega pelo anúncio, tira as dúvidas e dispara o checkout quando a pessoa decide comprar.',
    tone: 'Simpática, animada na medida e direta. Frases curtas, uma pergunta por vez, emojis com moderação.',
    systemPrompt: [
      '1. Cumprimente pelo nome (se souber) e pergunte o que a pessoa procura.',
      '2. Entenda a necessidade antes de oferecer: faça no máximo uma pergunta por mensagem.',
      '3. Explique o produto pelos benefícios que importam para ela, usando só o que você sabe.',
      '4. Se houver objeção (preço, confiança, prazo), responda com calma e com fatos — sem pressionar.',
      '5. Quando a pessoa quiser comprar, use a ação "fluxo" para enviar o pagamento.',
    ].join('\n'),
    rules: 'Não ofereça desconto que não esteja no que você sabe.\nNão prometa prazo de entrega que não esteja informado.',
    flowWhen: DEFAULT_FLOW_WHEN,
    handoffWhen: DEFAULT_HANDOFF_WHEN,
    handoffMessage: 'Vou chamar alguém da equipe para te ajudar, só um instante! 🙂',
  },
  {
    id: 'suporte', name: 'Caio', role: 'support', avatar: 'indigo',
    description: 'Resolve pedidos, trocas e dúvidas de entrega. Chama a equipe quando o caso foge do padrão.',
    tone: 'Calmo, educado e claro. Explica passo a passo e confirma se ficou resolvido.',
    systemPrompt: [
      '1. Entenda o problema: peça o número do pedido ou o e-mail da compra, se precisar.',
      '2. Responda com base no que você sabe (políticas de troca, prazos, como usar o produto).',
      '3. Confirme se a dúvida foi resolvida antes de encerrar.',
      '4. Caso fora do padrão (defeito, reembolso, cobrança errada, reclamação): passe para a equipe com a ação "humano" explicando o motivo.',
    ].join('\n'),
    rules: 'Não aprove reembolso, troca ou cancelamento por conta própria: isso é com a equipe.',
    flowWhen: '',
    handoffWhen: 'quando o caso envolver reembolso, cancelamento, defeito, cobrança errada, reclamação, ou quando a pessoa pedir para falar com alguém',
    handoffMessage: 'Já passei seu caso para a equipe — em breve alguém continua com você por aqui. 🙏',
  },
  {
    id: 'recuperacao', name: 'Lia', role: 'recovery', avatar: 'amber',
    description: 'Retoma quem parou no carrinho com uma conversa leve: sem pressão e sem prometer desconto que não existe.',
    tone: 'Leve, gentil e sem pressa. Mostra que está ali para ajudar, não para cobrar.',
    systemPrompt: [
      '1. Retome com naturalidade: pergunte se ficou alguma dúvida sobre a compra.',
      '2. Descubra o que travou (preço, forma de pagamento, confiança, momento) com uma pergunta simples.',
      '3. Responda à dúvida com o que você sabe e, se a pessoa quiser concluir, use a ação "fluxo".',
      '4. Se a pessoa disser que não quer, agradeça e encerre com educação.',
    ].join('\n'),
    rules: 'Nunca invente desconto, cupom ou condição especial.\nNão insista depois que a pessoa disser que não quer.',
    flowWhen: 'quando a pessoa quiser concluir a compra, pedir o link ou a forma de pagamento',
    handoffWhen: DEFAULT_HANDOFF_WHEN,
    handoffMessage: 'Vou chamar alguém da equipe para te ajudar com isso, tá? 😊',
  },
];

/* ------------------------------------------------------- montar com IA */

export const BUILD_SYSTEM = `Você configura agentes de atendimento por WhatsApp para pequenas empresas brasileiras.
Com base no material recebido, escreva a configuração do agente em JSON, exatamente com estas chaves:
{"nome": "primeiro nome do atendente", "descricao": "uma frase sobre o que ele faz", "objetivo": "sales|support|recovery|custom",
 "jeito_de_falar": "...", "instrucoes": "passos de como atender, um por linha", "conhecimento": "fatos sobre produtos, preços, formas de pagamento, prazos, garantias e políticas — só o que estiver no material",
 "perguntas": [{"p": "pergunta comum", "r": "resposta"}], "regras": "o que ele nunca deve fazer, uma por linha",
 "quando_disparar_fluxo": "...", "quando_passar_humano": "...", "mensagem_ao_passar": "..."}
Use somente fatos presentes no material: não invente preços, links, prazos nem descontos. Escreva em português do Brasil.
Responda apenas com o JSON.`;

export interface BuiltAgent {
  name: string; description: string; role: AgentRole; tone: string; systemPrompt: string; knowledge: string;
  faq: FaqItem[]; rules: string; flowWhen: string; handoffWhen: string; handoffMessage: string;
}

const cap = (v: unknown, max: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);

export function parseBuiltAgent(raw: string): BuiltAgent {
  const j = extractJson(raw);
  const perguntas = Array.isArray(j.perguntas ?? j.faq) ? (j.perguntas ?? j.faq) : [];
  const role = String(j.objetivo ?? j.role ?? 'custom');
  return {
    name: cap(j.nome ?? j.name, 40) || 'Atendente',
    description: cap(j.descricao ?? j.description, 200),
    role: asRole(role),
    tone: cap(j.jeito_de_falar ?? j.tone, 600),
    systemPrompt: cap(j.instrucoes ?? j.instructions, 4000),
    knowledge: cap(j.conhecimento ?? j.knowledge, 12000),
    faq: perguntas.map((f: any) => ({ q: cap(f?.p ?? f?.q, 300), a: cap(f?.r ?? f?.a, 1000) })).filter((f: FaqItem) => f.q && f.a).slice(0, 30),
    rules: cap(j.regras ?? j.rules, 2000),
    flowWhen: cap(j.quando_disparar_fluxo, 400),
    handoffWhen: cap(j.quando_passar_humano, 400),
    handoffMessage: cap(j.mensagem_ao_passar, 400),
  };
}

/** Texto legível de uma página HTML (título, descrição e corpo), para a IA ler o site. */
export function htmlToText(html: string, max = 10_000): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const desc = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decode = (s: string) => s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  const lines = decode(body).split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l) => l.length > 1);
  const out = [decode(title).trim() && `Título: ${decode(title).trim()}`, decode(desc).trim() && `Descrição: ${decode(desc).trim()}`, lines.join('\n')]
    .filter(Boolean).join('\n');
  return out.slice(0, max);
}
