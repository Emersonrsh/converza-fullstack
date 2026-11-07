import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, cx } from '../components/ui';
import { TimeChart } from '../dashboard/charts';
import { money, num, pctTxt, type Level, type ManagerData, type ManagerRow, type Overview } from './types';

const PERIODS: [string, string][] = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'],
  ['month', 'Este mês'], ['last_month', 'Mês passado'], ['custom', 'Personalizado'],
];
const LEVELS: [Level, string][] = [['campaign', 'Campanhas'], ['adset', 'Conjuntos de anúncios'], ['ad', 'Anúncios']];
const STATUS_TONE: Record<string, string> = { active: 'green', paused: '', review: 'blue', issue: 'red', off: '' };

type SortKey = 'name' | 'spend' | 'impressions' | 'linkClicks' | 'ctr' | 'cpc' | 'conversations' | 'cpConv' | 'leads' | 'sales' | 'revenue' | 'roas';
const sortVal = (r: ManagerRow, k: SortKey): number | string => {
  switch (k) {
    case 'name': return r.name.toLowerCase();
    case 'ctr': return r.derived.ctr;
    case 'cpc': return r.derived.cpc;
    case 'cpConv': return r.derived.costPerConversation;
    case 'leads': return r.converza.leads;
    case 'sales': return r.converza.sales;
    case 'revenue': return r.converza.revenue;
    case 'roas': return r.converza.roas;
    default: return r.metrics[k];
  }
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function Manager({ overview }: { overview: Overview }) {
  const selected = overview.profiles.flatMap((p) => p.adAccounts.filter((a) => a.selected));
  if (!selected.length) {
    return (
      <div className="card fbm-intro" data-testid="fb-manager-empty">
        <p>{overview.profiles.length ? 'Escolha quais contas de anúncios entram no painel para ver os dados aqui.' : 'Faça login na Meta e autorize o acesso para ver os dados aqui.'}</p>
        <p>Depois do login, você escolhe em Facebook → Perfis e contas quais contas entram no painel. Nada é ativado automaticamente.</p>
        <Link className="fbm-link" to="/meta/perfis" data-testid="fb-go-profiles"><Icon name="gear" size={15} />Perfis e contas</Link>
      </div>
    );
  }
  return <ManagerView />;
}

function Stat({ label, value, sub, testId, tone }: { label: string; value: string; sub?: string; testId?: string; tone?: string }) {
  return (
    <div className={cx('fbm-stat', tone)} data-testid={testId}>
      <b>{value}</b>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function ManagerView() {
  const [level, setLevel] = useState<Level>('campaign');
  const [period, setPeriod] = useState('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [act, setAct] = useState('');
  const [camp, setCamp] = useState<{ id: string; name: string } | null>(null);
  const [adset, setAdset] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState('');
  const [st, setSt] = useState<'all' | 'active' | 'paused'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const [cur, setCur] = useState<string | null>(null);
  const [data, setData] = useState<ManagerData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  async function load(fresh = false) {
    if (period === 'custom' && (!from || !to)) return;
    const my = ++seq.current;
    setBusy(true);
    const qs = new URLSearchParams({ level, period });
    if (period === 'custom') { qs.set('from', from); qs.set('to', to); }
    if (act) qs.set('actId', act);
    if (camp) qs.set('campaignId', camp.id);
    if (adset) qs.set('adsetId', adset.id);
    if (fresh) qs.set('fresh', '1');
    try {
      const r = await api.get<ManagerData>(`/meta/manager?${qs}`);
      if (my !== seq.current) return;
      setData(r); setErr(null);
    } catch (e) {
      if (my === seq.current) setErr(e instanceof Error ? e.message : 'Erro ao ler os anúncios');
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }
  useEffect(() => { void load(); }, [level, period, from, to, act, camp?.id, adset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const currencies = useMemo(() => Object.entries(data?.totals ?? {}).sort((a, b) => b[1].metrics.spend - a[1].metrics.spend).map(([c]) => c), [data]);
  const c = cur && currencies.includes(cur) ? cur : currencies[0] ?? data?.accounts[0]?.currency ?? 'BRL';
  const t = data?.totals[c];
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (data?.rows ?? [])
      .filter((r) => !term || r.name.toLowerCase().includes(term) || r.id.includes(term))
      .filter((r) => st === 'all' || (st === 'active' ? r.status.key === 'active' : r.status.key !== 'active'));
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key); const y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [data, q, st, sort]);
  const oneCur = rows.length > 0 && rows.every((r) => r.currency === rows[0].currency);
  const foot = useMemo(() => {
    const m = { spend: 0, impressions: 0, linkClicks: 0, conversations: 0, leads: 0, sales: 0, revenue: 0 };
    for (const r of rows) {
      m.spend += r.metrics.spend; m.impressions += r.metrics.impressions; m.linkClicks += r.metrics.linkClicks; m.conversations += r.metrics.conversations;
      m.leads += r.converza.leads; m.sales += r.converza.sales; m.revenue += r.converza.revenue;
    }
    return m;
  }, [rows]);

  const chart = (data?.daily[c] ?? []).map((d) => ({ label: dm(d.date), spend: d.spend, conversations: d.conversations, linkClicks: d.linkClicks }));
  const head = (k: SortKey, label: string, title?: string) => (
    <th className={cx('fbm-th', sort.key === k && 'on')} title={title} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === 'name' ? 1 : -1 }))}>
      {label}{sort.key === k && <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevron'} size={12} />}
    </th>
  );
  const goLevel = (l: Level) => {
    if (l === 'campaign') { setCamp(null); setAdset(null); }
    if (l === 'adset') setAdset(null);
    setLevel(l);
  };
  const drill = (r: ManagerRow) => {
    if (r.level === 'campaign') { setCamp({ id: r.id, name: r.name }); setAdset(null); setLevel('adset'); }
    else if (r.level === 'adset') { setAdset({ id: r.id, name: r.name }); setLevel('ad'); }
  };
  const fm = (v: number, currency = c) => money(v, currency);

  return (
    <div className="fbm-manager" data-testid="fb-manager">
      <div className="card fbm-bar">
        <select className="select" value={act} onChange={(e) => { setAct(e.target.value); setCamp(null); setAdset(null); }} data-testid="fb-account">
          <option value="">Todas as contas no painel{data ? ` (${data.accounts.length})` : ''}</option>
          {(data?.accounts ?? []).map((a) => <option key={a.actId} value={a.actId}>{a.name} · {a.currency}</option>)}
        </select>
        <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)} data-testid="fb-period">
          {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {period === 'custom' && <>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="fb-from" />
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="fb-to" />
        </>}
        {currencies.length > 1 && (
          <select className="select" value={c} onChange={(e) => setCur(e.target.value)} title="As contas usam moedas diferentes: os números aparecem por moeda" data-testid="fb-currency">
            {currencies.map((x) => <option key={x} value={x}>Moeda: {x}</option>)}
          </select>
        )}
        <span className="spacer" />
        {data?.updatedAt && <small className="faint" data-testid="fb-updated">Dados da Meta de {hhmm(data.updatedAt)}</small>}
        <button type="button" className="btn sm" disabled={busy} onClick={() => void load(true)} data-testid="fb-refresh">
          <Icon name="refresh" size={14} />{busy ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {err && <div className="hint bad"><Icon name="alert" size={14} />{err}</div>}
      {(data?.errors ?? []).map((e) => (
        <div key={e.actId} className="hint warn" data-testid="fb-account-error">
          <Icon name="alert" size={14} /><span><b>{e.name}:</b> {e.message} {e.expired && <Link className="linkbtn" to="/meta/perfis">Reconectar</Link>}</span>
        </div>
      ))}

      {!data ? <Spinner /> : <>
        <div className="fbm-kpi-group">
          <div className="fbm-kpi-h"><Icon name="meta" size={15} />Meta Ads <small className="faint">{dm(data.from)} a {dm(data.to)}</small></div>
          <div className="fbm-kpis" data-testid="fb-kpis">
            <Stat label="Investimento" value={fm(t?.metrics.spend ?? 0)} sub={`CPM ${fm(t?.derived.cpm ?? 0)}`} testId="fb-kpi-spend" />
            <Stat label="Impressões" value={num(t?.metrics.impressions ?? 0)} testId="fb-kpi-impressions" />
            <Stat label="Cliques no link" value={num(t?.metrics.linkClicks ?? 0)} sub={`CTR ${pctTxt(t?.derived.ctr ?? 0)} · CPC ${fm(t?.derived.cpc ?? 0)}`} testId="fb-kpi-clicks" />
            <Stat label="Conversas iniciadas" value={num(t?.metrics.conversations ?? 0)} sub={t?.metrics.conversations ? `${fm(t.derived.costPerConversation)} por conversa` : 'Anúncios de mensagem'} testId="fb-kpi-conversations" />
            <Stat label="Leads (Meta)" value={num(t?.metrics.leads ?? 0)} sub={t?.metrics.leads ? `${fm(t.derived.costPerLead)} por lead` : 'Formulários e pixel'} testId="fb-kpi-leads" />
            <Stat label="Compras (Meta)" value={num(t?.metrics.purchases ?? 0)} sub={t?.metrics.purchaseValue ? fm(t.metrics.purchaseValue) : 'Pelo pixel'} testId="fb-kpi-purchases" />
          </div>
        </div>
        <div className="fbm-kpi-group cz">
          <div className="fbm-kpi-h"><Icon name="chats" size={15} />No Converza
            <small className="faint" title="Contatos que chegaram por um anúncio de clique para o WhatsApp (pelo ID do anúncio) e as vendas aprovadas deles no período">quem veio dos anúncios</small></div>
          <div className="fbm-kpis four" data-testid="fb-kpis-converza">
            <Stat label="Leads dos anúncios" value={num(t?.converza.leads ?? 0)} sub={t?.converza.leads ? `${fm((t.metrics.spend || 0) / t.converza.leads)} por lead` : undefined} testId="fb-kpi-cz-leads" />
            <Stat label="Vendas aprovadas" value={num(t?.converza.sales ?? 0)} sub={t?.converza.sales ? `ticket médio ${fm(t.converza.revenue / t.converza.sales)}` : undefined} testId="fb-kpi-cz-sales" />
            <Stat label="Faturamento" value={fm(t?.converza.revenue ?? 0)} testId="fb-kpi-cz-revenue" tone="good" />
            <Stat label="ROAS real" value={`${(t?.converza.roas ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x`} sub="faturamento ÷ investimento" testId="fb-kpi-cz-roas" tone={(t?.converza.roas ?? 0) >= 1 ? 'good' : undefined} />
          </div>
          {data.unmatched.leads + data.unmatched.sales > 0 && (
            <small className="faint fbm-unmatched" data-testid="fb-unmatched">
              + {num(data.unmatched.leads)} {data.unmatched.leads === 1 ? 'lead' : 'leads'} e {num(data.unmatched.sales)} {data.unmatched.sales === 1 ? 'venda' : 'vendas'} com outra origem de anúncio (contas fora do painel, publicações impulsionadas ou UTM) no período.
            </small>
          )}
        </div>

        <div className="fbm-charts">
          <div className="card fbm-chart" data-testid="fb-chart-spend">
            <b>Investimento por dia</b>
            {chart.length ? <TimeChart data={chart} height={190} series={[{ key: 'spend', name: 'Investimento', color: '#2f73e0', format: (v) => fm(v) }]} />
              : <div className="empty">Sem gasto no período.</div>}
          </div>
          <div className="card fbm-chart" data-testid="fb-chart-conv">
            <b>Conversas e cliques por dia</b>
            {chart.length ? <TimeChart data={chart} height={190} integer area={false} series={[
              { key: 'conversations', name: 'Conversas iniciadas', color: '#0e9488', format: (v) => num(v) },
              { key: 'linkClicks', name: 'Cliques no link', color: '#f59e0b', format: (v) => num(v) },
            ]} /> : <div className="empty">Sem dados no período.</div>}
          </div>
        </div>

        <div className="card fbm-table-card" data-testid="fb-table">
          <div className="fbm-table-top">
            <div className="seg" role="tablist">
              {LEVELS.map(([l, label]) => <button type="button" key={l} className={cx(level === l && 'active')} onClick={() => goLevel(l)} data-testid={`fb-level-${l}`}>{label}</button>)}
            </div>
            {(camp || adset) && (
              <div className="fbm-crumbs" data-testid="fb-crumbs">
                <button type="button" className="linkbtn" onClick={() => goLevel('campaign')}>Todas as campanhas</button>
                {camp && <><Icon name="chevronRight" size={13} /><button type="button" className="linkbtn" onClick={() => { setAdset(null); setLevel('adset'); }}>{camp.name}</button></>}
                {adset && <><Icon name="chevronRight" size={13} /><span>{adset.name}</span></>}
              </div>
            )}
            <span className="spacer" />
            <div className="fbm-search"><Icon name="search" size={14} /><input placeholder="Buscar por nome ou ID" value={q} onChange={(e) => setQ(e.target.value)} data-testid="fb-search" /></div>
            <select className="select sm" value={st} onChange={(e) => setSt(e.target.value as typeof st)} data-testid="fb-status-filter">
              <option value="all">Todas</option><option value="active">Ativas</option><option value="paused">Pausadas e outras</option>
            </select>
          </div>
          <div className="fbm-table-wrap">
            <table className="fbm-tbl">
              <thead>
                <tr>
                  {head('name', LEVELS.find(([l]) => l === level)![1].replace('Conjuntos de anúncios', 'Conjunto'))}
                  {head('spend', 'Investimento')}
                  {head('impressions', 'Impressões')}
                  {head('linkClicks', 'Cliques no link')}
                  {head('ctr', 'CTR')}
                  {head('cpc', 'CPC')}
                  {head('conversations', 'Conversas')}
                  {head('cpConv', 'Custo/conversa')}
                  {head('leads', 'Leads', 'Leads no Converza que vieram deste anúncio')}
                  {head('sales', 'Vendas', 'Vendas aprovadas no Converza desses leads')}
                  {head('revenue', 'Faturamento')}
                  {head('roas', 'ROAS')}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.actId}-${r.id}`} data-testid="fb-row">
                    <td className="fbm-name">
                      {r.thumbnail && <img src={r.thumbnail} alt="" />}
                      <div>
                        {r.level !== 'ad'
                          ? <button type="button" className="fbm-name-btn" onClick={() => drill(r)} title={r.level === 'campaign' ? 'Ver os conjuntos' : 'Ver os anúncios'} data-testid="fb-drill">{r.name}</button>
                          : <b>{r.name}</b>}
                        <small>
                          <span className={cx('pill mini', STATUS_TONE[r.status.key])} data-testid="fb-row-status">{r.status.label}</span>
                          {r.budget && <span>{fm(r.budget.amount, r.currency)}{r.budget.kind === 'daily' ? '/dia' : ' no total'}</span>}
                          <span className="faint">{r.accountName}</span>
                        </small>
                      </div>
                    </td>
                    <td><b>{fm(r.metrics.spend, r.currency)}</b></td>
                    <td>{num(r.metrics.impressions)}</td>
                    <td>{num(r.metrics.linkClicks)}</td>
                    <td>{pctTxt(r.derived.ctr)}</td>
                    <td>{r.metrics.linkClicks ? fm(r.derived.cpc, r.currency) : '—'}</td>
                    <td>{num(r.metrics.conversations)}</td>
                    <td>{r.metrics.conversations ? fm(r.derived.costPerConversation, r.currency) : '—'}</td>
                    <td className="cz">{num(r.converza.leads)}</td>
                    <td className="cz">{num(r.converza.sales)}</td>
                    <td className="cz">{fm(r.converza.revenue, r.currency)}</td>
                    <td className={cx('cz', r.converza.roas >= 1 && 'good')}>{r.metrics.spend ? `${r.converza.roas.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x` : '—'}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && oneCur && (
                <tfoot>
                  <tr data-testid="fb-foot">
                    <td>{rows.length} {level === 'campaign' ? 'campanhas' : level === 'adset' ? 'conjuntos' : 'anúncios'}</td>
                    <td><b>{fm(foot.spend, rows[0].currency)}</b></td>
                    <td>{num(foot.impressions)}</td>
                    <td>{num(foot.linkClicks)}</td>
                    <td>{pctTxt(foot.impressions ? Math.round((foot.linkClicks / foot.impressions) * 10000) / 100 : 0)}</td>
                    <td>{foot.linkClicks ? fm(foot.spend / foot.linkClicks, rows[0].currency) : '—'}</td>
                    <td>{num(foot.conversations)}</td>
                    <td>{foot.conversations ? fm(foot.spend / foot.conversations, rows[0].currency) : '—'}</td>
                    <td className="cz">{num(foot.leads)}</td>
                    <td className="cz">{num(foot.sales)}</td>
                    <td className="cz">{fm(foot.revenue, rows[0].currency)}</td>
                    <td className="cz">{foot.spend ? `${(Math.round((foot.revenue / foot.spend) * 100) / 100).toLocaleString('pt-BR')}x` : '—'}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            {!rows.length && <div className="empty" data-testid="fb-table-empty">{busy ? 'Carregando…' : q || st !== 'all' ? 'Nada com esse filtro.' : 'Nenhum item nesta conta.'}</div>}
          </div>
          {data.total > data.rows.length && <small className="faint fbm-more">Mostrando os {data.rows.length} com mais investimento de {num(data.total)}.</small>}
        </div>
      </>}
    </div>
  );
}
