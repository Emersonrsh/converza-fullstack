import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Modal, Spinner, Switch, cx, toast } from '../components/ui';
import { money } from './types';
import type { Overview } from './types';

type Level = 'campaign' | 'adset' | 'ad';
type ActionType = 'pause' | 'activate' | 'budget_up' | 'budget_down' | 'notify';
interface Cond { metric: string; op: 'gt' | 'lt'; value: number }
interface Action { type: ActionType; pct?: number; limit?: number | null }
interface Rule {
  id: string; name: string; enabled: boolean; actId: string; level: Level; campaignIds: string[]; conditions: Cond[]; window: string;
  action: Action; cooldownHours: number; lastRunAt: string | null; lastError: string | null; applied24h: number;
}
interface Log { id: string; ruleName: string; objectName: string; level: string; action: string; status: 'applied' | 'error' | 'skipped'; detail: string; values: Record<string, number>; createdAt: string }
interface MetricDef { id: string; label: string; money: boolean; pct: boolean; x: boolean }
interface RulesData { rules: Rule[]; logs: Log[]; metrics: MetricDef[]; windows: { id: string; label: string }[]; everyMinutes: number }
interface SimMatch { id: string; name: string; level: string; values: Record<string, number>; status: string; cooling: boolean; preview: string; currency: string }

const LEVELS: [Level, string, string][] = [['campaign', 'Campanhas', 'campanha'], ['adset', 'Conjuntos de anúncios', 'conjunto'], ['ad', 'Anúncios', 'anúncio']];
const ACTIONS: [ActionType, string][] = [['pause', 'Pausar'], ['budget_up', 'Aumentar orçamento'], ['budget_down', 'Diminuir orçamento'], ['activate', 'Ativar (se estiver pausado)'], ['notify', 'Só registrar (sem mexer)']];
type Draft = Omit<Rule, 'id' | 'lastRunAt' | 'lastError' | 'applied24h'> & { id?: string };

/** Modelos prontos: o que o gestor faria olhando o painel de madrugada. */
const TEMPLATES: { id: string; label: string; desc: string; d: (act: string) => Draft }[] = [
  { id: 'no-sale', label: 'Pausar anúncio que gastou e não vendeu', desc: 'Gasto hoje acima de R$ 30 e nenhuma venda', d: (act) => ({
    name: 'Pausar anúncio sem venda (R$ 30)', enabled: true, actId: act, level: 'ad', campaignIds: [], window: 'today', cooldownHours: 24,
    conditions: [{ metric: 'spend', op: 'gt', value: 30 }, { metric: 'sales', op: 'lt', value: 1 }], action: { type: 'pause' } }) },
  { id: 'cpa', label: 'Pausar anúncio com CPA alto', desc: 'CPA acima de R$ 25 depois de R$ 50 gastos hoje', d: (act) => ({
    name: 'Pausar CPA acima de R$ 25', enabled: true, actId: act, level: 'ad', campaignIds: [], window: 'today', cooldownHours: 24,
    conditions: [{ metric: 'spend', op: 'gt', value: 50 }, { metric: 'cpa', op: 'gt', value: 25 }], action: { type: 'pause' } }) },
  { id: 'scale', label: 'Escalar quem dá lucro', desc: '+20% de orçamento se o ROAS passar de 2 nos últimos 3 dias (1x por dia)', d: (act) => ({
    name: 'Escalar ROAS acima de 2', enabled: true, actId: act, level: 'adset', campaignIds: [], window: '3d', cooldownHours: 24,
    conditions: [{ metric: 'roas', op: 'gt', value: 2 }, { metric: 'spend', op: 'gt', value: 50 }], action: { type: 'budget_up', pct: 20, limit: 500 } }) },
  { id: 'loss', label: 'Cortar orçamento de quem dá prejuízo', desc: '−30% se o lucro dos últimos 3 dias estiver negativo', d: (act) => ({
    name: 'Cortar prejuízo em 3 dias', enabled: true, actId: act, level: 'adset', campaignIds: [], window: '3d', cooldownHours: 24,
    conditions: [{ metric: 'profit', op: 'lt', value: 0 }, { metric: 'spend', op: 'gt', value: 60 }], action: { type: 'budget_down', pct: 30, limit: 20 } }) },
];

const fmtVal = (m: MetricDef | undefined, v: number, cur: string) => {
  if (v === -1) return 'sem resultado';
  if (!m) return String(v);
  if (m.money) return money(v, cur);
  if (m.pct) return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
  if (m.x) return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x`;
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ainda não rodou');

export function Rules({ overview }: { overview: Overview }) {
  const [data, setData] = useState<RulesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const accounts = useMemo(() => overview.profiles.flatMap((p) => p.adAccounts.filter((a) => a.selected).map((a) => ({ ...a, canManage: p.status === 'connected' && p.canManageAds !== false }))), [overview]);
  const curOf = (act: string) => accounts.find((a) => a.actId === act)?.currency ?? 'BRL';
  const metric = (id: string) => data?.metrics.find((m) => m.id === id);

  const load = useCallback(() => api.get<RulesData>('/ad-rules').then((r) => { setData(r); setErr(null); }).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const sock = getSocket();
    const on = () => void load();
    sock?.on('meta:rules', on);
    return () => { sock?.off('meta:rules', on); };
  }, [load]);

  async function toggle(r: Rule) {
    try { await api.patch(`/ad-rules/${r.id}`, { enabled: !r.enabled }); void load(); } catch (e) { toast((e as Error).message); }
  }
  async function remove(r: Rule) {
    if (!window.confirm(`Excluir a regra “${r.name}”? O histórico dela também some.`)) return;
    try { await api.del(`/ad-rules/${r.id}`); toast('Regra excluída'); void load(); } catch (e) { toast((e as Error).message); }
  }
  async function runNow(r: Rule) {
    setRunning(r.id);
    try {
      const out = await api.post<{ applied: number; matches: number }>(`/ad-rules/${r.id}/run`, {});
      toast(out.matches ? `${out.applied} de ${out.matches} ${out.matches === 1 ? 'objeto alterado' : 'objetos alterados'}` : 'Nenhum objeto bateu as condições agora');
      void load();
    } catch (e) { toast((e as Error).message); } finally { setRunning(null); }
  }

  if (!accounts.length) {
    return <div className="ag-empty" data-testid="rules-no-accounts"><Icon name="megaphone" size={30} /><b>Escolha uma conta de anúncios</b><span>As regras rodam nas contas escolhidas em Perfis e contas.</span></div>;
  }
  if (!data) return err ? <div className="note err"><Icon name="alert" size={15} /><span>{err}</span></div> : <Spinner />;

  const describe = (r: Draft) => {
    const cur = curOf(r.actId);
    const conds = r.conditions.map((c) => `${metric(c.metric)?.label ?? c.metric} ${c.op === 'gt' ? 'acima de' : 'abaixo de'} ${fmtVal(metric(c.metric), Number(c.value) || 0, cur)}`).join(' e ');
    const win = data.windows.find((w) => w.id === r.window)?.label.toLowerCase() ?? r.window;
    const lvl = LEVELS.find((l) => l[0] === r.level)?.[2] ?? r.level;
    const a = r.action;
    const act = a.type === 'pause' ? `pausar o ${lvl}` : a.type === 'activate' ? `ativar o ${lvl}` : a.type === 'notify' ? 'registrar no histórico'
      : `${a.type === 'budget_up' ? 'aumentar' : 'diminuir'} o orçamento em ${a.pct ?? 20}%${a.limit ? ` (${a.type === 'budget_up' ? 'até' : 'no mínimo'} ${money(a.limit, cur)})` : ''}`;
    return `Se ${conds} (${win}), ${act}.`;
  };

  return (
    <div className="rules" data-testid="rules">
      <section className="card rules-head">
        <div>
          <h3><Icon name="bolt" size={17} />Regras automáticas</h3>
          <p className="faint">Checadas a cada {data.everyMinutes} minutos com os números da Meta e as vendas do Converza (as mesmas do Gerenciador). Depois de agir num objeto, a regra espera o intervalo dela antes de mexer nele de novo.</p>
        </div>
        {overview.canEdit && <button type="button" className="btn primary" onClick={() => setEditing({ ...TEMPLATES[0].d(accounts[0].actId), name: '', conditions: [{ metric: 'spend', op: 'gt', value: 0 }] })} data-testid="rule-new"><Icon name="plus" size={15} />Nova regra</button>}
      </section>

      {overview.canEdit && (
        <div className="rules-tpl" data-testid="rule-templates">
          {TEMPLATES.map((t) => (
            <button type="button" key={t.id} className="card rules-tpl-i" onClick={() => setEditing(t.d(accounts[0].actId))} data-testid={`rule-tpl-${t.id}`}>
              <b>{t.label}</b><small>{t.desc}</small><span className="rules-tpl-go">Usar modelo <Icon name="chevronRight" size={13} /></span>
            </button>
          ))}
        </div>
      )}

      <section className="card rules-list">
        {data.rules.length === 0 ? <p className="faint rules-empty">Nenhuma regra ainda. Comece por um modelo acima.</p> : data.rules.map((r) => (
          <div key={r.id} className={cx('rules-row', !r.enabled && 'off')} data-testid="rule-row">
            {overview.canEdit && <span data-testid="rule-toggle"><Switch on={r.enabled} onClick={() => void toggle(r)} /></span>}
            <div className="rules-row-t">
              <b>{r.name}</b>
              <span>{describe(r)}</span>
              <small className="faint">{accounts.find((a) => a.actId === r.actId)?.name ?? r.actId}{r.campaignIds.length ? ` · ${r.campaignIds.length} ${r.campaignIds.length === 1 ? 'campanha' : 'campanhas'}` : ' · todas as campanhas'} · última checagem: {when(r.lastRunAt)}{r.applied24h ? ` · ${r.applied24h} ${r.applied24h === 1 ? 'ação' : 'ações'} nas últimas 24h` : ''}</small>
              {r.lastError && <small className="rules-err"><Icon name="alert" size={12} />{r.lastError}</small>}
            </div>
            {overview.canEdit && (
              <div className="rules-row-a">
                <button type="button" className="btn sm" disabled={running === r.id} onClick={() => void runNow(r)} title="Checar e aplicar agora" data-testid="rule-run"><Icon name="play" size={13} />{running === r.id ? 'Rodando…' : 'Rodar agora'}</button>
                <button type="button" className="btn sm icon" onClick={() => setEditing({ ...r })} title="Editar" data-testid="rule-edit"><Icon name="edit" size={14} /></button>
                <button type="button" className="btn sm icon" onClick={() => void remove(r)} title="Excluir" data-testid="rule-delete"><Icon name="trash" size={14} /></button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="card rules-log" data-testid="rule-log">
        <h4>Histórico</h4>
        {data.logs.length === 0 ? <p className="faint rules-empty">As ações das regras aparecem aqui.</p> : (
          <ul>
            {data.logs.map((l) => (
              <li key={l.id} className={l.status} data-testid="rule-log-item">
                <span className={cx('rules-log-st', l.status)}>{l.status === 'applied' ? 'feito' : l.status === 'error' ? 'erro' : 'ignorado'}</span>
                <span className="rules-log-t"><b>{l.detail}</b><small className="faint">{l.ruleName} · {Object.entries(l.values).map(([k, v]) => `${metric(k)?.label ?? k}: ${fmtVal(metric(k), v, 'BRL')}`).join(' · ')}</small></span>
                <span className="faint">{when(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && <RuleEditor draft={editing} accounts={accounts} data={data} describe={describe} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function RuleEditor({ draft, accounts, data, describe, onClose, onSaved }: {
  draft: Draft; accounts: { actId: string; name: string; currency: string; canManage: boolean }[]; data: RulesData;
  describe: (d: Draft) => string; onClose: () => void; onSaved: () => void;
}) {
  const [d, setD] = useState<Draft>(draft);
  const [camps, setCamps] = useState<{ id: string; name: string }[] | null>(null);
  const [sim, setSim] = useState<{ matches: SimMatch[]; checked: number } | null>(null);
  const [busy, setBusy] = useState<'save' | 'sim' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setSim(null); };
  const cur = accounts.find((a) => a.actId === d.actId)?.currency ?? 'BRL';
  const mdef = (id: string) => data.metrics.find((m) => m.id === id);
  const budget = d.action.type === 'budget_up' || d.action.type === 'budget_down';

  useEffect(() => {
    setCamps(null);
    api.get<{ rows: { id: string; name: string }[] }>(`/meta/manager?level=campaign&period=30d&actId=${d.actId}`)
      .then((r) => setCamps(r.rows.map((x) => ({ id: x.id, name: x.name })))).catch(() => setCamps([]));
  }, [d.actId]);

  const body = () => ({ ...d, conditions: d.conditions.map((c) => ({ ...c, value: Number(c.value) || 0 })) });
  async function simulate() {
    setBusy('sim'); setErr(null);
    try { setSim(await api.post('/ad-rules/simulate', body())); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function save() {
    if (!d.name.trim()) { setErr('Dê um nome para a regra'); return; }
    setBusy('save'); setErr(null);
    try {
      if (d.id) await api.put(`/ad-rules/${d.id}`, body()); else await api.post('/ad-rules', body());
      toast(d.id ? 'Regra salva' : 'Regra criada: ela roda sozinha a cada 30 minutos');
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  const setCond = (i: number, p: Partial<Cond>) => set({ conditions: d.conditions.map((c, k) => (k === i ? { ...c, ...p } : c)) });

  return (
    <Modal title={d.id ? 'Editar regra' : 'Nova regra automática'} icon="bolt" width={720} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={() => void simulate()} disabled={!!busy} data-testid="rule-simulate"><Icon name="eye" size={14} />{busy === 'sim' ? 'Simulando…' : 'Simular agora'}</button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" onClick={() => void save()} disabled={!!busy} data-testid="rule-save">{busy === 'save' ? 'Salvando…' : d.id ? 'Salvar' : 'Criar regra'}</button>
      </>}>
      <div className="rule-ed" data-testid="rule-editor">
        <label className="field"><span>Nome</span><input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Pausar anúncio sem venda" data-testid="rule-name" /></label>
        <div className="rule-grid">
          <label className="field"><span>Conta de anúncios</span>
            <select className="select" value={d.actId} onChange={(e) => set({ actId: e.target.value, campaignIds: [] })} data-testid="rule-act">
              {accounts.map((a) => <option key={a.actId} value={a.actId}>{a.name} ({a.currency})</option>)}
            </select></label>
          <label className="field"><span>Aplicar em</span>
            <select className="select" value={d.level} onChange={(e) => set({ level: e.target.value as Level })} data-testid="rule-level">
              {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className="field"><span>Olhando os números de</span>
            <select className="select" value={d.window} onChange={(e) => set({ window: e.target.value })} data-testid="rule-window">
              {data.windows.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select></label>
        </div>

        <div className="field"><span>Campanhas</span>
          <div className="rule-camps" data-testid="rule-camps">
            <label className="rule-chk"><input type="checkbox" checked={!d.campaignIds.length} onChange={() => set({ campaignIds: [] })} />Todas as campanhas da conta</label>
            {camps === null ? <small className="faint">carregando campanhas…</small> : camps.map((c) => (
              <label className="rule-chk" key={c.id}><input type="checkbox" checked={d.campaignIds.includes(c.id)}
                onChange={(e) => set({ campaignIds: e.target.checked ? [...d.campaignIds, c.id] : d.campaignIds.filter((x) => x !== c.id) })} />{c.name}</label>
            ))}
          </div>
        </div>

        <div className="field"><span>Quando <b>todas</b> estas condições valerem</span>
          {d.conditions.map((c, i) => (
            <div className="rule-cond" key={i} data-testid="rule-cond">
              <select className="select" value={c.metric} onChange={(e) => setCond(i, { metric: e.target.value })} data-testid="rule-cond-metric">
                {data.metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <select className="select" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as 'gt' | 'lt' })} data-testid="rule-cond-op">
                <option value="gt">maior que</option><option value="lt">menor que</option>
              </select>
              <span className="rule-num">{mdef(c.metric)?.money && <i>{cur === 'BRL' ? 'R$' : cur}</i>}
                <input className="input" type="number" min={0} step="any" value={c.value} onChange={(e) => setCond(i, { value: e.target.value as unknown as number })} data-testid="rule-cond-value" />
                {mdef(c.metric)?.pct && <i>%</i>}{mdef(c.metric)?.x && <i>x</i>}</span>
              <button type="button" className="btn sm icon" disabled={d.conditions.length < 2} onClick={() => set({ conditions: d.conditions.filter((_, k) => k !== i) })} title="Tirar condição"><Icon name="close" size={13} /></button>
            </div>
          ))}
          {d.conditions.length < 8 && <button type="button" className="btn sm ghost" onClick={() => set({ conditions: [...d.conditions, { metric: 'roas', op: 'lt', value: 1 }] })} data-testid="rule-cond-add"><Icon name="plus" size={13} />Condição</button>}
          <small className="faint">Custo por venda (CPA), por conversa e por lead: sem nenhum resultado, conta como infinito. Assim “CPA maior que R$ 25” também pega quem gastou e não vendeu.</small>
        </div>

        <div className="rule-grid">
          <label className="field"><span>Então</span>
            <select className="select" value={d.action.type} onChange={(e) => set({ action: { type: e.target.value as ActionType, pct: d.action.pct ?? 20, limit: d.action.limit ?? null } })} data-testid="rule-action">
              {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          {budget && <label className="field"><span>Quanto (%)</span><input className="input" type="number" min={1} max={500} value={d.action.pct ?? 20} onChange={(e) => set({ action: { ...d.action, pct: Number(e.target.value) || 0 } })} data-testid="rule-pct" /></label>}
          {budget && <label className="field"><span>{d.action.type === 'budget_up' ? 'Orçamento máximo' : 'Orçamento mínimo'} ({cur})</span><input className="input" type="number" min={0} value={d.action.limit ?? ''} placeholder="sem limite" onChange={(e) => set({ action: { ...d.action, limit: e.target.value ? Number(e.target.value) : null } })} data-testid="rule-limit" /></label>}
          <label className="field"><span>Não repetir no mesmo objeto por</span>
            <select className="select" value={d.cooldownHours} onChange={(e) => set({ cooldownHours: Number(e.target.value) })} data-testid="rule-cooldown">
              {[[1, '1 hora'], [6, '6 horas'], [12, '12 horas'], [24, '24 horas'], [48, '2 dias'], [72, '3 dias'], [168, '7 dias']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
        </div>
        {budget && <small className="faint">O orçamento muda onde ele mora: na campanha (Advantage+ / CBO) ou no conjunto. Se o nível escolhido não tiver orçamento próprio, a regra registra e não mexe.</small>}
        {!accounts.find((a) => a.actId === d.actId)?.canManage && d.action.type !== 'notify' && <div className="hint warn"><Icon name="alert" size={14} /><span>O login desta conta não tem permissão para mudar anúncios. Reconecte o perfil em Perfis e contas para a regra conseguir agir.</span></div>}

        <div className="rule-sum" data-testid="rule-summary"><Icon name="bolt" size={14} />{describe(d)}</div>
        {err && <div className="note err"><Icon name="alert" size={15} /><span>{err}</span></div>}
        {sim && (
          <div className="rule-sim" data-testid="rule-sim">
            <b>{sim.matches.length ? `Agora, ${sim.matches.length} de ${sim.checked} ${sim.matches.length === 1 ? 'bateria' : 'bateriam'} as condições:` : `Agora, nenhum dos ${sim.checked} bate as condições.`}</b>
            {sim.matches.map((m) => (
              <div key={m.id} className="rule-sim-i" data-testid="rule-sim-item">
                <span><b>{m.name}</b><small className="faint">{Object.entries(m.values).map(([k, v]) => `${mdef(k)?.label ?? k}: ${fmtVal(mdef(k), v, m.currency)}`).join(' · ')}</small></span>
                <span className={cx('pill mini', m.cooling ? '' : 'teal')}>{m.cooling ? 'já agiu há pouco' : m.preview}</span>
              </div>
            ))}
            <small className="faint">Simulação: nada foi alterado na Meta.</small>
          </div>
        )}
      </div>
    </Modal>
  );
}
