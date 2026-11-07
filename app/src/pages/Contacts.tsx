import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { getSocket } from '../socket';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Avatar, Spinner, TopbarActions, TopbarSub, cx, toast } from '../components/ui';
import { tagColor, useTags } from '../components/TagPicker';
import { ConfirmModal } from '../kanban/modals';
import { timeAgo } from '../kanban/util';
import { fmtPhone } from '../chats/util';
import { useContactFields } from '../contacts/CustomFields';
import { FiltersPanel } from '../contacts/FiltersPanel';
import { ContactDrawer } from '../contacts/ContactDrawer';
import { BulkKanbanModal, BulkStageModal, BulkTagsModal, ExportsModal, ImportModal, NewContactModal } from '../contacts/modals';
import {
  EMPTY_FILTERS, ORIGINS, ORIGIN_ICON, ORIGIN_LABEL, STATUS_OPTIONS, dateBR, downloadFromApi, filtersBody, filtersLabel, filtersQuery, panelCount,
} from '../contacts/util';
import type { ContactFiltersState, ContactItem, ContactListResp } from '../contacts/types';
import type { KBoardSummary } from '../kanban/types';

type ModalState = null | 'new' | 'import' | 'exports' | 'bulk-add' | 'bulk-remove' | 'bulk-stage' | 'bulk-kanban' | 'bulk-delete' | { del: ContactItem };
const PAGE = 50;
const fmtN = (n: number) => n.toLocaleString('pt-BR');

export function Contacts() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const openId = params.get('id');
  const { accountId, accounts } = useAuth();
  const role = accounts.find((a) => a.id === accountId)?.role;
  const canDelete = role !== 'agent';
  const fields = useContactFields() ?? [];
  const [tagsKey, setTagsKey] = useState(0);
  const tags = useTags(tagsKey);
  const [boards, setBoards] = useState<KBoardSummary[]>([]);
  const [filters, setFilters] = useState<ContactFiltersState>(EMPTY_FILTERS);
  const [q, setQ] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  const [sort, setSort] = useState('created_desc');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ContactListResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportsKey, setExportsKey] = useState(0);
  const seq = useRef(0);

  const openContact = useCallback((id: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('id', id); else n.delete('id'); return n; }, { replace: true });
  }, [setParams]);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.get<ContactListResp>(`/contacts?${filtersQuery(filters, { page, sort, limit: PAGE })}`);
      if (my !== seq.current) return;
      setData(r);
      if (page > r.pages) setPage(r.pages);
    } catch (e) { if (my === seq.current) toast(e instanceof Error ? e.message : 'Não foi possível carregar os contatos'); }
    if (my === seq.current) setLoading(false);
  }, [filters, page, sort]);
  useEffect(() => { void load(); }, [load, accountId]);

  // busca com atraso; filtros/ordem novos voltam para a página 1 e limpam a seleção
  useEffect(() => { const t = setTimeout(() => setFilters((f) => (f.q === q.trim() ? f : { ...f, q: q.trim() })), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setPage(1); setSelected(new Set()); setAllMatching(false); }, [filters, sort]);

  useEffect(() => {
    api.get<{ boards: KBoardSummary[] }>('/kanban/boards').then((r) => setBoards(r.boards)).catch(() => setBoards([]));
  }, [accountId]);

  // tempo real: contato novo chegando pelo WhatsApp, Kanban mudando
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 1500); };
    sock.on('message:new', on);
    sock.on('kanban:changed', on);
    sock.on('contacts:changed', on); // lead chegando por webhook
    return () => { sock.off('message:new', on); sock.off('kanban:changed', on); sock.off('contacts:changed', on); if (t) clearTimeout(t); };
  }, [load]);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  const list = data?.contacts ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;
  const pcount = panelCount(filters);
  const anyFilter = !!(filters.q || filters.status || filters.origin || pcount);
  const pageIds = list.map((c) => c.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selCount = allMatching ? total : selected.size;
  const columnNames = useMemo(() => new Map(boards.flatMap((b) => b.columns.map((c) => [c.id, `${b.name} › ${c.name}`] as [string, string]))), [boards]);

  function toggleSort(a: string, b: string) { setSort((s) => (s === a ? b : a)); }
  const sortIcon = (a: string, b: string) => (sort === a ? '↓' : sort === b ? '↑' : '');

  const target = () => filtersBody(filters, allMatching ? undefined : [...selected]);

  async function exportCsv() {
    setExporting(true);
    try {
      const body = selCount ? { filters: target(), label: filtersLabel(filters, { fields, columns: columnNames }, allMatching ? undefined : selected.size) } : { filters: filtersBody(filters), label: filtersLabel(filters, { fields, columns: columnNames }) };
      if (selCount && allMatching) body.label = `Todos os ${fmtN(total)} resultados${anyFilter ? ` · ${filtersLabel(filters, { fields, columns: columnNames })}` : ''}`;
      const r = await api.post<{ export: { id: string; filename: string; rows: number } }>('/contacts/exports', body);
      await downloadFromApi(`/contacts/exports/${r.export.id}/download`, r.export.filename);
      toast(`Exportados ${fmtN(r.export.rows)} contato${r.export.rows === 1 ? '' : 's'} — fica salvo em “Recentes”`);
      setExportsKey((k) => k + 1);
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível exportar'); }
    setExporting(false);
  }

  async function bulk(action: string, extra: Record<string, unknown>, okMsg: (n: number) => string) {
    try {
      const r = await api.post<{ affected: number }>('/contacts/bulk', { filters: target(), action, ...extra });
      toast(okMsg(r.affected));
      setModal(null); setSelected(new Set()); setAllMatching(false);
      if (action === 'add_tags') { setTagsKey((k) => k + 1); }
      void load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível aplicar'); }
  }

  async function removeOne(c: ContactItem) {
    try { await api.del(`/contacts/${c.id}`); toast(`Contato “${c.name}” excluído`); setModal(null); void load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível excluir'); }
  }

  const s = (n: number) => (n === 1 ? '' : 's');
  return (
    <div className="fade ct-page" data-testid="contacts-page">
      <TopbarSub>
        {counts ? (
          <span data-testid="contacts-counts">
            {fmtN(counts.total)} contato{s(counts.total)} • <span title="Falaram com você nos últimos 30 dias">{fmtN(counts.active)} ativo{s(counts.active)}</span> • <span title="Ainda não compraram">{fmtN(counts.leads)} lead{s(counts.leads)}</span>
          </span>
        ) : '…'}
      </TopbarSub>
      <TopbarActions>
        <button type="button" className={cx('btn', showPanel && 'on')} onClick={() => setShowPanel((v) => !v)} data-testid="toggle-filters">
          <Icon name="filter" size={15} />Filtros{pcount > 0 && <span className="ct-badge">{pcount}</span>}
        </button>
        <button type="button" className="btn" onClick={() => setModal('exports')} data-testid="open-exports"><Icon name="history" size={15} />Recentes</button>
        <button type="button" className="btn" disabled={!total || exporting} onClick={exportCsv} data-testid="export-csv"><Icon name="download" size={15} />{exporting ? 'Exportando…' : 'Exportar CSV'}</button>
        <button type="button" className="btn" onClick={() => setModal('import')} data-testid="open-import"><Icon name="upload" size={15} />Importar CSV</button>
        <button type="button" className="btn primary" onClick={() => setModal('new')} data-testid="new-contact"><Icon name="plus" size={16} />Novo Contato</button>
      </TopbarActions>

      {showPanel && <FiltersPanel value={filters} fields={fields} tags={tags} boards={boards} onApply={(p) => setFilters((f) => ({ ...f, ...p }))} />}

      <div className="ct-bar">
        <div className="fl-search ct-search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="Buscar contato..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar contato" data-testid="contact-search" />
        </div>
        <span className="spacer" />
        <select className={cx('select', filters.status && 'on')} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as ContactFiltersState['status'] }))} aria-label="Status" data-testid="status-filter">
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className={cx('select', filters.origin && 'on')} value={filters.origin} onChange={(e) => setFilters((f) => ({ ...f, origin: e.target.value as ContactFiltersState['origin'] }))} aria-label="Origem" data-testid="origin-filter">
          <option value="">Todas as origens</option>
          {ORIGINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>

      {selCount > 0 && (
        <div className="ct-bulk fade" data-testid="bulk-bar">
          <b>{fmtN(selCount)} selecionado{s(selCount)}</b>
          {!allMatching && pageAll && total > list.length && (
            <button type="button" className="linkbtn" onClick={() => setAllMatching(true)} data-testid="select-all-matching">Selecionar todos os {fmtN(total)} resultados</button>
          )}
          {allMatching && <span className="faint">(todos os resultados{anyFilter ? ' do filtro' : ''})</span>}
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => setModal('bulk-add')} data-testid="bulk-add-tags"><Icon name="tag" size={14} />Etiquetar</button>
          <button type="button" className="btn sm" onClick={() => setModal('bulk-remove')}><Icon name="tag" size={14} />Remover etiqueta</button>
          <button type="button" className="btn sm" onClick={() => setModal('bulk-kanban')} data-testid="bulk-kanban"><Icon name="kanban" size={14} />Kanban</button>
          <button type="button" className="btn sm" onClick={() => setModal('bulk-stage')} data-testid="bulk-stage-btn">Etapa</button>
          <button type="button" className="btn sm" onClick={exportCsv} disabled={exporting}><Icon name="download" size={14} />Exportar</button>
          {canDelete && <button type="button" className="btn sm danger" onClick={() => setModal('bulk-delete')} data-testid="bulk-delete"><Icon name="trash" size={14} />Excluir</button>}
          <button type="button" className="btn icon sm ghost" onClick={() => { setSelected(new Set()); setAllMatching(false); }} aria-label="Limpar seleção"><Icon name="close" size={14} /></button>
        </div>
      )}

      <div className="card ct-card">
        {!data ? <div style={{ height: 240 }}><Spinner /></div>
          : list.length === 0 ? (
            <div className="ct-empty" data-testid="contacts-empty">
              <Icon name="users" size={40} stroke={1.5} />
              {counts?.total === 0 && !anyFilter ? (
                <>
                  <b>Nenhum contato criado</b>
                  <span>Crie seu primeiro contato para começar a gerenciar</span>
                  <button type="button" className="btn primary" onClick={() => setModal('new')} data-testid="create-first"><Icon name="plus" size={15} />Criar Primeiro Contato</button>
                </>
              ) : (
                <>
                  <b>Nenhum contato encontrado</b>
                  <span>Tente ajustar a busca ou os filtros</span>
                  <button type="button" className="btn" onClick={() => { setQ(''); setFilters(EMPTY_FILTERS); }}>Limpar busca e filtros</button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className={cx('ct-scroll', loading && 'loading')}>
                <table className="ct-table">
                  <thead>
                    <tr>
                      <th className="ct-ck"><input type="checkbox" checked={pageAll} aria-label="Selecionar a página"
                        onChange={() => { setAllMatching(false); setSelected((cur) => { const n = new Set(cur); if (pageAll) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); return n; }); }} data-testid="select-page" /></th>
                      <th><button type="button" className="ct-sort" onClick={() => toggleSort('name_asc', 'name_desc')}>Contato {sortIcon('name_desc', 'name_asc')}</button></th>
                      <th>Etiquetas</th>
                      <th>Kanban</th>
                      <th>Origem</th>
                      <th><button type="button" className="ct-sort" onClick={() => toggleSort('last_desc', 'last_asc')}>Última conversa {sortIcon('last_desc', 'last_asc')}</button></th>
                      <th><button type="button" className="ct-sort" onClick={() => toggleSort('created_desc', 'created_asc')} data-testid="sort-created">Criado em {sortIcon('created_desc', 'created_asc')}</button></th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id} className={cx(selected.has(c.id) || allMatching ? 'sel' : '')} onClick={() => openContact(c.id)} data-testid="contact-row">
                        <td className="ct-ck" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={allMatching || selected.has(c.id)} aria-label={`Selecionar ${c.name}`}
                            onChange={() => { setAllMatching(false); setSelected((cur) => { const n = new Set(cur); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; }); }} data-testid="select-row" />
                        </td>
                        <td>
                          <div className="ct-who">
                            <Avatar name={c.name || c.phone} size={32} />
                            <div><b>{c.name}</b><small>{fmtPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</small></div>
                          </div>
                        </td>
                        <td>
                          <div className="ct-tags">
                            {c.tags.slice(0, 3).map((t) => <span key={t} style={{ ['--tc' as string]: tagColor(tags, t) }}>{t}</span>)}
                            {c.tags.length > 3 && <span className="more" title={c.tags.slice(3).join(', ')}>+{c.tags.length - 3}</span>}
                          </div>
                        </td>
                        <td>
                          <div className="ct-kb">
                            {c.kanban.slice(0, 2).map((k) => <span key={k.cardId} style={{ ['--cc' as string]: k.color }} title={`${k.boardName} › ${k.columnName}`}><i />{k.columnName}</span>)}
                            {c.kanban.length > 2 && <span className="more" title={c.kanban.slice(2).map((k) => `${k.boardName} › ${k.columnName}`).join('\n')}>+{c.kanban.length - 2}</span>}
                          </div>
                        </td>
                        <td><span className="ct-origin"><Icon name={ORIGIN_ICON[c.origin] ?? 'user'} size={13} />{ORIGIN_LABEL[c.origin] ?? c.origin}</span>{c.purchases > 0 && <span className="pill green ct-buyer" title={`${c.purchases} compra(s) aprovada(s)`}>cliente</span>}</td>
                        <td className="muted ct-last">{c.lastContactAt ? <span title={new Date(c.lastContactAt).toLocaleString('pt-BR')}>{timeAgo(c.lastContactAt)}</span> : '—'}{c.unreadCount > 0 && <span className="ct-unread">{c.unreadCount}</span>}</td>
                        <td className="muted">{dateBR(c.createdAt)}</td>
                        <td className="ct-act" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="btn icon sm ghost" title={c.conversationId ? 'Abrir conversa' : 'Iniciar conversa'} aria-label={c.conversationId ? 'Abrir conversa' : 'Iniciar conversa'}
                            onClick={() => nav(c.conversationId ? `/inbox?c=${c.conversationId}` : `/inbox?novo=${c.id}`)} data-testid="row-chat"><Icon name="chats" size={15} /></button>
                          <div className="menu-wrap">
                            <button type="button" className="btn icon sm ghost" onClick={() => setMenu(menu === c.id ? null : c.id)} aria-label={`Ações de ${c.name}`} data-testid="row-menu"><Icon name="dots" size={15} /></button>
                            {menu === c.id && (
                              <div className="menu fade" onClick={() => setMenu(null)}>
                                <button type="button" onClick={() => openContact(c.id)}><Icon name="edit" size={15} />Abrir ficha</button>
                                <button type="button" onClick={() => nav(c.conversationId ? `/inbox?c=${c.conversationId}` : `/inbox?novo=${c.id}`)}><Icon name="chats" size={15} />{c.conversationId ? 'Abrir conversa' : 'Iniciar conversa'}</button>
                                {canDelete && <><div className="sep" /><button type="button" className="danger" onClick={() => setModal({ del: c })}><Icon name="trash" size={15} />Excluir</button></>}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="ct-foot">
                <span className="faint" data-testid="contacts-range">{fmtN((data.page - 1) * data.limit + 1)}–{fmtN(Math.min(data.page * data.limit, total))} de {fmtN(total)}{anyFilter ? ' (com filtros)' : ''}</span>
                <span className="spacer" />
                <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="page-prev"><Icon name="chevronLeft" size={14} />Anterior</button>
                <span className="ct-page-n">Página {data.page} de {data.pages}</span>
                <button type="button" className="btn sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} data-testid="page-next">Próxima<Icon name="chevronRight" size={14} /></button>
              </div>
            </>
          )}
      </div>

      {openId && (
        <ContactDrawer id={openId} canDelete={canDelete} onClose={() => openContact(null)}
          onChanged={() => { setTagsKey((k) => k + 1); void load(); }} onDeleted={() => { openContact(null); void load(); }} />
      )}
      {modal === 'new' && <NewContactModal onClose={() => setModal(null)} onOpen={(id) => { setModal(null); openContact(id); }} onCreated={(id) => { setModal(null); setTagsKey((k) => k + 1); void load(); openContact(id); }} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} onDone={() => { setTagsKey((k) => k + 1); void load(); }} />}
      {modal === 'exports' && <ExportsModal refreshKey={exportsKey} onClose={() => setModal(null)} />}
      {modal === 'bulk-add' && <BulkTagsModal mode="add" count={selCount} onClose={() => setModal(null)} onApply={(t) => bulk('add_tags', { tags: t }, (n) => `Etiquetas adicionadas em ${fmtN(n)} contato${s(n)}`)} />}
      {modal === 'bulk-remove' && <BulkTagsModal mode="remove" count={selCount} onClose={() => setModal(null)} onApply={(t) => bulk('remove_tags', { tags: t }, (n) => `Etiquetas removidas de ${fmtN(n)} contato${s(n)}`)} />}
      {modal === 'bulk-stage' && <BulkStageModal count={selCount} onClose={() => setModal(null)} onApply={(st) => bulk('set_stage', { stage: st }, (n) => `Etapa alterada em ${fmtN(n)} contato${s(n)}`)} />}
      {modal === 'bulk-kanban' && <BulkKanbanModal count={selCount} onClose={() => setModal(null)} onApply={(b, c) => bulk('kanban', { boardId: b, columnId: c }, (n) => `${fmtN(n)} contato${s(n)} colocado${s(n)} no Kanban`)} />}
      {modal === 'bulk-delete' && (
        <ConfirmModal title="Excluir contatos" confirm={`Excluir ${fmtN(selCount)}`} danger onClose={() => setModal(null)} onConfirm={() => bulk('delete', {}, (n) => `${fmtN(n)} contato${s(n)} excluído${s(n)}`)}>
          Excluir <b>{fmtN(selCount)} contato{s(selCount)}</b>? As conversas, mensagens e cards do Kanban deles também são apagados. As vendas continuam no histórico. Não dá para desfazer.
        </ConfirmModal>
      )}
      {modal && typeof modal === 'object' && 'del' in modal && (
        <ConfirmModal title="Excluir contato" confirm="Excluir contato" danger onClose={() => setModal(null)} onConfirm={() => removeOne(modal.del)}>
          Excluir <b>{modal.del.name}</b>? A conversa, as mensagens e os cards do Kanban dele também são apagados. As vendas continuam no histórico.
        </ConfirmModal>
      )}
    </div>
  );
}
