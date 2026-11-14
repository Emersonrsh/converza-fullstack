/**
 * "Cérebro" do agente de IA, sem banco nem rede (testável sozinho): monta as instruções,
 * lê a resposta do modelo (mensagens + ação), escolhe qual agente atende e traz os modelos prontos.
 */
import { extractJson } from '../flows/aiTools';

export type AgentRole = 'sales' | 'support' | 'recovery' | 'custom';
export type ReplyAudio = 'never' | 'when_audio' | 'always';
/** 'flow' | 'handoff' | 'finish' | 'auto_1'… (personalizadas) | null */
export type AgentAction = string | null;

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
  language?: string;
  identity?: string;
  pace?: string;
  formality?: string;
  emoji?: string;
  stages?: AgentStage[];
  /** ações que a IA pode escolher (das automações); sem isso usa o fluxo/humano antigos */
  actions?: PromptAction[];
  /** texto das bases de conhecimento ligadas */
  bases?: string;
}

export interface AgentStage { name: string; goal: string; advanceWhen?: string }
export interface PromptAction { code: string; text: string }

export type AutomationTrigger = 'invalid_media' | 'reply_limit' | 'finish' | 'handoff' | 'intent';
export type AutomationAction = 'handoff' | 'flow' | 'close' | 'reply' | 'tag';
export interface AgentAutomation {
  key: string; trigger: AutomationTrigger; when?: string; action: AutomationAction;
  flowId?: string | null; tag?: string | null; departmentId?: string | null; message?: string;
}

export const SYSTEM_TRIGGERS: AutomationTrigger[] = ['invalid_media', 'reply_limit', 'finish', 'handoff'];
export const MAX_CUSTOM_AUTOMATIONS = 10;

export const LANGUAGES: Record<string, string> = {
  'pt-BR': 'português do Brasil', 'pt-PT': 'português de Portugal', 'en-US': 'inglês', es: 'espanhol', fr: 'francês', it: 'italiano', de: 'alemão',
};

const PACE: Record<string, string> = {
  dynamic: 'Respostas bem curtas e rápidas: uma ideia por mensagem, como quem digita no celular.',
  natural: 'Ritmo de conversa humana: mensagens curtas, divididas em 1 ou 2 balões quando fizer sentido.',
  balanced: 'Equilíbrio entre objetividade e explicação: responda a dúvida completa, sem textos longos.',
  detailed: 'Explique com mais detalhes quando o assunto pedir, organizando em parágrafos curtos.',
  analytic: 'Respostas completas e estruturadas: compare opções, traga os pontos importantes em tópicos curtos.',
};
const FORMALITY: Record<string, string> = {
  formal: 'Tom formal: trate por "senhor(a)" ou "você" com cortesia, sem gírias.',
  professional: 'Tom profissional: direto e focado em resolver, educado e gentil.',
  casual: 'Tom casual: leve e próximo, como um bom atendente de loja.',
  relaxed: 'Tom descontraído: bem-humorado e informal, sem perder o respeito.',
};
const EMOJI: Record<string, string> = {
  none: 'Não use emojis.',
  discreet: 'Use emojis raramente (no máximo um a cada algumas mensagens).',
  natural: 'Use emojis com naturalidade, no máximo um por mensagem.',
  expressive: 'Use emojis com frequência para deixar a conversa animada (sem exagerar).',
};

/** Completa as automações: as 4 obrigatórias sempre existem; sem nada salvo, vem do jeito antigo (fluxo + passar para a equipe). */
export function resolveAutomations(a: {
  automations?: AgentAutomation[] | null; flowId?: string | null; flowWhen?: string; flowTag?: string | null;
  handoffMessage?: string; handoffTag?: string | null; handoffDepartmentId?: string | null;
}): AgentAutomation[] {
  const saved = Array.isArray(a.automations) ? a.automations : [];
  const legacy = !saved.length;
  const sys = (t: AutomationTrigger): AgentAutomation => {
    const found = saved.find((x) => x.trigger === t);
    if (found) return found;
    if (t === 'invalid_media') return { key: t, trigger: t, action: 'reply', message: 'Por aqui eu ainda não consigo ver vídeos, figurinhas ou GIFs. Pode me contar por escrito? 🙂' };
    if (t === 'reply_limit') return { key: t, trigger: t, action: 'handoff', departmentId: a.handoffDepartmentId ?? null, message: '' };
    if (t === 'finish') return { key: t, trigger: t, action: 'close', message: '' };
    return { key: t, trigger: t, action: 'handoff', message: a.handoffMessage ?? '', tag: a.handoffTag ?? null, departmentId: a.handoffDepartmentId ?? null };
  };
  const intents = legacy
    ? (a.flowId ? [{ key: 'auto_flow', trigger: 'intent' as const, when: clean(a.flowWhen) || DEFAULT_FLOW_WHEN, action: 'flow' as const, flowId: a.flowId, tag: a.flowTag ?? null }] : [])
    : saved.filter((x) => x.trigger === 'intent' && clean(x.when)).slice(0, MAX_CUSTOM_AUTOMATIONS);
  return [...SYSTEM_TRIGGERS.map(sys), ...intents];
}

/** O que dizer à IA sobre cada ação que ela pode escolher. flowNames: id → nome (só fluxos ativos). */
export function promptActions(list: AgentAutomation[], flowNames: Record<string, string>, handoffWhen: string): PromptAction[] {
  const effect = (x: AgentAutomation) => {
    if (x.action === 'flow') return x.flowId && flowNames[x.flowId] ? `dispara o fluxo “${flowNames[x.flowId]}” (não mande links de pagamento por conta própria: o fluxo envia; junto, mande uma mensagem curta avisando)` : null;
    if (x.action === 'handoff') return 'passa a conversa para a equipe e você para de responder';
    if (x.action === 'close') return 'encerra o atendimento';
    if (x.action === 'tag') return x.tag ? `marca o contato com a etiqueta “${x.tag}” e você continua a conversa normalmente` : null;
    return 'envia uma mensagem pronta da empresa';
  };
  const out: PromptAction[] = [];
  const h = list.find((x) => x.trigger === 'handoff');
  const he = h && effect(h);
  out.push({ code: 'humano', text: `use ${clean(handoffWhen) || DEFAULT_HANDOFF_WHEN}: ${he ?? 'passa a conversa para a equipe e você para de responder'}.` });
  const f = list.find((x) => x.trigger === 'finish');
  const fe = f && effect(f);
  out.push({ code: 'encerrar', text: `use quando o atendimento terminar (a pessoa agradeceu ou se despediu e não há nada pendente): ${fe ?? 'encerra o atendimento'}. Mande junto uma despedida curta.` });
  list.filter((x) => x.trigger === 'intent').forEach((x, i) => {
    const e = effect(x);
    if (e) out.push({ code: `auto_${i + 1}`, text: `use quando ${clean(x.when)}: ${e}.` });
  });
  return out;
}

/** O que vai para o cliente: mensagem pronta "reply" sempre vai; nas outras, só quando a IA não escreveu nada. */
export function finalTexts(ai: string[], auto: AgentAutomation | null): string[] {
  const fixed = auto?.message?.trim() ?? '';
  if (!auto || !fixed || !['reply', 'handoff', 'close'].includes(auto.action)) return ai;
  if (auto.action === 'reply') return ai.includes(fixed) ? ai : [...ai, fixed];
  return ai.length ? ai : [fixed];
}

/** A automação que corresponde ao código que a IA escolheu. */
export function automationFor(list: AgentAutomation[], code: AgentAction): AgentAutomation | null {
  if (!code) return null;
  if (code === 'handoff') return list.find((x) => x.trigger === 'handoff') ?? null;
  if (code === 'finish') return list.find((x) => x.trigger === 'finish') ?? null;
  const intents = list.filter((x) => x.trigger === 'intent');
  if (code === 'flow') return intents.find((x) => x.action === 'flow') ?? null;
  const n = /^auto_(\d+)$/.exec(code)?.[1];
  return n ? intents[Number(n) - 1] ?? null : null;
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
  const lang = LANGUAGES[a.language ?? 'pt-BR'] ?? LANGUAGES['pt-BR'];
  const langRule = (a.language ?? 'pt-BR') === 'pt-BR' ? `Fale sempre em ${lang}, a não ser que o cliente escreva em outro idioma.` : `Fale sempre em ${lang}.`;
  const who = a.identity === 'ai'
    ? `Você é ${clean(a.name) || 'o assistente'}, assistente virtual da empresa ${clean(opts.company) || 'que você representa'} no WhatsApp. Apresente-se como assistente virtual.`
    : `Você é ${clean(a.name) || 'o atendente'}, atendente da empresa ${clean(opts.company) || 'que você representa'} no WhatsApp.`;
  parts.push(`${who} ${langRule}`);
  parts.push(`OBJETIVO\n${ROLE_GOAL[role]}`);
  const style = [clean(a.tone)];
  if (a.pace && PACE[a.pace]) style.push(PACE[a.pace]);
  if (a.formality && FORMALITY[a.formality]) style.push(FORMALITY[a.formality]);
  if (a.emoji && EMOJI[a.emoji]) style.push(EMOJI[a.emoji]);
  const styleText = style.filter(Boolean).join('\n');
  parts.push(`JEITO DE FALAR\n${styleText || 'Simpático, humano e objetivo. Frases curtas, como numa conversa de WhatsApp. Uma pergunta por vez.'}`);
  if (clean(a.systemPrompt)) parts.push(`COMO ATENDER\n${clean(a.systemPrompt)}`);
  const stages = (a.stages ?? []).filter((x) => clean(x.name));
  if (stages.length) {
    parts.push(`ETAPAS DA CONVERSA (siga nesta ordem; pela conversa até aqui, descubra em qual etapa está e não pule etapas sem motivo)\n${stages.map((x, i) =>
      `${i + 1}. ${clean(x.name)}${clean(x.goal) ? ` — ${clean(x.goal)}` : ''}${clean(x.advanceWhen) ? ` (avance quando ${clean(x.advanceWhen)})` : ''}`).join('\n')}`);
  }

  const knowledge = [clean(a.knowledge), clean(a.bases)].filter(Boolean).join('\n\n');
  parts.push(`O QUE VOCÊ SABE (sua única fonte sobre produtos, preços, prazos e condições)\n${knowledge || '(nada foi informado ainda — não fale de preços, prazos ou condições; diga que vai confirmar com a equipe)'}`);
  const faq = (a.faq ?? []).filter((f) => clean(f.q) && clean(f.a));
  if (faq.length) parts.push(`PERGUNTAS FREQUENTES\n${faq.map((f) => `- P: ${clean(f.q)}\n  R: ${clean(f.a)}`).join('\n')}`);

  const rules = [
    'Nunca invente preço, prazo, desconto, link, endereço, telefone ou qualquer informação que não esteja acima.',
    'Se não souber a resposta, diga com naturalidade que vai confirmar com a equipe.',
    a.identity === 'ai' ? 'Se perguntarem, confirme que é um assistente virtual e que a equipe pode assumir quando precisar.' : 'Não diga que é uma inteligência artificial a menos que perguntem diretamente; se perguntarem, seja honesto.',
    'Nunca peça senha, número de cartão ou código de verificação.',
  ];
  if (clean(a.rules)) rules.push(...clean(a.rules).split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean));
  parts.push(`REGRAS (nunca quebre)\n${rules.map((r) => `- ${r}`).join('\n')}`);

  const actions: string[] = [];
  if (a.actions) {
    for (const x of a.actions) actions.push(`- "${x.code}": ${x.text}`);
  } else if (a.flowName) {
    actions.push(`- "fluxo": dispara o fluxo “${a.flowName}”, que cuida do pagamento/checkout. Use ${clean(a.flowWhen) || DEFAULT_FLOW_WHEN}. Não mande link de pagamento por conta própria: o fluxo envia. Junto com a ação, mande uma mensagem curta avisando que vai enviar.`);
  }
  if (!a.actions) actions.push(`- "humano": passa a conversa para a equipe e você para de responder. Use ${clean(a.handoffWhen) || DEFAULT_HANDOFF_WHEN}.`);
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
    a.actions ? `- "acao": null${a.actions.map((x) => `, "${x.code}"`).join('')}.` : `- "acao": null${a.flowName ? ', "fluxo"' : ''} ou "humano".`,
    '- "motivo": em poucas palavras, por que escolheu a ação (a equipe vê isso).',
  ].join('\n'));
  return parts.join('\n\n');
}

export interface ParsedReply { messages: string[]; action: AgentAction; reason: string }

const ACTIONS: Record<string, AgentAction> = {
  fluxo: 'flow', flow: 'flow', checkout: 'flow', pagamento: 'flow',
  humano: 'handoff', human: 'handoff', handoff: 'handoff', equipe: 'handoff', transferir: 'handoff',
  encerrar: 'finish', finalizar: 'finish', finish: 'finish', encerrado: 'finish',
};
const actionOf = (k: string): AgentAction => ACTIONS[k] ?? (/^auto_\d{1,2}$/.test(k) ? k : null);

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
    return { messages: list, action: actionOf(actKey), reason: String(j.motivo ?? j.reason ?? '').trim().slice(0, 300) };
  }
  // JSON quebrado: tenta salvar as mensagens; nunca manda chaves/aspas de JSON para o cliente
  if (/"mensagens"\s*:/.test(text)) {
    const inside = text.slice(text.indexOf('"mensagens"'));
    const arr = /\[([\s\S]*?)\]/.exec(inside)?.[1] ?? '';
    const msgs = [...arr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => tidy(x[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'))).filter(Boolean).slice(0, 3);
    const act = /"acao"\s*:\s*"(\w+)"/.exec(text)?.[1]?.toLowerCase() ?? '';
    return { messages: msgs, action: actionOf(act), reason: '' };
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
