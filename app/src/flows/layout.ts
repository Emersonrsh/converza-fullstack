import { outputsFor } from './blocks';

interface LNode { id: string; type?: string; data: Record<string, any>; measured?: { width?: number; height?: number }; }
interface LEdge { source: string; target: string; sourceHandle?: string | null; }

const COL_GAP = 110;
const ROW_GAP = 42;
const WIDTH = 260;

/**
 * Organiza os blocos em colunas a partir do Início: cada nível de distância
 * vira uma coluna, na ordem das saídas (opção 1 em cima, opção 2 embaixo...).
 * Blocos soltos ficam numa coluna extra no fim.
 */
export function tidyLayout(nodes: LNode[], edges: LEdge[]): Record<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = nodes.find((n) => n.type === 'trigger') ?? nodes[0];
  const pos: Record<string, { x: number; y: number }> = {};
  if (!start) return pos;

  const handleRank = (src: LNode, handle: string | null | undefined) => {
    const outs = outputsFor(src.type ?? '', src.data ?? {});
    const i = outs.findIndex((o) => (o.id ?? null) === (handle ?? null));
    return i < 0 ? outs.length : i;
  };

  const depth = new Map<string, number>([[start.id, 0]]);
  const order: string[] = [start.id];
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    const src = byId.get(id);
    if (!src) continue;
    const outs = edges.filter((e) => e.source === id && byId.has(e.target))
      .sort((a, b) => handleRank(src, a.sourceHandle) - handleRank(src, b.sourceHandle));
    for (const e of outs) {
      if (depth.has(e.target)) continue;
      depth.set(e.target, (depth.get(id) ?? 0) + 1);
      order.push(e.target);
      queue.push(e.target);
    }
  }

  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) {
    if (!depth.has(n.id)) { depth.set(n.id, maxDepth + 1); order.push(n.id); }
  }

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const d = depth.get(id)!;
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }

  const heightOf = (id: string) => byId.get(id)?.measured?.height ?? 150;
  for (const [d, ids] of columns) {
    const total = ids.reduce((s, id) => s + heightOf(id), 0) + ROW_GAP * (ids.length - 1);
    let y = -total / 2;
    for (const id of ids) {
      pos[id] = { x: d * (WIDTH + COL_GAP), y: Math.round(y) };
      y += heightOf(id) + ROW_GAP;
    }
  }
  return pos;
}
