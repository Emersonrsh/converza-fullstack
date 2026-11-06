import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, toast, cx } from '../components/ui';
import type { Flow, FlowNode, FlowEdge } from '../types';

const NODE_W = 200;
const NODE_H = 72;
type NodeType = 'message' | 'ask' | 'condition' | 'action' | 'delay';
type Branch = 'true' | 'false';

const PALETTE: { type: NodeType; label: string; desc: string }[] = [
  { type: 'message', label: 'Mensagem', desc: 'Envia um texto' },
  { type: 'ask', label: 'Pergunta', desc: 'Envia e espera a resposta' },
  { type: 'condition', label: 'Condição', desc: 'Desvia por sim / não' },
  { type: 'action', label: 'Ação', desc: 'Muda etapa ou etiqueta' },
  { type: 'delay', label: 'Espera', desc: 'Aguarda um tempo' },
];
const COLOR: Record<string, string> = {
  trigger: '#0e9488', message: '#8b5cf6', ask: '#2f73e0', condition: '#f59e0b', action: '#1a9f52', delay: '#64748b',
};
const LABEL: Record<string, string> = {
  trigger: 'Gatilho', message: 'Mensagem', ask: 'Pergunta', condition: 'Condição', action: 'Ação', delay: 'Espera',
};
const STAGES: [string, string][] = [['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido']];
const OPS: [string, string][] = [['contains', 'contém'], ['equals', 'é igual a'], ['starts_with', 'começa com'], ['not_empty', 'não está vazio'], ['is_number', 'é um número']];

function defaultData(type: NodeType): Record<string, any> {
  switch (type) {
    case 'message': return { text: 'Olá {{name}}! 👋' };
    case 'ask': return { text: 'Posso te ajudar com o quê?' };
    case 'condition': return { field: 'lastMessage', op: 'contains', value: '' };
    case 'action': return { setStage: '', addTag: '' };
    case 'delay': return { seconds: 60 };
  }
}

function humanDelay(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function summary(n: FlowNode): string {
  const d = n.data ?? {};
  switch (n.type) {
    case 'trigger': return d.type === 'webhook' ? 'Evento de webhook' : 'Mensagem recebida';
    case 'message': case 'ask': return String(d.text ?? '') || '(sem texto)';
    case 'condition': {
      const op = OPS.find((o) => o[0] === d.op)?.[1] ?? d.op;
      return `resposta ${op}${d.value ? ` "${d.value}"` : ''}`;
    }
    case 'action': {
      const parts: string[] = [];
      if (d.setStage) parts.push(`etapa → ${STAGES.find((s) => s[0] === d.setStage)?.[1] ?? d.setStage}`);
      if (d.addTag) parts.push(`etiqueta "${d.addTag}"`);
      return parts.join(' · ') || '(sem ação)';
    }
    case 'delay': return `aguardar ${humanDelay(Number(d.seconds ?? 60))}`;
    default: return '';
  }
}

export function FlowBuilder({ flowId, onBack }: { flowId: string; onBack: () => void }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tempLine, setTempLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const connecting = useRef<{ source: string; branch?: Branch } | null>(null);

  useEffect(() => {
    api.get<{ flow: Flow }>(`/flows/${flowId}`).then((r) => {
      const f = r.flow;
      setFlow(f); setName(f.name);
      let ns = f.graph?.nodes ?? [];
      if (!ns.some((n) => n.type === 'trigger')) {
        ns = [{ id: 'trigger', type: 'trigger', x: 60, y: 160, data: { type: (f.trigger as any)?.type ?? 'inbound_message' } }, ...ns];
      }
      setNodes(ns); setEdges(f.graph?.edges ?? []);
    });
  }, [flowId]);

  const canvasPoint = (e: { clientX: number; clientY: number }) => {
    const el = canvasRef.current!;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop };
  };

  /* ---- arrastar blocos ---- */
  const onNodeMouseDown = (e: React.MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest('.handle')) return;
    e.stopPropagation();
    const n = nodes.find((x) => x.id === id)!;
    const p = canvasPoint(e);
    drag.current = { id, dx: p.x - (n.x ?? 0), dy: p.y - (n.y ?? 0) };
    setSelected(id);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (drag.current) {
      const p = canvasPoint(e);
      const { id, dx, dy } = drag.current;
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, x: Math.max(0, p.x - dx), y: Math.max(0, p.y - dy) } : n)));
      setDirty(true);
    } else if (connecting.current) {
      const p = canvasPoint(e);
      setTempLine((t) => (t ? { ...t, x2: p.x, y2: p.y } : t));
    }
  };
  const endInteraction = () => { drag.current = null; connecting.current = null; setTempLine(null); };

  /* ---- conectar blocos ---- */
  const startConnect = (e: React.MouseEvent, source: string, branch?: Branch) => {
    e.stopPropagation(); e.preventDefault();
    const p = canvasPoint(e);
    connecting.current = { source, branch };
    setTempLine({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };
  const finishConnect = (target: string) => {
    const c = connecting.current;
    if (!c || c.source === target) return;
    setEdges((es) => [
      ...es.filter((e) => !(e.source === c.source && (e.branch ?? null) === (c.branch ?? null))),
      { source: c.source, target, ...(c.branch ? { branch: c.branch } : {}) },
    ]);
    setDirty(true);
  };

  /* ---- editar ---- */
  const addNode = (type: NodeType) => {
    const id = `${type}_${Math.random().toString(36).slice(2, 7)}`;
    const i = nodes.length;
    setNodes((ns) => [...ns, { id, type, x: 340 + (i % 3) * 60, y: 100 + ((i * 90) % 540), data: defaultData(type) }]);
    setSelected(id); setDirty(true);
  };
  const updateData = (id: string, patch: Record<string, any>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n)));
    setDirty(true);
  };
  const removeNode = (id: string) => {
    if (id === 'trigger') return;
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelected(null); setDirty(true);
  };
  const removeEdge = (i: number) => { setEdges((es) => es.filter((_, idx) => idx !== i)); setDirty(true); };

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const trigger = nodes.find((n) => n.type === 'trigger')?.data ?? { type: 'inbound_message' };
      const r = await api.put<{ flow: Flow }>(`/flows/${flowId}`, { name, graph: { nodes, edges }, trigger });
      setFlow(r.flow); setDirty(false); toast('Fluxo salvo');
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro ao salvar'); return false; }
    finally { setSaving(false); }
  };
  const toggleStatus = async () => {
    if (!flow) return;
    if (dirty && !(await save())) return;
    const status = flow.status === 'active' ? 'paused' : 'active';
    const r = await api.put<{ flow: Flow }>(`/flows/${flowId}`, { status });
    setFlow(r.flow); toast(status === 'active' ? 'Fluxo ativado ✓' : 'Fluxo pausado');
  };

  /* ---- geometria ---- */
  const outPoint = (n: FlowNode, branch?: Branch) => ({
    x: (n.x ?? 0) + NODE_W,
    y: (n.y ?? 0) + (n.type === 'condition' ? (branch === 'true' ? 24 : 50) : NODE_H / 2),
  });
  const inPoint = (n: FlowNode) => ({ x: n.x ?? 0, y: (n.y ?? 0) + NODE_H / 2 });
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    `M${a.x} ${a.y} C ${a.x + 70} ${a.y}, ${b.x - 70} ${b.y}, ${b.x} ${b.y}`;

  if (!flow) return <Spinner />;
  const sel = nodes.find((n) => n.id === selected) ?? null;

  return (
    <div className="fade card" style={{ height: 'calc(100vh - 104px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
      {/* barra */}
      <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 10 }}>
        <button className="btn sm ghost" onClick={onBack}>← Voltar</button>
        <input className="input" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ maxWidth: 320, fontWeight: 700 }} />
        <span className={cx('pill', flow.status === 'active' ? 'green' : flow.status === 'paused' ? 'amber' : '', 'dot')}>
          {flow.status === 'active' ? 'ativo' : flow.status === 'paused' ? 'pausado' : 'rascunho'}
        </span>
        {dirty && <span className="faint" style={{ fontSize: 12 }}>alterações não salvas</span>}
        <div className="spacer" />
        <button className="btn sm" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</button>
        <button className="btn primary sm" onClick={toggleStatus}>
          <Icon name={flow.status === 'active' ? 'pause' : 'play'} size={14} />{flow.status === 'active' ? 'Pausar' : 'Ativar'}
        </button>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '210px 1fr 300px', minHeight: 0 }}>
        {/* paleta */}
        <div style={{ borderRight: '1px solid var(--border)', padding: 12, overflowY: 'auto' }}>
          <div className="label">Adicionar bloco</div>
          {PALETTE.map((p) => (
            <button key={p.type} className="pal" onClick={() => addNode(p.type)}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: COLOR[p.type], flex: 'none' }} />
              <span><b>{p.label}</b><small>{p.desc}</small></span>
            </button>
          ))}
          <div className="faint" style={{ fontSize: 11, lineHeight: 1.4, marginTop: 10 }}>
            Arraste da <b>bolinha</b> de um bloco até outro para ligar. Clique num bloco para editar.
          </div>
        </div>

        {/* canvas */}
        <div ref={canvasRef} className="fb-canvas" onMouseMove={onMouseMove} onMouseUp={endInteraction}
          onMouseLeave={endInteraction} onMouseDown={() => setSelected(null)}>
          <div className="fb-inner">
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
              {edges.map((e, i) => {
                const a = nodes.find((n) => n.id === e.source); const b = nodes.find((n) => n.id === e.target);
                if (!a || !b) return null;
                const p1 = outPoint(a, e.branch); const p2 = inPoint(b);
                const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
                return (
                  <g key={i}>
                    <path d={curve(p1, p2)} className={cx('fb-edge', e.branch === 'true' && 't', e.branch === 'false' && 'f')} />
                    <g className="fb-edge-del" style={{ pointerEvents: 'all' }} onMouseDown={(ev) => ev.stopPropagation()} onClick={() => removeEdge(i)}>
                      <circle cx={mx} cy={my} r={9} /><text x={mx} y={my + 4} textAnchor="middle">×</text>
                    </g>
                  </g>
                );
              })}
              {tempLine && <path d={curve({ x: tempLine.x1, y: tempLine.y1 }, { x: tempLine.x2, y: tempLine.y2 })} className="fb-edge" strokeDasharray="6 4" />}
            </svg>

            {nodes.map((n) => (
              <div key={n.id} className={cx('fb-node', selected === n.id && 'selected')}
                style={{ left: n.x ?? 0, top: n.y ?? 0, borderLeft: `4px solid ${COLOR[n.type] ?? 'var(--border)'}` }}
                onMouseDown={(e) => onNodeMouseDown(e, n.id)}
                onMouseUp={() => { if (connecting.current) finishConnect(n.id); }}>
                {n.type !== 'trigger' && <span className="handle in" />}
                <div className="hd" style={{ color: COLOR[n.type] }}>{LABEL[n.type] ?? n.type}</div>
                <div className="bd">{summary(n)}</div>
                {n.type === 'condition' ? (
                  <>
                    <span className="handle lbl" style={{ top: 16 }}>sim</span>
                    <span className="handle" style={{ right: -8, top: 17, borderColor: 'var(--success)' }} onMouseDown={(e) => startConnect(e, n.id, 'true')} />
                    <span className="handle lbl" style={{ top: 42 }}>não</span>
                    <span className="handle" style={{ right: -8, top: 43, borderColor: 'var(--danger)' }} onMouseDown={(e) => startConnect(e, n.id, 'false')} />
                  </>
                ) : (
                  <span className="handle" style={{ right: -8, top: NODE_H / 2 - 7 }} onMouseDown={(e) => startConnect(e, n.id)} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* painel */}
        <div style={{ borderLeft: '1px solid var(--border)', padding: 14, overflowY: 'auto' }}>
          {!sel ? (
            <div className="empty" style={{ padding: '30px 10px' }}>Selecione um bloco para editar.<br /><br />
              <span style={{ fontSize: 12 }}>Dica: um fluxo de vendas típico é <b>Gatilho → Pergunta → Condição → Mensagem/Ação</b>.</span></div>
          ) : (
            <div className="grid" style={{ gap: 12 }}>
              <div className="row"><span className="pill" style={{ background: COLOR[sel.type], color: '#fff' }}>{LABEL[sel.type]}</span>
                <div className="spacer" />
                {sel.type !== 'trigger' && <button className="btn sm ghost" onClick={() => removeNode(sel.id)}><Icon name="close" size={14} />Excluir</button>}</div>

              {sel.type === 'trigger' && (
                <div><label className="label">Quando iniciar</label>
                  <select className="select" value={sel.data?.type ?? 'inbound_message'} onChange={(e) => updateData(sel.id, { type: e.target.value })}>
                    <option value="inbound_message">Ao receber uma mensagem no WhatsApp</option>
                    <option value="webhook">Ao receber um evento de webhook</option>
                  </select>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Não inicia de novo enquanto já houver uma execução em andamento para o mesmo contato.</div></div>
              )}

              {(sel.type === 'message' || sel.type === 'ask') && (
                <div><label className="label">{sel.type === 'ask' ? 'Pergunta' : 'Texto da mensagem'}</label>
                  <textarea className="input" rows={6} value={sel.data?.text ?? ''} onChange={(e) => updateData(sel.id, { text: e.target.value })} />
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Variáveis: <code>{'{{name}}'}</code> <code>{'{{phone}}'}</code> <code>{'{{lastMessage}}'}</code>
                    {sel.type === 'ask' && <><br />O fluxo <b>pausa</b> aqui e continua quando o contato responder.</>}</div></div>
              )}

              {sel.type === 'condition' && (<>
                <div><label className="label">Se a resposta</label>
                  <select className="select" value={sel.data?.op ?? 'contains'} onChange={(e) => updateData(sel.id, { op: e.target.value })}>
                    {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></div>
                {!['not_empty', 'is_number'].includes(sel.data?.op) && (
                  <div><label className="label">Valor</label>
                    <input className="input" value={sel.data?.value ?? ''} onChange={(e) => updateData(sel.id, { value: e.target.value })} placeholder="ex.: sim" /></div>
                )}
                <div className="faint" style={{ fontSize: 11.5 }}>Ligue a bolinha <b style={{ color: 'var(--success)' }}>sim</b> para o caminho verdadeiro e a <b style={{ color: 'var(--danger)' }}>não</b> para o falso.</div>
              </>)}

              {sel.type === 'action' && (<>
                <div><label className="label">Mover para a etapa</label>
                  <select className="select" value={sel.data?.setStage ?? ''} onChange={(e) => updateData(sel.id, { setStage: e.target.value })}>
                    <option value="">(não mudar)</option>
                    {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></div>
                <div><label className="label">Adicionar etiqueta</label>
                  <input className="input" value={sel.data?.addTag ?? ''} onChange={(e) => updateData(sel.id, { addTag: e.target.value })} placeholder="ex.: Lead quente" /></div>
              </>)}

              {sel.type === 'delay' && (
                <div><label className="label">Aguardar</label>
                  <div className="row">
                    <input className="input" type="number" min={1} style={{ maxWidth: 110 }}
                      value={Number(sel.data?.seconds ?? 60) % 3600 === 0 ? Number(sel.data?.seconds ?? 60) / 3600 : Number(sel.data?.seconds ?? 60) / 60}
                      onChange={(e) => {
                        const unit = Number(sel.data?.seconds ?? 60) % 3600 === 0 ? 3600 : 60;
                        updateData(sel.id, { seconds: Math.max(1, Number(e.target.value)) * unit });
                      }} />
                    <select className="select" style={{ maxWidth: 120 }}
                      value={Number(sel.data?.seconds ?? 60) % 3600 === 0 ? 'h' : 'm'}
                      onChange={(e) => {
                        const amount = Number(sel.data?.seconds ?? 60) % 3600 === 0 ? Number(sel.data?.seconds) / 3600 : Number(sel.data?.seconds ?? 60) / 60;
                        updateData(sel.id, { seconds: Math.max(1, amount) * (e.target.value === 'h' ? 3600 : 60) });
                      }}>
                      <option value="m">minutos</option><option value="h">horas</option>
                    </select>
                  </div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>O fluxo retoma sozinho depois desse tempo.</div></div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
