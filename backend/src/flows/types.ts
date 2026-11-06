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
] as const;
export type BlockType = typeof BLOCK_TYPES[number];

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
      return [...(Array.isArray(d.options) ? d.options.filter((o: Dict) => o?.id).map((o: Dict) => String(o.id)) : []), 'fallback'];
    case 'ai_classify':
      return [...(Array.isArray(d.categories) ? d.categories.filter((c: Dict) => c?.id).map((c: Dict) => String(c.id)) : []), 'none'];
    case 'payment': return d.wait ? ['paid', 'unpaid'] : [null];
    case 'ask': return [null, 'invalid'];
    case 'goto_flow': return [];
    default: return [null];
  }
}

export function blockCount(graph: FlowGraph): number {
  return graph.nodes.filter((n) => n.type !== 'trigger').length;
}
