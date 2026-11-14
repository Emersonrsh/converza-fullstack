import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { KpiCard, Panel } from './widgets';
import { fmtDec, fmtMoney, fmtNum } from './format';
import type { Product } from '../types';

interface Line { id: string; name: string; sales: number; revenue: number; cost: number; fees: number; spend: number; adSales: number; profit: number; roas: number; cpa: number; margin: number }
interface Camp {
  id: string; name: string; actId: string; accountName: string; status: { key: string; label: string }; budget: { amount: number; kind: string } | null;
  spend: number; conversations: number; sales: number; revenue: number; profit: number; roas: number; cpa: number;
  product: { id: string; name: string; source: 'manual' | 'auto' } | null;
}
export interface TodayData {
  date: string; currency: string; feePct: number; totals: Line; products: Line[]; campaigns: Camp[];
  recent: { id: string; amount: number; at: string; product: string; customer: string | null; fromAd: boolean }[];
  accounts: { actId: string; name: string }[]; otherCurrencies: string[];
  errors: { actId: string; name: string; message: string }[]; updatedAt: string;
}

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  return `há ${Math.floor(s / 3600)} h`;
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Painel do dia: gasto × faturamento × lucro de hoje, por produto e por campanha, atualizando sozinho. */
export function TodayView({ currency, products, canEdit, refreshKey }: { currency: string; products: Product[]; canEdit: boolean; refreshKey: number }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const req = useRef(0);
  const money = (v: number) => fmtMoney(v, currency);

  const load = useCallback(async (fresh = false) => {
    const id = ++req.current;
    setBusy(true);
    try {
      const r = await api.get<TodayData>(`/ads-today?currency=${currency}${fresh ? '&fresh=1' : ''}`);
      if (id === req.current) { setData(r); setErr(null); }
    } catch (e) {
      if (id === req.current) setErr((e as Error).message);
    } finally {
      if (id === req.current) setBusy(false);
    }
  }, [currency]);

  useEffect(() => { void load(refreshKey > 0); }, [load, refreshKey]);
  // ao vivo: venda nova chega pelo socket; gasto da Meta a cada minuto; relógio do "há X min"
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const kick = () => { clearTimeout(t); t = setTimeout(() => void load(), 1200); };
    const sock = getSocket();
    sock?.on('sale:changed', kick);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => { sock?.off('sale:changed', kick); clearInterval(poll); clearInterval(clock); clearTimeout(t); };
  }, [load]);

  async function setProduct(c: Camp, productId: string) {
    try {
      await api.put('/ads-today/campaign-product', { actId: c.actId, campaignId: c.id, productId: productId || null });
      toast(productId ? 'Campanha ligada ao produto' : 'Produto da campanha volta a ser automático');
      void load();
    } catch (e) { toast((e as Error).message); }
  }

  if (!data) return err ? <div className="note err"><Icon name="alert" size={15} /><span>Não foi possível carregar: {err}</span></div> : <div style={{ height: 300 }}><Spinner /></div>;
  const t = data.totals;
  const kpis = [
    { icon: 'megaphone', tone: 'red', valueTone: 'red', label: 'Gasto hoje', value: money(t.spend), info: 'Valor gasto hoje nas contas de anúncios escolhidas (Meta), no fuso da sua conta.' },
    { icon: 'dollar', tone: 'teal', valueTone: 'teal', label: 'Faturamento hoje', value: money(t.revenue), info: 'Vendas aprovadas de hoje, de anúncio ou não.' },
    { icon: 'gem', tone: 'green', valueTone: t.profit < 0 ? 'red' : 'green', label: 'Lucro hoje', value: money(t.profit), info: `Faturamento − custo dos produtos (${money(t.cost)}) − taxas e impostos (${money(t.fees)}, ${fmtDec(data.feePct)}%) − gasto. Ajuste as taxas na engrenagem.` },
    { icon: 'trophy', tone: 'amber', valueTone: 'amber', label: 'ROAS hoje', value: `${fmtDec(t.roas)}x`, info: 'Faturamento de hoje ÷ gasto de hoje.' },
    { icon: 'bag', tone: 'purple', label: 'Vendas hoje', value: fmtNum(t.sales), info: `${fmtNum(t.adSales)} delas vieram de um anúncio (pelo ID do anúncio no WhatsApp ou na venda).` },
    { icon: 'cart', tone: 'blue', label: 'Custo por venda', value: t.cpa ? money(t.cpa) : '—', info: 'Gasto de hoje ÷ vendas de hoje.' },
  ] as const;

  return (
    <div className={cx('today', busy && 'busy')} data-testid="today">
      <div className="today-bar">
        <span className="live-dot" />
        <b>Hoje, {data.date.split('-').reverse().slice(0, 2).join('/')}</b>
        <span className="faint">· gasto da Meta atualizado {ago(data.updatedAt, now)} · vendas em tempo real</span>
      </div>

      {data.errors.length > 0 && <div className="hint warn"><Icon name="alert" size={14} /><span><b>Gasto incompleto:</b> {data.errors.map((e) => `${e.name}: ${e.message}`).join(' · ')}</span></div>}
      {!data.accounts.length && (
        <div className="hint" data-testid="today-no-ads"><Icon name="megaphone" size={14} />
          <span>Nenhuma conta de anúncios em {currency} no painel: o gasto fica zerado. {data.otherCurrencies.length ? `Suas contas estão em ${data.otherCurrencies.join(', ')}; troque a moeda acima.` : <>Escolha as contas em <Link to="/meta/perfis">Facebook → Perfis e contas</Link>.</>}</span>
        </div>
      )}

      <div className="kgrid six">
        {kpis.map((x) => (
          <KpiCard key={x.label} icon={x.icon} tone={x.tone} label={x.label} value={x.value} trend={0} hideTrend info={x.info}
            valueTone={'valueTone' in x ? x.valueTone : null} testId={`today-${x.label}`} />
        ))}
      </div>

      <Panel title="Lucro por produto" sub="O gasto de cada campanha entra no produto dela (escolhido abaixo ou o que ela mais vendeu nos últimos 30 dias)" testId="today-products">
        {data.products.length ? (
          <div className="dtable">
            <table>
              <thead><tr><th>Produto</th><th>Vendas</th><th>Faturamento</th><th>Gasto</th><th>Custos e taxas</th><th>Lucro</th><th>ROAS</th><th>CPA</th><th>Margem</th></tr></thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.id} data-testid="today-product" className={cx(p.id === 'sem-produto' && 'muted')}>
                    <td><b>{p.name}</b>{p.adSales > 0 && <small className="faint"> · {fmtNum(p.adSales)} de anúncio</small>}</td>
                    <td>{fmtNum(p.sales)}</td>
                    <td>{money(p.revenue)}</td>
                    <td>{p.spend ? money(p.spend) : <span className="faint">—</span>}</td>
                    <td title={`Custo dos produtos ${money(p.cost)} + taxas e impostos ${money(p.fees)}`}>{money(p.cost + p.fees)}</td>
                    <td className={cx('profit', p.profit >= 0 ? 'pos' : 'neg')} data-testid="today-product-profit"><b>{money(p.profit)}</b></td>
                    <td>{p.spend ? `${fmtDec(p.roas)}x` : '—'}</td>
                    <td>{p.cpa ? money(p.cpa) : '—'}</td>
                    <td>{p.revenue ? `${fmtDec(p.margin)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td><b>Total</b></td><td>{fmtNum(t.sales)}</td><td>{money(t.revenue)}</td><td>{money(t.spend)}</td><td>{money(t.cost + t.fees)}</td>
                <td className={cx('profit', t.profit >= 0 ? 'pos' : 'neg')}><b>{money(t.profit)}</b></td><td>{t.spend ? `${fmtDec(t.roas)}x` : '—'}</td><td>{t.cpa ? money(t.cpa) : '—'}</td><td>{t.revenue ? `${fmtDec(t.margin)}%` : '—'}</td>
              </tr></tfoot>
            </table>
          </div>
        ) : <p className="faint today-empty">Nenhuma venda nem gasto hoje ainda.</p>}
      </Panel>

      <div className="today-cols">
        <Panel title="Campanhas de hoje" sub="Gasto, vendas atribuídas e o produto de cada campanha" testId="today-campaigns">
          {data.campaigns.length ? (
            <div className="dtable">
              <table>
                <thead><tr><th>Campanha</th><th>Gasto</th><th>Vendas</th><th>Lucro</th><th>ROAS</th><th>Produto</th></tr></thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={c.id} data-testid="today-campaign">
                      <td><span className={cx('today-st', c.status.key)} title={c.status.label} /><b>{c.name}</b>{data.accounts.length > 1 && <small className="faint"> · {c.accountName}</small>}</td>
                      <td>{money(c.spend)}</td>
                      <td>{fmtNum(c.sales)}{c.sales > 0 && <small className="faint"> · {money(c.revenue)}</small>}</td>
                      <td className={cx('profit', c.profit >= 0 ? 'pos' : 'neg')}>{money(c.profit)}</td>
                      <td>{c.spend ? `${fmtDec(c.roas)}x` : '—'}</td>
                      <td>
                        <select className="select sm" value={c.product?.source === 'manual' ? c.product.id : ''} disabled={!canEdit}
                          onChange={(e) => void setProduct(c, e.target.value)} data-testid="today-campaign-product"
                          title={c.product?.source === 'auto' ? 'Escolhido automaticamente: o produto que esta campanha mais vendeu nos últimos 30 dias' : undefined}>
                          <option value="">{c.product?.source === 'auto' ? `Automático: ${c.product.name}` : 'Automático (sem vendas ainda)'}</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="faint today-empty">Nenhuma campanha ativa ou com gasto hoje.</p>}
        </Panel>

        <Panel title="Últimas vendas" sub="Chegam aqui na hora" testId="today-recent">
          {data.recent.length ? (
            <ul className="today-feed">
              {data.recent.map((s) => (
                <li key={s.id}>
                  <span className="today-feed-ic"><Icon name={s.fromAd ? 'megaphone' : 'bag'} size={14} /></span>
                  <span className="today-feed-t"><b>{money(s.amount)}</b><small>{s.product}{s.customer ? ` · ${s.customer}` : ''}</small></span>
                  <span className="faint" title={new Date(s.at).toLocaleString('pt-BR')}>{hhmm(s.at)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="faint today-empty">Nenhuma venda hoje ainda.</p>}
        </Panel>
      </div>
    </div>
  );
}
