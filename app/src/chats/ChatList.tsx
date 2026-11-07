import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { Avatar, Spinner, cx } from '../components/ui';
import { listTime, previewOf } from './util';
import type { ChatChip, ChatCounts, ChatDepartment, ChatFilters, ChatItem, ChatTab, TeamMember } from './types';

const TABS: [ChatTab, string][] = [['waiting', 'Aguardando'], ['attending', 'Atendendo'], ['resolved', 'Resolvidos']];
const CHIPS: [ChatChip, string][] = [['all', 'Tudo'], ['unread', 'Não lidas'], ['unanswered', 'Não respondidas']];
const STAGES: [string, string][] = [['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido']];

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return { open, setOpen, ref };
}

const TICK: Record<string, string> = { queued: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };

export function ChatList({
  accountName, tab, onTab, counts, filters, onFilters, items, loading, hasMore, onLoadMore, selectedId, onSelect, onNew,
  onCollapse, connections, tags, members, departments = [],
}: {
  accountName: string; tab: ChatTab; onTab: (t: ChatTab) => void; counts: ChatCounts | null;
  filters: ChatFilters; onFilters: (f: Partial<ChatFilters>) => void;
  items: ChatItem[] | null; loading: boolean; hasMore: boolean; onLoadMore: () => void;
  selectedId: string | null; onSelect: (id: string) => void; onNew: () => void; onCollapse: () => void;
  connections: { id: string; name: string; displayPhone: string | null }[]; tags: string[]; members: TeamMember[]; departments?: ChatDepartment[];
}) {
  const [q, setQ] = useState(filters.q);
  const fil = usePopover();
  const cal = usePopover();
  useEffect(() => { const t = setTimeout(() => { if (q !== filters.q) onFilters({ q }); }, 300); return () => clearTimeout(t); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeFilters = [filters.connectionId, filters.tag, filters.stage, filters.assignee, filters.department].filter(Boolean).length;
  const dateActive = !!(filters.from || filters.to);
  const anyFilter = !!(filters.q || activeFilters || dateActive || filters.chip !== 'all');

  return (
    <aside className="cl" data-testid="chat-list">
      <div className="cl-hd" title={accountName}><Icon name="chats" size={15} /><b>{accountName.toUpperCase()}</b></div>
      <div className="cl-search">
        <div className="cl-q">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar chats..." aria-label="Buscar chats" data-testid="chat-search" />
          {q && <button type="button" onClick={() => setQ('')} aria-label="Limpar busca"><Icon name="close" size={13} /></button>}
        </div>
        <button type="button" className="cl-btn" onClick={onNew} title="Nova conversa" aria-label="Nova conversa" data-testid="new-chat"><Icon name="plus" size={16} /></button>
        <div className="menu-wrap" ref={fil.ref}>
          <button type="button" className={cx('cl-btn', activeFilters > 0 && 'dot')} onClick={() => fil.setOpen((v) => !v)} title="Filtros" aria-label="Filtros" data-testid="chat-filters"><Icon name="filter" size={15} /></button>
          {fil.open && (
            <div className="menu cl-pop fade">
              <label className="label">Conexão</label>
              <select className="select sm" value={filters.connectionId} onChange={(e) => onFilters({ connectionId: e.target.value })} data-testid="f-connection">
                <option value="">Todas as conexões</option>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` · ${c.displayPhone}` : ''}</option>)}
              </select>
              <label className="label">Responsável</label>
              <select className="select sm" value={filters.assignee} onChange={(e) => onFilters({ assignee: e.target.value })} data-testid="f-assignee">
                <option value="">Qualquer pessoa</option>
                <option value="me">Atribuídas a mim</option>
                <option value="none">Sem responsável</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
              {departments.length > 0 && (<>
                <label className="label">Setor</label>
                <select className="select sm" value={filters.department} onChange={(e) => onFilters({ department: e.target.value })} data-testid="f-department">
                  <option value="">Todos os setores</option>
                  <option value="none">Sem setor</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </>)}
              <label className="label">Etapa do funil</label>
              <select className="select sm" value={filters.stage} onChange={(e) => onFilters({ stage: e.target.value })} data-testid="f-stage">
                <option value="">Todas as etapas</option>
                {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <label className="label">Etiqueta</label>
              <select className="select sm" value={filters.tag} onChange={(e) => onFilters({ tag: e.target.value })} data-testid="f-tag">
                <option value="">Todas as etiquetas</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {activeFilters > 0 && <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => onFilters({ connectionId: '', tag: '', stage: '', assignee: '', department: '' })}>Limpar filtros</button>}
            </div>
          )}
        </div>
      </div>

      <div className="cl-tabs" role="tablist">
        {TABS.map(([t, l]) => (
          <button type="button" role="tab" key={t} aria-selected={tab === t} className={cx(tab === t && 'on')} onClick={() => onTab(t)} data-testid={`tab-${t}`}>
            {l}{counts && counts[t] > 0 && <span className="cl-count">{counts[t] > 99 ? '99+' : counts[t]}</span>}
          </button>
        ))}
      </div>

      <div className="cl-chips">
        {CHIPS.map(([c, l]) => (
          <button type="button" key={c} className={cx('cl-chip', filters.chip === c && 'on')} onClick={() => onFilters({ chip: c })} data-testid={`chip-${c}`}>{l}</button>
        ))}
        <span className="spacer" />
        <div className="menu-wrap" ref={cal.ref}>
          <button type="button" className={cx('cl-cal', dateActive && 'on')} onClick={() => cal.setOpen((v) => !v)} title="Filtrar por data" aria-label="Filtrar por data" data-testid="chat-dates"><Icon name="calendar" size={16} /></button>
          {cal.open && (
            <div className="menu cl-pop fade" style={{ right: 0 }}>
              <label className="label">Última mensagem entre</label>
              <input className="input sm" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => onFilters({ from: e.target.value })} aria-label="De" data-testid="f-from" />
              <input className="input sm" type="date" style={{ marginTop: 6 }} value={filters.to} min={filters.from || undefined} onChange={(e) => onFilters({ to: e.target.value })} aria-label="Até" data-testid="f-to" />
              {dateActive && <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => onFilters({ from: '', to: '' })}>Limpar datas</button>}
            </div>
          )}
        </div>
      </div>

      <div className="cl-list">
        {!items && <div style={{ height: 160 }}><Spinner /></div>}
        {items && items.length === 0 && (
          <div className="cl-empty">
            <Icon name="chats" size={44} stroke={1.5} />
            <b>Nenhum chat encontrado</b>
            <span>{anyFilter ? 'Tente ajustar os filtros de busca' : tab === 'waiting' ? 'Novas conversas aparecem aqui assim que um cliente chamar' : tab === 'attending' ? 'Clique em “Atender” numa conversa para ela vir para cá' : 'Conversas finalizadas aparecem aqui'}</span>
          </div>
        )}
        {items?.map((c) => (
          <button type="button" key={c.id} className={cx('ci', selectedId === c.id && 'on', c.unreadCount > 0 && 'unread')} onClick={() => onSelect(c.id)} data-testid="chat-item">
            <Avatar name={c.contactName || c.contactPhone} size={42} />
            <div className="ci-main">
              <div className="ci-top"><b>{c.contactName || c.contactPhone}</b><span className="ci-time">{listTime(c.lastMessageAt)}</span></div>
              <div className="ci-prev">
                {c.last?.direction === 'out' && <span className={cx('tk', c.last.status)}>{TICK[c.last.status] ?? ''}</span>}
                <span className="ci-txt">{previewOf(c.last)}</span>
                {c.unreadCount > 0 && <span className="ci-badge">{c.unreadCount > 99 ? '99+' : c.unreadCount}</span>}
              </div>
              <div className="ci-meta">
                {c.departmentName && <span className="ci-tag ci-dept" style={{ background: `${c.departmentColor ?? '#64748b'}22`, color: c.departmentColor ?? undefined }} data-testid="ci-dept">{c.departmentName}</span>}
                {c.connectionName && <span className="ci-tag">{c.connectionName}</span>}
                {c.assignedName && <span className="ci-tag who"><Icon name="user" size={11} />{c.assignedName.split(' ')[0]}</span>}
                {!c.assignedUserId && c.status === 'pending' && !c.departmentName && <span className="ci-tag warn">pediu humano</span>}
                {c.status !== 'resolved' && !c.botPaused && <span className="ci-tag bot">🤖 automação</span>}
                {c.awaitingReply && c.status !== 'resolved' && <span className="ci-tag wait">aguardando resposta</span>}
              </div>
            </div>
          </button>
        ))}
        {hasMore && <button type="button" className="btn sm ghost" style={{ margin: '10px auto', display: 'flex' }} disabled={loading} onClick={onLoadMore}>Carregar mais</button>}
      </div>
      <button type="button" className="cl-collapse" onClick={onCollapse} title="Recolher lista" aria-label="Recolher lista"><Icon name="chevronLeft" size={14} /></button>
    </aside>
  );
}
