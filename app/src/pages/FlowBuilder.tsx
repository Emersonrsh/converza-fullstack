import '@xyflow/react/dist/style.css';
import {
  useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type RefObject,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow,
  type Connection, type Edge, type EdgeChange, type NodeChange, type OnBeforeDelete, type OnConnectEnd, type XYPosition,
} from '@xyflow/react';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, toast, cx } from '../components/ui';
import {
  BLOCKS, TOOLS, defaultData, emptyLookups, outputsFor, rid, upgradeNode, variablesOf, type BlockType, type Lookups, type Output,
} from '../flows/blocks';
import {
  BuilderContext, EdgeHoverContext, ZoomControls, edgeTypes, nodeTypes, type BlockFlowNode,
} from '../flows/canvas';
import { BlockModal, type EditorCtx } from '../flows/editors';
import { Simulator } from '../flows/Simulator';
import { levelsByNode, validateFlow, type Issue } from '../flows/validate';
import { tidyLayout } from '../flows/layout';
import { GenerateModal, MoveModal, ProductsModal, ShareModal, TranslateModal } from '../flows/modals';
import type {
  Connection as WaConnection, Flow, FlowEdge, FlowFolder, FlowListItem, FlowNode, Member, NodeStat, Product, Webhook,
} from '../types';

type Meta = Pick<Flow, 'id' | 'name' | 'status' | 'archivedAt' | 'shareCode' | 'folderId' | 'updatedAt'>;
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
type ModalKind = null | 'share' | 'translate' | 'generate' | 'products' | 'move';
interface Snap { nodes: BlockFlowNode[]; edges: Edge[]; }
interface Picker { left: number; top: number; flow: XYPosition; source: string; sourceHandle: string | null; }

const NODE_W = 260;
const COL_GAP = 110;
const DND_TYPE = 'application/converza-block';

/** Área de transferência entre fluxos (mesma aba). */
let clipboard: Snap | null = null;

const errMsg = (e: unknown) => (e as Error)?.message ?? 'Algo deu errado';
const pickMeta = (f: Flow): Meta => ({
  id: f.id, name: f.name, status: f.status, archivedAt: f.archivedAt, shareCode: f.shareCode, folderId: f.folderId, updatedAt: f.updatedAt,
});

function toRfNode(n: FlowNode): BlockFlowNode {
  // blocos de fluxos antigos abrem já no formato novo (Mídia → Mensagem, Condição com várias regras…)
  const up = upgradeNode(n.type, n.data ?? {});
  return {
    id: n.id, type: up.type, data: up.data, deletable: n.type !== 'trigger',
    position: n.position ?? { x: n.x ?? 0, y: n.y ?? 0 },
  };
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Busca de blocos por nome ou descrição ("pix", "etiqueta", "ia"…). */
const searchTools = (q: string) => {
  const t = norm(q.trim());
  if (!t) return TOOLS;
  // primeiro quem tem a palavra no nome, depois quem tem na descrição
  const byName = TOOLS.filter((b) => norm(BLOCKS[b].label).includes(t));
  return [...byName, ...TOOLS.filter((b) => !byName.includes(b) && norm(BLOCKS[b].desc).includes(t))];
};
function toRfEdge(e: FlowEdge): Edge {
  return { id: e.id || rid('e'), source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, type: 'deletable' };
}
/** Remove conexões quebradas e mantém só uma por saída. */
function cleanEdges(edges: Edge[], nodes: BlockFlowNode[]): Edge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const bySource = new Map<string, Edge>();
  const seen = new Set<string>();
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    let id = e.id;
    while (seen.has(id)) id = rid('e');
    seen.add(id);
    bySource.set(`${e.source}|${e.sourceHandle ?? ''}`, { ...e, id });
  }
  return [...bySource.values()];
}
function toGraph(nodes: BlockFlowNode[], edges: Edge[]) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id, type: n.type ?? 'message', data: n.data,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}
const graphKey = (nodes: BlockFlowNode[], edges: Edge[]) => JSON.stringify(toGraph(nodes, edges));
const outsKey = (o: Output[]) => o.map((x) => x.id ?? '').join('|');

/** Ao mudar as saídas de um bloco, mantém as conexões que ainda fazem sentido. */
function remapEdges(edges: Edge[], nodeId: string, oldOuts: Output[], newOuts: Output[]): Edge[] {
  const valid = new Set(newOuts.map((o) => o.id ?? ''));
  const taken = new Set(edges.filter((e) => e.source === nodeId && valid.has(e.sourceHandle ?? '')).map((e) => e.sourceHandle ?? ''));
  return edges.flatMap((e) => {
    if (e.source !== nodeId || valid.has(e.sourceHandle ?? '')) return [e];
    const wasFirst = oldOuts.findIndex((o) => (o.id ?? '') === (e.sourceHandle ?? '')) === 0;
    const first = newOuts[0];
    if (wasFirst && first && !taken.has(first.id ?? '')) {
      taken.add(first.id ?? '');
      return [{ ...e, sourceHandle: first.id }];
    }
    return [];
  });
}

function useClickOutside(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, open, onClose]);
}

export function FlowBuilder() {
  const { id = '' } = useParams();
  return <ReactFlowProvider key={id}><Builder flowId={id} /></ReactFlowProvider>;
}

function Builder({ flowId }: { flowId: string }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const rf = useReactFlow<BlockFlowNode, Edge>();
  const stageRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<BlockFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const [name, setName] = useState('');
  const [lookups, setLookups] = useState<Lookups>(emptyLookups);
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const [stats, setStats] = useState<Record<string, NodeStat>>({});
  const [totals, setTotals] = useState({ runs: 0, active: 0, done: 0 });
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState('');
  const [showTools, setShowTools] = useState(() => window.innerWidth > 1180);
  const [showSim, setShowSim] = useState(false);
  const [simNodeId, setSimNodeId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [, bumpHistory] = useState(0);

  const lastSaved = useRef('');
  const loaded = useRef(false);
  const deleted = useRef(false);
  const pendingTidy = useRef(false);
  const savingP = useRef<Promise<void> | null>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useClickOutside(menuRef, menuOpen, closeMenu);

  /* ------------------------------------------------------------ carga */

  const loadStats = useCallback(() => {
    api.get<{ stats: Record<string, NodeStat>; totals: { runs: number; active: number; done: number } }>(`/flows/${flowId}/stats`)
      .then((r) => { setStats(r.stats); setTotals(r.totals); }).catch(() => {});
  }, [flowId]);

  const loadLookups = useCallback(async () => {
    const [c, w, t, p, f, k, cf, dp, gv, tg, ag, px, wb] = await Promise.allSettled([
      api.get<{ connections: WaConnection[] }>('/connections'),
      api.get<{ webhooks: Webhook[] }>('/webhooks'),
      api.get<{ members: Member[] }>('/team'),
      api.get<{ products: Product[] }>('/settings/products'),
      api.get<{ flows: FlowListItem[] }>('/flows'),
      api.get<{ boards: { id: string; name: string; columns: { id: string; name: string }[] }[] }>('/kanban/boards'),
      api.get<{ fields: { key: string; label: string }[] }>('/contacts/fields'),
      api.get<{ departments: { id: string; name: string; color: string }[] }>('/departments'),
      api.get<{ variables: { key: string; type: 'text' | 'number'; value: string }[] }>('/globals'),
      api.get<{ tags: { name: string; color: string }[] }>('/settings/tags'),
      api.get<{ agents: { id: string; name: string; avatar: string; enabled: boolean }[] }>('/agents'),
      api.get<{ pixels: { id: string; name: string; platform: string; status: string }[]; platforms: { id: string; label: string; events: string[] }[] }>('/pixels'),
      api.get<{ wabas: { id: string; name: string; displayPhone: string | null }[] }>('/templates/wabas'),
    ]);
    setLookups({
      connections: c.status === 'fulfilled' ? c.value.connections.map((x) => ({ id: x.id, name: x.displayPhone ? `${x.name} (${x.displayPhone})` : x.name })) : [],
      webhooks: w.status === 'fulfilled' ? w.value.webhooks.map((x) => ({ id: x.id, name: x.name })) : [],
      team: t.status === 'fulfilled' ? t.value.members.map((x) => ({ userId: x.userId, name: x.name })) : [],
      products: p.status === 'fulfilled' ? p.value.products : [],
      flows: f.status === 'fulfilled' ? f.value.flows.map((x) => ({ id: x.id, name: x.name, status: x.status, archived: !!x.archivedAt })) : [],
      kanban: k.status === 'fulfilled' ? k.value.boards.map((b) => ({ id: b.id, name: b.name, columns: b.columns.map((c) => ({ id: c.id, name: c.name })) })) : [],
      fields: cf.status === 'fulfilled' ? cf.value.fields.map((x) => ({ key: x.key, label: x.label })) : [],
      departments: dp.status === 'fulfilled' ? dp.value.departments.map((x) => ({ id: x.id, name: x.name, color: x.color })) : [],
      globals: gv.status === 'fulfilled' ? gv.value.variables.map((x) => ({ key: x.key, type: x.type, value: x.value })) : [],
      tags: tg.status === 'fulfilled' ? tg.value.tags.map((x) => ({ name: x.name, color: x.color })) : [],
      agents: ag.status === 'fulfilled' ? ag.value.agents.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar, enabled: x.enabled })) : [],
      pixels: px.status === 'fulfilled' ? px.value.pixels.map((x) => ({ id: x.id, name: x.name, platform: x.platform, status: x.status })) : [],
      platforms: px.status === 'fulfilled' ? px.value.platforms : [],
      wabas: wb.status === 'fulfilled' ? wb.value.wabas.map((x) => ({ id: x.id, name: x.name, displayPhone: x.displayPhone })) : [],
    });
  }, []);

  useEffect(() => {
    let alive = true;
    api.get<{ flow: Flow }>(`/flows/${flowId}`).then(({ flow }) => {
      if (!alive) return;
      const ns = flow.graph.nodes.map(toRfNode);
      const es = cleanEdges(flow.graph.edges.map(toRfEdge), ns);
      if (params.get('organizar')) {
        pendingTidy.current = true;
        setParams({}, { replace: true });
      }
      setNodes(ns); setEdges(es);
      lastSaved.current = graphKey(ns, es);
      loaded.current = true;
      setMeta(pickMeta(flow)); setName(flow.name);
    }).catch((e) => alive && setLoadError(errMsg(e)));
    loadStats();
    void loadLookups();
    api.get<{ folders: FlowFolder[] }>('/flow-folders').then((r) => alive && setFolders(r.folders)).catch(() => {});
    return () => { alive = false; };
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // estatísticas ao vivo
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadStats(); }, 20000);
    return () => clearInterval(t);
  }, [loadStats]);

  /* ------------------------------------------------------------ salvar */

  const persist = useCallback(async (): Promise<boolean> => {
    if (!loaded.current || deleted.current) return true;
    if (savingP.current) await savingP.current;
    const graph = toGraph(nodesRef.current, edgesRef.current);
    const key = JSON.stringify(graph);
    if (key === lastSaved.current) { setSaveState('saved'); return true; }
    setSaveState('saving');
    let ok = true;
    const p = (async () => {
      try {
        await api.put(`/flows/${flowId}`, { graph });
        lastSaved.current = key;
        setSaveError('');
        setSaveState(graphKey(nodesRef.current, edgesRef.current) === key ? 'saved' : 'dirty');
      } catch (e) {
        ok = false;
        setSaveError(errMsg(e));
        setSaveState('error');
      }
    })();
    savingP.current = p;
    await p;
    if (savingP.current === p) savingP.current = null;
    return ok;
  }, [flowId]);

  // salvamento automático
  useEffect(() => {
    if (!loaded.current || nodes.some((n) => n.dragging)) return;
    if (graphKey(nodes, edges) === lastSaved.current) {
      // a alteração foi desfeita antes de salvar: nada pendente
      setSaveState((s) => (s === 'dirty' ? 'saved' : s));
      return;
    }
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
    const t = setTimeout(() => { void persist(); }, 900);
    return () => clearTimeout(t);
  }, [nodes, edges, persist]);

  // não perder alterações ao sair
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (loaded.current && !deleted.current && graphKey(nodesRef.current, edgesRef.current) !== lastSaved.current) {
        e.preventDefault(); e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => {
      window.removeEventListener('beforeunload', h);
      if (loaded.current && !deleted.current) {
        const graph = toGraph(nodesRef.current, edgesRef.current);
        if (JSON.stringify(graph) !== lastSaved.current) void api.put(`/flows/${flowId}`, { graph }).catch(() => {});
      }
    };
  }, [flowId]);

  /* ------------------------------------------------------------ validação */

  const issuesKey = useRef('');
  useEffect(() => {
    const t = setTimeout(() => {
      const res = validateFlow(nodes, edges, lookups);
      const key = JSON.stringify(res);
      if (key !== issuesKey.current) { issuesKey.current = key; setIssues(res); }
    }, 250);
    return () => clearTimeout(t);
  }, [nodes, edges, lookups]);
  const levels = useMemo(() => levelsByNode(issues), [issues]);
  const errorCount = issues.filter((i) => i.level === 'error').length;

  /* ------------------------------------------------------------ histórico */

  const snapshot = useCallback(() => {
    past.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    if (past.current.length > 80) past.current.shift();
    future.current = [];
    bumpHistory((x) => x + 1);
  }, []);

  const restore = useCallback((snap: Snap) => {
    const sel = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    setNodes(snap.nodes.map((n) => (!!n.selected === sel.has(n.id) ? n : { ...n, selected: sel.has(n.id) })));
    setEdges(snap.edges);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    restore(prev);
    bumpHistory((x) => x + 1);
  }, [restore]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes: nodesRef.current, edges: edgesRef.current });
    restore(next);
    bumpHistory((x) => x + 1);
  }, [restore]);

  /* ------------------------------------------------------------ edição */

  const onNodesChange = useCallback((changes: NodeChange<BlockFlowNode>[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const link = useCallback((source: string, sourceHandle: string | null, target: string) => {
    setEdges((es) => [
      ...es.filter((e) => !(e.source === source && (e.sourceHandle ?? null) === sourceHandle)),
      { id: rid('e'), source, sourceHandle, target, type: 'deletable' },
    ]);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    snapshot();
    link(c.source, c.sourceHandle ?? null, c.target);
  }, [snapshot, link]);

  const isValidConnection = useCallback((c: Edge | Connection) => c.source !== c.target, []);

  const onConnectEnd: OnConnectEnd = useCallback((event, state) => {
    if (state.isValid || state.toNode || !state.fromNode || state.fromHandle?.type !== 'source') return;
    const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
    const fromId = state.fromNode.id;
    const handle = state.fromHandle.id ?? null;
    // soltou em cima de outro bloco (fora da bolinha): conecta nele
    const el = document.elementFromPoint(pt.clientX, pt.clientY)?.closest('.react-flow__node');
    const targetId = el?.getAttribute('data-id');
    if (targetId) {
      const target = nodesRef.current.find((n) => n.id === targetId);
      if (target && target.id !== fromId && target.type !== 'trigger') { snapshot(); link(fromId, handle, target.id); }
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPickerQuery('');
    setPicker({
      left: Math.min(Math.max(8, pt.clientX - rect.left), rect.width - 262),
      top: Math.min(Math.max(8, pt.clientY - rect.top), rect.height - 372),
      flow: rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }),
      source: fromId, sourceHandle: handle,
    });
  }, [rf, snapshot, link]);

  const onBeforeDelete: OnBeforeDelete<BlockFlowNode, Edge> = useCallback(async ({ nodes: ns, edges: es }) => {
    const keep = ns.filter((n) => n.type !== 'trigger');
    if (!keep.length && !es.length) return false;
    snapshot();
    return { nodes: keep, edges: es };
  }, [snapshot]);

  /** Se o ponto (do canvas) estiver fora da área visível, move a câmera até ele. */
  const ensureVisible = useCallback((pos: XYPosition) => {
    setTimeout(() => {
      const el = stageRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const c = { x: pos.x + NODE_W / 2, y: pos.y + 60 };
      const p = rf.flowToScreenPosition(c);
      const m = 90;
      if (p.x < rect.left + m || p.x > rect.right - m || p.y < rect.top + m || p.y > rect.bottom - m) {
        rf.setCenter(c.x, c.y, { zoom: rf.getZoom(), duration: 300 });
      }
    }, 60);
  }, [rf]);

  const createNode = useCallback((type: BlockType, position: XYPosition, from?: { source: string; sourceHandle: string | null }) => {
    snapshot();
    ensureVisible(position);
    const id = rid(type);
    const node: BlockFlowNode = { id, type, position, data: defaultData(type), selected: true, deletable: true };
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
    setEdges((es) => {
      const base = es.map((e) => (e.selected ? { ...e, selected: false } : e));
      if (!from) return base;
      return [
        ...base.filter((e) => !(e.source === from.source && (e.sourceHandle ?? null) === from.sourceHandle)),
        { id: rid('e'), source: from.source, sourceHandle: from.sourceHandle, target: id, type: 'deletable' },
      ];
    });
    // abre o editor do bloco novo
    setEditingId(id);
    return id;
  }, [snapshot, ensureVisible]);

  /** Um lugar livre perto do ponto (para o bloco novo não cair em cima de outro). */
  const freeSpot = useCallback((start: XYPosition): XYPosition => {
    const H = 190; // altura provável do bloco novo (cresce com as saídas depois de configurado)
    const rects = nodesRef.current.map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? 150 }));
    const hit = (p: XYPosition) => rects.some((r) => p.x < r.x + r.w + 24 && p.x + NODE_W + 24 > r.x && p.y < r.y + r.h + 24 && p.y + H + 24 > r.y);
    for (let ring = 0; ring < 7; ring++) {
      const steps = ring === 0 ? [[0, 0]] : [[0, ring], [0, -ring], [ring, 0], [ring, ring], [ring, -ring], [-ring, 0], [-ring, ring], [-ring, -ring]];
      for (const [dx, dy] of steps) {
        const p = { x: start.x + dx * (NODE_W + 50), y: start.y + dy * (H + 40) };
        if (!hit(p)) return p;
      }
    }
    return start;
  }, []);

  const addFromTools = useCallback((type: BlockType) => {
    const sel = nodesRef.current.filter((n) => n.selected);
    if (sel.length === 1) {
      const s = sel[0];
      const outs = outputsFor(s.type ?? '', s.data);
      const used = new Set(edgesRef.current.filter((e) => e.source === s.id).map((e) => e.sourceHandle ?? ''));
      const idx = outs.findIndex((o) => !used.has(o.id ?? ''));
      if (idx >= 0) {
        const w = s.measured?.width ?? NODE_W;
        createNode(type, freeSpot({ x: s.position.x + w + COL_GAP, y: s.position.y + idx * 80 }), { source: s.id, sourceHandle: outs[idx].id });
        return;
      }
    }
    const rect = stageRef.current?.getBoundingClientRect();
    const center = rect
      ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    createNode(type, freeSpot({ x: center.x - NODE_W / 2, y: center.y - 70 }));
  }, [createNode, rf, freeSpot]);

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e: DragEvent) => {
    const type = e.dataTransfer.getData(DND_TYPE) as BlockType;
    if (!type || !BLOCKS[type] || type === 'trigger') return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    createNode(type, { x: p.x - NODE_W / 2, y: p.y - 24 });
  };

  /** Salvar do editor: troca os dados do bloco de uma vez (com desfazer). */
  const replaceNodeData = useCallback((id: string, data: Record<string, any>) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    if (JSON.stringify(node.data) === JSON.stringify(data)) return;
    snapshot();
    const oldOuts = outputsFor(node.type ?? '', node.data);
    const newOuts = outputsFor(node.type ?? '', data);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data } : n)));
    if (outsKey(oldOuts) !== outsKey(newOuts)) setEdges((es) => remapEdges(es, id, oldOuts, newOuts));
  }, [snapshot]);

  const deleteNode = useCallback((id: string) => {
    if (nodesRef.current.find((n) => n.id === id)?.type === 'trigger') return;
    snapshot();
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  }, [snapshot]);

  const deselect = useCallback(() => {
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns));
  }, []);

  const pasteSnap = useCallback((snap: Snap, offset: number) => {
    if (!snap.nodes.length) return;
    snapshot();
    const map = new Map<string, string>();
    const fresh = snap.nodes.map((n) => {
      const id = rid(n.type ?? 'blk');
      map.set(n.id, id);
      return {
        id, type: n.type, deletable: true, selected: true,
        position: { x: n.position.x + offset, y: n.position.y + offset },
        data: JSON.parse(JSON.stringify(n.data)),
      } as BlockFlowNode;
    });
    const freshEdges = snap.edges.map((e) => ({
      id: rid('e'), source: map.get(e.source)!, target: map.get(e.target)!, sourceHandle: e.sourceHandle ?? null, type: 'deletable',
    }));
    setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), ...fresh]);
    setEdges((es) => [...es, ...freshEdges]);
  }, [snapshot]);

  const selectionSnap = useCallback((): Snap | null => {
    const sel = nodesRef.current.filter((n) => n.selected && n.type !== 'trigger');
    if (!sel.length) return null;
    const ids = new Set(sel.map((n) => n.id));
    return {
      nodes: sel.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
      edges: edgesRef.current.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
  }, []);

  const copySelection = useCallback(() => {
    const snap = selectionSnap();
    if (!snap) return;
    clipboard = JSON.parse(JSON.stringify(snap));
    toast(snap.nodes.length === 1 ? 'Bloco copiado — Ctrl+V para colar' : `${snap.nodes.length} blocos copiados — Ctrl+V para colar`);
  }, [selectionSnap]);

  const paste = useCallback(() => { if (clipboard) pasteSnap(clipboard, 48); }, [pasteSnap]);
  const duplicateNode = useCallback((id: string) => {
    const n = nodesRef.current.find((x) => x.id === id);
    if (!n || n.type === 'trigger') return;
    pasteSnap({ nodes: [{ id: n.id, type: n.type, position: n.position, data: n.data }], edges: [] }, 40);
  }, [pasteSnap]);
  const duplicateSelection = useCallback(() => { const s = selectionSnap(); if (s) pasteSnap(s, 40); }, [selectionSnap, pasteSnap]);

  const applyTidy = useCallback((withSnapshot: boolean) => {
    if (withSnapshot) snapshot();
    const pos = tidyLayout(nodesRef.current, edgesRef.current);
    setNodes((ns) => ns.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)));
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 400, maxZoom: 1 }), 30);
  }, [snapshot, rf]);

  // organiza assim que os blocos gerados pela IA forem medidos
  useEffect(() => {
    if (!pendingTidy.current || !nodes.length || !nodes.every((n) => n.measured?.height)) return;
    pendingTidy.current = false;
    applyTidy(false);
  }, [nodes, applyTidy]);

  /* ------------------------------------------------------------ atalhos */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.modal-bg')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) { e.preventDefault(); redo(); }
      else if (mod && k === 'c') { if (!window.getSelection()?.toString()) copySelection(); }
      else if (mod && k === 'v') { e.preventDefault(); paste(); }
      else if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); }
      else if (mod && k === 's') { e.preventDefault(); void persist().then((ok) => ok && toast('Salvo ✓')); }
      else if (k === 'escape') { setPicker(null); setMenuOpen(false); setIssuesOpen(false); deselect(); }
      else if (k === 'enter' && !mod && !t?.closest?.('button, a')) {
        // Enter abre o editor do bloco selecionado
        const sel = nodesRef.current.filter((n) => n.selected);
        if (sel.length === 1) { e.preventDefault(); setEditingId(sel[0].id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, copySelection, paste, duplicateSelection, persist, deselect]);

  /* ------------------------------------------------------------ simulador */

  const getGraph = useCallback(() => toGraph(nodesRef.current, edgesRef.current), []);
  const onCursor = useCallback((id: string | null) => setSimNodeId(id), []);

  useEffect(() => {
    if (!simNodeId) return;
    const n = rf.getNode(simNodeId);
    const el = stageRef.current;
    if (!n || !el) return;
    const rect = el.getBoundingClientRect();
    const w = n.measured?.width ?? NODE_W;
    const p = rf.flowToScreenPosition({ x: n.position.x + w / 2, y: n.position.y + 50 });
    const inside = p.x > rect.left + 60 && p.x < rect.right - 60 && p.y > rect.top + 60 && p.y < rect.bottom - 60;
    if (!inside) rf.setCenter(n.position.x + w / 2, n.position.y + 70, { zoom: rf.getZoom(), duration: 400 });
  }, [simNodeId, rf]);

  function toggleSim() {
    setShowSim((v) => {
      if (!v) { deselect(); if (window.innerWidth < 1500) setShowTools(false); }
      else setSimNodeId(null);
      return !v;
    });
  }

  /* ------------------------------------------------------------ ações do fluxo */

  const focusNode = useCallback((id: string) => {
    const n = rf.getNode(id);
    if (!n) return;
    setNodes((ns) => ns.map((x) => (!!x.selected === (x.id === id) ? x : { ...x, selected: x.id === id })));
    const w = n.measured?.width ?? NODE_W;
    rf.setCenter(n.position.x + w / 2, n.position.y + 70, { zoom: Math.max(rf.getZoom(), 0.9), duration: 350 });
    setIssuesOpen(false);
  }, [rf]);

  async function saveName() {
    if (!meta) return;
    const n = name.trim();
    if (!n || n === meta.name) { setName(meta.name); return; }
    try {
      const r = await api.put<{ flow: Flow }>(`/flows/${flowId}`, { name: n });
      setMeta(pickMeta(r.flow)); setName(r.flow.name);
    } catch (e) { toast(errMsg(e)); setName(meta.name); }
  }

  async function changeStatus(status: 'active' | 'paused') {
    if (!meta) return;
    if (status === 'active') {
      const fresh = validateFlow(nodesRef.current, edgesRef.current, lookups).filter((i) => i.level === 'error');
      if (fresh.length && !confirm(`Este fluxo tem ${fresh.length} ${fresh.length === 1 ? 'problema que pode' : 'problemas que podem'} fazer ele falhar com clientes reais (veja em “Problemas”). Ativar mesmo assim?`)) {
        setIssuesOpen(true);
        return;
      }
      if (!(await persist())) { toast('Não foi possível salvar o fluxo. Tente de novo.'); return; }
    }
    try {
      const r = await api.put<{ flow: Flow }>(`/flows/${flowId}`, { status });
      setMeta(pickMeta(r.flow));
      if (status === 'active') {
        const trig = nodesRef.current.find((n) => n.type === 'trigger')?.data?.type ?? 'any_message';
        const byMessage = ['any_message', 'keyword', 'first_message'].includes(trig);
        toast(byMessage && !lookups.connections.length
          ? 'Fluxo ativo — conecte um número em Conexões para ele responder no WhatsApp'
          : 'Fluxo ativo ✓ — já está respondendo no WhatsApp');
      } else toast('Fluxo pausado');
    } catch (e) { toast(errMsg(e)); }
  }

  async function goBack() {
    const ok = await persist();
    if (!ok && !confirm('Não foi possível salvar as últimas alterações. Sair mesmo assim?')) return;
    nav('/flows');
  }

  async function archive() {
    if (!confirm('Arquivar este fluxo? Ele é pausado e as conversas em andamento nele são encerradas. Você pode restaurar depois.')) return;
    try { await persist(); const r = await api.post<{ flow: Flow }>(`/flows/${flowId}/archive`); setMeta(pickMeta(r.flow)); toast('Fluxo arquivado'); }
    catch (e) { toast(errMsg(e)); }
  }
  async function unarchive() {
    try { const r = await api.post<{ flow: Flow }>(`/flows/${flowId}/unarchive`); setMeta(pickMeta(r.flow)); toast('Fluxo restaurado — ative quando quiser'); }
    catch (e) { toast(errMsg(e)); }
  }
  async function duplicateFlow() {
    try { await persist(); const r = await api.post<{ flow: Flow }>(`/flows/${flowId}/duplicate`); toast('Cópia criada ✓'); nav(`/flows/${r.flow.id}`); }
    catch (e) { toast(errMsg(e)); }
  }
  async function deleteFlow() {
    if (!meta || !confirm(`Excluir “${meta.name}” para sempre? As estatísticas e execuções dele também são apagadas.`)) return;
    try { deleted.current = true; await api.del(`/flows/${flowId}`); toast('Fluxo excluído'); nav('/flows'); }
    catch (e) { deleted.current = false; toast(errMsg(e)); }
  }
  async function moveTo(folderId: string | null) {
    try { const r = await api.put<{ flow: Flow }>(`/flows/${flowId}`, { folderId }); setMeta(pickMeta(r.flow)); setModal(null); toast('Fluxo movido ✓'); }
    catch (e) { toast(errMsg(e)); }
  }
  async function resetStats() {
    if (!confirm('Zerar as estatísticas (entradas, avanços e taxa) de todos os blocos deste fluxo?')) return;
    try { await api.del(`/flows/${flowId}/stats`); setStats({}); toast('Estatísticas zeradas'); }
    catch (e) { toast(errMsg(e)); }
  }
  function applyGenerated(graph: { nodes: FlowNode[]; edges: FlowEdge[] }) {
    snapshot();
    const ns = graph.nodes.map(toRfNode);
    const es = cleanEdges(graph.edges.map(toRfEdge), ns);
    pendingTidy.current = true;
    setNodes(ns); setEdges(es); setModal(null); setShowSim(false);
    toast('Fluxo gerado ✓ — revise os textos e teste no Simulador');
  }

  /* ------------------------------------------------------------ render */

  const ctx = useMemo(() => ({
    stats, simNodeId, lookups, levels, onEdit: setEditingId, onDuplicate: duplicateNode, onDelete: deleteNode,
  }), [stats, simNodeId, lookups, levels, duplicateNode, deleteNode]);
  const variables = useMemo(() => variablesOf(nodes, lookups.fields.map((f) => f.key), lookups.globals.map((g) => g.key)), [nodes, lookups.fields, lookups.globals]);
  const editingNode = editingId ? nodes.find((n) => n.id === editingId) ?? null : null;
  const editorCtx: EditorCtx | null = editingNode ? {
    lookups, setLookups, vars: variables, flowId, nodeId: editingNode.id, openProducts: () => setModal('products'),
    triggerConnectionId: String(nodes.find((n) => n.type === 'trigger')?.data?.connectionId ?? ''),
  } : null;
  const toolList = useMemo(() => searchTools(toolQuery), [toolQuery]);
  const pickerList = useMemo(() => searchTools(pickerQuery), [pickerQuery]);
  const triggerType = String(nodes.find((n) => n.type === 'trigger')?.data?.type ?? 'any_message');
  const blockTotal = nodes.filter((n) => n.type !== 'trigger').length;

  if (loadError) {
    return (
      <div className="center" style={{ flexDirection: 'column', gap: 12 }}>
        <b>{loadError}</b>
        <button className="btn" onClick={() => nav('/flows')}><Icon name="arrowLeft" size={15} />Voltar para Fluxos</button>
      </div>
    );
  }
  if (!meta) return <Spinner />;

  const status = meta.archivedAt ? 'archived' : meta.status;
  const statusPill: Record<string, [string, string]> = {
    active: ['green', 'Ativo'], paused: ['amber', 'Pausado'], draft: ['', 'Rascunho'], archived: ['', 'Arquivado'],
  };

  return (
    <div className="fbx" data-testid="flow-builder">
      <div className="fbx-top">
        <button type="button" className="btn icon sm ghost" onClick={goBack} title="Voltar para Fluxos" aria-label="Voltar"><Icon name="arrowLeft" size={18} /></button>
        <input className="fbx-name" value={name} maxLength={120} aria-label="Nome do fluxo" data-testid="flow-name"
          style={{ width: `${Math.max(10, name.length + 2)}ch` }}
          onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(meta.name); (e.target as HTMLInputElement).blur(); } }} />
        <span className={cx('pill dot', statusPill[status][0])} data-testid="flow-status">{statusPill[status][1]}</span>
        {saveState === 'error' ? (
          <button type="button" className="fbx-save err" style={{ border: 0, background: 'none', cursor: 'pointer' }} title={saveError} onClick={() => void persist()}>
            <Icon name="alert" size={14} />Erro ao salvar · tentar de novo
          </button>
        ) : (
          <span className={cx('fbx-save', saveState === 'dirty' && 'dirty')} data-testid="save-state">
            {saveState === 'saving' ? 'Salvando…' : saveState === 'dirty' ? 'Alterações não salvas' : <><Icon name="check" size={13} />Salvo</>}
          </span>
        )}
        <div className="spacer" />
        <button type="button" className={cx('btn sm', showTools && 'on')} onClick={() => setShowTools((v) => !v)} data-testid="toggle-tools"><Icon name="grid" size={15} />Ferramentas</button>
        <button type="button" className={cx('btn sm', showSim && 'on')} onClick={toggleSim} data-testid="toggle-sim"><Icon name="play" size={15} />Simular</button>
        {meta.archivedAt ? (
          <button type="button" className="btn sm primary" onClick={unarchive}><Icon name="archive" size={15} />Restaurar</button>
        ) : meta.status === 'active' ? (
          <button type="button" className="btn sm" onClick={() => changeStatus('paused')} data-testid="status-btn"><Icon name="pause" size={15} />Pausar</button>
        ) : (
          <button type="button" className="btn sm primary" onClick={() => changeStatus('active')} data-testid="status-btn"><Icon name="bolt" size={15} />Ativar</button>
        )}
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="btn icon sm" onClick={() => setMenuOpen((v) => !v)} aria-label="Mais ações" data-testid="flow-menu"><Icon name="dots" size={16} /></button>
          {menuOpen && (
            <div className="menu fade" onClick={() => setMenuOpen(false)}>
              <button type="button" onClick={() => setModal('generate')}><Icon name="sparkles" size={15} />Gerar com IA</button>
              <button type="button" onClick={() => applyTidy(true)}><Icon name="grid" size={15} />Organizar blocos</button>
              <div className="sep" />
              <button type="button" onClick={() => setModal('share')}><Icon name="share" size={15} />Compartilhar (código)</button>
              <button type="button" onClick={async () => { if (await persist()) setModal('translate'); }}><Icon name="translate" size={15} />Traduzir</button>
              <button type="button" onClick={duplicateFlow}><Icon name="copy" size={15} />Duplicar fluxo</button>
              <button type="button" onClick={() => setModal('move')}><Icon name="folder" size={15} />Mover para pasta</button>
              <button type="button" onClick={() => setModal('products')}><Icon name="dollar" size={15} />Pagamentos (produtos)</button>
              <button type="button" onClick={resetStats}><Icon name="refresh" size={15} />Zerar estatísticas</button>
              <div className="sep" />
              {meta.archivedAt
                ? <button type="button" onClick={unarchive}><Icon name="archive" size={15} />Restaurar do arquivo</button>
                : <button type="button" onClick={archive}><Icon name="archive" size={15} />Arquivar</button>}
              <button type="button" className="danger" onClick={deleteFlow}><Icon name="trash" size={15} />Excluir fluxo</button>
            </div>
          )}
        </div>
      </div>

      {meta.archivedAt && (
        <div className="note warn" style={{ borderRadius: 0, alignItems: 'center' }}>
          <Icon name="archive" size={15} /><span style={{ flex: 1 }}>Este fluxo está arquivado e não responde clientes.</span>
          <button type="button" className="btn sm" onClick={unarchive}>Restaurar</button>
        </div>
      )}

      <div className="fbx-body">
        {showTools && (
          <aside className="fb-tools" data-testid="tools">
            <div className="fb-tools-h">
              <b>Ferramentas</b>
              <div className="fb-search">
                <Icon name="search" size={14} />
                <input value={toolQuery} placeholder="Buscar blocos..." onChange={(e) => setToolQuery(e.target.value)} data-testid="tools-search" />
                {toolQuery && <button type="button" onClick={() => setToolQuery('')} aria-label="Limpar busca"><Icon name="close" size={12} /></button>}
              </div>
            </div>
            <div className="fb-tools-l">
              {toolList.map((t) => (
                <button type="button" key={t} className="tool" style={{ '--c': BLOCKS[t].color } as CSSProperties} draggable
                  onDragStart={(e) => { e.dataTransfer.setData(DND_TYPE, t); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => addFromTools(t)} data-testid={`tool-${t}`}>
                  <span className="ti"><Icon name={BLOCKS[t].icon} size={15} stroke={2.2} /></span>
                  <span><b>{BLOCKS[t].label}</b><small>{BLOCKS[t].desc}</small></span>
                </button>
              ))}
              {!toolList.length && <div className="faint" style={{ fontSize: 12, padding: '10px 4px' }}>Nenhum bloco com “{toolQuery}”.</div>}
            </div>
            <div className="tip">
              Clique para adicionar — com um bloco selecionado, o novo já sai conectado nele. Ou arraste para o canvas.
              Clique duas vezes num bloco para editar.
              <br /><br />Atalhos: <b>Enter</b> edita · <b>Ctrl+Z</b> desfaz · <b>Ctrl+C / Ctrl+V</b> copia e cola · <b>Ctrl+D</b> duplica · <b>Delete</b> apaga.
            </div>
          </aside>
        )}

        <div className="fb-stage" ref={stageRef} onDragOver={onDragOver} onDrop={onDrop}>
          <BuilderContext.Provider value={ctx}>
            <EdgeHoverContext.Provider value={hoverEdge}>
              <ReactFlow<BlockFlowNode, Edge>
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onConnectEnd={onConnectEnd}
                isValidConnection={isValidConnection}
                onBeforeDelete={onBeforeDelete}
                onNodeDragStart={snapshot}
                onNodeDoubleClick={(_, n) => setEditingId(n.id)}
                onPaneClick={() => { setPicker(null); setIssuesOpen(false); }}
                onEdgeMouseEnter={(_, e) => setHoverEdge(e.id)}
                onEdgeMouseLeave={() => setHoverEdge(null)}
                defaultEdgeOptions={{ type: 'deletable' }}
                deleteKeyCode={editingId ? null : ['Backspace', 'Delete']}
                fitView
                fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={2}
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
                <MiniMap pannable zoomable nodeStrokeWidth={0} nodeBorderRadius={10} style={{ width: 180, height: 120 }}
                  nodeColor={(n) => BLOCKS[n.type as BlockType]?.color ?? '#94a3b8'} ariaLabel="Mini mapa" />
                <ZoomControls />
              </ReactFlow>
            </EdgeHoverContext.Provider>
          </BuilderContext.Provider>

          <div className="fb-float tl">
            <button type="button" className={cx('fb-chip', errorCount ? 'warn' : issues.length ? 'warn' : 'ok')} onClick={() => setIssuesOpen((v) => !v)} data-testid="issues-chip">
              <Icon name={issues.length ? 'alert' : 'check'} size={14} />
              {issues.length ? <><b>{issues.length}</b> {issues.length === 1 ? 'problema' : 'problemas'}</> : 'Sem problemas'}
            </button>
            <span className="fb-chip stats" title="Contatos reais que passaram por este fluxo" style={{ cursor: 'default' }}>
              <Icon name="trend" size={14} /><b>{totals.runs}</b> execuções · <b>{totals.active}</b> em andamento
            </span>
          </div>

          <div className="fb-float tr">
            <button type="button" className="fb-chip" onClick={undo} disabled={!past.current.length} title="Desfazer (Ctrl+Z)" aria-label="Desfazer" style={{ opacity: past.current.length ? 1 : 0.5 }}>↶</button>
            <button type="button" className="fb-chip" onClick={redo} disabled={!future.current.length} title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer" style={{ opacity: future.current.length ? 1 : 0.5 }}>↷</button>
            <button type="button" className="fb-chip" onClick={() => applyTidy(true)} title="Organizar os blocos automaticamente" aria-label="Organizar"><Icon name="grid" size={14} /><span className="lbl">Organizar</span></button>
          </div>

          {issuesOpen && (
            <div className="card fb-issues fade" data-testid="issues">
              {issues.length === 0 && <div className="empty" style={{ padding: 18 }}>Nenhum problema encontrado ✓</div>}
              {issues.map((i, k) => (
                <button type="button" key={k} onClick={() => focusNode(i.nodeId)}>
                  <span className={cx('lv', i.level)}><Icon name="alert" size={14} /></span><span>{i.text}</span>
                </button>
              ))}
            </div>
          )}

          {blockTotal === 0 && (
            <div className="fb-empty">
              <div className="card fade">
                <b style={{ fontSize: 15 }}>Monte seu fluxo</b>
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: '8px 0 14px' }}>
                  Tudo começa no bloco <b>Início</b>. Arraste blocos da barra <b>Ferramentas</b>, ou puxe a bolinha do Início e solte no vazio para escolher o próximo bloco.
                </p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  {!showTools && <button type="button" className="btn sm" onClick={() => setShowTools(true)}><Icon name="grid" size={14} />Ferramentas</button>}
                  <button type="button" className="btn sm primary" onClick={() => setModal('generate')}><Icon name="sparkles" size={14} />Gerar com IA</button>
                </div>
              </div>
            </div>
          )}

          {picker && (
            <div className="card fb-picker fade" style={{ left: picker.left, top: picker.top }} data-testid="block-picker">
              <div className="faint" style={{ fontSize: 11.5, fontWeight: 700, padding: '4px 6px 6px' }}>Adicionar bloco conectado</div>
              <div className="fb-search sm">
                <Icon name="search" size={13} />
                <input autoFocus value={pickerQuery} placeholder="Buscar blocos..." onChange={(e) => setPickerQuery(e.target.value)} data-testid="picker-search"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setPicker(null);
                    if (e.key === 'Enter' && pickerList[0]) {
                      createNode(pickerList[0], { x: picker.flow.x, y: picker.flow.y - 22 }, { source: picker.source, sourceHandle: picker.sourceHandle });
                      setPicker(null);
                    }
                  }} />
              </div>
              <div className="fb-picker-l">
                {pickerList.map((t) => (
                  <button type="button" key={t} onClick={() => {
                    createNode(t, { x: picker.flow.x, y: picker.flow.y - 22 }, { source: picker.source, sourceHandle: picker.sourceHandle });
                    setPicker(null);
                  }} data-testid={`pick-${t}`}>
                    <span className="ti" style={{ background: BLOCKS[t].color }}><Icon name={BLOCKS[t].icon} size={12} stroke={2.4} /></span>{BLOCKS[t].label}
                  </button>
                ))}
                {!pickerList.length && <div className="faint" style={{ fontSize: 12, padding: 8 }}>Nada encontrado</div>}
              </div>
            </div>
          )}
        </div>

        {showSim && (
          <Simulator triggerType={triggerType} getGraph={getGraph} onCursor={onCursor}
            onClose={() => { setShowSim(false); setSimNodeId(null); }} />
        )}
      </div>

      {editingNode && editorCtx && (
        <BlockModal key={editingNode.id} node={editingNode} ctx={editorCtx}
          onSave={(data) => { replaceNodeData(editingNode.id, data); setEditingId(null); }}
          onClose={() => setEditingId(null)}
          onDelete={() => { deleteNode(editingNode.id); setEditingId(null); }} />
      )}

      {modal === 'generate' && (
        <GenerateModal replacing={blockTotal > 0} onClose={() => setModal(null)}
          onGenerated={(g) => applyGenerated(g as { nodes: FlowNode[]; edges: FlowEdge[] })} />
      )}
      {modal === 'share' && <ShareModal flowId={flowId} onClose={() => setModal(null)} onChange={(c) => setMeta((m) => (m ? { ...m, shareCode: c } : m))} />}
      {modal === 'translate' && <TranslateModal flowId={flowId} onClose={() => setModal(null)} onDone={(f) => { setModal(null); nav(`/flows/${f.id}`); }} />}
      {modal === 'move' && <MoveModal current={meta.folderId} folders={folders} onClose={() => setModal(null)} onMove={moveTo} />}
      {modal === 'products' && (
        <ProductsModal onClose={() => setModal(null)}
          onChange={(list) => setLookups((l) => ({ ...l, products: list }))} />
      )}
    </div>
  );
}
