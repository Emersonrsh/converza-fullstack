import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, money } from '../api';
import { getSocket } from '../socket';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Avatar, Spinner, cx, toast } from '../components/ui';
import { fmtPhone } from '../chats/util';
import { CardModal, ColumnModal, ConfirmModal, DeleteColumnModal } from '../kanban/modals';
import { KIND_LABEL, dateBR, dueState, plural, rateTone, shortSince, timeAgo } from '../kanban/util';
import type { KBoard, KCard, KColumn, KStats } from '../kanban/types';
import type { TeamMember } from '../chats/types';

type ModalState =
  | null
  | { kind: 'card'; card: KCard }
  | { kind: 'newCard'; columnId: string; top: boolean }
  | { kind: 'column'; column?: KColumn }
  | { kind: 'deleteColumn'; column: KColumn }
  | { kind: 'deleteBoard' };

const pct = (n: number) => `${String(Math.round(n * 10) / 10).replace('.', ',')}%`;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function stats(columns: KColumn[], cards: KCard[]): KStats {
  const kind = new Map(columns.map((c) => [c.id, c.kind]));
  let value = 0; let won = 0;
  for (const c of cards) {
    if (kind.get(c.columnId) !== 'lost') value += c.value;
    if (kind.get(c.columnId) === 'won') won += 1;
  }
  return { cards: cards.length, value, won, conversion: cards.length ? Math.round((won / cards.length) * 1000) / 10 : 0 };
}

export function KanbanBoard() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { accountId, accounts } = useAuth();
  const role = accounts.find((a) => a.id === accountId)?.role;
  const [data, setData] = useState<KBoard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string>>(new Map());
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<string | null>(null); // 'board' | id da coluna
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ columnId: string; index: number } | null>(null);
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [colDrop, setColDrop] = useState<number | null>(null);
  const [, tick] = useState(0);
  const dragging = useRef(false);
  // ids arrastados em refs: os eventos de arrastar chegam antes do React redesenhar
  const dragRef = useRef<string | null>(null);
  const colDragRef = useRef<string | null>(null);
  const pendingReload = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<KBoard>(`/kanban/boards/${id}`);
      setData(r); setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? 'Este quadro não existe mais ou é de outra conta.' : e instanceof Error ? e.message : 'Não foi possível abrir o quadro');
    }
  }, [id]);
  useEffect(() => { setData(null); void load(); }, [load]);

  useEffect(() => {
    api.get<{ members: TeamMember[] }>('/team').then((r) => setMembers(r.members)).catch(() => setMembers([]));
    api.get<{ tags: { name: string; color: string }[] }>('/settings/tags')
      .then((r) => setTagColors(new Map(r.tags.map((t) => [t.name.toLowerCase(), t.color])))).catch(() => undefined);
  }, [accountId]);

  // tempo real: alguém mexeu no quadro (ou chegou mensagem de um contato dele)
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaving = useRef(false); // excluindo o quadro: não recarrega (daria 404 antes de sair da página)
  const scheduleReload = useCallback(() => {
    if (leaving.current) return;
    if (dragging.current) { pendingReload.current = true; return; }
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => void load(), 300);
  }, [load]);
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onKanban = (p: { boardId?: string }) => { if (p.boardId === id) scheduleReload(); };
    const onMsg = (p: { conversationId: string }) => { if (dataRef.current?.cards.some((c) => c.conversationId === p.conversationId)) scheduleReload(); };
    const onConv = (p: { conversation: { id: string } }) => { if (dataRef.current?.cards.some((c) => c.conversationId === p.conversation.id)) scheduleReload(); };
    sock.on('kanban:changed', onKanban);
    sock.on('message:new', onMsg);
    sock.on('conversation:updated', onConv);
    const i = setInterval(() => tick((x) => x + 1), 60_000);
    return () => { sock.off('kanban:changed', onKanban); sock.off('message:new', onMsg); sock.off('conversation:updated', onConv); clearInterval(i); };
  }, [id, scheduleReload, accountId]);

  // ?card=<id>: abre o card (link vindo do Chats ao vivo)
  const cardParam = params.get('card');
  useEffect(() => {
    if (!data || !cardParam) return;
    const card = data.cards.find((c) => c.id === cardParam);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('card'); return n; }, { replace: true });
    if (!card) { toast('Esse card não está mais neste quadro'); return; }
    setModal({ kind: 'card', card });
    highlight(card.id);
  }, [data, cardParam]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  function highlight(cardId: string) {
    setFlash(cardId);
    setTimeout(() => {
      document.querySelector(`[data-card-id="${cardId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }, 50);
    setTimeout(() => setFlash((f) => (f === cardId ? null : f)), 1800);
  }

  /* --------------------------------------------------------- filtros */
  const visible = useCallback((c: KCard) => {
    if (who === 'none' ? !!c.assignedUserId : who && c.assignedUserId !== who) return false;
    const t = norm(q.trim());
    if (!t) return true;
    const digits = q.replace(/\D/g, '');
    return norm(c.title).includes(t) || norm(c.contactName ?? '').includes(t) || (digits.length >= 3 && (c.contactPhone ?? '').includes(digits))
      || c.contactTags.some((x) => norm(x).includes(t)) || norm(c.notes ?? '').includes(t);
  }, [q, who]);
  const filtering = !!(q.trim() || who);

  const cardsOf = useMemo(() => {
    const m = new Map<string, KCard[]>();
    for (const col of data?.columns ?? []) m.set(col.id, []);
    for (const c of data?.cards ?? []) m.get(c.columnId)?.push(c);
    for (const list of m.values()) list.sort((a, b) => a.position - b.position);
    return m;
  }, [data]);

  const st = useMemo(() => (data ? stats(data.columns, data.cards) : null), [data]);

  /* -------------------------------------------------------- mover card */
  function moveLocal(cardId: string, columnId: string, afterId: string | null, beforeId: string | null, top = false) {
    setData((d) => {
      if (!d) return d;
      const card = d.cards.find((c) => c.id === cardId);
      if (!card) return d;
      const others = d.cards.filter((c) => c.id !== cardId);
      const col = others.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
      const ai = afterId ? col.findIndex((c) => c.id === afterId) : -1;
      const bi = beforeId ? col.findIndex((c) => c.id === beforeId) : -1;
      const idx = top ? 0 : ai >= 0 ? ai + 1 : bi >= 0 ? bi : col.length;
      const prev = col[idx - 1]; const next = col[idx];
      const position = prev && next ? (prev.position + next.position) / 2 : prev ? prev.position + 1024 : next ? next.position - 1024 : 1024;
      const moved: KCard = { ...card, columnId, position, movedAt: columnId !== card.columnId ? new Date().toISOString() : card.movedAt };
      return { ...d, cards: [...others, moved] };
    });
  }

  async function moveCard(cardId: string, columnId: string, afterId: string | null, beforeId: string | null, top = false) {
    moveLocal(cardId, columnId, afterId, beforeId, top);
    try {
      await api.post(`/kanban/cards/${cardId}/move`, { columnId, afterId, beforeId, ...(top ? { top: true } : {}) });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não foi possível mover o card');
      void load();
    }
  }

  function endDrag() {
    dragging.current = false;
    dragRef.current = null; colDragRef.current = null;
    setDrag(null); setDrop(null); setColDrag(null); setColDrop(null);
    if (pendingReload.current) { pendingReload.current = false; scheduleReload(); }
  }

  /** Posição (entre os cards visíveis, sem o arrastado) onde o card cairia nesta altura. */
  function indexAt(container: HTMLElement, clientY: number, exclude: string) {
    let index = 0;
    container.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
      if (el.dataset.cardId === exclude) return;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) index += 1;
    });
    return index;
  }

  function onCardsDragOver(e: DragEvent<HTMLDivElement>, columnId: string) {
    const cardId = dragRef.current;
    if (!cardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = indexAt(e.currentTarget, e.clientY, cardId);
    setDrop((cur) => (cur && cur.columnId === columnId && cur.index === index ? cur : { columnId, index }));
  }

  function onCardsDrop(e: DragEvent<HTMLDivElement>, columnId: string) {
    const cardId = dragRef.current;
    if (!cardId) return;
    e.preventDefault();
    const target = indexAt(e.currentTarget, e.clientY, cardId);
    endDrag();
    const list = (cardsOf.get(columnId) ?? []).filter((c) => visible(c) && c.id !== cardId);
    const after = list[target - 1]?.id ?? null;
    const before = list[target]?.id ?? null;
    const card = data?.cards.find((c) => c.id === cardId);
    if (!card) return;
    // soltou no mesmo lugar: nada a fazer
    const cur = (cardsOf.get(columnId) ?? []).filter((c) => visible(c));
    const at = cur.findIndex((c) => c.id === cardId);
    if (card.columnId === columnId && at >= 0 && (cur[at - 1]?.id ?? null) === after && (cur[at + 1]?.id ?? null) === before) return;
    void moveCard(cardId, columnId, after, before);
  }

  /* ------------------------------------------------------ mover coluna */
  async function reorderColumns(ids: string[]) {
    if (!data) return;
    const prev = data.columns;
    setData({ ...data, columns: ids.map((cid, i) => ({ ...prev.find((c) => c.id === cid)!, position: i })) });
    try { await api.put(`/kanban/boards/${id}/columns/order`, { ids }); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível reordenar'); void load(); }
  }

  function shiftColumn(colId: string, dir: -1 | 1) {
    if (!data) return;
    const ids = data.columns.map((c) => c.id);
    const i = ids.indexOf(colId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorderColumns(ids);
  }

  function colIndexAt(clientX: number, exclude: string) {
    let index = 0;
    boardRef.current?.querySelectorAll<HTMLElement>('[data-col-id]').forEach((el) => {
      if (el.dataset.colId === exclude) return;
      const r = el.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) index += 1;
    });
    return index;
  }

  function onBoardDragOver(e: DragEvent<HTMLDivElement>) {
    const moving = colDragRef.current;
    if (!moving) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const index = colIndexAt(e.clientX, moving);
    setColDrop((cur) => (cur === index ? cur : index));
  }

  function onBoardDrop(e: DragEvent<HTMLDivElement>) {
    const moving = colDragRef.current;
    if (!moving || !data) return;
    e.preventDefault();
    const index = colIndexAt(e.clientX, moving);
    endDrag();
    const ids = data.columns.map((c) => c.id).filter((x) => x !== moving);
    ids.splice(index, 0, moving);
    if (ids.join() !== data.columns.map((c) => c.id).join()) void reorderColumns(ids);
  }

  /* ---------------------------------------------------------- quadro */
  async function saveName() {
    setEditingName(false);
    const n = name.trim();
    if (!data || !n || n === data.board.name) return;
    try {
      await api.patch(`/kanban/boards/${id}`, { name: n });
      setData({ ...data, board: { ...data.board, name: n } });
      toast('Quadro renomeado');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível renomear'); }
  }

  async function duplicateBoard() {
    try {
      const r = await api.post<{ board: { id: string; name: string } }>(`/kanban/boards/${id}/duplicate`);
      toast(`Criado “${r.board.name}”`);
      nav(`/kanban/${r.board.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível duplicar'); }
  }

  async function deleteBoard() {
    leaving.current = true;
    try {
      await api.del(`/kanban/boards/${id}`);
      toast('Quadro excluído');
      nav('/kanban');
    } catch (e) { leaving.current = false; toast(e instanceof Error ? e.message : 'Não foi possível excluir'); }
  }

  if (err) {
    return (
      <div className="cv-empty" style={{ flex: 1 }}>
        <div className="cv-empty-ic warn"><Icon name="alert" size={28} /></div>
        <b>Não foi possível abrir o quadro</b>
        <span>{err}</span>
        <Link to="/kanban" className="btn sm" style={{ marginTop: 12 }}>Voltar para os Kanbans</Link>
      </div>
    );
  }
  if (!data || !st) return <div className="center"><Spinner /></div>;

  return (
    <div className="kb-view fade" data-testid="kanban-board">
      <header className="kb-hd">
        <Link to="/kanban" className="btn icon sm ghost" aria-label="Voltar para os Kanbans" title="Voltar para os Kanbans"><Icon name="arrowLeft" size={17} /></Link>
        <div className="kb-title">
          {editingName ? (
            <input className="input sm" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingName(false); }} data-testid="board-name-input" />
          ) : (
            <button type="button" className="kb-name" onClick={() => { setName(data.board.name); setEditingName(true); }} title="Renomear" data-testid="board-title">
              <span className="kb-name-t">{data.board.name}</span><Icon name="edit" size={13} />
            </button>
          )}
          <small>Atualizado {timeAgo(data.board.updatedAt)}</small>
        </div>
        <div className="kb-hstats" data-testid="board-stats">
          <span><b>{st.cards}</b> {st.cards === 1 ? 'card' : 'cards'}</span>
          <span className="money">{money(st.value).replace(',00', '')}</span>
          <span className="conv"><b>{st.won}</b> conv.</span>
          <span className={cx('rate', rateTone(st.conversion))}>{pct(st.conversion)}</span>
        </div>
        <span className="spacer" />
        <div className="fl-search kb-csearch">
          <Icon name="search" size={15} />
          <input className="input sm" placeholder="Buscar cards..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cards" data-testid="card-filter" />
        </div>
        <select className="select sm kb-who" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Responsável" data-testid="card-who">
          <option value="">Todos os responsáveis</option>
          <option value="none">Sem responsável</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select>
        <button type="button" className="btn sm primary" onClick={() => setModal({ kind: 'column' })} data-testid="new-column"><Icon name="plus" size={14} />Nova coluna</button>
        <div className="menu-wrap">
          <button type="button" className="btn icon sm ghost" onClick={() => setMenu(menu === 'board' ? null : 'board')} aria-label="Ações do quadro" data-testid="board-actions"><Icon name="dots" size={16} /></button>
          {menu === 'board' && (
            <div className="menu fade" onClick={() => setMenu(null)}>
              <button type="button" onClick={() => { setName(data.board.name); setEditingName(true); }}><Icon name="edit" size={15} />Renomear</button>
              <button type="button" onClick={duplicateBoard}><Icon name="copy" size={15} />Duplicar (só as colunas)</button>
              <div className="sep" />
              <button type="button" className="danger" onClick={() => (role === 'agent' ? toast('Apenas donos e administradores excluem quadros') : setModal({ kind: 'deleteBoard' }))}><Icon name="trash" size={15} />Excluir quadro</button>
            </div>
          )}
        </div>
      </header>

      <div className="kb-board" ref={boardRef} onDragOver={onBoardDragOver} onDrop={onBoardDrop}>
        {data.columns.map((col, ci) => {
          const order = colDrag ? data.columns.filter((c) => c.id !== colDrag) : [];
          const phHere = !!colDrag && colDrop !== null && order[colDrop]?.id === col.id;
          const all = cardsOf.get(col.id) ?? [];
          const shown = all.filter(visible);
          const value = all.reduce((a, c) => a + c.value, 0);
          let k = 0;
          const items: ReactElement[] = [];
          shown.forEach((c) => {
            if (drop && drop.columnId === col.id && c.id !== drag && k === drop.index) items.push(<div key="ph" className="kb-ph" />);
            if (c.id !== drag) k += 1;
            items.push(
              <article key={c.id} data-card-id={c.id} className={cx('kb-ci', drag === c.id && 'dragging', flash === c.id && 'flash')} draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.id);
                  dragging.current = true;
                  dragRef.current = c.id;
                  requestAnimationFrame(() => setDrag(c.id));
                }}
                onDragEnd={endDrag} onClick={() => setModal({ kind: 'card', card: c })} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') setModal({ kind: 'card', card: c }); }} data-testid="kb-card">
                <div className="kb-ci-top">
                  <Avatar name={c.title} size={30} />
                  <div className="kb-ci-who"><b>{c.title}</b>{c.contactPhone && <small>{fmtPhone(c.contactPhone)}</small>}</div>
                  {c.value > 0 && <span className="kb-ci-val">{money(c.value).replace(',00', '')}</span>}
                </div>
                {c.contactTags.length > 0 && (
                  <div className="kb-ci-tags">
                    {c.contactTags.slice(0, 3).map((t) => <span key={t} style={{ ['--tc' as string]: tagColors.get(t.toLowerCase()) ?? '#64748b' }}>{t}</span>)}
                    {c.contactTags.length > 3 && <span className="more">+{c.contactTags.length - 3}</span>}
                  </div>
                )}
                {c.notes && <p className="kb-ci-notes">{c.notes}</p>}
                <div className="kb-ci-ft">
                  <span title={`Nesta coluna ${timeAgo(c.movedAt)}`}><Icon name="clock" size={12} />{shortSince(c.movedAt)}</span>
                  {c.dueDate && <span className={cx('kb-due', dueState(c.dueDate))} title="Prazo"><Icon name="calendar" size={12} />{dateBR(c.dueDate)}</span>}
                  <span className="spacer" />
                  {c.conversationId && (
                    <button type="button" className={cx('kb-ci-chat', c.unreadCount > 0 && 'unread')} title={c.unreadCount ? `${plural(c.unreadCount, 'mensagem não lida', 'mensagens não lidas')}` : 'Abrir conversa'}
                      aria-label="Abrir conversa" onClick={(e) => { e.stopPropagation(); nav(`/inbox?c=${c.conversationId}`); }} data-testid="kb-card-chat">
                      <Icon name="chats" size={13} />{c.unreadCount > 0 && <i>{c.unreadCount}</i>}
                    </button>
                  )}
                  {c.assignedName && <span title={`Responsável: ${c.assignedName}`}><Avatar name={c.assignedName} size={20} /></span>}
                </div>
              </article>,
            );
          });
          if (drop && drop.columnId === col.id && k === drop.index && !items.some((x) => x.key === 'ph')) items.push(<div key="ph" className="kb-ph" />);
          return (
            <section key={col.id} data-col-id={col.id} className={cx('kb-col', colDrag === col.id && 'dragging', drop?.columnId === col.id && 'over')}
              style={{ ['--cc' as string]: col.color }} data-testid="kb-column">
              {phHere && <div className="kb-col-ph" />}
              <header className="kb-col-hd" draggable={!drag}
                onDragStart={(e) => {
                  if ((e.target as HTMLElement).closest('button, .menu')) { e.preventDefault(); return; }
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', `col:${col.id}`);
                  dragging.current = true;
                  colDragRef.current = col.id;
                  requestAnimationFrame(() => setColDrag(col.id));
                }}
                onDragEnd={endDrag} title="Arraste para reordenar a coluna">
                <i className="kb-col-dot" />
                <b className="kb-col-name">{col.name}</b>
                <span className="kb-col-count" data-testid="kb-column-count">{filtering ? `${shown.length}/${all.length}` : all.length}</span>
                {col.kind !== 'open' && (
                  <span className={cx('kb-kind', col.kind)} title={col.kind === 'won' ? 'Coluna de ganho: os cards contam como conversão' : 'Coluna de perdido: os cards saem do valor do pipeline'}>
                    {col.kind === 'won' ? '✓' : '✕'}{norm(col.name).includes(norm(KIND_LABEL[col.kind])) ? '' : ` ${KIND_LABEL[col.kind]}`}
                  </span>
                )}
                <span className="spacer" />
                <button type="button" className="kb-col-btn" onClick={() => setModal({ kind: 'newCard', columnId: col.id, top: true })} title="Novo card no topo" aria-label={`Novo card em ${col.name}`}><Icon name="plus" size={15} /></button>
                <div className="menu-wrap">
                  <button type="button" className="kb-col-btn" onClick={() => setMenu(menu === col.id ? null : col.id)} aria-label={`Ações da coluna ${col.name}`} data-testid="column-menu"><Icon name="dots" size={15} /></button>
                  {menu === col.id && (
                    <div className="menu fade" onClick={() => setMenu(null)}>
                      <button type="button" onClick={() => setModal({ kind: 'column', column: col })}><Icon name="edit" size={15} />Editar coluna</button>
                      <button type="button" disabled={ci === 0} onClick={() => shiftColumn(col.id, -1)}><Icon name="arrowLeft" size={15} />Mover para a esquerda</button>
                      <button type="button" disabled={ci === data.columns.length - 1} onClick={() => shiftColumn(col.id, 1)}><Icon name="arrowRight" size={15} />Mover para a direita</button>
                      <div className="sep" />
                      <button type="button" className="danger" disabled={data.columns.length <= 1} onClick={() => setModal({ kind: 'deleteColumn', column: col })}><Icon name="trash" size={15} />Excluir coluna</button>
                    </div>
                  )}
                </div>
              </header>
              <div className="kb-col-sum">{col.kind === 'lost' ? 'fora do pipeline' : money(value).replace(',00', '')}</div>
              <div className="kb-cards" onDragOver={(e) => onCardsDragOver(e, col.id)} onDrop={(e) => onCardsDrop(e, col.id)}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop((d) => (d?.columnId === col.id ? null : d)); }}
                data-testid="kb-dropzone">
                {items}
                {shown.length === 0 && !drag && <div className="kb-empty">{filtering && all.length ? 'Nenhum card com esse filtro' : 'Nenhum card'}</div>}
              </div>
              <button type="button" className="kb-add" onClick={() => setModal({ kind: 'newCard', columnId: col.id, top: false })} data-testid="add-card"><Icon name="plus" size={14} />Adicionar card</button>
            </section>
          );
        })}
        {colDrag && colDrop !== null && colDrop >= data.columns.length - 1 && <div className="kb-col-ph end" />}
        <button type="button" className="kb-addcol" onClick={() => setModal({ kind: 'column' })}><Icon name="plus" size={16} />Nova coluna</button>
      </div>

      {modal?.kind === 'card' && (
        <CardModal boardId={id} columns={data.columns} members={members} card={modal.card} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); toast('Card salvo'); void load(); }} onDeleted={() => { setModal(null); void load(); }} />
      )}
      {modal?.kind === 'newCard' && (
        <CardModal boardId={id} columns={data.columns} members={members} columnId={modal.columnId} top={modal.top} onClose={() => setModal(null)}
          onSaved={(c) => { setModal(null); toast('Card criado'); void load().then(() => highlight(c.id)); }} />
      )}
      {modal?.kind === 'column' && (
        <ColumnModal boardId={id} column={modal.column} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); toast(modal.column ? 'Coluna salva' : 'Coluna criada'); void load(); }} />
      )}
      {modal?.kind === 'deleteColumn' && (
        <DeleteColumnModal column={modal.column} columns={data.columns} count={(cardsOf.get(modal.column.id) ?? []).length}
          onClose={() => setModal(null)} onDone={() => { setModal(null); void load(); }} />
      )}
      {modal?.kind === 'deleteBoard' && (
        <ConfirmModal title="Excluir quadro" confirm="Excluir quadro" danger onClose={() => setModal(null)} onConfirm={deleteBoard}>
          Excluir o quadro <b>{data.board.name}</b>{st.cards ? <> e os seus {plural(st.cards, 'card', 'cards')}</> : null}? Os contatos e as conversas continuam salvos.
        </ConfirmModal>
      )}
    </div>
  );
}
