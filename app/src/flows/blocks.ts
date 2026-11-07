import { money } from '../api';

export type BlockType =
  | 'trigger' | 'message' | 'media' | 'menu' | 'ask' | 'condition' | 'delay' | 'random'
  | 'action' | 'handoff' | 'http' | 'payment' | 'ai_reply' | 'ai_classify' | 'goto_flow';

export type BlockCategory = 'Mensagens' | 'Lógica' | 'CRM' | 'Integrações' | 'IA';

export interface BlockMeta { label: string; desc: string; icon: string; color: string; category: BlockCategory | null; }

export const BLOCKS: Record<BlockType, BlockMeta> = {
  trigger: { label: 'Início', desc: 'Quando o fluxo começa', icon: 'flag', color: '#0e9488', category: null },
  message: { label: 'Mensagem', desc: 'Envia um texto', icon: 'chat', color: '#8b5cf6', category: 'Mensagens' },
  media: { label: 'Mídia', desc: 'Imagem, vídeo, áudio ou PDF', icon: 'image', color: '#c026d3', category: 'Mensagens' },
  menu: { label: 'Menu de opções', desc: 'Botões ou lista, uma saída por opção', icon: 'list', color: '#2f73e0', category: 'Mensagens' },
  ask: { label: 'Pergunta', desc: 'Espera a resposta e salva', icon: 'help', color: '#0891b2', category: 'Mensagens' },
  condition: { label: 'Condição', desc: 'Divide em sim / não', icon: 'split', color: '#d97706', category: 'Lógica' },
  delay: { label: 'Espera', desc: 'Aguarda um tempo', icon: 'clock', color: '#64748b', category: 'Lógica' },
  random: { label: 'Teste A/B', desc: 'Divide por porcentagem', icon: 'shuffle', color: '#ea580c', category: 'Lógica' },
  goto_flow: { label: 'Ir para fluxo', desc: 'Continua em outro fluxo', icon: 'arrowRight', color: '#475569', category: 'Lógica' },
  action: { label: 'Ações de CRM', desc: 'Etapa do funil, etiquetas, nome, Kanban', icon: 'tag', color: '#1a9f52', category: 'CRM' },
  handoff: { label: 'Transferir p/ humano', desc: 'Pausa a automação na conversa', icon: 'userArrow', color: '#db2777', category: 'CRM' },
  http: { label: 'Webhook / HTTP', desc: 'Chama uma API externa', icon: 'globe', color: '#0f766e', category: 'Integrações' },
  payment: { label: 'Pagamento', desc: 'Envia o link e aguarda a confirmação', icon: 'dollar', color: '#16a34a', category: 'Integrações' },
  ai_reply: { label: 'Resposta com IA', desc: 'A IA conversa com o cliente', icon: 'sparkles', color: '#7c3aed', category: 'IA' },
  ai_classify: { label: 'Classificar com IA', desc: 'Entende a intenção e divide', icon: 'brain', color: '#6d28d9', category: 'IA' },
};

export const CATEGORIES: BlockCategory[] = ['Mensagens', 'Lógica', 'CRM', 'Integrações', 'IA'];

export const STAGES: [string, string][] = [
  ['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido'],
];
export const stageLabel = (s: string) => STAGES.find((x) => x[0] === s)?.[1] ?? s;

export const AI_MODELS: [string, string][] = [
  ['', 'Padrão da plataforma'],
  ['openai/gpt-4o-mini', 'GPT-4o mini (rápido e barato)'],
  ['openai/gpt-4o', 'GPT-4o'],
  ['google/gemini-1.5-pro', 'Gemini 1.5 Pro'],
  ['anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet'],
];

export const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

export function defaultData(type: BlockType): Record<string, any> {
  switch (type) {
    case 'trigger': return { type: 'any_message', keywords: '', match: 'contains', connectionId: '', webhookId: '', reentry: 'always', cooldownHours: 24 };
    case 'message': return { text: 'Olá {{primeiro_nome}}! 👋' };
    case 'media': return { mediaType: 'image', url: '', caption: '' };
    case 'menu': return {
      text: 'Como posso te ajudar?',
      options: [{ id: rid('opt'), title: 'Quero comprar' }, { id: rid('opt'), title: 'Tirar dúvidas' }],
      style: 'auto', buttonLabel: 'Ver opções', invalidText: '', maxRetries: 1, saveAs: '',
    };
    case 'ask': return { text: 'Qual é o seu e-mail?', saveAs: 'email', validation: 'email', invalidText: '', maxRetries: 2 };
    case 'condition': return { field: 'lastMessage', op: 'contains', value: 'sim', varName: '' };
    case 'delay': return { amount: 5, unit: 'minutes' };
    case 'random': return { percentA: 50 };
    case 'action': return { setStage: '', addTags: [], removeTags: [], setName: '', kanbanBoardId: '', kanbanColumnId: '', setFields: [] };
    case 'handoff': return { message: 'Vou te transferir para um atendente, só um instante! 🙋', assignUserId: '' };
    case 'http': return { method: 'POST', url: '', headers: [], body: '{\n  "telefone": "{{telefone}}",\n  "nome": "{{nome}}"\n}', saveAs: 'http' };
    case 'payment': return { productId: '', url: '', text: 'Aqui está o seu link de pagamento 👇\n{{link}}', wait: true, timeoutMinutes: 60 };
    case 'ai_reply': return {
      prompt: 'Você é um vendedor simpático. Tire as dúvidas do cliente e conduza para a compra, sem inventar preços.',
      model: '', useHistory: true, send: true, saveAs: '', fallbackText: '',
    };
    case 'ai_classify': return {
      categories: [
        { id: rid('cat'), label: 'Quer comprar', description: 'pergunta preço, formas de pagamento' },
        { id: rid('cat'), label: 'Dúvida', description: 'quer saber como funciona' },
      ],
      instructions: '',
    };
    case 'goto_flow': return { flowId: '' };
  }
}

export interface Output { id: string | null; label: string; tone?: 'green' | 'red' | 'muted'; }

export function outputsFor(type: string, d: Record<string, any>): Output[] {
  switch (type) {
    case 'condition': return [{ id: 'true', label: 'Sim', tone: 'green' }, { id: 'false', label: 'Não', tone: 'red' }];
    case 'random': {
      const a = Math.min(100, Math.max(0, Number(d.percentA ?? 50)));
      return [{ id: 'a', label: `A · ${a}%` }, { id: 'b', label: `B · ${100 - a}%` }];
    }
    case 'http': return [{ id: 'success', label: 'Sucesso', tone: 'green' }, { id: 'error', label: 'Erro', tone: 'red' }];
    case 'menu': return [
      ...(Array.isArray(d.options) ? d.options : []).map((o: any) => ({ id: String(o.id), label: o.title || '(sem título)' })),
      { id: 'fallback', label: 'Outro / não reconheceu', tone: 'muted' as const },
    ];
    case 'ai_classify': return [
      ...(Array.isArray(d.categories) ? d.categories : []).map((c: any) => ({ id: String(c.id), label: c.label || '(sem nome)' })),
      { id: 'none', label: 'Nenhuma', tone: 'muted' as const },
    ];
    case 'payment': return d.wait
      ? [{ id: 'paid', label: 'Pago', tone: 'green' }, { id: 'unpaid', label: 'Não pago', tone: 'red' }]
      : [{ id: null, label: '' }];
    case 'ask': return (d.validation ?? 'any') === 'any'
      ? [{ id: null, label: '' }]
      : [{ id: null, label: 'Resposta válida' }, { id: 'invalid', label: 'Inválida', tone: 'red' }];
    case 'goto_flow': return [];
    default: return [{ id: null, label: '' }];
  }
}

export interface Lookups {
  connections: { id: string; name: string }[];
  webhooks: { id: string; name: string }[];
  team: { userId: string; name: string }[];
  products: { id: string; name: string; price: string; checkoutUrl: string | null }[];
  flows: { id: string; name: string; status: string; archived: boolean }[];
  kanban: { id: string; name: string; columns: { id: string; name: string }[] }[];
  fields: { key: string; label: string }[];
  departments: { id: string; name: string; color: string }[];
  globals: { key: string; type: 'text' | 'number'; value: string }[];
}
export const emptyLookups: Lookups = { connections: [], webhooks: [], team: [], products: [], flows: [], kanban: [], fields: [], departments: [], globals: [] };

const UNITS: Record<string, [string, string]> = {
  seconds: ['segundo', 'segundos'], minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['dia', 'dias'],
};
export const delayText = (d: Record<string, any>) => {
  const n = Number(d.amount ?? 5);
  const u = UNITS[d.unit] ?? UNITS.minutes;
  return `${n} ${n === 1 ? u[0] : u[1]}`;
};

const OPS: Record<string, string> = {
  contains: 'contém', not_contains: 'não contém', equals: 'é igual a', not_equals: 'é diferente de',
  starts_with: 'começa com', not_empty: 'não está vazia', is_empty: 'está vazia', is_number: 'é um número',
  greater_than: 'é maior que', less_than: 'é menor que', has_tag: 'tem a etiqueta', not_has_tag: 'não tem a etiqueta',
  open: 'está dentro do horário', closed: 'está fora do horário',
};
const FIELDS: Record<string, string> = { lastMessage: 'Resposta', name: 'Nome', stage: 'Etapa', phone: 'Telefone', tags: 'Contato', global: 'Global' };
export const OP_LABELS = OPS;

/** Texto curto mostrado dentro do bloco no canvas. */
export function summary(type: string, d: Record<string, any>, lk: Lookups): string {
  switch (type) {
    case 'trigger': {
      const t = d.type ?? 'any_message';
      if (t === 'keyword') return d.keywords ? `Palavras-chave: ${d.keywords}` : 'Palavra-chave (defina as palavras)';
      if (t === 'first_message') return 'Primeira mensagem do contato';
      if (t === 'webhook') return `Evento de webhook${d.webhookId ? `: ${lk.webhooks.find((w) => w.id === d.webhookId)?.name ?? ''}` : ''}`;
      if (t === 'manual') return 'Iniciado por outro fluxo';
      return 'Qualquer mensagem recebida';
    }
    case 'message': case 'ask': return String(d.text ?? '');
    case 'media': {
      const kinds: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', document: '📄 Documento' };
      return `${kinds[d.mediaType] ?? 'Mídia'}${d.caption ? ` · ${d.caption}` : d.url ? '' : ' (sem link)'}`;
    }
    case 'menu': return String(d.text ?? '');
    case 'condition': {
      if (d.field === 'tags') return `Contato ${OPS[d.op] ?? d.op} “${d.value ?? ''}”`;
      if (d.field === 'business_hours') return d.op === 'closed' ? 'Fora do horário de atendimento' : 'Dentro do horário de atendimento';
      const field = d.field === 'var' ? `{{${d.varName || '?'}}}` : d.field === 'global' ? `{{${d.globalKey || 'g_?'}}}` : FIELDS[d.field] ?? 'Resposta';
      const noValue = ['not_empty', 'is_empty', 'is_number'].includes(d.op);
      const value = d.field === 'stage' ? stageLabel(d.value) : d.value;
      return `${field} ${OPS[d.op] ?? d.op}${noValue ? '' : ` “${value ?? ''}”`}`;
    }
    case 'delay': return `Aguardar ${delayText(d)}`;
    case 'random': return 'Divide os contatos aleatoriamente';
    case 'action': {
      const parts: string[] = [];
      if (d.setStage) parts.push(`Etapa → ${stageLabel(d.setStage)}`);
      const add = Array.isArray(d.addTags) ? d.addTags : [];
      const rem = Array.isArray(d.removeTags) ? d.removeTags : [];
      if (add.length) parts.push(`+ ${add.join(', ')}`);
      if (rem.length) parts.push(`− ${rem.join(', ')}`);
      if (d.setName) parts.push(`Nome → ${d.setName}`);
      const sf = (Array.isArray(d.setFields) ? d.setFields : []).filter((f: { key?: string }) => f?.key);
      if (sf.length) parts.push(`Campos → ${sf.map((f: { key: string }) => lk.fields.find((x) => x.key === f.key)?.label ?? f.key).join(', ')}`);
      const sg = (Array.isArray(d.setGlobals) ? d.setGlobals : []).filter((g: { key?: string }) => g?.key);
      if (sg.length) parts.push(sg.map((g: { key: string; op?: string; value?: string }) => `${g.key} ${g.op === 'add' ? '+' : g.op === 'subtract' ? '−' : '='} ${g.value ?? ''}`).join(', '));
      if (d.kanbanBoardId) {
        const b = lk.kanban.find((x) => x.id === d.kanbanBoardId);
        const c = b?.columns.find((x) => x.id === d.kanbanColumnId);
        parts.push(b ? `Kanban → ${b.name} › ${c?.name ?? '?'}` : 'Kanban → quadro removido');
      }
      return parts.join(' · ');
    }
    case 'handoff': {
      const who = lk.team.find((t) => t.userId === d.assignUserId)?.name;
      if (who) return `Transferir para ${who}`;
      const dept = lk.departments.find((x) => x.id === d.departmentId)?.name;
      return dept ? `Fila do setor ${dept}` : 'Transferir para a equipe';
    }
    case 'http': return d.url ? `${d.method ?? 'GET'} ${String(d.url).replace(/^https?:\/\//, '')}` : '';
    case 'payment': {
      const p = lk.products.find((x) => x.id === d.productId);
      const what = p ? `${p.name} (${money(Number(p.price))})` : d.url ? 'Link personalizado' : 'Sem produto/link';
      return `${what}${d.wait ? ` · aguarda até ${Number(d.timeoutMinutes ?? 60)} min` : ''}`;
    }
    case 'ai_reply': return String(d.prompt ?? '');
    case 'ai_classify': return `Classifica em ${(d.categories ?? []).length} categorias`;
    case 'goto_flow': return lk.flows.find((f) => f.id === d.flowId)?.name ? `→ ${lk.flows.find((f) => f.id === d.flowId)?.name}` : '';
    default: return '';
  }
}

/** Variáveis que podem ser usadas nos textos, a partir dos blocos do fluxo. */
export function variablesOf(nodes: { type?: string; data: Record<string, any> }[], fieldKeys: string[] = [], globalKeys: string[] = []): string[] {
  const vars = new Set<string>(['primeiro_nome', 'nome', 'telefone', 'email', 'resposta', 'saudacao', 'data', 'hora', 'dia', ...fieldKeys.map((k) => `campos.${k}`), ...globalKeys]);
  for (const n of nodes) {
    const d = n.data ?? {};
    if (n.type === 'ask' && d.saveAs) vars.add(d.saveAs);
    if (n.type === 'menu') { vars.add('opcao'); if (d.saveAs) vars.add(d.saveAs); }
    if (n.type === 'ai_reply') vars.add(d.saveAs || 'ia');
    if (n.type === 'ai_classify') vars.add('categoria');
    if (n.type === 'payment') vars.add('link_pagamento');
    if (n.type === 'http') vars.add(`${d.saveAs || 'http'}.campo`);
    if (n.type === 'trigger' && d.type === 'webhook') { vars.add('produto'); vars.add('valor'); vars.add('evento'); }
  }
  return [...vars];
}

export const sanitizeVarName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
