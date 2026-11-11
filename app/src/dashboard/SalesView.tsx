import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getAccountId, getToken } from '../api';
import { Icon } from '../icons';
import { Spinner, toast, cx } from '../components/ui';
import { Donut, EmptyChart, HBarList, HourBars, TimeChart } from './charts';
import { KpiCard, Panel, ValueQty } from './widgets';
import { InvoiceModal, SaleModal, type ConnOpt } from './modals';
import { fmtCompact, fmtDec, fmtMoney, fmtNum, fmtPct, fmtPhone, SALE_STATUS, trend } from './format';
import type { SaleRow, SalesDash } from './types';
import type { Product } from '../types';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

export function SalesView({ data, query, currency: cur, refreshKey, products, connections, onChanged, onAdSpend }: {
  data: SalesDash; query: string; currency: string; refreshKey: number; products: Product[]; connections: ConnOpt[];
  onChanged: () => void; onAdSpend: () => void;
}) {
  const k = data.kpis; const p = data.previous;
  const money = (v: number) => fmtMoney(v, cur);
  const [mode, setMode] = useState<'valor' | 'qtd'>('valor');
  const [prodMode, setProdMode] = useState<'valor' | 'qtd'>('valor');
  const [hiddenProducts, setHiddenProducts] = useState<string[]>([]);
  const [prodFilterOpen, setProdFilterOpen] = useState(false);

  const kpis = [
    { icon: 'users', tone: 'blue', label: 'Leads novos', value: fmtNum(k.leads), t: trend(k.leads, p.leads), info: 'Contatos que falaram com você pela primeira vez no período.' },
    { icon: 'dollar', tone: 'teal', valueTone: 'teal', label: 'Faturamento', value: money(k.revenue), t: trend(k.revenue, p.revenue), info: 'Soma das vendas aprovadas no período (sem pendentes, recusadas e reembolsos).' },
    { icon: 'bag', tone: 'purple', label: 'Vendas', value: fmtNum(k.sales), t: trend(k.sales, p.sales), info: 'Quantidade de vendas aprovadas no período.' },
    { icon: 'trophy', tone: 'amber', valueTone: 'amber', label: 'ROAS', value: fmtDec(k.roas), t: trend(k.roas, p.roas), info: 'Retorno sobre o investimento em anúncios: faturamento ÷ gasto com anúncios. ROAS 3 = cada R$ 1 investido voltou R$ 3.' },
    { icon: 'checkCircle', tone: 'green', label: 'Taxa de conversão', value: fmtPct(k.conversion), t: trend(k.conversion, p.conversion), info: 'Vendas aprovadas ÷ leads novos do período.' },
    { icon: 'cart', tone: 'purple', label: 'Ticket médio', value: money(k.ticket), t: trend(k.ticket, p.ticket), info: 'Faturamento ÷ número de vendas aprovadas.' },
    { icon: 'gem', tone: 'green', valueTone: k.profit < 0 ? 'red' : 'green', label: 'Lucro', value: money(k.profit), t: trend(k.profit, p.profit), info: `Faturamento − custo dos produtos (${money(k.cost)}) − taxas e impostos (${money(k.fees)}) − gasto com anúncios. Ajuste as taxas na engrenagem.` },
    { icon: 'megaphone', tone: 'red', valueTone: 'red', label: 'Gasto Meta (Ad)', value: money(k.adSpend), t: trend(k.adSpend, p.adSpend), invert: true, info: 'Investimento em anúncios no período. Clique no ícone de filtro para lançar ou ver os gastos.', action: { icon: 'filter', title: 'Lançar / ver gastos com anúncios', onClick: onAdSpend } },
  ] as const;

  // por que o gasto (e o ROAS) pode estar zerado: conta com erro, conta em outra moeda ou nenhuma conta no painel
  const adAccs = data.adAccounts ?? [];
  const adBroken = adAccs.filter((a) => a.error);
  const adOtherCur = adAccs.length > 0 && adAccs.every((a) => a.currency !== cur);
  const periodData = data.series.period;
  const hourData = data.series.byHour;
  const products2 = data.byProduct.filter((x) => !hiddenProducts.includes(x.id));

  return (
    <>
      <div className="kgrid">
        {kpis.map((x) => (
          <KpiCard key={x.label} icon={x.icon} tone={x.tone} label={x.label} value={x.value} trend={x.t} info={x.info}
            valueTone={'valueTone' in x ? x.valueTone : null} invertTrend={'invert' in x} action={'action' in x ? x.action : undefined}
            testId={`kpi-${x.label}`} />
        ))}
      </div>
      {adBroken.length > 0 && (
        <div className="hint warn dash-adwarn" data-testid="dash-ad-warn">
          <Icon name="alert" size={14} />
          <span>
            <b>Gasto e ROAS incompletos:</b> a Meta não está liberando o gasto de {adBroken.map((a) => `“${a.name}”`).join(', ')}. {adBroken[0].error}
          </span>
        </div>
      )}
      {!adBroken.length && k.adSpend === 0 && (adAccs.length === 0 || adOtherCur) && (
        <div className="hint dash-adwarn" data-testid="dash-ad-info">
          <Icon name="info" size={14} />
          <span>
            {adAccs.length === 0
              ? <>Nenhuma conta de anúncios entra no Dashboard. Ligue a conta em <b>Facebook → Perfis e contas</b> (ou lance o gasto à mão no ícone de filtro do card “Gasto Meta”) para ver o ROAS.</>
              : <>As contas de anúncios do painel estão em {[...new Set(adAccs.map((a) => a.currency))].join(', ')}. Troque a moeda do Dashboard para ver o gasto e o ROAS delas.</>}
          </span>
        </div>
      )}

      <div className="drow two">
        <Panel title="Vendas por período" sub="Histórico temporal das conversões e faturamento" actions={<ValueQty value={mode} onChange={setMode} />} testId="chart-period">
          <TimeChart data={periodData} integer={mode === 'qtd'}
            series={mode === 'valor'
              ? [{ key: 'revenue', name: 'Faturamento', color: '#19b3a4', format: money }]
              : [{ key: 'count', name: 'Vendas', color: '#19b3a4', format: (v) => fmtNum(v) }]} />
        </Panel>
        <Panel title="Vendas por horário" sub="Total de vendas do período filtrado, por hora do dia" testId="chart-hours">
          <HourBars data={hourData.map((h) => ({ hour: h.hour, value: h.count }))} color="var(--primary)"
            tooltip={(i) => (<><b>{String(hourData[i].hour).padStart(2, '0')}h</b><div>Vendas: <b>{hourData[i].count}</b></div><div>Faturamento: <b>{money(hourData[i].revenue)}</b></div></>)} />
        </Panel>
      </div>

      <div className="drow three">
        <Panel title="Vendas por instância" sub="Operações por conexão ativa" testId="chart-conn-count">
          <HBarList color="#2f73e0" items={data.byConnection.map((c) => ({ key: c.id ?? 'none', label: c.name, sub: c.phone, value: c.count, display: `${fmtNum(c.count)} ${c.count === 1 ? 'venda' : 'vendas'}` }))} />
        </Panel>
        <Panel title="Faturamento por instância" sub="Receita por conexão ativa" testId="chart-conn-revenue">
          <HBarList color="#0e9488" items={data.byConnection.map((c) => ({ key: c.id ?? 'none', label: c.name, sub: c.phone, value: c.revenue, display: money(c.revenue) }))} />
        </Panel>
        <Panel title="Vendas por estado" sub="Distribuição geográfica das vendas" testId="chart-states">
          <HBarList color="#8b5cf6" items={data.byState.map((s) => ({ key: s.state ?? 'nd', label: s.state ?? 'Não identificado', sub: money(s.revenue), value: s.count, display: `${fmtNum(s.count)} ${s.count === 1 ? 'venda' : 'vendas'}` }))} />
        </Panel>
      </div>

      <div className="drow two">
        <SalesTable query={query} refreshKey={refreshKey} products={products} connections={connections} currency={cur} onChanged={onChanged} />
        <Panel title="Performance dos produtos" sub="Participação no total" testId="chart-products"
          actions={<>
            <ValueQty value={prodMode} onChange={setProdMode} />
            <div className="menu-wrap">
              <button type="button" className={cx('dicon', hiddenProducts.length > 0 && 'on')} title="Escolher produtos" aria-label="Escolher produtos" onClick={() => setProdFilterOpen((v) => !v)}><Icon name="filter" size={15} /></button>
              {prodFilterOpen && (
                <div className="menu fade" style={{ minWidth: 220 }}>
                  {data.byProduct.length === 0 && <div className="faint" style={{ padding: 10, fontSize: 12.5 }}>Sem produtos no período.</div>}
                  {data.byProduct.map((x) => (
                    <label key={x.id} className="menu-check">
                      <input type="checkbox" checked={!hiddenProducts.includes(x.id)}
                        onChange={(e) => setHiddenProducts((h) => (e.target.checked ? h.filter((i) => i !== x.id) : [...h, x.id]))} />
                      <span>{x.name}</span>
                    </label>
                  ))}
                  {hiddenProducts.length > 0 && <button type="button" onClick={() => setHiddenProducts([])}>Mostrar todos</button>}
                </div>
              )}
            </div>
          </>}>
          <Donut items={products2.map((x) => ({ key: x.id, label: x.name, value: prodMode === 'valor' ? x.revenue : x.count }))}
            format={prodMode === 'valor' ? money : (v) => fmtNum(v)} centerLabel={prodMode === 'valor' ? 'faturamento' : 'vendas'}
            centerFormat={prodMode === 'valor' ? (v) => `${cur === 'BRL' ? 'R$ ' : `${cur} `}${fmtCompact(v)}` : (v) => fmtNum(v)} />
        </Panel>
      </div>
    </>
  );
}

/* -------------------------------------------------------------- histórico */

function SalesTable({ query, refreshKey, products, connections, currency, onChanged }: {
  query: string; refreshKey: number; products: Product[]; connections: ConnOpt[]; currency: string; onChanged: () => void;
}) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SaleRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<SaleRow | null | 'new'>(null);
  const [invoice, setInvoice] = useState<SaleRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const pageSize = 20;
  const lastQuery = useRef(query);

  useEffect(() => { if (lastQuery.current !== query) { lastQuery.current = query; setPage(1); } }, [query]);
  useEffect(() => {
    let alive = true;
    api.get<{ rows: SaleRow[]; total: number }>(`/dashboard/sales/list?${query}&page=${page}&pageSize=${pageSize}`)
      .then((r) => { if (alive) { setRows(r.rows); setTotal(r.total); } })
      .catch((e) => toast((e as Error).message));
    return () => { alive = false; };
  }, [query, page, refreshKey]);

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await fetch(`${API_BASE}/dashboard/sales/export.csv?${query}`, {
        headers: { Authorization: `Bearer ${getToken()}`, 'x-account-id': getAccountId() ?? '' },
      });
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'vendas.csv';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(`Não foi possível exportar: ${(e as Error).message}`); }
    finally { setExporting(false); }
  }

  async function remove(s: SaleRow) {
    if (!confirm(`Excluir a venda de ${s.customerName ?? 'cliente'} (${fmtMoney(s.amount, s.currency)})?`)) return;
    try { await api.del(`/sales/${s.id}`); toast('Venda excluída'); onChanged(); } catch (e) { toast((e as Error).message); }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const saved = () => { setEditing(null); setInvoice(null); onChanged(); };
  const cols = useMemo(() => ['Instância', 'Nº da instância', 'Nº do lead', 'Cliente (nome)', 'Produto', 'ID', 'Valor', 'Moeda', 'Source ID', 'Data', 'Ações'], []);

  return (
    <Panel title="Histórico de vendas" sub="Auditoria e emissão fiscal de notas" testId="sales-history"
      actions={<>
        <button type="button" className="btn sm" onClick={exportCsv} disabled={exporting || total === 0} data-testid="export-csv"><Icon name="download" size={14} />{exporting ? 'Exportando…' : 'Exportar CSV'}</button>
        <button type="button" className="btn sm primary" onClick={() => setEditing('new')} data-testid="new-sale"><Icon name="plus" size={14} />Nova venda</button>
      </>}>
      <div className="dtable">
        <table>
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows?.map((s) => (
              <tr key={s.id}>
                <td>{s.connectionName ?? <span className="faint">—</span>}</td>
                <td className="nowrap">{s.connectionPhone ?? <span className="faint">—</span>}</td>
                <td className="nowrap">{fmtPhone(s.customerPhone)}</td>
                <td><b>{s.customerName ?? '—'}</b></td>
                <td>{s.productName ?? <span className="faint">—</span>}</td>
                <td className="mono" title={s.id}>{s.externalId ?? s.id.slice(0, 8)}</td>
                <td className="nowrap"><b>{fmtMoney(s.amount, s.currency)}</b><span className={cx('pill mini', SALE_STATUS[s.status][0])}>{SALE_STATUS[s.status][1]}</span></td>
                <td>{s.currency}</td>
                <td className="mono">{s.sourceId ?? <span className="faint">—</span>}</td>
                <td className="nowrap">{s.dateLabel}</td>
                <td className="nowrap">
                  <button className="btn icon sm ghost" title="Editar venda" aria-label="Editar venda" onClick={() => setEditing(s)}><Icon name="edit" size={14} /></button>
                  <button className={cx('btn icon sm ghost', !!s.invoiceIssuedAt && 'nf-on')} title={s.invoiceIssuedAt ? `Nota ${s.invoiceNumber ?? ''} emitida` : 'Nota fiscal'} aria-label="Nota fiscal" onClick={() => setInvoice(s)}><Icon name="file" size={14} /></button>
                  <button className="btn icon sm ghost" title="Excluir venda" aria-label="Excluir venda" onClick={() => remove(s)}><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows && <div style={{ height: 120 }}><Spinner /></div>}
        {rows && rows.length === 0 && <EmptyChart height={110}><i>Nenhuma venda registrada no histórico do período.</i></EmptyChart>}
      </div>
      {total > pageSize && (
        <div className="row dpager">
          <span className="faint">Mostrando {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} de {total}</span>
          <span className="spacer" />
          <button className="btn icon sm" disabled={page <= 1} onClick={() => setPage((x) => x - 1)} aria-label="Página anterior"><Icon name="chevronLeft" size={15} /></button>
          <span style={{ fontWeight: 700, fontSize: 12.5 }}>{page} / {pages}</span>
          <button className="btn icon sm" disabled={page >= pages} onClick={() => setPage((x) => x + 1)} aria-label="Próxima página"><Icon name="chevronRight" size={15} /></button>
        </div>
      )}
      {editing && <SaleModal sale={editing === 'new' ? null : editing} products={products} connections={connections} currency={currency} onClose={() => setEditing(null)} onSaved={saved} />}
      {invoice && <InvoiceModal sale={invoice} onClose={() => setInvoice(null)} onSaved={saved} />}
    </Panel>
  );
}
