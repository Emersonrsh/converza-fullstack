import { money } from '../api';

export type BlockType =
  | 'trigger'
  // barra "Ferramentas"
  | 'message' | 'template' | 'tags' | 'pix' | 'menu' | 'carousel' | 'ask' | 'chat_status' | 'notify'
  | 'condition' | 'distributor' | 'goto_flow' | 'pixel' | 'delay' | 'department' | 'http' | 'ai' | 'ai_agent'
  | 'kanban' | 'set_var' | 'sale'
  // blocos antigos: continuam nos fluxos que já os usam
  | 'media' | 'random' | 'action' | 'handoff' | 'payment' | 'ai_reply' | 'ai_classify';

export interface BlockMeta { label: string; desc: string; icon: string; color: string; legacy?: boolean }

export const BLOCKS: Record<BlockType, BlockMeta> = {
  trigger: { label: 'Início', desc: 'Quando o fluxo começa', icon: 'flag', color: '#0e9488' },
  message: { label: 'Mensagem', desc: 'Texto, imagem, vídeo, áudio, arquivo, contato e sticker', icon: 'chat', color: '#3b82f6' },
  template: { label: 'Template WhatsApp', desc: 'Modelo aprovado pela Meta (fala fora das 24 h)', icon: 'file', color: '#2563eb' },
  tags: { label: 'Etiquetas', desc: 'Adiciona ou remove etiquetas do contato', icon: 'tag', color: '#8b5cf6' },
  pix: { label: 'Botão PIX', desc: 'Cartão com o Pix copia e cola', icon: 'card', color: '#10b981' },
  menu: { label: 'Menu', desc: 'Lista ou botões, uma saída por opção', icon: 'list', color: '#a855f7' },
  carousel: { label: 'Carrossel', desc: 'Cartões com imagem e botões', icon: 'grid', color: '#0ea5e9' },
  ask: { label: 'Aguarda Resposta', desc: 'Espera o cliente responder e salva', icon: 'save', color: '#f97316' },
  chat_status: { label: 'Controlador de Chat', desc: 'Aguardando, Atendimento ou Resolvido', icon: 'chats', color: '#64748b' },
  notify: { label: 'Notificação', desc: 'Avisa outro número pelo WhatsApp', icon: 'bell', color: '#14b8a6' },
  condition: { label: 'Condicional', desc: 'Divide em sim / não por regras', icon: 'split', color: '#0284c7' },
  distributor: { label: 'Distribuidor', desc: 'Divide os contatos entre as saídas', icon: 'fork', color: '#f59e0b' },
  goto_flow: { label: 'Conexão de Fluxo', desc: 'Continua em outro fluxo', icon: 'share', color: '#f43f5e' },
  pixel: { label: 'Pixel', desc: 'Evento no Facebook / TikTok', icon: 'target', color: '#ca8a04' },
  delay: { label: 'Intervalo Inteligente', desc: 'Espera um tempo, uma data ou um horário', icon: 'clock', color: '#06b6d4' },
  department: { label: 'Departamento', desc: 'Coloca a conversa num setor', icon: 'building', color: '#6366f1' },
  http: { label: 'Integração', desc: 'Chama uma API (GET, POST, PUT…)', icon: 'globe', color: '#2563eb' },
  ai: { label: 'Bloco de IA', desc: 'GPT, Gemini ou OpenRouter: responde e decide', icon: 'sparkles', color: '#059669' },
  ai_agent: { label: 'Agente de IA', desc: 'Entrega ou tira a conversa do agente', icon: 'bot', color: '#7c3aed' },
  kanban: { label: 'Kanban', desc: 'Adiciona, move ou tira o card do contato', icon: 'kanban', color: '#9333ea' },
  set_var: { label: 'Manipulador', desc: 'Define, soma ou junta variáveis', icon: 'sliders', color: '#ea580c' },
  sale: { label: 'Venda aprovada', desc: 'Registra a venda (dashboard e pixel)', icon: 'dollar', color: '#16a34a' },
  media: { label: 'Mídia (antigo)', desc: 'Imagem, vídeo, áudio ou PDF', icon: 'image', color: '#c026d3', legacy: true },
  random: { label: 'Teste A/B (antigo)', desc: 'Divide por porcentagem', icon: 'shuffle', color: '#ea580c', legacy: true },
  action: { label: 'Ações de CRM (antigo)', desc: 'Etapa do funil, etiquetas, nome, Kanban', icon: 'tag', color: '#1a9f52', legacy: true },
  handoff: { label: 'Transferir p/ humano (antigo)', desc: 'Pausa a automação na conversa', icon: 'userArrow', color: '#db2777', legacy: true },
  payment: { label: 'Pagamento (antigo)', desc: 'Envia o link e aguarda a confirmação', icon: 'dollar', color: '#16a34a', legacy: true },
  ai_reply: { label: 'Resposta com IA (antigo)', desc: 'A IA conversa com o cliente', icon: 'sparkles', color: '#7c3aed', legacy: true },
  ai_classify: { label: 'Classificar com IA (antigo)', desc: 'Entende a intenção e divide', icon: 'brain', color: '#6d28d9', legacy: true },
};

/** Ordem da barra "Ferramentas". */
export const TOOLS: BlockType[] = [
  'message', 'template', 'tags', 'pix', 'menu', 'carousel', 'ask', 'chat_status', 'notify', 'condition', 'distributor',
  'goto_flow', 'pixel', 'delay', 'department', 'http', 'ai', 'ai_agent', 'kanban', 'set_var', 'sale',
];

export const STAGES: [string, string][] = [
  ['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido'],
];
export const stageLabel = (s: string) => STAGES.find((x) => x[0] === s)?.[1] ?? s;

export const AI_MODELS: [string, string][] = [['', 'Padrão da plataforma']];

export const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_PROMPT = 'Você é um assistente útil.\nSempre responda em português do Brasil.\nSeja claro e objetivo.';

export function defaultData(type: BlockType): Record<string, any> {
  switch (type) {
    case 'trigger': return { type: 'any_message', keywords: '', match: 'contains', connectionId: '', webhookId: '', reentry: 'always', cooldownHours: 24 };
    case 'message': return { items: [] };
    case 'template': return {
      connectionId: '', name: '', language: '', paramFormat: 'positional', bodyText: '', bodyVars: [], vars: {},
      headerFormat: '', headerVar: '', headerText: '', headerMediaUrl: '', buttons: [], buttonValues: {}, timeoutAmount: 60, timeoutUnit: 'minutes',
    };
    case 'tags': return { mode: 'add', tags: [] };
    case 'pix': return { keyType: 'evp', key: '', merchantName: '', amount: '', text: '', imageUrl: '', imageFileId: '', imageName: '' };
    case 'menu': return { style: 'list', text: '', buttonLabel: '', expireAmount: 0, expireUnit: 'days', options: [], saveAs: '', invalidText: '', maxRetries: 1 };
    case 'carousel': return {
      expireAmount: 0, expireUnit: 'days', text: 'Escolha uma opção abaixo',
      cards: [{ id: rid('card'), text: '', imageUrl: '', imageFileId: '', imageName: '', buttons: [{ id: rid('btn'), type: 'reply', title: 'Opção A' }] }],
    };
    case 'ask': return { waitForever: false, timeoutAmount: 1, timeoutUnit: 'days', buffer: false, bufferSeconds: 5, quote: false, react: false, reactEmoji: '👍', saveAs: '', text: '', validation: 'any', invalidText: '', maxRetries: 2 };
    case 'chat_status': return { status: 'pending', assignUserId: '', pause: true };
    case 'notify': return { name: '', country: '55', phone: '', text: '', templateName: '', templateLanguage: '', templateVarCount: 0, templateParam: '' };
    case 'condition': return { logic: 'all', rules: [] };
    case 'distributor': return { mode: 'sticky', outputs: [{ id: rid('out'), label: 'Saída 1' }, { id: rid('out'), label: 'Saída 2' }] };
    case 'goto_flow': return { flowId: '' };
    case 'pixel': return { platform: 'meta', pixelId: '', event: 'Purchase', value: '', currency: 'BRL' };
    case 'delay': return { mode: 'interval', amount: 1, unit: 'minutes', date: '', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', useBusinessHours: false };
    case 'department': return { action: 'set', departmentId: '' };
    case 'http': return { method: 'GET', url: '', headersJson: '{\n  "Content-Type": "application/json"\n}', body: '', mappings: [], saveAs: 'http' };
    case 'ai': return {
      provider: 'converza', apiKey: '', model: '', input: '{{resposta}}', saveAs: '', send: true, prompt: DEFAULT_PROMPT,
      audio: false, image: false, pdf: false, detectReceipt: false,
      receiptOnly: false, validatePixKey: false, pixKeys: [''], validateRecipient: false, recipientNames: [''], conditions: [], keepContext: false, contextSize: 5,
    };
    case 'ai_agent': return { action: 'assign', agentId: '' };
    case 'kanban': return { action: 'add', boardId: '', columnId: '' };
    case 'set_var': return { name: '', op: 'set', value: '' };
    case 'sale': return { productId: '', customerName: '{{comprovante.nome_pagador}}', amount: '{{comprovante.valor}}', currency: '{{comprovante.currency}}', notifyTitle: '', notifySubtitle: '' };
    // antigos
    case 'media': return { mediaType: 'image', url: '', caption: '' };
    case 'random': return { percentA: 50 };
    case 'action': return { setStage: '', addTags: [], removeTags: [], setName: '', kanbanBoardId: '', kanbanColumnId: '', setFields: [] };
    case 'handoff': return { message: 'Vou te transferir para um atendente, só um instante! 🙋', assignUserId: '' };
    case 'payment': return { productId: '', url: '', text: 'Aqui está o seu link de pagamento 👇\n{{link}}', wait: true, timeoutMinutes: 60 };
    case 'ai_reply': return { prompt: 'Você é um vendedor simpático. Tire as dúvidas do cliente e conduza para a compra, sem inventar preços.', model: '', useHistory: true, send: true, saveAs: '', fallbackText: '' };
    case 'ai_classify': return { categories: [{ id: rid('cat'), label: 'Quer comprar', description: 'pergunta preço, formas de pagamento' }, { id: rid('cat'), label: 'Dúvida', description: 'quer saber como funciona' }], instructions: '' };
  }
}

/** Fluxos antigos: converte o bloco para o formato novo ao abrir (o que já funcionava continua igual). */
export function upgradeNode(type: string, data: Record<string, any>): { type: string; data: Record<string, any> } {
  const d = { ...(data ?? {}) };
  if (type === 'media') {
    const kind = d.mediaType === 'document' ? 'file' : ['image', 'video', 'audio'].includes(d.mediaType) ? d.mediaType : 'image';
    return { type: 'message', data: { title: d.title, items: [{ id: rid('it'), type: kind, url: d.url ?? '', caption: d.caption ?? '', filename: d.filename ?? '' }] } };
  }
  if (type === 'message' && !Array.isArray(d.items)) {
    const { text, ...rest } = d;
    return { type, data: { ...rest, items: String(text ?? '').trim() ? [{ id: rid('it'), type: 'text', text }] : [] } };
  }
  if (type === 'condition' && !Array.isArray(d.rules)) {
    const { field, op, value, varName, globalKey, ...rest } = d;
    return { type, data: { ...rest, logic: 'all', rules: field !== undefined || op !== undefined ? [{ id: rid('r'), field: field ?? 'lastMessage', op: op ?? 'contains', value: value ?? '', varName: varName ?? '', globalKey: globalKey ?? '' }] : [] } };
  }
  if (type === 'delay' && d.mode === undefined) return { type, data: { ...d, mode: 'interval', amount: d.amount ?? Math.max(1, Math.round(Number(d.seconds ?? 60) / 60)), unit: d.unit ?? 'minutes' } };
  if (type === 'http' && d.headersJson === undefined) {
    const obj = Object.fromEntries((Array.isArray(d.headers) ? d.headers : []).filter((h: any) => String(h?.key ?? '').trim()).map((h: any) => [String(h.key).trim(), String(h.value ?? '')]));
    const { headers: _h, ...rest } = d;
    return { type, data: { ...rest, headersJson: JSON.stringify(obj, null, 2), mappings: d.mappings ?? [] } };
  }
  if (type === 'ask' && d.timeoutAmount === undefined && d.waitForever === undefined) return { type, data: { ...d, waitForever: true, timeoutAmount: 1, timeoutUnit: 'days' } };
  if (type === 'menu' && (d.style === 'auto' || d.style === 'text' || d.style === undefined)) {
    return { type, data: { ...d, style: (Array.isArray(d.options) ? d.options.length : 0) > 3 ? 'list' : 'buttons' } };
  }
  return { type, data: d };
}

export interface Output { id: string | null; label: string; tone?: 'green' | 'red' | 'muted'; }

const UNIT_SEC: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
export const durationSeconds = (amount: unknown, unit: unknown) => {
  const n = Number(String(amount ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * (UNIT_SEC[String(unit)] ?? 60)) : 0;
};

export function carouselReplyButtons(d: Record<string, any>): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const c of Array.isArray(d.cards) ? d.cards : []) {
    for (const b of Array.isArray(c?.buttons) ? c.buttons : []) if (b?.id && (b.type ?? 'reply') === 'reply') out.push({ id: String(b.id), title: String(b.title ?? '') });
  }
  return out;
}

export function templateReplyButtons(d: Record<string, any>): { id: string; title: string }[] {
  return (Array.isArray(d.buttons) ? d.buttons : []).map((b: any, i: number) => ({ b, i }))
    .filter(({ b }: any) => String(b?.type ?? '').toUpperCase() === 'QUICK_REPLY')
    .map(({ b, i }: any) => ({ id: `qr_${i}`, title: String(b.text ?? '') }));
}
export const templateWaits = (d: Record<string, any>) => durationSeconds(d.timeoutAmount ?? 60, d.timeoutUnit ?? 'minutes') > 0;

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
      { id: 'fallback', label: 'Outra resposta', tone: 'muted' as const },
      ...(durationSeconds(d.expireAmount, d.expireUnit) > 0 ? [{ id: 'timeout', label: 'Inatividade', tone: 'red' as const }] : []),
    ];
    case 'carousel': {
      const btns = carouselReplyButtons(d);
      if (!btns.length) return [{ id: null, label: '' }];
      return [
        ...btns.map((b) => ({ id: b.id, label: b.title || '(botão sem texto)' })),
        { id: 'fallback', label: 'Outra resposta', tone: 'muted' as const },
        ...(durationSeconds(d.expireAmount, d.expireUnit) > 0 ? [{ id: 'timeout', label: 'Inatividade', tone: 'red' as const }] : []),
      ];
    }
    case 'template': return templateWaits(d)
      ? [...templateReplyButtons(d).map((b) => ({ id: b.id, label: b.title })), { id: 'replied', label: 'Outra resposta', tone: 'muted' as const }, { id: 'timeout', label: 'Sem resposta', tone: 'red' as const }]
      : [{ id: null, label: '' }];
    case 'distributor': return (Array.isArray(d.outputs) ? d.outputs : []).map((o: any, i: number) => ({ id: String(o.id), label: o.label || `Saída ${i + 1}` }));
    case 'ai': return [
      ...(d.detectReceipt ? [{ id: 'receipt', label: 'Comprovante válido', tone: 'green' as const }] : []),
      ...(d.detectReceipt && d.validatePixKey ? [{ id: 'pix_wrong', label: 'Chave Pix errada', tone: 'red' as const }] : []),
      ...(d.detectReceipt && d.validateRecipient ? [{ id: 'name_wrong', label: 'Nome errado', tone: 'red' as const }] : []),
      ...(Array.isArray(d.conditions) ? d.conditions : []).map((c: any) => ({ id: String(c.id), label: c.label || '(condição sem nome)' })),
      { id: null, label: 'Fallback (padrão)' },
      { id: 'error', label: 'Falha', tone: 'red' as const },
    ];
    case 'ai_classify': return [
      ...(Array.isArray(d.categories) ? d.categories : []).map((c: any) => ({ id: String(c.id), label: c.label || '(sem nome)' })),
      { id: 'none', label: 'Nenhuma', tone: 'muted' as const },
    ];
    case 'payment': return d.wait
      ? [{ id: 'paid', label: 'Pago', tone: 'green' }, { id: 'unpaid', label: 'Não pago', tone: 'red' }]
      : [{ id: null, label: '' }];
    case 'ask': {
      const outs: Output[] = [{ id: null, label: 'Respondeu' }];
      if ((d.validation ?? 'any') !== 'any') outs.push({ id: 'invalid', label: 'Inválida', tone: 'red' });
      if (!d.waitForever && d.timeoutAmount !== undefined) outs.push({ id: 'timeout', label: 'Sem resposta', tone: 'red' });
      return outs.length === 1 ? [{ id: null, label: '' }] : outs;
    }
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
  tags: { name: string; color: string }[];
  agents: { id: string; name: string; avatar: string; enabled: boolean }[];
  pixels: { id: string; name: string; platform: string; status: string }[];
  platforms: { id: string; label: string; events: string[] }[];
  wabas: { id: string; name: string; displayPhone: string | null }[];
}
export const emptyLookups: Lookups = {
  connections: [], webhooks: [], team: [], products: [], flows: [], kanban: [], fields: [], departments: [], globals: [],
  tags: [], agents: [], pixels: [], platforms: [], wabas: [],
};

const UNITS: Record<string, [string, string]> = {
  seconds: ['segundo', 'segundos'], minutes: ['minuto', 'minutos'], hours: ['hora', 'horas'], days: ['dia', 'dias'],
};
export const durationText = (amount: unknown, unit: unknown) => {
  const n = Number(amount ?? 0);
  const u = UNITS[String(unit)] ?? UNITS.minutes;
  return `${String(amount ?? '')} ${n === 1 ? u[0] : u[1]}`;
};
export const delayText = (d: Record<string, any>) => durationText(d.amount ?? 5, d.unit);

export const OP_LABELS: Record<string, string> = {
  contains: 'contém', not_contains: 'não contém', equals: 'é igual a', not_equals: 'é diferente de',
  starts_with: 'começa com', ends_with: 'termina com', not_empty: 'não está vazio', is_empty: 'está vazio', is_number: 'é um número',
  greater_than: 'é maior que', less_than: 'é menor que', has_tag: 'tem a etiqueta', not_has_tag: 'não tem a etiqueta',
  open: 'está dentro do horário', closed: 'está fora do horário',
};
const OPS = OP_LABELS;
export const FIELD_LABELS: Record<string, string> = {
  lastMessage: 'Resposta', var: 'Variável', name: 'Nome', stage: 'Etapa', phone: 'Telefone', email: 'E-mail', tags: 'Contato',
  field: 'Campo', global: 'Global', business_hours: 'Horário',
};
const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MEDIA_LABEL: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', file: '📄 Arquivo', sticker: '🌟 Sticker', contact: '👤 Contato', interval: '⏱️ Intervalo' };
export const STATUS_LABEL: Record<string, string> = { pending: 'Aguardando', open: 'Atendimento', resolved: 'Resolvido' };

function ruleText(r: Record<string, any>, lk: Lookups): string {
  if (r.field === 'tags') return `Contato ${OPS[r.op] ?? r.op} “${r.value ?? ''}”`;
  if (r.field === 'business_hours') return r.op === 'closed' ? 'Fora do horário' : 'Dentro do horário';
  const field = r.field === 'var' ? `{{${r.varName || '?'}}}` : r.field === 'global' ? `{{${r.globalKey || 'g_?'}}}`
    : r.field === 'field' ? (lk.fields.find((f) => f.key === r.fieldKey)?.label ?? 'Campo') : FIELD_LABELS[r.field] ?? 'Resposta';
  const noValue = ['not_empty', 'is_empty', 'is_number'].includes(r.op);
  const value = r.field === 'stage' ? stageLabel(r.value) : r.value;
  return `${field} ${OPS[r.op] ?? r.op}${noValue ? '' : ` “${value ?? ''}”`}`;
}

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
    case 'message': {
      const items: any[] = Array.isArray(d.items) ? d.items : d.text ? [{ type: 'text', text: d.text }] : [];
      if (!items.length) return '';
      const first = items.find((i) => i.type === 'text' && String(i.text ?? '').trim());
      const others = items.filter((i) => i !== first).map((i) => MEDIA_LABEL[i.type] ?? i.type);
      return [first ? String(first.text) : '', others.length ? others.join(' · ') : ''].filter(Boolean).join('\n');
    }
    case 'template': return d.name ? `📄 ${d.name}${templateWaits(d) ? ` · espera ${durationText(d.timeoutAmount, d.timeoutUnit)}` : ''}` : '';
    case 'tags': {
      const tags: string[] = Array.isArray(d.tags) ? d.tags : [];
      return tags.length ? `${d.mode === 'remove' ? '−' : '+'} ${tags.join(', ')}` : '';
    }
    case 'pix': return d.key ? `Pix${d.amount ? ` ${/\{\{/.test(String(d.amount)) ? d.amount : `R$ ${d.amount}`}` : ''} · ${d.merchantName || 'sem recebedor'}` : '';
    case 'menu': return String(d.text ?? '');
    case 'carousel': return `${(d.cards ?? []).length} ${(d.cards ?? []).length === 1 ? 'cartão' : 'cartões'}${d.text ? ` · ${d.text}` : ''}`;
    case 'ask': return String(d.text ?? '').trim() || (d.waitForever ? 'Aguarda a resposta (sem limite)' : `Aguarda a resposta (até ${durationText(d.timeoutAmount ?? 1, d.timeoutUnit ?? 'days')})`);
    case 'chat_status': {
      const who = lk.team.find((t) => t.userId === d.assignUserId)?.name;
      return `${STATUS_LABEL[d.status] ?? 'Aguardando'}${d.status === 'open' && who ? ` · ${who}` : ''}`;
    }
    case 'notify': return d.phone ? `${d.name || 'Notificação'} → +${d.country || '55'} ${d.phone}` : '';
    case 'condition': {
      const rules: any[] = Array.isArray(d.rules) ? d.rules : d.field ? [d] : [];
      return rules.map((r) => ruleText(r, lk)).join(d.logic === 'any' ? '\nou ' : '\ne ');
    }
    case 'distributor': return (d.outputs ?? []).length ? `${(d.outputs ?? []).length} saídas · ${d.mode === 'next' ? 'sempre para o próximo' : 'prevenir repetição'}` : '';
    case 'goto_flow': return lk.flows.find((f) => f.id === d.flowId)?.name ? `→ ${lk.flows.find((f) => f.id === d.flowId)?.name}` : '';
    case 'pixel': {
      const px = lk.pixels.find((p) => p.id === d.pixelId);
      return px ? `${px.name} · ${d.event}${d.value ? ` · ${d.value}` : ''}` : '';
    }
    case 'delay': {
      if (d.mode === 'date') return d.date ? `Até ${String(d.date).replace('T', ' ')}` : '';
      if (d.mode === 'hours') return d.useBusinessHours ? 'Até o horário de atendimento' : `Até ${(d.days ?? []).map((x: number) => DAYS[x]).join(', ')} · ${d.from}–${d.to}`;
      return `Aguardar ${delayText(d)}`;
    }
    case 'department': return d.action === 'clear' ? 'Tirar a conversa do setor' : lk.departments.find((x) => x.id === d.departmentId)?.name ?? '';
    case 'http': return d.url ? `${d.method ?? 'GET'} ${String(d.url).replace(/^https?:\/\//, '')}` : '';
    case 'ai': {
      const prov: Record<string, string> = { converza: 'Converza IA', openai: 'GPT', gemini: 'Gemini', openrouter: 'OpenRouter' };
      return `${prov[d.provider] ?? 'Converza IA'}${d.model ? ` · ${d.model}` : ''}\n${String(d.prompt ?? '').split('\n')[0]}`;
    }
    case 'ai_agent': {
      if (d.action === 'remove') return 'Devolve a conversa para o fluxo';
      const a = lk.agents.find((x) => x.id === d.agentId);
      return a ? `Entrega para ${a.name}` : '';
    }
    case 'kanban': {
      const b = lk.kanban.find((x) => x.id === d.boardId);
      if (!b) return '';
      const c = b.columns.find((x) => x.id === d.columnId)?.name;
      return `${d.action === 'remove' ? 'Tirar de' : d.action === 'move' ? 'Mover em' : 'Adicionar em'} ${b.name}${c && d.action !== 'remove' ? ` › ${c}` : ''}`;
    }
    case 'set_var': {
      if (!d.name) return '';
      const sym: Record<string, string> = { set: '=', add: '+', subtract: '−', multiply: '×', divide: '÷', append: '+=', clear: '' };
      return d.op === 'clear' ? `Limpar ${d.name}` : `${d.name} ${sym[d.op] ?? '='} ${d.value ?? ''}`;
    }
    case 'sale': {
      const p = lk.products.find((x) => x.id === d.productId);
      return p ? `${p.name} · ${money(Number(p.price))} (preço reserva)` : '';
    }
    // antigos
    case 'media': {
      const kinds: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', document: '📄 Documento' };
      return `${kinds[d.mediaType] ?? 'Mídia'}${d.caption ? ` · ${d.caption}` : d.url ? '' : ' (sem link)'}`;
    }
    case 'random': return 'Divide os contatos aleatoriamente';
    case 'action': {
      const parts: string[] = [];
      if (d.setStage) parts.push(`Etapa → ${stageLabel(d.setStage)}`);
      const add = Array.isArray(d.addTags) ? d.addTags : [];
      const rem = Array.isArray(d.removeTags) ? d.removeTags : [];
      if (add.length) parts.push(`+ ${add.join(', ')}`);
      if (rem.length) parts.push(`− ${rem.join(', ')}`);
      if (d.setName) parts.push(`Nome → ${d.setName}`);
      if (d.kanbanBoardId) {
        const b = lk.kanban.find((x) => x.id === d.kanbanBoardId);
        const c = b?.columns.find((x) => x.id === d.kanbanColumnId)?.name;
        parts.push(b ? `Kanban → ${b.name}${c ? ` › ${c}` : ''}` : 'Kanban → quadro removido');
      }
      return parts.join(' · ');
    }
    case 'handoff': {
      const who = lk.team.find((t) => t.userId === d.assignUserId)?.name;
      if (who) return `Transferir para ${who}`;
      const dept = lk.departments.find((x) => x.id === d.departmentId)?.name;
      return dept ? `Fila do setor ${dept}` : 'Transferir para a equipe';
    }
    case 'payment': {
      const p = lk.products.find((x) => x.id === d.productId);
      const what = p ? `${p.name} (${money(Number(p.price))})` : d.url ? 'Link personalizado' : 'Sem produto/link';
      return `${what}${d.wait ? ` · aguarda até ${Number(d.timeoutMinutes ?? 60)} min` : ''}`;
    }
    case 'ai_reply': return String(d.prompt ?? '');
    case 'ai_classify': return `Classifica em ${(d.categories ?? []).length} categorias`;
    default: return '';
  }
}

/** Variáveis que podem ser usadas nos textos, a partir dos blocos do fluxo. */
export function variablesOf(nodes: { type?: string; data: Record<string, any> }[], fieldKeys: string[] = [], globalKeys: string[] = []): string[] {
  const vars = new Set<string>(['primeiro_nome', 'nome', 'telefone', 'email', 'resposta', 'saudacao', 'data', 'hora', 'dia', ...fieldKeys.map((k) => `campos.${k}`), ...globalKeys]);
  for (const n of nodes) {
    const d = n.data ?? {};
    switch (n.type) {
      case 'ask': if (d.saveAs) vars.add(d.saveAs); break;
      case 'menu': vars.add('opcao'); if (d.saveAs) vars.add(d.saveAs); break;
      case 'carousel': vars.add('opcao'); break;
      case 'template': vars.add('resposta_template'); break;
      case 'pix': vars.add('pix.codigo'); vars.add('pix.valor'); vars.add('pix.referencia'); break;
      case 'notify': vars.add('notificacao'); break;
      case 'http':
        vars.add(`${d.saveAs || 'http'}.campo`);
        vars.add(`${d.saveAs || 'http'}_status`);
        for (const m of Array.isArray(d.mappings) ? d.mappings : []) if (m?.var) vars.add(m.var);
        break;
      case 'ai':
        vars.add('ia.resposta'); vars.add('ia.erro'); vars.add('ia.transcricao'); vars.add('ia.condicao');
        if (d.saveAs) vars.add(String(d.saveAs));
        if (d.detectReceipt) ['comprovante.valido', 'comprovante.valor', 'comprovante.nome_pagador', 'comprovante.nome_recebedor', 'comprovante.data', 'comprovante.banco', 'comprovante.id_transacao', 'comprovante.currency', 'comprovante.chave_pix', 'comprovante.chave_ok', 'comprovante.nome_ok', 'comprovante.motivo'].forEach((v) => vars.add(v));
        break;
      case 'set_var': if (d.name) vars.add(String(d.name).replace(/^\{\{|\}\}$/g, '')); break;
      case 'sale': ['venda.cliente', 'venda.valor', 'venda.valor_numero', 'venda.moeda', 'venda.produto'].forEach((v) => vars.add(v)); break;
      case 'ai_reply': vars.add(d.saveAs || 'ia'); break;
      case 'ai_classify': vars.add('categoria'); break;
      case 'payment': vars.add('link_pagamento'); break;
      case 'trigger': if (d.type === 'webhook') { vars.add('produto'); vars.add('valor'); vars.add('evento'); } break;
      default: break;
    }
  }
  return [...vars];
}

export const sanitizeVarName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

/* ------------------------------------------------------------------ prévia no canvas */

export type PreviewPart =
  | { k: 'row'; icon: string; text: string; sub?: string }
  | { k: 'label'; text: string }
  | { k: 'chips'; items: { text: string; color?: string }[] }
  | { k: 'box'; title: string; sub?: string }
  | { k: 'note'; text: string }
  | { k: 'img'; fileId?: string; url?: string; name: string; caption?: string };

const ITEM_ICON: Record<string, string> = { text: 'chat', interval: 'clock', image: 'image', video: 'video', audio: 'mic', file: 'file', sticker: 'sticker', contact: 'contact' };
const ITEM_NAME: Record<string, string> = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', file: 'Arquivo', sticker: 'Sticker' };
const EVENT_PT: Record<string, string> = {
  Purchase: 'Compra', Lead: 'Lead', InitiateCheckout: 'Início de checkout', AddToCart: 'Adicionar ao carrinho', AddPaymentInfo: 'Dados de pagamento',
  CompleteRegistration: 'Cadastro', Contact: 'Contato', ViewContent: 'Ver conteúdo', Subscribe: 'Assinatura', Schedule: 'Agendamento', PlaceAnOrder: 'Pedido',
  CompletePayment: 'Pagamento concluído', SubmitForm: 'Formulário enviado',
};
const PREVIEW_MAX = 12;
const short = (s: unknown, n = 70) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const unitShort: Record<string, string> = { seconds: 's', minutes: 'min', hours: 'h', days: 'd' };

/**
 * O que compõe o bloco, para mostrar no canvas (itens da mensagem, etiquetas, setor, evento do pixel…).
 * Vazio = o bloco mostra só o resumo de texto (ou "clique duas vezes para configurar").
 */
export function preview(type: string, d: Record<string, any>, lk: Lookups): PreviewPart[] {
  switch (type) {
    case 'message': {
      const items: any[] = Array.isArray(d.items) ? d.items : d.text ? [{ type: 'text', text: d.text }] : [];
      const parts: PreviewPart[] = [];
      for (const it of items) {
        const t = String(it.type ?? 'text');
        if (t === 'text') {
          if (Number(it.typingSeconds) > 0) parts.push({ k: 'row', icon: 'edit', text: `Digitando: ${Number(it.typingSeconds)}s` });
          parts.push({ k: 'row', icon: 'chat', text: short(it.text) || 'Texto vazio' });
        } else if (t === 'interval') {
          if (it.mode === 'random') {
            const lo = Math.min(Number(it.min ?? 10), Number(it.max ?? 40)); const hi = Math.max(Number(it.min ?? 10), Number(it.max ?? 40));
            parts.push({ k: 'row', icon: 'shuffle', text: lo === hi ? `Delay: ${lo}s` : `Delay aleatório: ${lo}–${hi}s` });
          } else parts.push({ k: 'row', icon: 'clock', text: `Delay: ${Number(it.amount ?? 3)}${unitShort[it.unit ?? 'seconds'] ?? 's'}` });
        }
        else if (t === 'contact') parts.push({ k: 'row', icon: 'contact', text: `Contato: ${short(it.name, 40) || 'sem nome'}` });
        else if ((t === 'image' || t === 'sticker') && (it.fileId || /^https?:\/\//i.test(String(it.url ?? '').trim()))) {
          const name = it.fileName || (it.url ? String(it.url).split('/').pop() : '') || ITEM_NAME[t];
          parts.push({ k: 'img', fileId: it.fileId || undefined, url: it.fileId ? undefined : String(it.url).trim(), name: short(name, 48), caption: it.caption ? short(it.caption, 60) : undefined });
        } else {
          if (t === 'audio' && Number(it.recordingSeconds) > 0) parts.push({ k: 'row', icon: 'mic', text: `Gravando: ${Number(it.recordingSeconds)}s` });
          const name = it.filename || it.fileName || (it.url ? String(it.url).split('/').pop() : '');
          parts.push({ k: 'row', icon: ITEM_ICON[t] ?? 'file', text: `${ITEM_NAME[t] ?? 'Arquivo'}: ${short(name, 48) || 'sem arquivo'}`, sub: it.caption ? short(it.caption, 50) : undefined });
        }
      }
      if (parts.length > PREVIEW_MAX) {
        const extra = parts.length - PREVIEW_MAX;
        return [...parts.slice(0, PREVIEW_MAX), { k: 'note', text: `+ ${extra} ${extra === 1 ? 'item' : 'itens'}` }];
      }
      return parts;
    }
    case 'media': {
      const url = String(d.url ?? '').trim();
      if (d.mediaType === 'image' && /^https?:\/\//i.test(url)) return [{ k: 'img', url, name: short(url.split('/').pop(), 48), caption: d.caption ? short(d.caption, 60) : undefined }];
      return [];
    }
    case 'tags': {
      const tags: string[] = Array.isArray(d.tags) ? d.tags : [];
      if (!tags.length) return [];
      return [
        { k: 'label', text: d.mode === 'remove' ? 'Remover etiquetas do cliente:' : 'Adicionar etiquetas ao cliente:' },
        { k: 'chips', items: tags.map((t) => ({ text: t, color: lk.tags.find((x) => x.name === t)?.color })) },
      ];
    }
    case 'department': {
      if (d.action === 'clear') return [{ k: 'row', icon: 'building', text: 'Tirar a conversa do setor' }];
      const dep = lk.departments.find((x) => x.id === d.departmentId);
      return dep ? [{ k: 'label', text: 'Atribuir departamento ao chat:' }, { k: 'chips', items: [{ text: dep.name, color: dep.color }] }] : [];
    }
    case 'kanban': {
      const b = lk.kanban.find((x) => x.id === d.boardId);
      if (!b) return [];
      const c = b.columns.find((x) => x.id === d.columnId)?.name;
      const label = d.action === 'remove' ? 'Tirar o card de:' : d.action === 'move' ? 'Mover o card para:' : 'Adicionar card em:';
      return [{ k: 'label', text: label }, { k: 'box', title: b.name, sub: c && d.action !== 'remove' ? `Coluna: ${c}` : undefined }];
    }
    case 'pixel': {
      const px = lk.pixels.find((p) => p.id === d.pixelId);
      if (!px) return [];
      const plat = ({ meta: 'Facebook', meta_whatsapp: 'Facebook (WhatsApp)', tiktok: 'TikTok' } as Record<string, string>)[px.platform || d.platform] ?? 'Facebook';
      const value = d.value ? ` • Valor: ${/\{\{/.test(String(d.value)) ? d.value : `${d.value} ${d.currency || 'BRL'}`}` : '';
      return [{ k: 'label', text: `Disparar evento no ${plat}:` }, { k: 'box', title: px.name, sub: `Tipo: ${EVENT_PT[d.event] ?? d.event}${value}` }];
    }
    case 'condition': {
      const rules: any[] = Array.isArray(d.rules) ? d.rules : d.field ? [d] : [];
      if (!rules.length) return [];
      const joiner = d.logic === 'any' ? 'ou' : 'e';
      return [
        ...rules.slice(0, 4).map((r, i) => ({ k: 'box', title: `${i ? `${joiner} ` : ''}${ruleText(r, lk)}` }) as PreviewPart),
        ...(rules.length > 4 ? [{ k: 'note', text: `+ ${rules.length - 4} regras` } as PreviewPart] : []),
        { k: 'note', text: 'Caso não atenda a condição, o fluxo segue pela saída “Não”' },
      ];
    }
    case 'delay': {
      const s = summary('delay', d, lk);
      if (!s) return [];
      const text = d.mode === 'date' || d.mode === 'hours' ? s : `Espera de ${delayText(d)}`;
      return [{ k: 'row', icon: 'clock', text }];
    }
    case 'sale': {
      const p = lk.products.find((x) => x.id === d.productId);
      return p ? [{ k: 'label', text: 'Registrar venda:' }, { k: 'box', title: p.name, sub: money(Number(p.price)) }] : [];
    }
    case 'ai_agent': {
      if (d.action === 'remove') return [{ k: 'row', icon: 'bot', text: 'Devolve a conversa para o fluxo' }];
      const a = lk.agents.find((x) => x.id === d.agentId);
      return a ? [{ k: 'label', text: 'Entregar a conversa para:' }, { k: 'chips', items: [{ text: a.name }] }] : [];
    }
    case 'goto_flow': {
      const f = lk.flows.find((x) => x.id === d.flowId);
      return f ? [{ k: 'label', text: 'Ir para o fluxo:' }, { k: 'box', title: f.name }] : [];
    }
    case 'chat_status': {
      const who = lk.team.find((t) => t.userId === d.assignUserId)?.name;
      return [{ k: 'label', text: 'Status da conversa:' }, { k: 'chips', items: [{ text: STATUS_LABEL[d.status] ?? 'Aguardando' }, ...(d.status === 'open' && who ? [{ text: who }] : [])] }];
    }
    case 'http': return d.url ? [{ k: 'label', text: 'Chamar a API:' }, { k: 'box', title: `${d.method ?? 'GET'} ${String(d.url).replace(/^https?:\/\//, '')}` }] : [];
    case 'notify': return d.phone ? [{ k: 'label', text: 'Avisar pelo WhatsApp:' }, { k: 'box', title: d.name || 'Notificação', sub: `+${d.country || '55'} ${d.phone}` }] : [];
    default: return [];
  }
}
