import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, type Edge } from '@xyflow/react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Spinner } from '../components/ui';
import { BuilderContext, DEFAULT_HANDLE, ZoomControls, edgeTypes, hasOutputRows, nodeTypes, type BlockFlowNode, type BuilderCtx } from '../flows/canvas';
import { BLOCKS, emptyLookups, upgradeNode, type BlockType, type Lookups } from '../flows/blocks';
import type { Flow, FlowNode } from '../types';
import { resumeRun } from './FlowControls';

const noop = () => {};

function toNode(n: FlowNode, stoppedAt: string | null): BlockFlowNode {
  const up = upgradeNode(n.type, n.data ?? {});
  return {
    id: n.id, type: up.type, data: up.data, position: n.position ?? { x: n.x ?? 0, y: n.y ?? 0 },
    draggable: false, connectable: false, deletable: false,
    className: n.id === stoppedAt ? 'rf-stopped' : undefined,
  };
}

/**
 * "Retomar fluxo": mostra o fluxo inteiro (só leitura) e deixa escolher o bloco de onde ele volta a rodar.
 * O bloco onde parou já vem marcado: retomar nele continua do ponto exato (ex.: a mensagem que falhou).
 */
export function ResumeFlowModal({ convId, runId, flowId, flowName, stoppedAt, failed, onClose, mode = 'resume', onStart, lastInfo }: {
  convId: string; runId?: string; flowId: string; flowName: string; stoppedAt: string | null; failed: boolean; onClose: () => void;
  /** 'start': dispara o fluxo a partir do bloco escolhido (de uma execução que já terminou ou nunca rodou) */
  mode?: 'resume' | 'start'; onStart?: (nodeId: string) => Promise<boolean>; lastInfo?: string | null;
}) {
  const starting = mode === 'start';
  const [flow, setFlow] = useState<Flow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(stoppedAt);
  const [busy, setBusy] = useState(false);
  const [lookups, setLookups] = useState<Lookups>(emptyLookups);

  useEffect(() => {
    api.get<{ flow: Flow }>(`/flows/${flowId}`).then((r) => setFlow(r.flow)).catch((e) => setErr(e instanceof Error ? e.message : 'Não foi possível abrir o fluxo'));
    // nomes de produtos, fluxos, conexões e pixels nos blocos (o resto aparece pelo resumo do bloco)
    void Promise.allSettled([
      api.get<{ products: Lookups['products'] }>('/settings/products'),
      api.get<{ flows: { id: string; name: string; status: string; archivedAt: string | null }[] }>('/flows'),
      api.get<{ connections: { id: string; name: string; displayPhone: string | null }[] }>('/connections'),
      api.get<{ pixels: { id: string; name: string; platform: string; status: string }[] }>('/pixels'),
    ]).then(([p, f, c, px]) => setLookups((l) => ({
      ...l,
      products: p.status === 'fulfilled' ? p.value.products : [],
      flows: f.status === 'fulfilled' ? f.value.flows.map((x) => ({ id: x.id, name: x.name, status: x.status, archived: !!x.archivedAt })) : [],
      connections: c.status === 'fulfilled' ? c.value.connections.map((x) => ({ id: x.id, name: x.displayPhone ? `${x.name} (${x.displayPhone})` : x.name })) : [],
      pixels: px.status === 'fulfilled' ? px.value.pixels.map((x) => ({ id: x.id, name: x.name, platform: x.platform, status: x.status })) : [],
    })));
  }, [flowId]);

  const nodes = useMemo(() => (flow ? flow.graph.nodes.map((n) => toNode(n, stoppedAt)) : []), [flow, stoppedAt]);
  const edges = useMemo<Edge[]>(() => {
    if (!flow) return [];
    const rows = new Map(nodes.map((n) => [n.id, hasOutputRows(n.type ?? '', (n.data ?? {}) as Record<string, any>)]));
    return flow.graph.edges.map((e, i) => ({
      id: e.id || `e${i}`, source: e.source, target: e.target, type: 'deletable', deletable: false, selectable: false,
      sourceHandle: e.sourceHandle ?? (rows.get(e.source) ? DEFAULT_HANDLE : null),
    }));
  }, [flow, nodes]);

  const picked = nodes.find((n) => n.id === pick);
  const pickedName = picked ? String(picked.data?.title || BLOCKS[picked.type as BlockType]?.label || 'Bloco') : null;
  const ctx = useMemo<BuilderCtx>(() => ({ stats: {}, simNodeId: pick, lookups, levels: {}, onEdit: (id) => setPick(id), onDuplicate: noop, onDelete: noop }), [pick, lookups]);
  const same = !!pick && pick === stoppedAt;

  async function go() {
    if (!pick) return;
    setBusy(true);
    const ok = starting ? await onStart!(pick) : await resumeRun(convId, { runId, nodeId: same ? null : pick });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Modal title={starting ? 'Disparar a partir de uma etapa' : 'Retomar fluxo'} subtitle={flowName} icon="play" width={1080} onClose={onClose}
      footer={
        <div className="rfm-ft">
          <span className="rfm-pick" data-testid="resume-pick">
            {pick
              ? starting
                ? <>Começa a partir de <b>{pickedName}</b>{same ? ' — onde ele parou da última vez' : ''}</>
                : <>Volta a rodar a partir de <b>{pickedName}</b>{same ? (failed ? ' — reenvia o que não saiu e segue' : ' — onde ele parou') : ' — do começo desse bloco'}</>
              : starting ? 'Clique no bloco de onde o fluxo deve começar' : 'Clique no bloco de onde o fluxo deve voltar a rodar'}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!pick || busy} onClick={() => void go()} data-testid="resume-go">
            <Icon name="play" size={14} />{busy ? (starting ? 'Disparando…' : 'Retomando…') : (starting ? 'Disparar daqui' : 'Retomar fluxo')}
          </button>
        </div>
      }>
      <div className="rfm-hint">
        <Icon name="info" size={14} />
        {starting ? (
          <span>
            {stoppedAt ? <>{lastInfo ?? 'O bloco com borda tracejada é onde ele parou da última vez com este contato.'} </> : 'Este contato ainda não passou por este fluxo. '}
            Clique no bloco de onde ele deve começar; as respostas que o cliente já deu neste fluxo continuam valendo.
          </span>
        ) : (
          <span>
            {failed ? 'O fluxo parou porque uma mensagem não saiu.' : 'O fluxo está pausado.'} O bloco com borda tracejada é onde ele parou.
            Clique em outro bloco para recomeçar dali.
          </span>
        )}
      </div>
      <div className="rfm-canvas" data-testid="resume-canvas">
        {err && <div className="hint warn"><Icon name="alert" size={14} />{err}</div>}
        {!flow && !err && <div className="rfm-load"><Spinner /></div>}
        {flow && (
          <ReactFlowProvider>
            <BuilderContext.Provider value={ctx}>
              <ReactFlow<BlockFlowNode, Edge>
                nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
                onNodeClick={(_, n) => setPick(n.id)}
                onInit={(rf) => { setTimeout(() => void rf.fitView({ padding: 0.15, maxZoom: 1 }), 120); }}
                fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.1} maxZoom={1.6} zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} />
                <ZoomControls />
              </ReactFlow>
            </BuilderContext.Provider>
          </ReactFlowProvider>
        )}
      </div>
    </Modal>
  );
}
