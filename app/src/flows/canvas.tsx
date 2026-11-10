import { createContext, memo, useContext, useEffect, useState, type CSSProperties } from 'react';
import { cachedSignedUrl } from './editors/fields';
import {
  BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, useReactFlow, useUpdateNodeInternals,
  type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import { Icon } from '../icons';
import { cx } from '../components/ui';
import { money } from '../api';
import { BLOCKS, emptyLookups, outputsFor, preview, summary, type BlockType, type Lookups, type PreviewPart } from './blocks';
import type { IssueLevel } from './validate';
import type { NodeStat } from '../types';

export type BlockNodeData = Record<string, any>;
export type BlockFlowNode = Node<BlockNodeData>;

export interface BuilderCtx {
  stats: Record<string, NodeStat>;
  simNodeId: string | null;
  lookups: Lookups;
  levels: Record<string, IssueLevel>;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}
const noop = () => {};
export const BuilderContext = createContext<BuilderCtx>({
  stats: {}, simNodeId: null, lookups: emptyLookups, levels: {}, onEdit: noop, onDuplicate: noop, onDelete: noop,
});

/** Contexto separado para o hover das conexões (não re-renderiza os blocos). */
export const EdgeHoverContext = createContext<string | null>(null);

export const BlockNode = memo(function BlockNode({ id, type, data, selected }: NodeProps<BlockFlowNode>) {
  const ctx = useContext(BuilderContext);
  const meta = BLOCKS[type as BlockType] ?? BLOCKS.message;
  const outs = outputsFor(type, data);
  const updateInternals = useUpdateNodeInternals();
  const handlesKey = outs.map((o) => `${o.id ?? 'out'}:${o.label}`).join('|');
  useEffect(() => { updateInternals(id); }, [id, handlesKey, updateInternals]);

  const st = ctx.stats[id];
  const entries = st?.entries ?? 0;
  const advances = st?.advances ?? 0;
  const rate = entries ? Math.min(100, Math.round((advances / entries) * 100)) : 0;
  const rows = hasOutputRows(type, data);
  const parts = preview(type, data, ctx.lookups);
  const text = parts.length ? '' : summary(type, data, ctx.lookups);
  const level = ctx.levels[id];

  return (
    <div
      className={cx('blk', selected && 'sel', ctx.simNodeId === id && 'sim', !!level && 'bad', level === 'error' && 'err')}
      style={{ '--c': meta.color } as CSSProperties}
      data-testid={`block-${type}`}
    >
      {type !== 'trigger' && <Handle type="target" position={Position.Left} className="blk-hin" />}
      <div className="blk-tools nodrag nopan" onDoubleClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onEdit(id); }} title="Editar (Enter)" aria-label="Editar bloco" data-testid="blk-edit"><Icon name="edit" size={13} /></button>
        {type !== 'trigger' && (<>
          <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onDuplicate(id); }} title="Duplicar" aria-label="Duplicar bloco" data-testid="blk-dup"><Icon name="copy" size={13} /></button>
          <button type="button" className="del" onClick={(e) => { e.stopPropagation(); ctx.onDelete(id); }} title="Excluir" aria-label="Excluir bloco" data-testid="blk-del"><Icon name="trash" size={13} /></button>
        </>)}
      </div>
      <div className="blk-hd">
        <span className="blk-ic"><Icon name={meta.icon} size={14} stroke={2.2} /></span>
        <span className="blk-tt">{data.title || meta.label}</span>
      </div>
      {parts.length ? <Preview parts={parts} /> : <div className={cx('blk-bd', !text && 'empty')}>{text || 'Clique duas vezes para configurar'}</div>}
      {rows ? (
        <div className="blk-outs">
          {outs.map((o) => (
            <div key={o.id ?? 'out'} className={cx('blk-out', o.tone)}>
              <span title={o.label}>{o.label || 'Continuar'}</span>
              <Handle type="source" position={Position.Right} id={o.id ?? DEFAULT_HANDLE} className="blk-hout" />
            </div>
          ))}
        </div>
      ) : outs.length === 1 ? (
        <Handle type="source" position={Position.Right} className="blk-hout solo" />
      ) : null}
      <div className="blk-ft" title="Estatísticas de contatos reais (a simulação não conta)">
        <span><b>{entries}</b> entradas</span>
        <span><b>{advances}</b> avanços</span>
        <span><b>{rate}%</b> taxa</span>
      </div>
    </div>
  );
});

/** O que compõe o bloco: itens da mensagem, etiquetas, setor, evento do pixel… */
/** Miniatura da imagem do bloco (arquivo enviado = link assinado; link = direto). */
function ImagePreview({ part }: { part: Extract<PreviewPart, { k: 'img' }> }) {
  const [src, setSrc] = useState<string | null>(part.url ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
    if (!part.fileId) { setSrc(part.url ?? null); return; }
    let on = true;
    void cachedSignedUrl(part.fileId).then((u) => { if (on) setSrc(u); });
    return () => { on = false; };
  }, [part.fileId, part.url]);
  return (
    <div className="pv-img" data-testid="pv-img">
      <div className="pv-img-frame">
        {src && !broken
          ? <img src={src} alt={part.name} loading="lazy" draggable={false} onError={() => setBroken(true)} />
          : <span className="pv-img-ph"><Icon name="image" size={20} />{broken ? 'Não foi possível carregar' : 'Carregando…'}</span>}
      </div>
      {part.caption ? <small className="pv-img-cap">{part.caption}</small> : null}
    </div>
  );
}

/**
 * A saída padrão (id null no fluxo) precisa de um id na tela quando o bloco tem várias saídas:
 * sem id, o canvas usa a PRIMEIRA bolinha do bloco e a linha sai do lugar errado.
 */
export const DEFAULT_HANDLE = '__default';
/** O bloco mostra as saídas em linhas (várias, ou uma com nome)? */
export function hasOutputRows(type: string, data: Record<string, any>) {
  const outs = outputsFor(type, data);
  return outs.length > 1 || (outs.length === 1 && outs[0].label !== '');
}

function Preview({ parts }: { parts: PreviewPart[] }) {
  return (
    <div className="blk-pv" data-testid="blk-preview">
      {parts.map((p, i) => {
        switch (p.k) {
          case 'row': return (
            <div key={i} className="pv-row"><Icon name={p.icon} size={12} stroke={2.2} /><span><span className="pv-t">{p.text}</span>{p.sub && <small>{p.sub}</small>}</span></div>
          );
          case 'label': return <div key={i} className="pv-label">{p.text}</div>;
          case 'chips': return (
            <div key={i} className="pv-chips">{p.items.map((c, j) => (
              <span key={j} className="pv-chip" style={c.color ? ({ '--chip': c.color } as CSSProperties) : undefined}><i />{c.text}</span>
            ))}</div>
          );
          case 'img': return <ImagePreview key={i} part={p} />;
          case 'box': return <div key={i} className="pv-box"><b>{p.title}</b>{p.sub && <small>{p.sub}</small>}</div>;
          default: return <div key={i} className="pv-note">{p.text}</div>;
        }
      })}
    </div>
  );
}

/** Venda aprovada: círculo com borda neon que acende e apaga. */
export const SaleNode = memo(function SaleNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const ctx = useContext(BuilderContext);
  const st = ctx.stats[id];
  const entries = st?.entries ?? 0;
  const advances = st?.advances ?? 0;
  const rate = entries ? Math.min(100, Math.round((advances / entries) * 100)) : 0;
  const level = ctx.levels[id];
  const product = ctx.lookups.products.find((x) => x.id === data.productId);
  return (
    <div className={cx('sale-node', selected && 'sel', ctx.simNodeId === id && 'sim', !!level && 'bad', level === 'error' && 'err')} data-testid="block-sale">
      <div className="blk-tools nodrag nopan" onDoubleClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onEdit(id); }} title="Editar (Enter)" aria-label="Editar bloco" data-testid="blk-edit"><Icon name="edit" size={13} /></button>
        <button type="button" onClick={(e) => { e.stopPropagation(); ctx.onDuplicate(id); }} title="Duplicar" aria-label="Duplicar bloco" data-testid="blk-dup"><Icon name="copy" size={13} /></button>
        <button type="button" className="del" onClick={(e) => { e.stopPropagation(); ctx.onDelete(id); }} title="Excluir" aria-label="Excluir bloco" data-testid="blk-del"><Icon name="trash" size={13} /></button>
      </div>
      <div className="sale-orb" title={product ? `${product.name} · ${money(Number(product.price))}` : 'Registra a venda (dashboard e pixel)'}>
        <Handle type="target" position={Position.Left} className="blk-hin sale-h" />
        <span className="sale-ic">$</span>
        <span className="sale-tt">{data.title || 'Venda aprovada'}</span>
        <Handle type="source" position={Position.Right} className="blk-hout sale-h" />
      </div>
      <div className="sale-stats" title="Estatísticas de contatos reais (a simulação não conta)">
        <span><small>Entradas</small><b>{entries}</b></span>
        <span><small>Avanços</small><b>{advances}</b></span>
        <span><small>Taxa</small><b>{rate}%</b></span>
      </div>
    </div>
  );
});

const GREEN = new Set(['true', 'paid', 'success', 'receipt']);
const RED = new Set(['false', 'unpaid', 'error', 'invalid', 'timeout']);

export function DeletableEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, sourceHandleId } = props;
  const { deleteElements } = useReactFlow();
  const hovered = useContext(EdgeHoverContext) === id;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const tone = sourceHandleId && GREEN.has(sourceHandleId) ? 'var(--success)'
    : sourceHandleId && RED.has(sourceHandleId) ? 'var(--danger)' : undefined;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={22}
        style={{ ...style, ...(tone ? { stroke: tone } : {}), ...(selected ? { strokeWidth: 3 } : {}) }} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={cx('edge-del', 'nodrag', 'nopan', (selected || hovered) && 'show')}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(e) => { e.stopPropagation(); void deleteElements({ edges: [{ id }] }); }}
          title="Remover conexão"
          aria-label="Remover conexão"
        >×</button>
      </EdgeLabelRenderer>
    </>
  );
}

export const nodeTypes = { ...Object.fromEntries(Object.keys(BLOCKS).map((t) => [t, BlockNode])), sale: SaleNode };
export const edgeTypes = { deletable: DeletableEdge };

export function ZoomControls() {
  const rf = useReactFlow();
  const reset = () => {
    const start = rf.getNodes().find((n) => n.type === 'trigger') ?? rf.getNodes()[0];
    if (start) {
      const w = start.measured?.width ?? 260;
      rf.setCenter(start.position.x + w / 2 + 260, start.position.y + 120, { zoom: 1, duration: 300 });
    } else rf.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 });
  };
  return (
    <div className="fb-zoom">
      <button type="button" onClick={() => rf.zoomIn({ duration: 200 })} title="Aumentar zoom" aria-label="Aumentar zoom"><Icon name="zoomIn" size={16} /></button>
      <button type="button" onClick={() => rf.zoomOut({ duration: 200 })} title="Diminuir zoom" aria-label="Diminuir zoom"><Icon name="zoomOut" size={16} /></button>
      <button type="button" onClick={() => rf.fitView({ padding: 0.25, duration: 300, maxZoom: 1.2 })} title="Ver o fluxo inteiro" aria-label="Ver o fluxo inteiro"><Icon name="fit" size={16} /></button>
      <button type="button" onClick={reset} title="Voltar ao início (100%)" aria-label="Voltar ao início"><Icon name="reset" size={16} /></button>
    </div>
  );
}
