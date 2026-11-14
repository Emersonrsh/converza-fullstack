import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { CreateDialog, Editor, type EditorStart } from './editor/Editor';
import { TimeChart } from '../dashboard/charts';
import { money, num, pctTxt, type BreakdownRow, type Level, type ManagerData, type ManagerRow, type Overview } from './types';
import { BREAKDOWN_OPTS, BreakdownMenu, ColumnsMenu, colById, deriveOf, exportCsv, loadColumns, saveColumns, sumMetrics, type TRow } from './columns';

const PERIODS: [string, string][] = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['7d', 'Últimos 7 dias'], ['14d', 'Últimos 14 dias'], ['30d', 'Últimos 30 dias'], ['90d', 'Últimos 90 dias'],
  ['month', 'Este mês'], ['last_month', 'Mês passado'], ['custom', 'Personalizado'],
];
const LEVELS: [Level, string][] = [['campaign', 'Campanhas'], ['adset', 'Conjuntos de anúncios'], ['ad', 'Anúncios']];
const STATUS_TONE: Record<string, string> = { active: 'green', paused: '', review: 'blue', issue: 'red', off: '' };

type SortKey = string;
const sortVal = (r: ManagerRow, k: SortKey): number | string => {
  if (k === 'name') return r.name.toLowerCase();
  const v = colById(k)?.v(r as TRow);
  return typeof v === 'number' ? v : typeof v === 'string' ? v : -Infinity;
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
  return <ManagerView canEdit={overview.canEdit} />;
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

/** Orçamento editável na linha (só onde a Meta guarda o orçamento: campanha com orçamento próprio ou conjunto). */
function BudgetCell({ row, editable, onSave }: { row: ManagerRow; editable: boolean; onSave: (amount: number) => Promise<boolean> }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  if (!row.budget) return null;
  const label = `${money(row.budget.amount, row.currency)}${row.budget.kind === 'daily' ? '/dia' : ' no total'}`;
  if (!edit) {
    return editable
      ? <button type="button" className="fbm-budget" onClick={() => { setV(String(row.budget!.amount).replace('.', ',')); setEdit(true); }} title="Mudar o orçamento" data-testid="fb-budget">{label}<Icon name="edit" size={11} /></button>
      : <span>{label}</span>;
  }
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  const save = async () => {
    if (!(n > 0)) return;
    setBusy(true);
    const ok = await onSave(n);
    setBusy(false);
    if (ok) setEdit(false);
  };
  return (
    <span className="fbm-budget-edit" data-testid="fb-budget-edit">
      <input autoFocus className="input" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEdit(false); }} data-testid="fb-budget-input" />
      <small>{row.budget.kind === 'daily' ? '/dia' : 'total'}</small>
      <button type="button" className="btn sm primary" disabled={busy || !(n > 0)} onClick={() => void save()} data-testid="fb-budget-save">{busy ? '…' : 'Salvar'}</button>
      <button type="button" className="btn sm ghost" onClick={() => setEdit(false)}>Cancelar</button>
    </span>
  );
}

/** Fluxo dos leads da campanha (quem chega pelos anúncios dela começa nesse fluxo). */
function FlowCell({ row, flows, editable, onSave }: { row: ManagerRow; flows: { id: string; name: string }[]; editable: boolean; onSave: (flowId: string | null) => void }) {
  if (!editable) return row.flow ? <span className="fbm-flow" title="Leads desta campanha começam neste fluxo"><Icon name="flow" size={11} />{row.flow.name}</span> : null;
  return (
    <label className={cx('fbm-flow', !row.flow && 'none')} title="Leads que chegarem pelos anúncios desta campanha começam direto neste fluxo">
      <Icon name="flow" size={11} />
      <select value={row.flow?.id ?? ''} onChange={(e) => onSave(e.target.value || null)} data-testid="fb-flow">
        <option value="">{row.flow ? 'Sem fluxo' : 'Ligar a um fluxo'}</option>
        {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        {row.flow && !flows.some((f) => f.id === row.flow!.id) && <option value={row.flow.id}>{row.flow.name}</option>}
      </select>
    </label>
  );
}

function HeadCell({ col, sort, onSort }: { col: { id: string; label: string; title?: string }; sort: { key: string; dir: 1 | -1 }; onSort: (k: string) => void }) {
  return (
    <th className={cx('fbm-th', sort.key === col.id && 'on')} title={col.title} onClick={() => onSort(col.id)} data-testid={`fb-th-${col.id}`}>
      {col.label}{sort.key === col.id && <Icon name={sort.dir === 1 ? 'chevronUp' : 'chevron'} size={12} />}
    </th>
  );
}

function ManagerView({ canEdit }: { canEdit: boolean }) {
  const [level, setLevel] = useState<Level>('campaign');
  const [period, setPeriod] = useState('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [act, setAct] = useState('');
  const [camp, setCamp] = useState<{ id: string; name: string } | null>(null);
  const [adset, setAdset] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState('');
  const [st, setSt] = useState<'all' | 'active' | 'paused' | 'delivered'>('all');
  const [cols, setCols] = useState(loadColumns);
  const [bd, setBd] = useState('');
  const [bdData, setBdData] = useState<{ key: string; rows: BreakdownRow[]; errors: string[] } | null>(null);
  const [bdBusy, setBdBusy] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const [cur, setCur] = useState<string | null>(null);
  const [data, setData] = useState<ManagerData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const [create, setCreate] = useState(false);
  const [editor, setEditor] = useState<EditorStart | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [acting, setActing] = useState(false);
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [pending, setPending] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!canEdit) return;
    api.get<{ flows: { id: string; name: string; status: string; archivedAt: string | null }[] }>('/flows')
      .then((r) => setFlows(r.flows.filter((f) => f.status === 'active' && !f.archivedAt).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
  }, [canEdit]);

  const manageable = (actId: string) => canEdit && !!data?.accounts.find((a) => a.actId === actId)?.canManage;
  const anyManage = canEdit && !!data?.accounts.some((a) => a.canManage);
  const what = (l: Level) => (l === 'campaign' ? 'Campanha' : l === 'adset' ? 'Conjunto' : 'Anúncio');

  async function toggle(r: ManagerRow) {
    const next = (pending[r.id] ?? r.configured) === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setPending((p) => ({ ...p, [r.id]: next }));
    try {
      await api.post(`/meta/objects/${r.id}/status`, { actId: r.actId, status: next });
      toast(next === 'ACTIVE' ? `${what(r.level)} ativada. A Meta pode levar alguns minutos para voltar a entregar.` : `${what(r.level)} pausada.`);
      await load(true);
    } catch (e) { toast(e instanceof Error ? e.message : 'A Meta não aceitou a mudança'); }
    setPending((p) => { const { [r.id]: _x, ...rest } = p; return rest; });
  }
  async function saveBudget(r: ManagerRow, amount: number) {
    try {
      await api.post(`/meta/objects/${r.id}/budget`, { actId: r.actId, kind: r.budget!.kind, amount });
      toast('Orçamento atualizado na Meta');
      await load(true);
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : 'A Meta não aceitou o orçamento'); return false; }
  }
  async function saveFlow(r: ManagerRow, flowId: string | null) {
    try {
      await api.put('/meta/campaign-flows', { actId: r.actId, campaignId: r.id, flowId });
      toast(flowId ? 'Os leads desta campanha agora começam nesse fluxo' : 'Campanha sem fluxo ligado');
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não deu para salvar'); }
  }

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
      .filter((r) => st === 'all' || (st === 'delivered' ? r.metrics.impressions > 0 : st === 'active' ? r.status.key === 'active' : r.status.key !== 'active'));
    return [...list].sort((a, b) => {
      const x = sortVal(a, sort.key); const y = sortVal(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [data, q, st, sort]);
  const oneCur = rows.length > 0 && rows.every((r) => r.currency === rows[0].currency);
  const foot = useMemo((): TRow | null => {
    if (!rows.length) return null;
    const metrics = sumMetrics(rows.map((r) => r.metrics));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const cz = { leads: 0, sales: 0, revenue: 0, roas: 0, cost: 0, fees: 0, profit: 0, margin: 0, cpa: 0 };
    for (const r of rows) { cz.leads += r.converza.leads; cz.sales += r.converza.sales; cz.revenue += r.converza.revenue; cz.cost += r.converza.cost; cz.fees += r.converza.fees; }
    cz.revenue = r2(cz.revenue); cz.cost = r2(cz.cost); cz.fees = r2(cz.fees);
    cz.roas = metrics.spend ? r2(cz.revenue / metrics.spend) : 0;
    cz.profit = r2(cz.revenue - cz.cost - cz.fees - metrics.spend);
    cz.margin = cz.revenue ? r2((cz.profit / cz.revenue) * 100) : 0;
    cz.cpa = cz.sales ? r2(metrics.spend / cz.sales) : 0;
    const k = rows[0].result?.key;
    const same = !!k && rows.every((r) => r.result?.key === k);
    const value = same ? rows.reduce((n, r) => n + (r.result?.value ?? 0), 0) : 0;
    return { metrics, derived: deriveOf(metrics), currency: rows[0].currency, converza: cz,
      result: same ? { key: k!, label: rows[0].result!.label, value, cost: value ? Math.round((metrics.spend / value) * 100) / 100 : 0 } : null };
  }, [rows]);
  const columns = cols.cols.map((id) => colById(id)!).filter(Boolean);
  // detalhamento: pede à Meta quando muda o nível, o período ou o filtro
  const bdKey = `${bd}|${level}|${period}|${from}|${to}|${act}|${camp?.id ?? ''}|${adset?.id ?? ''}`;
  useEffect(() => {
    if (!bd) { setBdData(null); return; }
    if (period === 'custom' && (!from || !to)) return;
    let alive = true;
    setBdBusy(true);
    const qs = new URLSearchParams({ level, period, by: bd });
    if (period === 'custom') { qs.set('from', from); qs.set('to', to); }
    if (act) qs.set('actId', act);
    if (camp) qs.set('campaignId', camp.id);
    if (adset) qs.set('adsetId', adset.id);
    api.get<{ rows: BreakdownRow[]; errors: string[] }>(`/meta/manager/breakdown?${qs}`)
      .then((r) => { if (alive) setBdData({ key: bdKey, rows: r.rows, errors: r.errors }); })
      .catch((e) => { if (alive) { setBdData({ key: bdKey, rows: [], errors: [e instanceof Error ? e.message : 'Erro'] }); } })
      .finally(() => { if (alive) setBdBusy(false); });
    return () => { alive = false; };
  }, [bdKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // linhas do detalhamento herdam o tipo de resultado da linha de cima (conversas, compras…)
  const subRows = (id: string) => {
    if (!bdData || bdData.key !== bdKey) return [];
    const parent = data?.rows.find((r) => r.id === id);
    return bdData.rows.filter((x) => x.id === id).map((x) => {
      const k = parent?.result?.key;
      const value = k ? Number(x.metrics[k]) || 0 : 0;
      return { ...x, result: k ? { key: k, label: parent!.result!.label, value, cost: value ? Math.round((x.metrics.spend / value) * 100) / 100 : 0 } : null };
    });
  };
  const doExport = () => {
    const list: { name: string; sub?: string; row: TRow }[] = [];
    for (const r of rows) {
      list.push({ name: r.name, row: r as TRow });
      for (const x of subRows(r.id)) list.push({ name: r.name, sub: x.label, row: x as TRow });
    }
    const lv = LEVELS.find(([l]) => l === level)![1].toLowerCase().replace(/ /g, '-');
    exportCsv(`gerenciador-${lv}-${data?.from ?? ''}-a-${data?.to ?? ''}`, columns, list);
  };

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
  const picked = rows.filter((r) => checked.includes(r.id));
  const canAct = picked.length > 0 && picked.every((r) => manageable(r.actId) && r.configured);
  const editRow = (r: ManagerRow) => {
    const campaignId = r.level === 'campaign' ? r.id : r.campaignId;
    if (campaignId) setEditor({ mode: 'edit', actId: r.actId, campaignId, focus: r.level === 'campaign' ? null : r.id });
  };
  async function duplicate() {
    setActing(true);
    try {
      for (const r of picked) await api.post(`/meta/objects/${r.id}/copy`, { actId: r.actId, level: r.level, deep: true });
      toast(picked.length === 1 ? 'Cópia criada (pausada).' : `${picked.length} cópias criadas (pausadas).`);
      setChecked([]); await load(true);
    } catch (e) { toast(e instanceof Error ? e.message : 'A Meta não duplicou'); } finally { setActing(false); }
  }
  async function removeRows() {
    if (!window.confirm(`Excluir ${picked.length === 1 ? `“${picked[0].name}”` : `${picked.length} itens`} na Meta? Isso não pode ser desfeito.`)) return;
    setActing(true);
    try {
      for (const r of picked) await api.del(`/meta/objects/${r.id}?actId=${r.actId}`);
      toast('Excluído na Meta.'); setChecked([]); await load(true);
    } catch (e) { toast(e instanceof Error ? e.message : 'A Meta não excluiu'); } finally { setActing(false); }
  }
  async function setStatusRows(status: 'ACTIVE' | 'PAUSED') {
    setActing(true);
    try {
      for (const r of picked) await api.post(`/meta/objects/${r.id}/status`, { actId: r.actId, status });
      toast(status === 'ACTIVE' ? 'Ativado na Meta.' : 'Pausado na Meta.'); await load(true);
    } catch (e) { toast(e instanceof Error ? e.message : 'A Meta não aceitou'); } finally { setActing(false); }
  }

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
        {canEdit && (
          <button type="button" className="btn sm primary" disabled={!anyManage} onClick={() => setCreate(true)} data-testid="fb-create"
            title={anyManage ? 'Criar campanha, conjunto ou anúncio' : 'Reconecte o perfil em Perfis e contas e aceite a permissão de gerenciar anúncios'}>
            <Icon name="plus" size={14} />Criar campanha
          </button>
        )}
      </div>
      {canEdit && data && !anyManage && data.accounts.length > 0 && (
        <div className="hint" data-testid="fb-no-manage"><Icon name="info" size={14} /><span>Para criar campanhas e pausar ou mudar orçamentos por aqui, reconecte o perfil em <Link className="linkbtn" to="/meta/perfis">Perfis e contas</Link> e aceite a permissão de <b>gerenciar anúncios</b>.</span></div>
      )}
      {create && data && (
        <CreateDialog accounts={data.accounts.filter((a) => a.canManage && (!act || a.actId === act)).map((a) => ({ actId: a.actId, name: a.name, currency: a.currency, canManage: !!a.canManage }))}
          onClose={() => setCreate(false)} onStart={(st0) => { setCreate(false); setEditor(st0); }} />
      )}
      {editor && data && (
        <Editor accounts={data.accounts.map((a) => ({ actId: a.actId, name: a.name, currency: a.currency, canManage: !!a.canManage }))} start={editor} flows={flows}
          onClose={() => { setEditor(null); void load(true); }} onPublished={() => { setChecked([]); }} />
      )}

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
          <div className="fbm-kpis five" data-testid="fb-kpis-converza">
            <Stat label="Leads dos anúncios" value={num(t?.converza.leads ?? 0)} sub={t?.converza.leads ? `${fm((t.metrics.spend || 0) / t.converza.leads)} por lead` : undefined} testId="fb-kpi-cz-leads" />
            <Stat label="Vendas aprovadas" value={num(t?.converza.sales ?? 0)} sub={t?.converza.sales ? `ticket médio ${fm(t.converza.revenue / t.converza.sales)}` : undefined} testId="fb-kpi-cz-sales" />
            <Stat label="Faturamento" value={fm(t?.converza.revenue ?? 0)} testId="fb-kpi-cz-revenue" tone="good" />
            <Stat label="ROAS real" value={`${(t?.converza.roas ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x`} sub="faturamento ÷ investimento" testId="fb-kpi-cz-roas" tone={(t?.converza.roas ?? 0) >= 1 ? 'good' : undefined} />
            <Stat label="Lucro líquido" value={fm(t?.converza.profit ?? 0)} testId="fb-kpi-cz-profit"
              sub={t?.converza.revenue ? `margem ${(t.converza.margin).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% · custos e taxas ${fm(t.converza.cost + t.converza.fees)}` : 'faturamento − custos − taxas − gasto'}
              tone={t && (t.converza.revenue || t.metrics.spend) ? (t.converza.profit >= 0 ? 'good' : 'bad') : undefined} />
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
              <option value="all">Todos</option><option value="delivered">Tiveram veiculação</option><option value="active">Ativos</option><option value="paused">Pausados e outros</option>
            </select>
            <ColumnsMenu value={cols} onChange={(v) => { setCols(v); saveColumns(v); }} />
            <BreakdownMenu value={bd} onChange={setBd} />
            <button type="button" className="btn sm" onClick={doExport} disabled={!rows.length} title="Exportar a tabela (CSV para Excel ou Planilhas)" data-testid="fb-export"><Icon name="download" size={14} />Exportar</button>
          </div>
          {canEdit && (
            <div className="fbm-actions" data-testid="fb-actions">
              <button type="button" className="btn sm primary" disabled={!anyManage} onClick={() => setCreate(true)} data-testid="fb-act-create"><Icon name="plus" size={14} />Criar</button>
              <button type="button" className="btn sm" disabled={!canAct || acting} onClick={() => void duplicate()} data-testid="fb-act-dup"><Icon name="copy" size={14} />Duplicar</button>
              <button type="button" className="btn sm" disabled={picked.length !== 1 || !canAct} onClick={() => editRow(picked[0])} data-testid="fb-act-edit"><Icon name="edit" size={14} />Editar</button>
              <button type="button" className="btn sm" disabled={!canAct || acting} onClick={() => void setStatusRows('ACTIVE')} data-testid="fb-act-on"><Icon name="play" size={14} />Ativar</button>
              <button type="button" className="btn sm" disabled={!canAct || acting} onClick={() => void setStatusRows('PAUSED')} data-testid="fb-act-off"><Icon name="pause" size={14} />Pausar</button>
              <button type="button" className="btn sm" disabled={!canAct || acting} onClick={() => void removeRows()} data-testid="fb-act-del"><Icon name="trash" size={14} />Excluir</button>
              {picked.length > 0 && <small className="faint">{picked.length} selecionado(s) <button type="button" className="linkbtn" onClick={() => setChecked([])}>limpar</button></small>}
            </div>
          )}
          <div className="fbm-table-wrap">
            <table className="fbm-tbl">
              <thead>
                <tr>
                  <th className="fbm-th-sw" title="Ligada / pausada na Meta">
                    {canEdit && <input type="checkbox" className="fbm-check" checked={rows.length > 0 && rows.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? rows.map((r) => r.id) : [])} aria-label="Marcar todos" data-testid="fb-check-all" />}
                    Ligada
                  </th>
                  {head('name', LEVELS.find(([l]) => l === level)![1].replace('Conjuntos de anúncios', 'Conjunto'))}
                  {columns.map((c) => <HeadCell key={c.id} col={c} sort={sort} onSort={(k) => setSort((x) => ({ key: k, dir: x.key === k ? (x.dir === 1 ? -1 : 1) : -1 }))} />)}
                </tr>
              </thead>
              <tbody>
                {rows.flatMap((r) => [
                  <tr key={`${r.actId}-${r.id}`} data-testid="fb-row">
                    <td className="fbm-sw">
                      {canEdit && <input type="checkbox" className="fbm-check" checked={checked.includes(r.id)} onChange={(e) => setChecked((x) => (e.target.checked ? [...x, r.id] : x.filter((y) => y !== r.id)))} aria-label="Marcar" data-testid="fb-check" />}
                      {r.configured && (() => {
                        const on = (pending[r.id] ?? r.configured) === 'ACTIVE';
                        const can = manageable(r.actId) && (r.configured === 'ACTIVE' || r.configured === 'PAUSED');
                        return (
                          <button type="button" className={cx('switch', on && 'on')} aria-pressed={on} disabled={!can || r.id in pending}
                            onClick={() => void toggle(r)} title={can ? (on ? `Pausar ${what(r.level).toLowerCase()}` : `Ativar ${what(r.level).toLowerCase()}`) : 'Sem permissão para mudar'}
                            data-testid="fb-toggle"><i /></button>
                        );
                      })()}
                    </td>
                    <td className="fbm-name-td">
                      <div className="fbm-name">
                      {r.thumbnail && <img src={r.thumbnail} alt="" />}
                      <div>
                        {r.level !== 'ad'
                          ? <button type="button" className="fbm-name-btn" onClick={() => drill(r)} title={r.level === 'campaign' ? 'Ver os conjuntos' : 'Ver os anúncios'} data-testid="fb-drill">{r.name}</button>
                          : <b>{r.name}</b>}
                        {manageable(r.actId) && r.configured && <button type="button" className="fbm-edit" onClick={() => editRow(r)} title="Editar" data-testid="fb-edit"><Icon name="edit" size={12} />Editar</button>}
                        <small>
                          <span className={cx('pill mini', STATUS_TONE[r.status.key])} data-testid="fb-row-status">{r.status.label}</span>
                          <BudgetCell row={r} editable={manageable(r.actId)} onSave={(n) => saveBudget(r, n)} />
                          {r.level === 'campaign' && <FlowCell row={r} flows={flows} editable={canEdit} onSave={(id) => void saveFlow(r, id)} />}
                          <span className="faint">{r.accountName}</span>
                        </small>
                      </div>
                      </div>
                    </td>
                    {columns.map((c) => <td key={c.id} className={cx(c.cz && 'cz', c.id === 'czRoas' && r.converza.roas >= 1 && 'good', (c.id === 'czProfit' || c.id === 'czMargin') && r.converza.revenue + r.metrics.spend > 0 && (r.converza.profit >= 0 ? 'good' : 'bad'))} data-col={c.id}>{c.id === 'spend' ? <b>{c.f(r as TRow)}</b> : c.id === 'results' && r.result ? <span className="fbm-result">{c.f(r as TRow)}<small>{r.result.label}</small></span> : c.f(r as TRow)}</td>)}
                  </tr>,
                  ...subRows(r.id).map((x) => (
                    <tr key={`${r.actId}-${r.id}-${x.key}`} className="fbm-bdrow" data-testid="fb-sub-row">
                      <td />
                      <td className="fbm-name-td"><span className="fbm-sub-l">{x.label}</span></td>
                      {columns.map((c) => <td key={c.id} className={cx(c.cz && 'cz')}>{c.f(x as TRow)}</td>)}
                    </tr>
                  )),
                ])}
              </tbody>
              {rows.length > 1 && oneCur && foot && (
                <tfoot>
                  <tr data-testid="fb-foot">
                    <td />
                    <td>{rows.length} {level === 'campaign' ? 'campanhas' : level === 'adset' ? 'conjuntos' : 'anúncios'}</td>
                    {columns.map((c) => <td key={c.id} className={cx(c.cz && 'cz')}>{['budget', 'bidStrategy', 'endTime', 'quality', 'engagementRank', 'conversionRank'].includes(c.id) ? '' : c.id === 'spend' ? <b>{c.f(foot)}</b> : c.f(foot)}</td>)}
                  </tr>
                </tfoot>
              )}
            </table>
            {!rows.length && <div className="empty" data-testid="fb-table-empty">{busy ? 'Carregando…' : q || st !== 'all' ? 'Nada com esse filtro.' : 'Nenhum item nesta conta.'}</div>}
          </div>
          {bd && (bdBusy ? <small className="faint fbm-more">Buscando o detalhamento na Meta…</small> : bdData?.errors.length ? <small className="err fbm-more">{bdData.errors.join(' · ')}</small>
            : <small className="faint fbm-more" data-testid="fb-bd-note">Detalhamento por {BREAKDOWN_OPTS.find((b) => b.id === bd)?.label.toLowerCase()}: cada linha mostra a divisão logo abaixo. Leads e vendas do Converza não têm detalhamento.</small>)}
          {data.total > data.rows.length && <small className="faint fbm-more">Mostrando os {data.rows.length} com mais investimento de {num(data.total)}.</small>}
        </div>
      </>}
    </div>
  );
}
