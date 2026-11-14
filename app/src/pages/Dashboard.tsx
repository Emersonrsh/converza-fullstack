import { Logo } from '../components/Logo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SubscriptionAlert } from '../components/SubscriptionAlert';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, toast, cx } from '../components/ui';
import { SalesView } from '../dashboard/SalesView';
import { AttendanceView } from '../dashboard/AttendanceView';
import { AdSpendModal, PartnerModal, SettingsModal, TrailModal, type ConnOpt } from '../dashboard/modals';
import { CurrencyPicker, IconBtn } from '../dashboard/widgets';
import { fmtNum, todayLocal } from '../dashboard/format';
import type { AttendanceDash, DashFilters, PartnerInfo, Period, SalesDash } from '../dashboard/types';
import type { Product, Subscription } from '../types';
import { TodayView } from '../dashboard/TodayView';
import { AdAccountFilter } from '../dashboard/AdAccountFilter';

const DEFAULTS: DashFilters = { period: 'today', from: '', to: '', connectionId: '', productId: '', currency: 'BRL', adAccounts: [] };
const PERIOD_OPTS: [Period, string][] = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'],
  ['month', 'Este mês'], ['last_month', 'Mês passado'], ['custom', 'Personalizado'],
];
const filtersKey = (acc: string | null) => `converza:dash:filters:${acc}`;
const bannerKey = (acc: string | null) => `converza:dash:partnerBanner:${acc}`;

function loadSaved(acc: string | null): DashFilters | null {
  try { const v = localStorage.getItem(filtersKey(acc)); return v ? { ...DEFAULTS, ...JSON.parse(v) } : null; } catch { return null; }
}
const toQuery = (f: DashFilters) => {
  const q = new URLSearchParams({ period: f.period, currency: f.currency });
  if (f.period === 'custom') { q.set('from', f.from); q.set('to', f.to); }
  if (f.connectionId) q.set('connectionId', f.connectionId);
  if (f.productId) q.set('productId', f.productId);
  if (f.adAccounts?.length) q.set('adAccounts', f.adAccounts.join(','));
  return q.toString();
};
function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return ['Bom dia', '☀️'];
  if (h >= 12 && h < 18) return ['Boa tarde', '🌤️'];
  return ['Boa noite', '🌙'];
}

export function Dashboard() {
  const nav = useNavigate();
  const { user, accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [tab, setTab] = useState<'hoje' | 'vendas' | 'atendimento'>(() => {
    try { const v = localStorage.getItem('cw.dash.tab'); return v === 'hoje' || v === 'atendimento' ? v : 'vendas'; } catch { return 'vendas'; }
  });
  useEffect(() => { try { localStorage.setItem('cw.dash.tab', tab); } catch { /* sem storage */ } }, [tab]);
  const [filters, setFilters] = useState<DashFilters>(() => loadSaved(accountId) ?? DEFAULTS);
  const [saved, setSaved] = useState<DashFilters | null>(() => loadSaved(accountId));
  const [sales, setSales] = useState<SalesDash | null>(null);
  const [att, setAtt] = useState<AttendanceDash | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [connections, setConnections] = useState<ConnOpt[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sub, setSub] = useState<Subscription | null | undefined>(undefined);
  const [partner, setPartner] = useState<PartnerInfo | null>(null);
  const [bannerOff, setBannerOff] = useState(() => localStorage.getItem(bannerKey(accountId)) === '1');
  const [modal, setModal] = useState<null | 'trail' | 'partner' | 'settings' | 'adspend'>(null);

  const customOk = filters.period !== 'custom' || (!!filters.from && !!filters.to);
  const query = useMemo(() => toQuery(filters), [filters]);
  const set = (patch: Partial<DashFilters>) => setFilters((f) => ({ ...f, ...patch }));

  // listas dos filtros, assinatura e programa de parceiros
  const loadLists = useCallback(() => {
    api.get<{ connections: (ConnOpt & { status: string })[] }>('/connections').then((r) => setConnections(r.connections)).catch(() => {});
    api.get<{ products: Product[] }>('/settings/products').then((r) => setProducts(r.products)).catch(() => {});
  }, []);
  useEffect(() => {
    loadLists();
    api.get<{ subscription: Subscription | null }>('/billing/subscription').then((r) => setSub(r.subscription)).catch(() => setSub(null));
    api.get<PartnerInfo>('/partners/me').then(setPartner).catch(() => setPartner(null));
  }, [accountId, loadLists]);

  const reqId = useRef(0);
  const load = useCallback(async (quiet = false) => {
    if (!customOk || tab === 'hoje') return;
    const id = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      if (tab === 'vendas') {
        const r = await api.get<SalesDash>(`/dashboard/sales?${query}`);
        if (id === reqId.current) { setSales(r); setErr(null); }
      } else {
        const r = await api.get<AttendanceDash>(`/dashboard/attendance?${query}`);
        if (id === reqId.current) { setAtt(r); setErr(null); }
      }
    } catch (e) {
      if (id === reqId.current) setErr((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [tab, query, customOk]);

  useEffect(() => { void load(); }, [load]);

  // atualização ao vivo: novas vendas/mensagens + a cada minuto
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const kick = () => {
      clearTimeout(debounce.current);
      debounce.current = setTimeout(() => { void load(true); setRefreshKey((x) => x + 1); }, 1500);
    };
    const sock = getSocket();
    sock?.on('sale:changed', kick);
    const onMsg = () => { if (tab === 'atendimento') kick(); };
    sock?.on('message:new', onMsg);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, 60000);
    return () => { sock?.off('sale:changed', kick); sock?.off('message:new', onMsg); clearInterval(t); clearTimeout(debounce.current); };
  }, [load, tab]);

  const refresh = () => { void load(); setRefreshKey((x) => x + 1); };
  const changed = () => { void load(true); setRefreshKey((x) => x + 1); };
  const isSaved = saved !== null && JSON.stringify(saved) === JSON.stringify(filters);
  function saveFilters() {
    localStorage.setItem(filtersKey(accountId), JSON.stringify(filters));
    setSaved(filters);
    toast('Filtros salvos — o dashboard vai abrir sempre assim');
  }
  function resetFilters() {
    setFilters(DEFAULTS);
    toast('Filtros restaurados');
  }
  function closeBanner() {
    localStorage.setItem(bannerKey(accountId), '1');
    setBannerOff(true);
  }

  const [profitFallback, setProfitFallback] = useState({ gatewayFeePercent: 0, taxPercent: 0 });
  useEffect(() => { if (modal === 'settings' && !sales) api.get<{ settings: { gatewayFeePercent: number; taxPercent: number } }>('/dashboard/settings').then((r) => setProfitFallback(r.settings)).catch(() => {}); }, [modal, sales]);
  const [hello, emoji] = greeting();
  const firstName = (user?.name ?? '').trim();
  const header = sales?.header;
  const currencies = sales?.currencies ?? ['BRL'];
  const range = (tab === 'vendas' ? sales?.range : att?.range) ?? null;

  return (
    <div className="fade dash" data-testid="dashboard">
      <section className="card dhead">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{hello}, {firstName}! <span aria-hidden="true">{emoji}</span></h2>
          <p>Operação <b className="op">{header?.accountName ?? accounts.find((x) => x.id === accountId)?.name ?? '…'}</b>{header && <> • <b>{fmtNum(header.totalLeads)}</b> leads acumulados</>}</p>
        </div>
        <button type="button" className="btn sm" onClick={() => setModal('trail')} data-testid="trail-btn"><Icon name="trophy" size={15} /><span className="trail-txt">Trilha de conquistas</span></button>
      </section>

      {partner?.enabled && !bannerOff && (
        <section className="pbanner" data-testid="partner-banner">
          <button type="button" className="pb-x" onClick={closeBanner} aria-label="Fechar"><Icon name="close" size={14} /></button>
          <div className="pb-brand">
            <Logo size={50} className="pb-logo" />
            <div><b>CONVERZA</b><small>vendas no automático</small></div>
          </div>
          <div className="pb-sep" />
          <div className="pb-main">
            <small>Torne-se nosso</small>
            <b>PARCEIRO</b>
            <span className="pb-chip"><Icon name="bot" size={14} />Plataforma de vendas com IA no WhatsApp</span>
          </div>
          <div className="pb-sep hide-sm" />
          <div className="pb-pct hide-sm"><small>até</small><b>{partner.commissionPercent}%</b><small>de comissão</small></div>
          <button type="button" className="pb-cta" onClick={() => setModal('partner')}>Quero ser parceiro<Icon name="arrowRight" size={16} /></button>
          <svg className="pb-art" viewBox="0 0 220 160" aria-hidden="true">
            <circle cx="150" cy="80" r="70" fill="#fff" fillOpacity=".06" />
            <circle cx="150" cy="80" r="44" fill="#fff" fillOpacity=".07" />
            <rect x="96" y="38" width="86" height="44" rx="14" fill="#fff" fillOpacity=".9" />
            <path d="M112 82l-6 14 18-14Z" fill="#fff" fillOpacity=".9" />
            <circle cx="122" cy="60" r="5" fill="#0b8278" /><circle cx="139" cy="60" r="5" fill="#0b8278" /><circle cx="156" cy="60" r="5" fill="#0b8278" />
            <rect x="140" y="92" width="62" height="34" rx="12" fill="#f6ad3c" />
            <text x="171" y="114" textAnchor="middle" fontSize="15" fontWeight="800" fill="#2a1a00">%</text>
          </svg>
        </section>
      )}

      {sub !== undefined && <SubscriptionAlert status={sub?.status ?? 'inactive'} />}

      <section className="card dfil" data-testid="filters">
        <div className="seg dtabs">
          <button type="button" className={cx(tab === 'hoje' && 'active')} onClick={() => setTab('hoje')} data-testid="tab-hoje"><span className="live-dot sm" />Hoje</button>
          <button type="button" className={cx(tab === 'vendas' && 'active')} onClick={() => setTab('vendas')} data-testid="tab-vendas">Vendas</button>
          <button type="button" className={cx(tab === 'atendimento' && 'active')} onClick={() => setTab('atendimento')} data-testid="tab-atendimento">Atendimento</button>
        </div>
        {tab !== 'hoje' && <select className="select dsel" value={filters.period} data-testid="period"
          onChange={(e) => {
            const period = e.target.value as Period;
            set(period === 'custom' && !filters.from ? { period, from: range?.from ?? todayLocal(), to: range?.to ?? todayLocal() } : { period });
          }}>
          {PERIOD_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>}
        {tab !== 'hoje' && filters.period === 'custom' && (
          <span className="row" style={{ gap: 6 }}>
            <input className="input dsel" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="De" data-testid="from" />
            <span className="faint">até</span>
            <input className="input dsel" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="Até" data-testid="to" />
          </span>
        )}
        {tab !== 'hoje' && <select className="select dsel" value={filters.connectionId} onChange={(e) => set({ connectionId: e.target.value })} data-testid="conn-filter">
          <option value="">Todas as conexões</option>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` · ${c.displayPhone}` : ''}</option>)}
        </select>}
        {tab === 'vendas' && (
          <select className="select dsel" value={filters.productId} onChange={(e) => set({ productId: e.target.value })} data-testid="product-filter">
            <option value="">Todos os produtos</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="spacer" />
        {tab !== 'atendimento' && <AdAccountFilter value={filters.adAccounts ?? []} onChange={(adAccounts) => set({ adAccounts })} />}
        {tab !== 'atendimento' && <CurrencyPicker value={filters.currency} options={[...new Set([...currencies, filters.currency])]} onChange={(currency) => set({ currency })} />}
        <div className="dicons">
          <IconBtn icon="rotateCcw" title="Restaurar filtros padrão" onClick={resetFilters} testId="reset-filters" />
          <IconBtn icon={isSaved ? 'bookmarkCheck' : 'bookmark'} title={isSaved ? 'Estes filtros são o seu padrão' : 'Salvar filtros como padrão'} active={isSaved} onClick={saveFilters} testId="save-filters" />
          <IconBtn icon="refreshCw" title="Atualizar agora" onClick={refresh} spinning={loading} testId="refresh" />
          <IconBtn icon="gear" title="Ajustes do lucro (taxas e impostos)" onClick={() => setModal('settings')} testId="dash-settings" />
        </div>
      </section>

      {err && <div className="note err"><Icon name="alert" size={15} /><span>Não foi possível carregar: {err}</span></div>}
      {!customOk && <div className="note warn"><Icon name="calendar" size={15} /><span>Escolha as duas datas do período personalizado.</span></div>}

      {tab === 'hoje'
        ? <TodayView currency={filters.currency} adAccounts={filters.adAccounts ?? []} products={products} canEdit={canEdit} refreshKey={refreshKey} />
        : tab === 'vendas'
        ? (sales ? <div className={cx('dbody', loading && 'busy')}><SalesView data={sales} query={query} currency={filters.currency} refreshKey={refreshKey}
            products={products} connections={connections} onChanged={changed} onAdSpend={() => setModal('adspend')} /></div> : <div style={{ height: 300 }}><Spinner /></div>)
        : (att ? <div className={cx('dbody', loading && 'busy')}><AttendanceView data={att} /></div> : <div style={{ height: 300 }}><Spinner /></div>)}

      {modal === 'trail' && <TrailModal onClose={() => setModal(null)} />}
      {modal === 'partner' && partner && <PartnerModal info={partner} onClose={() => setModal(null)} />}
      {modal === 'settings' && (
        <SettingsModal initial={sales?.profitSettings ?? profitFallback} onClose={() => setModal(null)}
          onSaved={() => { setModal(null); changed(); }} />
      )}
      {modal === 'adspend' && range && (
        <AdSpendModal from={range.from} to={range.to} currency={filters.currency} onClose={() => setModal(null)} onChanged={changed} />
      )}
    </div>
  );
}
