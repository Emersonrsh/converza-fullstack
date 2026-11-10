export type Dict = Record<string, any>;

export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Dict;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** null = saída padrão do bloco; demais valores = saída nomeada (ex.: 'true', id de opção) */
  sourceHandle: string | null;
}

export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; }

export const BLOCK_TYPES = [
  'trigger', 'message', 'media', 'menu', 'ask', 'condition', 'delay', 'random',
  'action', 'handoff', 'http', 'payment', 'ai_reply', 'ai_classify', 'goto_flow',
  // blocos da barra "Ferramentas" (2026-11)
  'template', 'tags', 'pix', 'carousel', 'chat_status', 'notify', 'distributor', 'pixel',
  'department', 'ai', 'ai_agent', 'kanban', 'set_var', 'sale',
] as const;
export type BlockType = typeof BLOCK_TYPES[number];

/** Blocos antigos: continuam rodando nos fluxos que já os usam, mas não aparecem mais na barra. */
export const LEGACY_BLOCKS = ['media', 'random', 'action', 'handoff', 'payment', 'ai_reply', 'ai_classify'] as const;

const UNIT_SEC: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
/** Limite do WhatsApp/da fila para qualquer espera: 31 dias. */
export const MAX_WAIT_SECONDS = 31 * 86400;

/** amount + unidade → segundos (0 se vazio/inválido), no máximo 31 dias. */
export function durationSeconds(amount: unknown, unit: unknown): number {
  const n = Number(String(amount ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, Math.round(n * (UNIT_SEC[String(unit)] ?? 60)));
}

/** Botões de resposta de um carrossel (cada um vira uma saída). */
export function carouselReplyButtons(d: Dict): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const c of Array.isArray(d.cards) ? d.cards : []) {
    for (const b of Array.isArray(c?.buttons) ? c.buttons : []) {
      if (b?.id && (b.type ?? 'reply') === 'reply') out.push({ id: String(b.id), title: String(b.title ?? '') });
    }
  }
  return out;
}

/**
 * Botões de resposta na ordem em que o cliente os vê (como o carrossel é enviado: até 10 cartões; cartão com
 * botão de link mostra só o link; senão até 2 botões de resposta). Pelo QR Code eles viram opções numeradas.
 */
export function carouselVisibleReplies(d: Dict): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const c of (Array.isArray(d.cards) ? d.cards : []).slice(0, 10)) {
    const btns: Dict[] = Array.isArray(c?.buttons) ? c.buttons : [];
    if (btns.some((b) => b?.type === 'url')) continue;
    for (const b of btns.filter((x) => x?.id && (x.type ?? 'reply') === 'reply').slice(0, 2)) out.push({ id: String(b.id), title: String(b.title ?? '') });
  }
  return out;
}

/** "2", "2.", "2)" ou "2 - Quero esse" → 2 (resposta pelo número da opção). */
export function numberReply(text: unknown): number | null {
  const m = String(text ?? '').trim().match(/^(\d{1,2})(?:\s*[.)\-–:]|\s|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/** Botões de resposta rápida do modelo escolhido no bloco Template (guardados ao escolher o modelo). */
export function templateReplyButtons(d: Dict): { id: string; title: string }[] {
  return (Array.isArray(d.buttons) ? d.buttons : [])
    .map((b: Dict, i: number) => ({ b, i }))
    .filter(({ b }) => String(b?.type ?? '').toUpperCase() === 'QUICK_REPLY')
    .map(({ b, i }) => ({ id: `qr_${i}`, title: String(b.text ?? '') }));
}

/** O bloco Template espera a resposta do cliente? (0 = não espera) */
export const templateWaits = (d: Dict) => durationSeconds(d.timeoutAmount ?? 60, d.timeoutUnit ?? 'minutes') > 0;

export type TriggerType = 'any_message' | 'keyword' | 'first_message' | 'webhook' | 'manual';

export interface MenuOption { id: string; title: string; description?: string; }

export const STAGES = ['new', 'in_service', 'negotiating', 'won', 'lost'] as const;
export const STAGE_LABEL: Record<string, string> = {
  new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido',
};

/** Converte grafos antigos (x/y, branch) e dados soltos para o formato atual. */
export function normalizeGraph(raw: unknown): FlowGraph {
  const g = (raw ?? {}) as Dict;
  const nodes: FlowNode[] = (Array.isArray(g.nodes) ? g.nodes : [])
    .filter((n: Dict) => n && typeof n.id === 'string' && n.id.length > 0)
    .map((n: Dict) => ({
      id: n.id,
      type: String(n.type ?? 'message'),
      position: {
        x: Math.round(Number(n.position?.x ?? n.x ?? 0) || 0),
        y: Math.round(Number(n.position?.y ?? n.y ?? 0) || 0),
      },
      data: n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? { ...n.data } : {},
    }));

  // ids duplicados: mantém o primeiro
  const seen = new Set<string>();
  const unique = nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));

  for (const n of unique) {
    if (n.type === 'trigger' && (!n.data.type || n.data.type === 'inbound_message')) n.data.type = 'any_message';
  }

  const ids = new Set(unique.map((n) => n.id));
  const edges: FlowEdge[] = (Array.isArray(g.edges) ? g.edges : [])
    .filter((e: Dict) => e && ids.has(String(e.source)) && ids.has(String(e.target)))
    .map((e: Dict, i: number) => {
      const h = e.sourceHandle ?? e.branch ?? null;
      return {
        id: String(e.id ?? `e${i}_${e.source}_${e.target}`),
        source: String(e.source),
        target: String(e.target),
        sourceHandle: h === 'out' || h === '' ? null : h == null ? null : String(h),
      };
    });

  return { nodes: unique, edges };
}

/** Configuração do gatilho: o bloco "Início" do grafo é a fonte da verdade. */
export function triggerOf(flowTrigger: unknown, graph?: FlowGraph): Dict {
  const fromGraph = graph?.nodes.find((n) => n.type === 'trigger')?.data;
  const t: Dict = { ...((flowTrigger ?? {}) as Dict), ...(fromGraph ?? {}) };
  if (!t.type || t.type === 'inbound_message') t.type = 'any_message';
  return t;
}

/** Saídas de cada bloco (null = saída padrão). Usado para validar conexões. */
export function outputsOf(node: { type: string; data?: Dict }): (string | null)[] {
  const d = node.data ?? {};
  switch (node.type) {
    case 'condition': return ['true', 'false'];
    case 'random': return ['a', 'b'];
    case 'http': return ['success', 'error'];
    case 'menu':
      return [
        ...(Array.isArray(d.options) ? d.options.filter((o: Dict) => o?.id).map((o: Dict) => String(o.id)) : []), 'fallback',
        ...(durationSeconds(d.expireAmount, d.expireUnit) > 0 ? ['timeout'] : []),
      ];
    case 'carousel': {
      const btns = carouselReplyButtons(d).map((b) => b.id);
      if (!btns.length) return [null];
      return [...btns, 'fallback', ...(durationSeconds(d.expireAmount, d.expireUnit) > 0 ? ['timeout'] : [])];
    }
    case 'template':
      return templateWaits(d) ? [...templateReplyButtons(d).map((b) => b.id), 'replied', 'timeout'] : [null];
    case 'distributor':
      return (Array.isArray(d.outputs) ? d.outputs : []).filter((o: Dict) => o?.id).map((o: Dict) => String(o.id));
    case 'ai':
      return [
        ...(d.detectReceipt ? ['receipt'] : []),
        ...(d.detectReceipt && d.validatePixKey ? ['pix_wrong'] : []),
        ...(d.detectReceipt && d.validateRecipient ? ['name_wrong'] : []),
        ...(Array.isArray(d.conditions) ? d.conditions.filter((c: Dict) => c?.id).map((c: Dict) => String(c.id)) : []),
        null, 'error',
      ];
    case 'ai_classify':
      return [...(Array.isArray(d.categories) ? d.categories.filter((c: Dict) => c?.id).map((c: Dict) => String(c.id)) : []), 'none'];
    case 'payment': return d.wait ? ['paid', 'unpaid'] : [null];
    case 'ask': return [null, 'invalid', 'timeout'];
    case 'goto_flow': return [];
    default: return [null];
  }
}

export function blockCount(graph: FlowGraph): number {
  return graph.nodes.filter((n) => n.type !== 'trigger').length;
}
