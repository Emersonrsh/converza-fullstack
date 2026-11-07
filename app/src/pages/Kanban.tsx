import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';
import { getSocket } from '../socket';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, TopbarActions, cx, toast } from '../components/ui';
import { Funnel } from '../kanban/Funnel';
import { BoardModal, ConfirmModal } from '../kanban/modals';
import { plural, rateTone, timeAgo } from '../kanban/util';
import type { KBoardSummary, KTotals } from '../kanban/types';

const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')}%`;

function BoardCard({ b, onOpen, onRename, onDuplicate, onDelete }: {
  b: KBoardSummary; onOpen: () => void; onRename: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);
  return (
    <div className="kb-bcard" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }} data-testid="board-card">
      <Funnel columns={b.columns} />
      <div className="kb-bcard-hd">
        <b title={b.name}>{b.name}</b>
        <span className="kb-badge">{plural(b.columns.length, 'coluna', 'colunas')}</span>
        <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn icon sm ghost kb-more" onClick={() => setMenu((v) => !v)} aria-label="Ações do quadro" data-testid="board-menu"><Icon name="dots" size={16} /></button>
          {menu && (
            <div className="menu fade" onClick={() => setMenu(false)}>
              <button type="button" onClick={onOpen}><Icon name="arrowRight" size={15} />Abrir</button>
              <button type="button" onClick={onRename}><Icon name="edit" size={15} />Renomear</button>
              <button type="button" onClick={onDuplicate}><Icon name="copy" size={15} />Duplicar (só as colunas)</button>
              <div className="sep" />
              <button type="button" className="danger" onClick={onDelete}><Icon name="trash" size={15} />Excluir</button>
            </div>
          )}
        </div>
      </div>
      <div className="kb-bstats">
        <span><b>{b.stats.cards}</b> {b.stats.cards === 1 ? 'card' : 'cards'}</span>
        <span className="money">{money(b.stats.value).replace(',00', '')}</span>
        <span className="conv"><b>{b.stats.won}</b> conv.</span>
        <span className={cx('rate', rateTone(b.stats.conversion))}>{pct(b.stats.conversion)}</span>
      </div>
      <div className="kb-progress" title={`Conversão: ${pct(b.stats.conversion)}`}><i style={{ width: `${Math.min(100, b.stats.conversion)}%` }} /></div>
      <small className="kb-upd">Atualizado {timeAgo(b.updatedAt)}</small>
    </div>
  );
}

export function Kanban() {
  const nav = useNavigate();
  const { accountId, accounts } = useAuth();
  const role = accounts.find((a) => a.id === accountId)?.role;
  const [boards, setBoards] = useState<KBoardSummary[] | null>(null);
  const [totals, setTotals] = useState<KTotals | null>(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<null | { kind: 'new' } | { kind: 'rename'; b: KBoardSummary } | { kind: 'delete'; b: KBoardSummary }>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ boards: KBoardSummary[]; totals: KTotals }>('/kanban/boards');
      setBoards(r.boards); setTotals(r.totals);
    } catch (e) { setBoards((b) => b ?? []); toast(e instanceof Error ? e.message : 'Não foi possível carregar os quadros'); }
  }, []);
  useEffect(() => { void load(); }, [load, accountId]);

  // tempo real: outra pessoa mexeu num quadro; e "Atualizado há…" sempre em dia
  useEffect(() => {
    const sock = getSocket();
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 400); };
    sock?.on('kanban:changed', on);
    const i = setInterval(() => tick((x) => x + 1), 60_000);
    return () => { sock?.off('kanban:changed', on); if (t) clearTimeout(t); clearInterval(i); };
  }, [load, accountId]);

  const shown = useMemo(() => (boards ?? []).filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase())), [boards, q]);

  async function duplicate(b: KBoardSummary) {
    try {
      await api.post(`/kanban/boards/${b.id}/duplicate`);
      toast(`Quadro “${b.name}” duplicado`);
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível duplicar'); }
  }

  async function remove(b: KBoardSummary) {
    try {
      await api.del(`/kanban/boards/${b.id}`);
      toast(`Quadro “${b.name}” excluído`);
      setModal(null);
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível excluir'); }
  }

  return (
    <div className="fade kb-page" data-testid="kanban-list">
      <TopbarActions>
        <button type="button" className="btn primary" onClick={() => setModal({ kind: 'new' })} data-testid="new-board"><Icon name="plus" size={16} />Novo Kanban</button>
      </TopbarActions>

      <div className="kb-kpis">
        <div className="kb-kpi" data-testid="kpi-boards"><b>{totals?.boards ?? '—'}</b><span>Quadros</span></div>
        <div className="kb-kpi" data-testid="kpi-cards"><b>{totals?.cards ?? '—'}</b><span>Cards no pipeline</span></div>
        <div className="kb-kpi" data-testid="kpi-value" title="Soma do valor dos cards (sem os de colunas de Perdido)"><b>{totals ? money(totals.value).replace(',00', '') : '—'}</b><span>Valor no pipeline</span></div>
        <div className="kb-kpi" data-testid="kpi-conversion" title="Média da taxa de conversão dos quadros com cards (cards em colunas de Ganho ÷ total)"><b>{totals ? pct(totals.conversion) : '—'}</b><span>Conversão média</span></div>
      </div>

      <div className="fl-search kb-search">
        <Icon name="search" size={16} />
        <input className="input" placeholder="Buscar kanban..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar kanban" data-testid="board-search" />
      </div>

      {!boards ? <div style={{ height: 200 }}><Spinner /></div> : (
        <div className="kb-grid">
          {shown.map((b) => (
            <BoardCard key={b.id} b={b} onOpen={() => nav(`/kanban/${b.id}`)}
              onRename={() => setModal({ kind: 'rename', b })} onDuplicate={() => duplicate(b)}
              onDelete={() => (role === 'agent' ? toast('Apenas donos e administradores excluem quadros') : setModal({ kind: 'delete', b }))} />
          ))}
          {!q.trim() && (
            <button type="button" className="kb-newcard" onClick={() => setModal({ kind: 'new' })} data-testid="new-board-card">
              <Icon name="plus" size={22} />
              <b>Novo quadro</b>
              {boards.length === 0 && <small>Crie um quadro para organizar leads e negociações em colunas</small>}
            </button>
          )}
          {q.trim() && shown.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>Nenhum quadro com “{q.trim()}”.</div>}
        </div>
      )}

      {modal?.kind === 'new' && <BoardModal onClose={() => setModal(null)} onSaved={(b) => { setModal(null); toast(`Quadro “${b.name}” criado`); nav(`/kanban/${b.id}`); }} />}
      {modal?.kind === 'rename' && (
        <BoardModal initial={modal.b} columns={modal.b.columns} onClose={() => setModal(null)} onSaved={() => { setModal(null); toast('Quadro renomeado'); void load(); }} />
      )}
      {modal?.kind === 'delete' && (
        <ConfirmModal title="Excluir quadro" confirm="Excluir quadro" danger onClose={() => setModal(null)} onConfirm={() => remove(modal.b)}>
          Excluir o quadro <b>{modal.b.name}</b>{modal.b.stats.cards ? <> e os seus {plural(modal.b.stats.cards, 'card', 'cards')}</> : null}? Os contatos e as conversas continuam salvos.
        </ConfirmModal>
      )}
    </div>
  );
}
