import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Modal, Spinner, Switch, cx, toast } from '../components/ui';
import { TagPicker } from '../components/TagPicker';
import { ConfirmModal } from '../kanban/modals';
import { PathPicker } from './PathPicker';
import { JsonView } from './JsonView';
import { EventsPanel } from './EventsPanel';
import { TemplateActionField } from './TemplateAction';
import { UsageMeter } from '../pages/Webhooks';
import { OP_LABEL, SPECIALS, type ConditionOp, type DryRun, type WebhookActions, type WebhookCondition, type WebhookDetail, type WebhookMapping } from './types';
import { ago, mergeDetected, sameJson } from './util';

interface ConnOpt { id: string; name: string; displayPhone: string | null; wabaId: string | null; status: string }
interface BoardOpt { id: string; name: string; columns: { id: string; name: string }[] }
interface FlowOpt { id: string; name: string; status: string; archivedAt: string | null }
interface Draft { name: string; enabled: boolean; connectionId: string | null; mapping: WebhookMapping; conditions: WebhookCondition[]; actions: WebhookActions }

const STATUS_VALUES: [string, string][] = [['aprovada', 'Aprovada'], ['pendente', 'Pendente'], ['recusada', 'Recusada'], ['reembolsada', 'Reembolsada']];
const OPS = Object.entries(OP_LABEL) as [ConditionOp, string][];

function Section({ icon, title, desc, children, testId, right }: { icon: string; title: string; desc?: string; children: ReactNode; testId?: string; right?: ReactNode }) {
  return (
    <section className="card ag-sec" data-testid={testId}>
      <header><span className="ag-sec-ic"><Icon name={icon} size={16} /></span><div><b>{title}</b>{desc && <small>{desc}</small>}</div><span className="spacer" />{right}</header>
      <div className="ag-sec-body">{children}</div>
    </section>
  );
}
const Lbl = ({ children, hint }: { children: ReactNode; hint?: string }) => <label className="label">{children}{hint && <span className="lbl-hint"> · {hint}</span>}</label>;

function connLabel(c: ConnOpt) { return c.displayPhone ? `${c.name} (${c.displayPhone})` : c.name; }

/* ======================================================= novo (como no print) */

function NewWebhook() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [conns, setConns] = useState<ConnOpt[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ connections: ConnOpt[] }>('/connections').then((r) => setConns(r.connections)).catch(() => setConns([])); }, []);
  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ webhook: { id: string } }>('/webhooks', { name, connectionId: connectionId || null, enabled });
      toast('Webhook criado — copie a URL e mande um teste');
      nav(`/webhooks/${r.webhook.id}`, { replace: true });
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  }
  return (
    <div className="fade wh-editor" data-testid="webhook-new">
      <nav className="wh-crumbs"><Link to="/webhooks">Webhooks</Link><Icon name="chevronRight" size={13} /><b>Novo</b></nav>
      <div className="wh-head"><Icon name="webhook" size={22} /><div><h2>Novo webhook</h2><small>Criar webhook</small></div></div>
      <section className="card wh-new">
        <header><b>Criar webhook</b><span className="spacer" /><Switch on={enabled} onClick={() => setEnabled((x) => !x)} /></header>
        <div className="wh-new-body">
          <div><Lbl>Nome do webhook</Lbl><input className="input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Webhook N8N Vendas" data-testid="wh-new-name"
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save(); }} /></div>
          <div>
            <Lbl>Conexão</Lbl>
            <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} data-testid="wh-new-conn">
              <option value="">Nenhuma</option>
              {conns.map((c) => <option key={c.id} value={c.id}>{connLabel(c)}</option>)}
            </select>
            <small className="faint">Opcional. Necessária para mandar mensagem e disparar fluxo. Use a mesma conexão WhatsApp do lead.</small>
          </div>
        </div>
        <footer><button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void save()} data-testid="wh-new-save"><Icon name="save" size={14} />{busy ? 'Salvando…' : 'Salvar e continuar'}</button></footer>
      </section>
    </div>
  );
}

/* ======================================================= configurar */

export function WebhookEditor() {
  const { id = 'novo' } = useParams();
  if (id === 'novo') return <NewWebhook />;
  return <EditWebhook id={id} />;
}

function draftOf(d: WebhookDetail): Draft {
  const w = d.webhook;
  return { name: w.name, enabled: w.enabled, connectionId: w.connectionId, mapping: w.mapping ?? {}, conditions: w.conditions ?? [], actions: w.actions ?? {} };
}

function EditWebhook({ id }: { id: string }) {
  const nav = useNavigate();
  const { accountId } = useAuth();
  const [detail, setDetail] = useState<WebhookDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [initial, setInitial] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [conns, setConns] = useState<ConnOpt[]>([]);
  const [boards, setBoards] = useState<BoardOpt[]>([]);
  const [flows, setFlows] = useState<FlowOpt[]>([]);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<DryRun | null>(null);
  const [testing, setTesting] = useState(false);
  const [modal, setModal] = useState<null | 'paste' | 'delete' | 'rotate' | 'run' | 'leave'>(null);
  const [paste, setPaste] = useState('');
  const [showRemove, setShowRemove] = useState(false);

  const apply = useCallback((d: WebhookDetail, keepDraft = false) => {
    setDetail(d);
    const fresh = draftOf(d);
    setInitial(fresh);
    setDraft((cur) => (keepDraft && cur ? cur : fresh));
  }, []);
  const load = useCallback(() => api.get<WebhookDetail>(`/webhooks/${id}`).then((d) => apply(d)).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), [id, apply]);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => {
    api.get<{ connections: ConnOpt[] }>('/connections').then((r) => setConns(r.connections)).catch(() => {});
    api.get<{ boards: BoardOpt[] }>('/kanban/boards').then((r) => setBoards(r.boards)).catch(() => {});
    api.get<{ flows: FlowOpt[] }>('/flows').then((r) => setFlows(r.flows.filter((f) => !f.archivedAt))).catch(() => {});
  }, [accountId]);

  // primeiro evento chegando: traz o exemplo (e o mapeamento detectado) sem perder o que já foi editado
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = (p: { webhookId: string; event: { status: string } }) => {
      if (p.webhookId !== id) return;
      if (!detail?.webhook.sample || p.event.status !== 'queued') {
        api.get<WebhookDetail>(`/webhooks/${id}`).then((d) => {
          if (!detail?.webhook.sample && d.webhook.sample) toast('Evento recebido! Confira o mapeamento');
          setDetail(d);
          setInitial((ini) => (ini ? { ...ini, mapping: d.webhook.mapping } : ini));
          setDraft((cur) => (cur && !Object.keys(cur.mapping).length ? { ...cur, mapping: d.webhook.mapping } : cur));
        }).catch(() => {});
      }
    };
    sock.on('webhook:event', on);
    return () => { sock.off('webhook:event', on); };
  }, [id, detail?.webhook.sample]);

  const dirty = !!draft && !!initial && !sameJson(draft, initial);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const leaves = detail?.leaves ?? [];
  const sample = detail?.webhook.sample ?? null;
  const conn = useMemo(() => conns.find((c) => c.id === draft?.connectionId) ?? null, [conns, draft?.connectionId]);
  const varNames = (draft?.mapping.vars ?? []).map((v) => v.name).filter(Boolean);
  const condSpecials: [string, string][] = [...SPECIALS, ...varNames.map((v) => [v, `Variável ${v}`] as [string, string])];

  if (err) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível abrir</b><span>{err}</span><Link className="btn" to="/webhooks">Voltar para webhooks</Link></div>;
  if (!detail || !draft) return <Spinner />;
  const w = detail.webhook;
  const setD = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setM = (patch: Partial<WebhookMapping>) => setD({ mapping: { ...draft.mapping, ...patch } });
  const setA = (patch: Partial<WebhookActions>) => setD({ actions: { ...draft.actions, ...patch } });
  const m = draft.mapping;
  const a = draft.actions;
  const board = boards.find((b) => b.id === a.kanban?.boardId) ?? null;

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const d = await api.put<WebhookDetail>(`/webhooks/${id}`, {
        name: draft.name, enabled: draft.enabled, connectionId: draft.connectionId, mapping: draft.mapping, conditions: draft.conditions,
        actions: { ...draft.actions, tags: draft.actions.tags?.length ? draft.actions.tags : undefined, removeTags: draft.actions.removeTags?.length ? draft.actions.removeTags : undefined },
      });
      apply(d);
      toast('Webhook salvo');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); }
    setSaving(false);
  }
  async function simulate(eventId?: string) {
    if (!draft) return;
    setTesting(true);
    try {
      setTest(await api.post<DryRun>(`/webhooks/${id}/test`, {
        ...(eventId ? { eventId } : {}), mapping: draft.mapping, conditions: draft.conditions, actions: draft.actions, connectionId: draft.connectionId,
      }));
      document.querySelector('[data-testid=sec-test]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setTesting(false);
  }
  const back = () => (dirty ? setModal('leave') : nav('/webhooks'));

  return (
    <div className="fade wh-editor" data-testid="webhook-editor">
      <nav className="wh-crumbs"><Link to="/webhooks" onClick={(e) => { if (dirty) { e.preventDefault(); setModal('leave'); } }}>Webhooks</Link><Icon name="chevronRight" size={13} /><b>{w.name}</b></nav>
      <div className="card ag-ed-head">
        <button type="button" className="btn icon ghost" onClick={back} aria-label="Voltar para webhooks"><Icon name="arrowLeft" size={17} /></button>
        <span className="wh-ic"><Icon name="webhook" size={18} /></span>
        <div className="ag-ed-who"><b>{draft.name || 'Sem nome'}</b><small>{dirty ? 'Alterações não salvas' : `Salvo ${ago(w.updatedAt)}`}{w.platform ? ` · ${w.platform}` : ''}</small></div>
        <span className="spacer" />
        <label className={cx('ag-ed-on', draft.enabled && 'on')} title={draft.enabled ? 'Executando as ações' : 'Pausado: só registra os eventos'}>
          <Switch on={draft.enabled} onClick={() => setD({ enabled: !draft.enabled })} /><span data-testid="wh-enabled-label">{draft.enabled ? 'Ativo' : 'Pausado'}</span>
        </label>
        <button type="button" className="btn sm ghost danger" onClick={() => setModal('delete')} aria-label="Excluir webhook" data-testid="wh-ed-delete"><Icon name="trash" size={14} /></button>
        <button type="button" className="btn primary" disabled={!dirty || saving || !draft.name.trim()} onClick={() => void save()} data-testid="wh-save">{saving ? 'Salvando…' : 'Salvar'}</button>
      </div>

      <div className="ag-ed-body">
        <div className="ag-ed-form">
          <Section icon="webhook" title="Dados do webhook" desc="Nome e número de WhatsApp" testId="sec-data">
            <div className="ag-two">
              <div><Lbl>Nome do webhook</Lbl><input className="input" maxLength={80} value={draft.name} onChange={(e) => setD({ name: e.target.value })} data-testid="wh-name" /></div>
              <div>
                <Lbl>Conexão</Lbl>
                <select className="select" value={draft.connectionId ?? ''} onChange={(e) => setD({ connectionId: e.target.value || null })} data-testid="wh-conn">
                  <option value="">Nenhuma</option>
                  {conns.map((c) => <option key={c.id} value={c.id}>{connLabel(c)}{c.status !== 'connected' ? ' — desconectada' : ''}</option>)}
                </select>
              </div>
            </div>
            <small className="faint">A conexão é usada para mandar o modelo de mensagem e disparar o fluxo. Use a mesma conexão WhatsApp em que o lead conversa.</small>
          </Section>

          <Section icon="split" title="Mapeamento" desc="De onde vem cada dado do lead no evento recebido" testId="sec-mapping"
            right={sample ? <button type="button" className="btn sm" onClick={() => setM(mergeDetected(m, detail.detected))} data-testid="wh-detect"><Icon name="sparkles" size={13} />Detectar sozinho</button> : null}>
            {!sample && <div className="hint"><Icon name="info" size={14} />Mande um evento de teste pela plataforma (Hotmart, Kiwify, N8N…) ou cole um exemplo: os campos aparecem aqui para escolher.</div>}
            <div className="wh-map">
              <MapRow label="Telefone (WhatsApp)" required value={m.phone} onChange={(v) => setM({ phone: v })} leaves={leaves} testId="map-phone" />
              <MapRow label="Nome" value={m.name} onChange={(v) => setM({ name: v })} leaves={leaves} testId="map-name" />
              <MapRow label="E-mail" value={m.email} onChange={(v) => setM({ email: v })} leaves={leaves} testId="map-email" />
            </div>
            {sample && !m.phone && <div className="hint bad"><Icon name="alert" size={14} />Escolha o campo do telefone: sem ele o lead não vira contato.</div>}
            <div className="wh-subhd">Venda <small>(opcional — aparece no Dashboard)</small></div>
            <div className="wh-map">
              <MapRow label="Valor" value={m.amount} onChange={(v) => setM({ amount: v, ...(v ? {} : { amountInCents: false }) })} leaves={leaves} testId="map-amount"
                extra={m.amount ? <label className="wh-check"><input type="checkbox" checked={!!m.amountInCents} onChange={(e) => setM({ amountInCents: e.target.checked })} data-testid="map-cents" />em centavos</label> : null} />
              <MapRow label="Status do pagamento" value={m.status} onChange={(v) => setM({ status: v })} leaves={leaves} testId="map-status" />
              <MapRow label="Evento" value={m.event} onChange={(v) => setM({ event: v })} leaves={leaves} testId="map-event" />
              <MapRow label="Produto" value={m.product} onChange={(v) => setM({ product: v })} leaves={leaves} testId="map-product" />
              <MapRow label="ID da transação" value={m.transaction} onChange={(v) => setM({ transaction: v })} leaves={leaves} testId="map-transaction" hint="evita venda duplicada em reenvios" />
            </div>
            <div className="wh-subhd">Campos personalizados do contato</div>
            {(m.fields ?? []).map((f, i) => (
              <div key={i} className="wh-pair">
                <select className="select" value={f.key} onChange={(e) => setM({ fields: (m.fields ?? []).map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} data-testid="map-field-key">
                  <option value="">Campo…</option>
                  {detail.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <PathPicker value={f.path || undefined} leaves={leaves} onChange={(v) => setM({ fields: (m.fields ?? []).map((x, j) => (j === i ? { ...x, path: v ?? '' } : x)) })} testId="map-field-path" />
                <button type="button" className="btn icon sm ghost" onClick={() => setM({ fields: (m.fields ?? []).filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="close" size={14} /></button>
              </div>
            ))}
            {detail.fields.length ? <button type="button" className="linkbtn wh-add" onClick={() => setM({ fields: [...(m.fields ?? []), { key: '', path: '' }] })} data-testid="map-field-add">+ Campo do contato</button>
              : <small className="faint">Crie campos personalizados (CPF, cidade…) em Contatos para preencher aqui.</small>}
            <div className="wh-subhd">Variáveis extras <small>(para o modelo e o fluxo: {'{{nome_da_variavel}}'})</small></div>
            {(m.vars ?? []).map((v, i) => (
              <div key={i} className="wh-pair">
                <input className="input" value={v.name} placeholder="nome_da_variavel" maxLength={40}
                  onChange={(e) => setM({ vars: (m.vars ?? []).map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') } : x)) })} data-testid="map-var-name" />
                <PathPicker value={v.path || undefined} leaves={leaves} onChange={(p) => setM({ vars: (m.vars ?? []).map((x, j) => (j === i ? { ...x, path: p ?? '' } : x)) })} testId="map-var-path" />
                <button type="button" className="btn icon sm ghost" onClick={() => setM({ vars: (m.vars ?? []).filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="close" size={14} /></button>
              </div>
            ))}
            <button type="button" className="linkbtn wh-add" onClick={() => setM({ vars: [...(m.vars ?? []), { name: '', path: '' }] })} data-testid="map-var-add">+ Variável</button>
          </Section>

          <Section icon="filter" title="Condições" desc="Quando as ações devem rodar" testId="sec-conditions">
            <div className="wh-radio">
              <label><input type="radio" checked={!draft.conditions.length} onChange={() => setD({ conditions: [] })} />Sempre, em todo evento recebido</label>
              <label><input type="radio" checked={!!draft.conditions.length} onChange={() => { if (!draft.conditions.length) setD({ conditions: [{ path: 'status_venda', op: 'eq', value: 'aprovada' }] }); }} data-testid="cond-when" />Só quando…</label>
            </div>
            {draft.conditions.map((c, i) => {
              const setC = (patch: Partial<WebhookCondition>) => setD({ conditions: draft.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="wh-cond" data-testid="cond-row">
                  <PathPicker value={c.path || undefined} leaves={leaves} specials={condSpecials} onChange={(v) => setC({ path: v ?? '' })} testId="cond-path" />
                  <select className="select" value={c.op} onChange={(e) => setC({ op: e.target.value as ConditionOp })} data-testid="cond-op">
                    {OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {c.op !== 'exists' && c.op !== 'empty' && (c.path === 'status_venda'
                    ? <select className="select" value={c.value ?? ''} onChange={(e) => setC({ value: e.target.value })} data-testid="cond-value">{STATUS_VALUES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                    : <input className="input" value={c.value ?? ''} onChange={(e) => setC({ value: e.target.value })} placeholder="valor (vírgula = um ou outro)" data-testid="cond-value" />)}
                  <button type="button" className="btn icon sm ghost" onClick={() => setD({ conditions: draft.conditions.filter((_, j) => j !== i) })} aria-label="Remover condição"><Icon name="close" size={14} /></button>
                </div>
              );
            })}
            {!!draft.conditions.length && <button type="button" className="linkbtn wh-add" onClick={() => setD({ conditions: [...draft.conditions, { path: '', op: 'eq', value: '' }] })} data-testid="cond-add">+ Condição (todas precisam bater)</button>}
            {!!draft.conditions.length && <small className="faint">Ex.: só compras aprovadas — “Status da venda é igual a Aprovada”. Evento que não bate fica no histórico como “Ignorado”.</small>}
          </Section>

          <Section icon="bolt" title="Ações" desc="O que acontece com o lead a cada evento" testId="sec-actions">
            <div className="wh-act">
              <b><Icon name="user" size={14} />Contato</b>
              <span className="faint">Cria ou atualiza o contato pelo telefone (sem duplicar quem já existe).</span>
              <label className="wh-check"><input type="checkbox" checked={!!a.overwrite} onChange={(e) => setA({ overwrite: e.target.checked })} data-testid="act-overwrite" />Atualizar nome, e-mail e campos de quem já é contato</label>
            </div>
            <div className="wh-act">
              <b><Icon name="tag" size={14} />Etiquetas</b>
              <TagPicker value={a.tags ?? []} onChange={(v) => setA({ tags: v })} placeholder="Adicionar etiqueta…" testId="act-tags" />
              {showRemove || a.removeTags?.length ? (
                <><span className="faint">Tirar as etiquetas:</span><TagPicker value={a.removeTags ?? []} onChange={(v) => setA({ removeTags: v })} placeholder="Tirar etiqueta…" testId="act-remove-tags" /></>
              ) : <button type="button" className="linkbtn wh-add" onClick={() => setShowRemove(true)}>+ também tirar etiquetas</button>}
            </div>
            <div className="wh-act">
              <b><Icon name="kanban" size={14} />Kanban</b>
              <div className="ag-two">
                <select className="select" value={a.kanban?.boardId ?? ''} data-testid="act-board"
                  onChange={(e) => { const b = boards.find((x) => x.id === e.target.value); setA({ kanban: b ? { boardId: b.id, columnId: b.columns[0]?.id ?? '' } : null }); }}>
                  <option value="">Não colocar no Kanban</option>
                  {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {board && (
                  <select className="select" value={a.kanban?.columnId ?? ''} onChange={(e) => setA({ kanban: { boardId: board.id, columnId: e.target.value } })} data-testid="act-column">
                    {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </div>
              {board && <span className="faint">Se o lead já tiver card nesse quadro, o card é movido para a coluna.</span>}
            </div>
            <div className="wh-act">
              <b><Icon name="dollar" size={14} />Venda</b>
              <label className="wh-check"><input type="checkbox" checked={a.sale !== false} onChange={(e) => setA({ sale: e.target.checked })} data-testid="act-sale" />Registrar a venda quando o evento tiver valor</label>
              <span className="faint">{m.amount ? 'Aparece no Dashboard; venda aprovada libera os fluxos que esperam o pagamento.' : 'Escolha o campo do valor no mapeamento para registrar vendas.'}</span>
            </div>
            <div className="wh-act">
              <b><Icon name="chat" size={14} />Mensagem no WhatsApp</b>
              <TemplateActionField connectionId={draft.connectionId} hasWaba={!!conn?.wabaId} value={a.template} onChange={(t) => setA({ template: t })} leaves={leaves} vars={varNames} />
            </div>
            <div className="wh-act">
              <b><Icon name="flow" size={14} />Fluxo</b>
              <select className="select" value={a.flowId ?? ''} onChange={(e) => setA({ flowId: e.target.value || null })} data-testid="act-flow">
                <option value="">Não disparar fluxo</option>
                {flows.map((f) => <option key={f.id} value={f.id} disabled={f.status !== 'active' && f.id !== a.flowId}>{f.name}{f.status !== 'active' ? ' (pausado)' : ''}</option>)}
              </select>
              {a.flowId && <span className="faint">{a.template?.name
                ? 'Se o lead não falou com você nas últimas 24h, o modelo vai primeiro e o fluxo começa quando ele responder.'
                : 'Pela regra da Meta, as mensagens de texto do fluxo só chegam a quem falou com você nas últimas 24h. Para lead novo, mande também um modelo.'}</span>}
              <span className="faint">No fluxo, use {'{{evento}}'}, {'{{valor}}'}, {'{{produto}}'}, {'{{status_venda}}'}, {'{{transacao}}'} e as variáveis extras.</span>
            </div>
          </Section>

          <Section icon="play" title="Testar" desc="Veja o que acontece antes de usar de verdade" testId="sec-test">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" disabled={!sample || testing} onClick={() => void simulate()} data-testid="wh-simulate"><Icon name="play" size={14} />{testing ? 'Simulando…' : 'Simular com o exemplo'}</button>
              <button type="button" className="btn ghost" disabled={!sample || dirty} onClick={() => setModal('run')} title={dirty ? 'Salve antes de executar' : undefined} data-testid="wh-run"><Icon name="bolt" size={14} />Executar de verdade</button>
            </div>
            {!sample && <small className="faint">Precisa de um evento de exemplo.</small>}
            {test && (
              <div className="wh-test" data-testid="wh-test-result">
                <ul className="wh-results">
                  {test.steps.map((s, i) => <li key={i} className={cx(!s.ok && 'bad', s.warn && 'warn')}><Icon name={!s.ok ? 'alert' : s.warn ? 'info' : 'check'} size={13} />{s.text}</li>)}
                </ul>
                {test.resolved.detected.length > 0 && <small className="faint">Achado automaticamente: {test.resolved.detected.join(', ')}.</small>}
                <small className="faint">Simulação: nada foi criado nem enviado.</small>
              </div>
            )}
          </Section>
        </div>

        <aside className="ag-ed-side wh-side">
          <section className="card wh-urlcard">
            <header><Icon name="link" size={15} /><b>URL do webhook</b></header>
            <div className="wh-url big"><code data-testid="wh-url">{w.url}</code>
              <button type="button" className="btn icon sm" aria-label="Copiar URL" onClick={() => { void navigator.clipboard?.writeText(w.url ?? ''); toast('URL copiada'); }} data-testid="wh-url-copy"><Icon name="copy" size={14} /></button>
            </div>
            <small className="faint">Cole na plataforma (Hotmart, Kiwify, Eduzz, N8N, Make, formulário do site…). Aceita POST com JSON ou formulário, e GET com os dados na URL.</small>
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn sm ghost" onClick={() => setModal('rotate')} data-testid="wh-rotate"><Icon name="refresh" size={13} />Gerar nova URL</button>
              <span className="spacer" />
              <UsageMeter usage={detail.usage} />
            </div>
          </section>

          <section className="card wh-sample" data-testid="wh-sample">
            <header><Icon name="file" size={15} /><b>Evento de exemplo</b><span className="spacer" />
              <button type="button" className="btn sm ghost" onClick={() => { setPaste(sample ? JSON.stringify(sample, null, 2) : ''); setModal('paste'); }} data-testid="wh-paste-open">Colar exemplo</button>
            </header>
            {sample ? <>
              <small className="faint">{w.platform ? `Parece ${w.platform} · ` : ''}recebido {ago(w.sampleAt)} · clique num valor para copiar o caminho</small>
              <JsonView value={sample} />
            </> : (
              <div className="wh-wait" data-testid="wh-waiting"><span className="wh-live" />Aguardando o primeiro evento…<small>Mande um teste pela plataforma usando a URL acima.</small></div>
            )}
          </section>

          <EventsPanel webhookId={id} onSample={(d) => apply(d, true)} onSimulate={(eventId) => void simulate(eventId)} />
        </aside>
      </div>

      {modal === 'paste' && (
        <Modal title="Colar um exemplo de evento" icon="file" width={620} onClose={() => setModal(null)} footer={<>
          <button type="button" className="btn" onClick={() => setModal(null)}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!paste.trim()} data-testid="wh-paste-save" onClick={async () => {
            try { apply(await api.put<WebhookDetail>(`/webhooks/${id}/sample`, { payload: paste }), true); setModal(null); toast('Exemplo salvo'); }
            catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
          }}>Usar este exemplo</button>
        </>}>
          <textarea className="input mono" rows={14} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'{\n  "nome": "Maria",\n  "telefone": "11999998888"\n}'} data-testid="wh-paste" />
          <small className="faint">Cole o corpo (JSON) que a plataforma manda. Ele serve só para escolher os campos — nada é executado.</small>
        </Modal>
      )}
      {modal === 'rotate' && (
        <ConfirmModal title="Gerar nova URL" confirm="Gerar nova URL" onClose={() => setModal(null)} onConfirm={async () => {
          try { apply(await api.post<WebhookDetail>(`/webhooks/${id}/rotate`), true); setModal(null); toast('URL nova gerada — atualize nas plataformas'); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>A URL atual para de funcionar na hora. Use se ela vazou ou para trocar de plataforma — e cole a nova onde a antiga estava.</ConfirmModal>
      )}
      {modal === 'run' && (
        <ConfirmModal title="Executar com o exemplo" confirm="Executar" onClose={() => setModal(null)} onConfirm={async () => {
          try {
            const r = await api.post<{ event: { status: string; summary: string | null } }>(`/webhooks/${id}/run-sample`);
            setModal(null); toast(r.event.summary ?? 'Executado');
          } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>O exemplo passa pelo webhook como se a plataforma tivesse mandado agora: cria ou atualiza o contato do exemplo e executa as ações (inclusive mandar o modelo de mensagem). Conta no consumo do mês.</ConfirmModal>
      )}
      {modal === 'delete' && (
        <ConfirmModal title="Excluir webhook" confirm="Excluir webhook" danger onClose={() => setModal(null)} onConfirm={async () => {
          try { await api.del(`/webhooks/${id}`); toast(`Webhook “${w.name}” excluído`); nav('/webhooks'); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>Excluir <b>{w.name}</b>? A URL para de funcionar na hora e o histórico de eventos é apagado. Os contatos e vendas que ele criou continuam.</ConfirmModal>
      )}
      {modal === 'leave' && (
        <ConfirmModal title="Sair sem salvar?" confirm="Sair sem salvar" danger onClose={() => setModal(null)} onConfirm={() => nav('/webhooks')}>
          As alterações deste webhook ainda não foram salvas.
        </ConfirmModal>
      )}
    </div>
  );
}

function MapRow({ label, value, onChange, leaves, required, testId, hint, extra }: {
  label: string; value: string | undefined; onChange: (v: string | undefined) => void; leaves: WebhookDetail['leaves'];
  required?: boolean; testId?: string; hint?: string; extra?: ReactNode;
}) {
  return (
    <div className="wh-map-row">
      <span className="wh-map-lbl"><span>{label}{required && <b className="req">*</b>}</span>{hint && <small>{hint}</small>}</span>
      <PathPicker value={value} onChange={onChange} leaves={leaves} testId={testId} />
      {extra}
    </div>
  );
}
