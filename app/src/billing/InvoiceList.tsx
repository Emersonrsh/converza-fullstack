import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, cx } from '../components/ui';
import { KIND_LABEL, STATUS_LABEL, fmtDate, fmtMoney, methodLabel, type Invoice } from './types';
import { openInvoice } from './actions';

/** Tabela de faturas (resumo da página principal e a lista completa). */
export function InvoiceTable({ rows, empty, refunds }: { rows: Invoice[]; empty: ReactNode; refunds?: boolean }) {
  if (!rows.length) return <div className="bl-empty" data-testid="bl-invoices-empty">{empty}</div>;
  return (
    <div className="bl-table">
      <table data-testid="bl-invoices">
        <thead>
          <tr>
            <th>Fatura</th><th>{refunds ? 'Reembolso' : 'Data'}</th><th>Descrição</th><th className="r">{refunds ? 'Valor devolvido' : 'Valor'}</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => {
            const [label, color] = refunds
              ? (i.status === 'refunded' ? ['Total', 'blue'] : ['Parcial', 'amber'])
              : STATUS_LABEL[i.status] ?? [i.status, ''];
            const open = i.status === 'pending' || i.status === 'overdue';
            return (
              <tr key={i.id} data-testid="bl-invoice-row">
                <td><b className="bl-mono">#{i.number}</b></td>
                <td>{refunds ? fmtDate(i.refundedAt) : fmtDate(i.paidAt ?? i.dueDate ?? i.createdAt)}</td>
                <td className="bl-desc">
                  <span>{i.description}</span>
                  <small>{KIND_LABEL[i.kind] ?? i.kind}{i.method || i.gateway === 'paddle' ? ` · ${methodLabel(i.method, i.gateway)}` : ''}{open && i.dueDate ? ` · vence ${fmtDate(i.dueDate)}` : ''}</small>
                </td>
                <td className="r bl-mono">{fmtMoney(refunds ? i.refundAmount ?? i.amount : i.amount, i.currency)}</td>
                <td><span className={cx('pill', color)} data-testid="bl-invoice-status">{label}</span></td>
                <td className="r">
                  {i.hasLink && i.status !== 'canceled' && (
                    <button type="button" className={cx('btn sm', open && 'primary')} onClick={() => void openInvoice(i)} data-testid="bl-invoice-open">
                      {open ? 'Pagar' : i.gateway === 'paddle' ? 'PDF' : 'Ver'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Filters { status: string; kind: string; from: string; to: string; q: string }
const EMPTY: Filters = { status: 'all', kind: 'all', from: '', to: '', q: '' };

/** Assinatura › Faturas e Assinatura › Reembolsos (com filtros e páginas). */
export function InvoiceList({ refunds }: { refunds?: boolean }) {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [err, setErr] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page) });
    if (!refunds && applied.status !== 'all') qs.set('status', applied.status);
    if (applied.kind !== 'all') qs.set('kind', applied.kind);
    if (applied.from) qs.set('from', applied.from);
    if (applied.to) qs.set('to', applied.to);
    if (applied.q.trim()) qs.set('q', applied.q.trim());
    return api.get<{ invoices?: Invoice[]; refunds?: Invoice[]; total: number; pageSize: number }>(`/billing/${refunds ? 'refunds' : 'invoices'}?${qs}`)
      .then((r) => { setRows((refunds ? r.refunds : r.invoices) ?? []); setTotal(r.total); setPageSize(r.pageSize); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Erro'));
  }, [page, applied, refunds]);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = () => void load();
    sock.on('billing:changed', on);
    return () => { sock.off('billing:changed', on); };
  }, [load]);

  const active = JSON.stringify(applied) !== JSON.stringify(EMPTY);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const title = refunds ? 'Reembolsos' : 'Faturas';

  return (
    <div className="fade bl-page" data-testid={refunds ? 'bl-refunds-page' : 'bl-invoices-page'}>
      <div className="bl-crumb"><Link to="/billing">Cobranças e assinaturas</Link><Icon name="chevronRight" size={14} /><span>{title}</span></div>
      <section className="card bl-history">
        <div className="bl-history-h">
          <div><b>{title}</b><small>{refunds ? 'Consulte reembolsos processados na sua conta' : 'Consulte o histórico de faturas da sua conta'}</small></div>
          <button type="button" className={cx('btn sm', (showFilters || active) && 'on')} onClick={() => setShowFilters((v) => !v)} data-testid="bl-filters-btn">
            <Icon name="filter" size={14} />Filtros{active ? ' (ativos)' : ''}
          </button>
        </div>
        {showFilters && (
          <form className="bl-filters" data-testid="bl-filters" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(f); }}>
            {!refunds && (
              <div><label className="label">Status</label>
                <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} data-testid="bl-f-status">
                  <option value="all">Todos</option><option value="paid">Pagas</option><option value="open">Em aberto</option>
                  <option value="overdue">Vencidas</option><option value="refunded">Reembolsadas</option><option value="canceled">Canceladas</option>
                </select></div>
            )}
            <div><label className="label">Tipo</label>
              <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} data-testid="bl-f-kind">
                <option value="all">Todos</option><option value="subscription">Mensalidade</option><option value="instances">Instâncias</option>
                <option value="tokens">Tokens de IA</option><option value="dispatch">Disparos extras</option>
              </select></div>
            <div><label className="label">De</label><input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} data-testid="bl-f-from" /></div>
            <div><label className="label">Até</label><input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} data-testid="bl-f-to" /></div>
            <div className="bl-f-q"><label className="label">Buscar</label><input className="input" value={f.q} placeholder="Nº da fatura ou descrição" onChange={(e) => setF({ ...f, q: e.target.value })} data-testid="bl-f-q" /></div>
            <div className="bl-f-btns">
              <button type="button" className="btn sm ghost" onClick={() => { setF(EMPTY); setApplied(EMPTY); setPage(1); }} data-testid="bl-f-clear">Limpar</button>
              <button type="submit" className="btn sm primary" data-testid="bl-f-apply">Aplicar</button>
            </div>
          </form>
        )}
        {err && !rows && <div className="hint bad"><Icon name="alert" size={14} />{err}</div>}
        {!rows && !err && <Spinner />}
        {rows && (
          <InvoiceTable rows={rows} refunds={refunds} empty={refunds
            ? <><Icon name="rotateCcw" size={26} /><b>Nenhum reembolso encontrado</b><span>Seus reembolsos aparecerão aqui quando disponíveis</span></>
            : <><Icon name="file" size={26} /><b>Nenhuma fatura encontrada</b><span>{active ? 'Nenhuma fatura com esses filtros.' : 'Suas faturas aparecerão aqui quando disponíveis'}</span></>} />
        )}
        {rows && pages > 1 && (
          <div className="bl-pager" data-testid="bl-pager">
            <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="chevronLeft" size={14} />Anterior</button>
            <span>Página {page} de {pages}</span>
            <button type="button" className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima<Icon name="chevronRight" size={14} /></button>
          </div>
        )}
      </section>
    </div>
  );
}
