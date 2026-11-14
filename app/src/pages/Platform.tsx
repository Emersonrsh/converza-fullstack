import { useCallback, useEffect, useState } from 'react';
import { api, money, num } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Modal, Spinner, TopbarActions, cx, toast, useBackdrop } from '../components/ui';
import { PlatformPush } from './PlatformPush';

/**
 * Painel da plataforma: só para os donos do Converza (PLATFORM_ADMIN_EMAILS).
 * Números do negócio, todas as empresas, detalhes, suspender/reativar e dias de cortesia.
 */

type Status = 'paying' | 'canceling' | 'past_due' | 'courtesy' | 'house' | 'inactive' | 'canceled' | 'suspended';
const STATUS: Record<Status, [string, string]> = {
  paying: ['Pagando', 'green'], canceling: ['Cancelando', 'amber'], past_due: ['Atrasada', 'red'], courtesy: ['Cortesia', 'blue'],
  house: ['Da casa', 'teal'], inactive: ['Sem assinatura', ''], canceled: ['Cancelada', ''], suspended: ['Suspensa', 'red'],
};
const FILTERS: ['all' | Status, string][] = [
  ['all', 'Todas'], ['paying', 'Pagando'], ['canceling', 'Cancelando'], ['past_due', 'Atrasadas'], ['courtesy', 'Cortesia'],
  ['house', 'Da casa'], ['inactive', 'Sem assinatura'], ['canceled', 'Canceladas'], ['suspended', 'Suspensas'],
];
const ACTION: Record<string, string> = { suspend: 'Suspendeu', reactivate: 'Reativou', courtesy: 'Deu cortesia', ai_credits: 'Adicionou créditos de IA', ai_credits_remove: 'Tirou créditos de IA', push_test: 'Enviou notificação de teste', push_sale_test: 'Simulou venda (notificação)' };
const ROLE: Record<string, string> = { owner: 'Dono', admin: 'Administrador', agent: 'Atendente' };
const INV: Record<string, [string, string]> = { paid: ['Paga', 'green'], pending: ['Pendente', 'amber'], overdue: ['Atrasada', 'red'], refunded: ['Reembolsada', ''], canceled: ['Cancelada', ''] };

interface Overview {
  price: number;
  companies: { total: number; new30: number; paying: number; canceling: number; pastDue: number; house: number; courtesy: number; suspended: number; inactive: number; canceled30: number };
  mrr: number; payingInstances: number; payingIntl: number;
  revenue: { month: number; lastMonth: number; months: { month: string; total: number }[] };
  overdue: { count: number; amount: number };
  usage: { numbersConnected: number; numbersTotal: number; aiTokens30: number; activeUsers7: number };
}
interface Row {
  id: string; name: string; number: number; createdAt: string; status: Status; suspendedReason: string | null;
  instances: number; periodEnd: string | null; ownerName: string | null; ownerEmail: string | null;
  members: number; numbers: number; numbersOn: number; lastAccess: string | null; aiTokens30: number; aiBalance: number;
}
interface AuditRow { id: string; actorEmail: string; accountName: string; action: string; detail: Record<string, any>; createdAt: string }
interface Detail {
  account: { id: string; name: string; number: number; createdAt: string; suspendedAt: string | null; suspendedReason: string | null; status: Status };
  subscription: { status: string; instances: number; periodEnd: string | null; startedAt: string | null; gateway: string | null; paymentMethod: string | null; country: string; cancelAtPeriodEnd: boolean; house: boolean; renewing: boolean; aiTokensBalance: number } | null;
  members: { name: string; email: string; role: string; joinedAt: string; lastAccess: string | null }[];
  numbers: { name: string; provider: string; status: string; displayPhone: string | null }[];
  invoices: { number: number; description: string; amount: number; currency: string; status: string; method: string | null; paidAt: string | null; createdAt: string }[];
  totals: { paid: number; aiTokens30: number };
  supportUntil: string | null;
  audit: AuditRow[];
}

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
const dateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (iso: string | null) => {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return 'agora há pouco';
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
};
const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : num(n));

function Pill({ s }: { s: Status }) {
  const [label, tone] = STATUS[s] ?? STATUS.inactive;
  return <span className={cx('pill dot', tone)} data-testid="pf-status">{label}</span>;
}

function Kpi({ icon, label, value, sub, tone, testId }: { icon: string; label: string; value: string; sub?: React.ReactNode; tone?: string; testId: string }) {
  return (
    <div className={cx('card pf-kpi', tone)} data-testid={testId}>
      <span className="pf-kpi-ic"><Icon name={icon} size={18} /></span>
      <div><small>{label}</small><b>{value}</b>{sub && <span className="pf-kpi-sub">{sub}</span>}</div>
    </div>
  );
}

function RevenueChart({ months }: { months: { month: string; total: number }[] }) {
  const max = Math.max(1, ...months.map((m) => m.total));
  return (
    <div className="card pf-chart" data-testid="pf-revenue-chart">
      <div className="pf-card-h"><b>Receita recebida</b><small>últimos 6 meses · já sem reembolsos</small></div>
      <div className="pf-bars">
        {months.every((m) => !m.total) && <div className="pf-bars-empty">Nenhum pagamento recebido ainda. Quando os clientes pagarem pela Asaas ou pela Paddle, a receita aparece aqui.</div>}
        {months.map((m, i) => (
          <div key={m.month} className={cx('pf-bar', i === months.length - 1 && 'now')} title={`${monthLabel(m.month)}: ${money(m.total)}`}>
            <span className="pf-bar-v">{m.total ? compact(Math.round(m.total)) : ''}</span>
            <i style={{ height: `${Math.max(3, (m.total / max) * 100)}%` }} />
            <small>{monthLabel(m.month)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function Breakdown({ o, onPick }: { o: Overview; onPick: (s: Status) => void }) {
  const c = o.companies;
  const parts: [Status, number][] = [['paying', c.paying], ['canceling', c.canceling], ['past_due', c.pastDue], ['courtesy', c.courtesy], ['house', c.house], ['suspended', c.suspended], ['inactive', c.inactive]];
  const total = Math.max(1, parts.reduce((a, [, v]) => a + v, 0));
  return (
    <div className="card pf-mix" data-testid="pf-breakdown">
      <div className="pf-card-h"><b>Empresas por situação</b><small>{num(c.total)} no total · +{num(c.new30)} nos últimos 30 dias</small></div>
      <div className="pf-mix-bar">{parts.filter(([, v]) => v > 0).map(([s, v]) => <i key={s} className={cx('pf-seg', STATUS[s][1] || 'gray')} style={{ width: `${(v / total) * 100}%` }} title={`${STATUS[s][0]}: ${v}`} />)}</div>
      <div className="pf-mix-list">
        {parts.map(([s, v]) => (
          <button type="button" key={s} onClick={() => onPick(s)} data-testid={`pf-mix-${s}`}>
            <span className={cx('pf-dot', STATUS[s][1] || 'gray')} />{STATUS[s][0]}<b>{num(v)}</b>
          </button>
        ))}
      </div>
      <div className="pf-mix-foot">{num(c.canceled30)} {c.canceled30 === 1 ? 'cancelamento' : 'cancelamentos'} nos últimos 30 dias</div>
    </div>
  );
}

/* ------------------------------------------------------------------ ações */

function CourtesyModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const [days, setDays] = useState(7);
  const [instances, setInstances] = useState(Math.max(1, d.subscription?.instances ?? 1));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const active = d.subscription?.status === 'active' && d.subscription.periodEnd && new Date(d.subscription.periodEnd) > new Date();
  const until = new Date((active ? new Date(d.subscription!.periodEnd!).getTime() : Date.now()) + days * 86_400_000);
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.post(`/platform/accounts/${d.account.id}/courtesy`, { days, instances, note });
      toast(`Cortesia liberada até ${until.toLocaleDateString('pt-BR')}`); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Erro'); setBusy(false); }
  }
  return (
    <Modal title="Dar dias de cortesia" icon="gift" width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy || days < 1} onClick={() => void save()} data-testid="pf-courtesy-save">{busy ? 'Liberando…' : 'Liberar cortesia'}</button>
    </>}>
      <div className="pf-form">
        <p className="muted">A empresa usa tudo sem pagar até a data abaixo. No fim, a assinatura <b>não renova sozinha</b>: ela precisa assinar para continuar.</p>
        <div className="pf-days">{[7, 15, 30].map((v) => <button type="button" key={v} className={cx(days === v && 'on')} onClick={() => setDays(v)}>{v} dias</button>)}</div>
        <div className="pf-row2">
          <label><span className="label">Dias</span><input className="input" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))} data-testid="pf-courtesy-days" /></label>
          <label><span className="label">Números (instâncias)</span><input className="input" type="number" min={1} max={50} value={instances} onChange={(e) => setInstances(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} data-testid="pf-courtesy-instances" /></label>
        </div>
        <label><span className="label">Anotação (só você vê, opcional)</span><input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: teste de 7 dias combinado no WhatsApp" /></label>
        <div className="hint" data-testid="pf-courtesy-until"><Icon name="calendar" size={14} /><span>Liberado até <b>{until.toLocaleDateString('pt-BR')}</b>{active ? ' (somado ao período que ela já tem)' : ''}.</span></div>
        {err && <div className="hint bad"><Icon name="alert" size={14} /><span>{err}</span></div>}
      </div>
    </Modal>
  );
}

const CREDIT_PRESETS = [10_000, 50_000, 100_000, 500_000, 1_000_000];

function CreditsModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [tokens, setTokens] = useState(100_000);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const balance = d.subscription?.aiTokensBalance ?? 0;
  const after = mode === 'add' ? balance + tokens : Math.max(0, balance - tokens);
  const active = d.subscription?.status === 'active';
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ balance: number }>(`/platform/accounts/${d.account.id}/ai-credits`, { tokens, mode, note });
      toast(`${mode === 'add' ? 'Créditos adicionados' : 'Créditos retirados'} · saldo ${num(r.balance)} tokens`); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Erro'); setBusy(false); }
  }
  return (
    <Modal title="Créditos de IA" icon="bolt" width={480} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className={cx('btn', mode === 'add' ? 'primary' : 'pf-danger')} disabled={busy || tokens < 1 || (mode === 'remove' && balance === 0)} onClick={() => void save()} data-testid="pf-credits-save">
        {busy ? 'Salvando…' : mode === 'add' ? `Adicionar ${num(tokens)} tokens` : `Tirar ${num(Math.min(tokens, balance))} tokens`}</button>
    </>}>
      <div className="pf-form">
        <div className="gen-tabs" role="tablist">
          <button type="button" className={cx(mode === 'add' && 'on')} onClick={() => setMode('add')} data-testid="pf-credits-add"><Icon name="plus" size={14} />Adicionar</button>
          <button type="button" className={cx(mode === 'remove' && 'on')} onClick={() => setMode('remove')} data-testid="pf-credits-remove"><Icon name="trash" size={14} />Tirar (corrigir)</button>
        </div>
        <p className="muted">Os tokens entram no saldo de IA de <b>{d.account.name}</b> sem gerar cobrança — servem para bônus, testes e compensações. Tudo fica no registro de ações.</p>
        <div className="pf-days pf-presets">{CREDIT_PRESETS.map((v) => <button type="button" key={v} className={cx(tokens === v && 'on')} onClick={() => setTokens(v)}>{v >= 1_000_000 ? `${v / 1_000_000} mi` : `${v / 1000} mil`}</button>)}</div>
        <label><span className="label">Quantidade de tokens</span>
          <input className="input" type="number" min={1} max={100_000_000} step={1000} value={tokens}
            onChange={(e) => setTokens(Math.min(100_000_000, Math.max(0, Math.floor(Number(e.target.value) || 0))))} data-testid="pf-credits-tokens" /></label>
        <label><span className="label">Anotação (só você vê, opcional)</span><input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: bônus de boas-vindas" data-testid="pf-credits-note" /></label>
        <div className="hint" data-testid="pf-credits-after"><Icon name="bolt" size={14} /><span>Saldo: <b>{num(balance)}</b> → <b>{num(after)}</b> tokens</span></div>
        {!active && <div className="hint"><Icon name="info" size={14} /><span>Esta empresa está sem assinatura ativa: o saldo fica guardado, mas a IA só funciona quando ela assinar (ou com uma cortesia).</span></div>}
        {err && <div className="hint bad"><Icon name="alert" size={14} /><span>{err}</span></div>}
      </div>
    </Modal>
  );
}

function SuspendModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { await api.post(`/platform/accounts/${d.account.id}/suspend`, { reason }); toast(`${d.account.name} suspensa`); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Erro'); setBusy(false); }
  }
  return (
    <Modal title={`Suspender ${d.account.name}?`} icon="alert" width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn pf-danger" disabled={busy || reason.trim().length < 3} onClick={() => void save()} data-testid="pf-suspend-save">{busy ? 'Suspendendo…' : 'Suspender empresa'}</button>
    </>}>
      <div className="pf-form">
        <ul className="pf-list-plain">
          <li>Ninguém da empresa consegue entrar: aparece um aviso com o motivo.</li>
          <li>Os números param de enviar mensagens (as recebidas continuam chegando).</li>
          <li>Nada é apagado. Dá para reativar a qualquer momento.</li>
          <li>A cobrança no gateway <b>não</b> é cancelada: se for o caso, cancele no painel da Asaas ou da Paddle.</li>
        </ul>
        <label><span className="label">Motivo (a empresa vê)</span>
          <input className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: uso em desacordo com os Termos (envio de spam)" data-testid="pf-suspend-reason" autoFocus /></label>
        {err && <div className="hint bad"><Icon name="alert" size={14} /><span>{err}</span></div>}
      </div>
    </Modal>
  );
}

function AuditList({ items, showAccount }: { items: AuditRow[]; showAccount?: boolean }) {
  if (!items.length) return <div className="pf-empty-sm">Nenhuma ação registrada ainda.</div>;
  return (
    <ul className="pf-audit" data-testid="pf-audit">
      {items.map((a) => (
        <li key={a.id}>
          <span className={cx('pf-audit-ic', a.action)}><Icon name={a.action === 'suspend' ? 'alert' : a.action === 'courtesy' ? 'gift' : a.action.startsWith('ai_credits') ? 'bolt' : 'check'} size={13} /></span>
          <div>
            <b>{ACTION[a.action] ?? a.action}{showAccount ? ` · ${a.accountName}` : ''}</b>
            <span>
              {a.action === 'courtesy' && `${a.detail.days} dias, ${a.detail.instances} ${a.detail.instances === 1 ? 'número' : 'números'}, até ${date(a.detail.until)}${a.detail.note ? ` · ${a.detail.note}` : ''}`}
              {a.action === 'suspend' && `Motivo: ${a.detail.reason}`}
              {a.action === 'reactivate' && (a.detail.reason ? `Estava suspensa por: ${a.detail.reason}` : 'Acesso devolvido')}
              {a.action.startsWith('ai_credits') && `${a.action === 'ai_credits' ? '+' : '−'}${num(a.detail.tokens)} tokens · saldo ${num(a.detail.before)} → ${num(a.detail.balance)}${a.detail.note ? ` · ${a.detail.note}` : ''}`}
            </span>
            <small>{a.actorEmail} · {dateTime(a.createdAt)}</small>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AccountDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const bg = useBackdrop(onClose);
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'courtesy' | 'suspend' | 'credits'>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.get<Detail>(`/platform/accounts/${id}`).then(setD).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')); }, [id]);
  useEffect(load, [load]);
  const changed = () => { setModal(null); load(); onChanged(); };
  async function reactivate() {
    if (!d) return;
    setBusy(true);
    try { await api.post(`/platform/accounts/${d.account.id}/reactivate`, {}); toast(`${d.account.name} reativada ✓`); changed(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  }
  const s = d?.subscription;
  const owner = d?.members.find((m) => m.role === 'owner');
  return (
    <div className="cd-bg" {...bg}>
      <aside className="cd fade pf-drawer" role="dialog" aria-label="Detalhes da empresa" data-testid="pf-drawer">
        {err ? <div className="cv-empty" style={{ flex: 1 }}><b>Não foi possível abrir</b><span>{err}</span></div> : !d ? <Spinner /> : (
          <>
            <header className="cd-hd">
              <span className="pf-av">{d.account.name.slice(0, 1).toUpperCase()}</span>
              <div className="cd-who"><b>{d.account.name}</b><span>ID {d.account.number} · criada em {date(d.account.createdAt)}</span></div>
              <Pill s={d.account.status} />
              <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" size={18} /></button>
            </header>
            <div className="cd-body">
              {d.account.suspendedAt && (
                <div className="hint bad" style={{ marginTop: 12 }} data-testid="pf-suspended-note"><Icon name="alert" size={14} />
                  <span>Suspensa desde {dateTime(d.account.suspendedAt)}{d.account.suspendedReason ? ` · ${d.account.suspendedReason}` : ''}</span></div>
              )}
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Resumo</b></div>
                <div className="cd-grid pf-facts">
                  <div><small>Dono</small><span>{owner ? <>{owner.name}<br /><a href={`mailto:${owner.email}`} className="cd-link">{owner.email}</a></> : '—'}</span></div>
                  <div><small>Total já pago</small><span>{money(d.totals.paid)}</span></div>
                  <div><small>Equipe</small><span>{d.members.length} {d.members.length === 1 ? 'pessoa' : 'pessoas'}</span></div>
                  <div><small>IA nos últimos 30 dias</small><span>{num(d.totals.aiTokens30)} tokens</span></div>
                </div>
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Assinatura</b></div>
                {!s ? <div className="pf-empty-sm">Sem registro de assinatura.</div> : (
                  <div className="cd-grid pf-facts">
                    <div><small>Situação</small><span>{STATUS[d.account.status]?.[0]}{s.renewing ? ' · renova sozinha' : s.status === 'active' && !s.house ? ' · não renova' : ''}</span></div>
                    <div><small>Números contratados</small><span>{s.house ? 'conta da casa' : s.instances}</span></div>
                    <div><small>{s.status === 'active' ? (s.renewing ? 'Próxima cobrança' : 'Vale até') : 'Venceu em'}</small><span>{s.house ? '—' : date(s.periodEnd)}</span></div>
                    <div><small>Pagamento</small><span>{s.gateway ? `${s.gateway === 'asaas' ? 'Asaas' : 'Paddle'}${s.paymentMethod ? ` · ${s.paymentMethod === 'pix' ? 'Pix' : s.paymentMethod === 'card' ? 'cartão' : s.paymentMethod}` : ''}` : s.status === 'active' && !s.house ? 'cortesia' : '—'}</span></div>
                    <div><small>Cliente desde</small><span>{date(s.startedAt)}</span></div>
                    <div><small>Tokens de IA de saldo</small><span>{s.house ? '∞' : num(s.aiTokensBalance)}</span></div>
                  </div>
                )}
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Números ({d.numbers.length})</b></div>
                {d.numbers.length === 0 ? <div className="pf-empty-sm">Nenhum número conectado.</div> : (
                  <ul className="pf-mini">{d.numbers.map((c, i) => (
                    <li key={i}><span className={cx('cn-dot', c.status === 'connected' ? 'green' : c.status === 'pending' ? 'amber' : 'red')} />
                      <b>{c.name}</b><span>{c.displayPhone ?? '—'} · {c.provider === 'web' ? 'QR Code' : 'API oficial'}</span></li>
                  ))}</ul>
                )}
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Equipe</b></div>
                <ul className="pf-mini">{d.members.map((m) => (
                  <li key={m.email}><b>{m.name}</b><span>{m.email} · {ROLE[m.role] ?? m.role} · último acesso {ago(m.lastAccess)}</span></li>
                ))}</ul>
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Faturas recentes</b></div>
                {d.invoices.length === 0 ? <div className="pf-empty-sm">Nenhuma fatura ainda.</div> : (
                  <ul className="pf-mini">{d.invoices.map((iv) => (
                    <li key={iv.number} className="pf-inv"><b>#{iv.number} · {iv.description}</b>
                      <span>{iv.currency === 'BRL' ? money(iv.amount) : `${iv.currency} ${iv.amount.toFixed(2)}`} · {date(iv.paidAt ?? iv.createdAt)}</span>
                      <span className={cx('pill mini', INV[iv.status]?.[1])}>{INV[iv.status]?.[0] ?? iv.status}</span></li>
                  ))}</ul>
                )}
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Acesso de suporte</b></div>
                <div className="pf-support" data-testid="pf-support">
                  <Icon name="headset" size={16} />
                  {d.supportUntil
                    ? <span>Liberado pela empresa até <b>{dateTime(d.supportUntil)}</b>. Quem está em <code>SUPPORT_EMAILS</code> vê a empresa no seletor de empresas, com o selo 🛟.</span>
                    : <span>Não liberado. Conversas, contatos e configurações só podem ser vistos quando a empresa libera em <b>Configurações › Acesso de suporte</b> (é o que os Termos de Uso garantem a ela).</span>}
                </div>
              </section>
              <section className="cd-sec">
                <div className="cd-sec-h"><b>Histórico no painel</b></div>
                <AuditList items={d.audit} />
              </section>
            </div>
            <footer className="cd-ft">
              {d.account.suspendedAt
                ? <button type="button" className="btn primary" disabled={busy} onClick={() => void reactivate()} data-testid="pf-reactivate"><Icon name="check" size={15} />{busy ? 'Reativando…' : 'Reativar empresa'}</button>
                : <button type="button" className="btn danger-ghost" onClick={() => setModal('suspend')} data-testid="pf-suspend"><Icon name="alert" size={15} />Suspender</button>}
              <span style={{ flex: 1 }} />
              {!s?.house && <button type="button" className="btn" onClick={() => setModal('credits')} data-testid="pf-credits"><Icon name="bolt" size={15} />Créditos de IA</button>}
              {!s?.house && !s?.renewing && <button type="button" className="btn" onClick={() => setModal('courtesy')} data-testid="pf-courtesy"><Icon name="gift" size={15} />Dar cortesia</button>}
            </footer>
            {modal === 'courtesy' && <CourtesyModal d={d} onClose={() => setModal(null)} onDone={changed} />}
            {modal === 'suspend' && <SuspendModal d={d} onClose={() => setModal(null)} onDone={changed} />}
            {modal === 'credits' && <CreditsModal d={d} onClose={() => setModal(null)} onDone={changed} />}
          </>
        )}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ página */

export function Platform() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'companies' | 'audit' | 'push'>('companies');
  const [o, setO] = useState<Overview | null>(null);
  const [list, setList] = useState<{ accounts: Row[]; total: number; page: number; pageSize: number } | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | Status>('all');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadOverview = useCallback(() => { api.get<Overview>('/platform/overview').then(setO).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')); }, []);
  const loadList = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ q: q.trim(), status, page: String(page) });
    api.get<typeof list>(`/platform/accounts?${p}`).then((r) => setList(r)).catch((e) => toast(e instanceof Error ? e.message : 'Erro')).finally(() => setLoading(false));
  }, [q, status, page]);
  useEffect(loadOverview, [loadOverview]);
  useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList, q]);
  useEffect(() => { if (tab === 'audit') api.get<{ audit: AuditRow[] }>('/platform/audit').then((r) => setAudit(r.audit)).catch(() => setAudit([])); }, [tab]);

  if (!user?.platformAdmin) return <div className="ag-empty"><Icon name="shield" size={30} /><b>Área restrita</b><span>Este painel é só para os donos da plataforma.</span></div>;
  if (err && !o) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar o painel</b><span>{err}</span></div>;
  if (!o) return <Spinner />;
  const diff = o.revenue.lastMonth ? Math.round(((o.revenue.month - o.revenue.lastMonth) / o.revenue.lastMonth) * 100) : null;
  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div className="fade pf-page" data-testid="platform-page">
      <TopbarActions>
        <div className="pf-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'companies'} className={cx(tab === 'companies' && 'on')} onClick={() => setTab('companies')} data-testid="pf-tab-companies"><Icon name="building" size={15} />Empresas</button>
          <button type="button" role="tab" aria-selected={tab === 'audit'} className={cx(tab === 'audit' && 'on')} onClick={() => setTab('audit')} data-testid="pf-tab-audit"><Icon name="list" size={15} />Registro de ações</button>
          <button type="button" role="tab" aria-selected={tab === 'push'} className={cx(tab === 'push' && 'on')} onClick={() => setTab('push')} data-testid="pf-tab-push"><Icon name="bell" size={15} />Notificações</button>
        </div>
      </TopbarActions>

      <div className="pf-kpis">
        <Kpi icon="dollar" label="Recebido este mês" value={money(o.revenue.month)} testId="pf-kpi-revenue" tone="teal"
          sub={diff === null ? `mês passado: ${money(o.revenue.lastMonth)}` : <><span className={diff >= 0 ? 'up' : 'down'}>{diff >= 0 ? '▲' : '▼'} {Math.abs(diff)}%</span> vs. mês passado</>} />
        <Kpi icon="trendUp" label="Receita recorrente (estimada)" value={money(o.mrr)} testId="pf-kpi-mrr"
          sub={`${num(o.payingInstances)} ${o.payingInstances === 1 ? 'número pago' : 'números pagos'} × ${money(o.price)}${o.payingIntl ? ` · +${o.payingIntl} no exterior` : ''}`} />
        <Kpi icon="building" label="Empresas pagando" value={num(o.companies.paying)} testId="pf-kpi-paying"
          sub={`${num(o.companies.canceling)} cancelando · ${num(o.companies.courtesy)} em cortesia`} />
        <Kpi icon="alert" label="Faturas atrasadas" value={num(o.overdue.count)} testId="pf-kpi-overdue" tone={o.overdue.count ? 'red' : undefined}
          sub={o.overdue.count ? `${money(o.overdue.amount)} em aberto · ${num(o.companies.pastDue)} empresas atrasadas` : 'tudo em dia'} />
      </div>

      <div className="pf-grid">
        <RevenueChart months={o.revenue.months} />
        <Breakdown o={o} onPick={(s) => { setTab('companies'); setStatus(s); setPage(1); }} />
        <div className="card pf-usage" data-testid="pf-usage">
          <div className="pf-card-h"><b>Uso da plataforma</b><small>agora e nos últimos dias</small></div>
          <div className="pf-use"><Icon name="phone" size={16} /><span>Números conectados</span><b>{num(o.usage.numbersConnected)}<small> de {num(o.usage.numbersTotal)}</small></b></div>
          <div className="pf-use"><Icon name="users" size={16} /><span>Pessoas que entraram (7 dias)</span><b>{num(o.usage.activeUsers7)}</b></div>
          <div className="pf-use"><Icon name="bolt" size={16} /><span>Tokens de IA usados (30 dias)</span><b>{compact(o.usage.aiTokens30)}</b></div>
          <div className="pf-use"><Icon name="plus" size={16} /><span>Empresas novas (30 dias)</span><b>{num(o.companies.new30)}</b></div>
        </div>
      </div>

      {tab === 'push' ? <PlatformPush /> : tab === 'companies' ? (
        <div className="card ct-card pf-table-card">
          <div className="pf-table-top">
            <div className="fl-search ct-search">
              <Icon name="search" size={16} />
              <input className="input" placeholder="Buscar por empresa, dono, e-mail ou ID" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Buscar empresa" data-testid="pf-search" />
            </div>
            <div className="pf-filters" role="tablist" aria-label="Situação">
              {FILTERS.map(([v, label]) => (
                <button type="button" key={v} className={cx(status === v && 'on')} onClick={() => { setStatus(v); setPage(1); }} data-testid={`pf-filter-${v}`}>{label}</button>
              ))}
            </div>
          </div>
          {!list ? <Spinner /> : list.accounts.length === 0 ? (
            <div className="pf-empty" data-testid="pf-empty"><Icon name="search" size={22} /><b>Nenhuma empresa encontrada</b><span>Troque a busca ou o filtro.</span></div>
          ) : (
            <div className={cx('ct-scroll', loading && 'loading')}>
              <table className="ct-table pf-table" data-testid="pf-table">
                <thead><tr><th>Empresa</th><th>Situação</th><th>Números</th><th>Vence em</th><th>Último acesso</th><th>IA: usado (30 d) / saldo</th><th>Cadastro</th></tr></thead>
                <tbody>
                  {list.accounts.map((r) => (
                    <tr key={r.id} onClick={() => setOpen(r.id)} data-testid="pf-row">
                      <td><div className="pf-co"><span className="pf-av sm">{r.name.slice(0, 1).toUpperCase()}</span>
                        <div><b>{r.name}</b><small>#{r.number} · {r.ownerEmail ?? 'sem dono'}</small></div></div></td>
                      <td><Pill s={r.status} />{r.status === 'suspended' && r.suspendedReason && <small className="pf-why" title={r.suspendedReason}>{r.suspendedReason}</small>}</td>
                      <td><span className="pf-num">{r.numbersOn}<small>/{r.numbers}</small></span>{r.instances > 0 && r.status !== 'house' && <small className="pf-sub">{r.instances} {r.instances === 1 ? 'contratado' : 'contratados'}</small>}</td>
                      <td>{['paying', 'canceling', 'courtesy', 'past_due'].includes(r.status) ? date(r.periodEnd) : '—'}</td>
                      <td>{ago(r.lastAccess)}</td>
                      <td>{r.aiTokens30 ? compact(r.aiTokens30) : '—'}<small className="pf-sub" data-testid="pf-row-balance">{r.status === 'house' ? 'saldo ∞' : `saldo ${compact(r.aiBalance)}`}</small></td>
                      <td>{date(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list && list.total > list.pageSize && (
            <div className="pf-pager">
              <span>{num((page - 1) * list.pageSize + 1)}–{num(Math.min(page * list.pageSize, list.total))} de {num(list.total)}</span>
              <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <button type="button" className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
            </div>
          )}
        </div>
      ) : (
        <div className="card pad" data-testid="pf-audit-card">
          <div className="pf-card-h"><b>Registro de ações</b><small>tudo o que foi feito neste painel, por quem e quando (últimas 100)</small></div>
          {!audit ? <Spinner /> : <AuditList items={audit} showAccount />}
        </div>
      )}

      {open && <AccountDrawer id={open} onClose={() => setOpen(null)} onChanged={() => { loadOverview(); loadList(); }} />}
    </div>
  );
}
