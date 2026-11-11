import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { cx, toast } from '../components/ui';
import type { ChatRun } from './types';

/** avisa o painel do contato e o cabeçalho que os fluxos da conversa mudaram */
export const FLOW_RUNS_EVENT = 'cv:flowruns';
export const flowRunsChanged = () => window.dispatchEvent(new Event(FLOW_RUNS_EVENT));

export const ACTIVE = ['running', 'waiting', 'waiting_input', 'waiting_payment'];
export const HELD = ['paused', 'failed'];

/** Fluxos da conversa (em andamento, pausados e parados por falha); recarrega quando algo muda. */
export function useFlowRuns(convId: string, bump: unknown) {
  const [runs, setRuns] = useState<ChatRun[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const h = () => setTick((t) => t + 1);
    window.addEventListener(FLOW_RUNS_EVENT, h);
    return () => window.removeEventListener(FLOW_RUNS_EVENT, h);
  }, []);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api.get<{ runs: ChatRun[] }>(`/conversations/${convId}/flow-runs`).then((r) => alive && setRuns(r.runs)).catch(() => undefined);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [convId, bump, tick]);
  return runs;
}

/** abre o popup "Retomar fluxo" (escolher o bloco) para uma execução parada */
export const RESUME_OPEN_EVENT = 'cv:resume-open';
export const openResume = (runId: string) => window.dispatchEvent(new CustomEvent(RESUME_OPEN_EVENT, { detail: runId }));

export async function resumeRun(convId: string, body: { runId?: string; messageId?: string; nodeId?: string | null }) {
  try {
    await api.post(`/conversations/${convId}/flow-runs/resume`, body);
    toast('Fluxo retomado de onde parou');
    flowRunsChanged();
    return true;
  } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível retomar'); return false; }
}

export async function pauseRuns(convId: string, runId?: string) {
  try {
    const r = await api.post<{ paused: number }>(`/conversations/${convId}/flow-runs/pause`, runId ? { runId } : {});
    toast(r.paused === 1 ? 'Fluxo pausado. Ele continua de onde parou quando você retomar.' : `${r.paused} fluxos pausados`);
    flowRunsChanged();
  } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível pausar'); }
}

interface FlowItem { id: string; name: string; status: string; archivedAt: string | null }

/** Botão "Disparar fluxo" do cabeçalho da conversa: escolhe um fluxo e começa agora. */
export function FlowLauncher({ convId }: { convId: string }) {
  const [open, setOpen] = useState(false);
  const [flows, setFlows] = useState<FlowItem[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<FlowItem | null>(null);
  const [list, setList] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.get<{ flows: FlowItem[] }>('/flows').then((r) => setFlows(r.flows.filter((f) => f.status === 'active' && !f.archivedAt))).catch(() => setFlows([]));
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => { setOpen(false); setPicked(null); setQ(''); }, [convId]);

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (flows ?? []).filter((f) => !n || f.name.toLowerCase().includes(n)).sort((a, b) => a.name.localeCompare(b.name));
  }, [flows, q]);

  async function start() {
    if (!picked) return;
    setBusy(true);
    try {
      await api.post(`/conversations/${convId}/flows/start`, { flowId: picked.id });
      toast(`Fluxo “${picked.name}” disparado`);
      setOpen(false); setPicked(null); setQ('');
      flowRunsChanged();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível disparar'); }
    finally { setBusy(false); }
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={cx('btn icon sm', open ? 'on' : 'ghost')} onClick={() => setOpen((v) => !v)} title="Disparar fluxo" aria-label="Disparar fluxo" data-testid="flow-launch">
        <Icon name="flow" size={16} />
      </button>
      {open && (
        <div className="fl-pop fade" data-testid="flow-launch-pop">
          <div className="fl-pop-h"><Icon name="flow" size={14} /><b>Disparar fluxo</b>
            <button type="button" className="btn icon sm ghost" onClick={() => setOpen(false)} aria-label="Fechar"><Icon name="close" size={14} /></button>
          </div>
          <div className="fl-pop-pick">
            <Icon name="search" size={15} />
            <input autoFocus className="input sm" placeholder="Digite o nome do fluxo…" value={picked && !list ? picked.name : q}
              onFocus={() => setList(true)} onChange={(e) => { setQ(e.target.value); setPicked(null); setList(true); }} data-testid="flow-launch-q" />
            {picked && <button type="button" className="btn icon sm ghost" onClick={() => { setPicked(null); setQ(''); setList(true); }} aria-label="Limpar"><Icon name="close" size={13} /></button>}
          </div>
          {list && (
            <div className="fl-pop-list">
              {flows === null && <div className="faint">Carregando…</div>}
              {flows !== null && shown.length === 0 && <div className="faint">{flows.length ? 'Nenhum fluxo com esse nome.' : 'Nenhum fluxo ativo. Ative um fluxo na tela de Fluxos.'}</div>}
              {shown.map((f) => (
                <button type="button" key={f.id} className={cx(picked?.id === f.id && 'on')} onClick={() => { setPicked(f); setList(false); }} data-testid="flow-launch-item">{f.name}</button>
              ))}
            </div>
          )}
          <div className="fl-pop-ft">
            <button type="button" className="btn sm primary" disabled={!picked || busy} onClick={() => void start()} data-testid="flow-launch-go">
              <Icon name="play" size={14} />{busy ? 'Disparando…' : 'Ativar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Botão do cabeçalho: pausa os fluxos em andamento; se só há fluxos parados, retoma. */
export function FlowPauseButton({ convId, runs }: { convId: string; runs: ChatRun[] }) {
  const active = runs.filter((r) => ACTIVE.includes(r.status));
  const held = runs.filter((r) => HELD.includes(r.status));
  if (active.length) {
    return (
      <button type="button" className="btn icon sm ghost" onClick={() => void pauseRuns(convId)} data-testid="flow-pause"
        title={`Pausar ${active.length === 1 ? `o fluxo “${active[0].flowName}”` : `os ${active.length} fluxos`} (continua de onde parou ao retomar)`} aria-label="Pausar fluxo">
        <Icon name="pause" size={16} />
      </button>
    );
  }
  if (held.length) {
    const r = held[0];
    return (
      <button type="button" className={cx('btn icon sm cv-resume', r.status === 'failed' && 'failed')} onClick={() => openResume(r.id)} data-testid="flow-resume"
        title={r.status === 'failed' ? `Retomar fluxo: “${r.flowName}” parou porque uma mensagem não saiu` : `Retomar fluxo: “${r.flowName}” está pausado`}
        aria-label="Retomar fluxo">
        <Icon name="play" size={16} />
      </button>
    );
  }
  return null;
}
