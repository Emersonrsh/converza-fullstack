import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Modal, Spinner, cx, toast } from '../components/ui';
import { useTags } from '../components/TagPicker';
import { FiltersPanel } from '../contacts/FiltersPanel';
import { EMPTY_FILTERS, ORIGINS, STATUS_OPTIONS } from '../contacts/util';
import type { ContactField, ContactFiltersState } from '../contacts/types';
import type { KBoardSummary } from '../kanban/types';
import { TemplateActionField } from '../webhooks/TemplateAction';
import type { TemplateAction } from '../webhooks/types';
import { CONTACT_TOKENS, pl, type AudiencePreview, type DispatchQuota, type SavedFilters } from './types';

interface ConnOpt { id: string; name: string; displayPhone: string | null; wabaId: string | null; status: string; messagingLimit: string | null; labels?: { limit: string | null }; provider?: 'cloud' | 'web'; webState?: string | null }
/** QR Code: limite de segurança e intervalo entre contatos (vêm do servidor) */
interface WebPacing { dailyLimit: number; usedLast24h: number; minGapSec: number; maxGapSec: number }
interface FlowOpt { id: string; name: string; status: string; archivedAt: string | null }

const SPEEDS: [number, string][] = [[10, '10 por minuto (bem devagar)'], [30, '30 por minuto (recomendado)'], [60, '60 por minuto'], [120, '120 por minuto'], [300, '300 por minuto (rápido)']];
const TIER_CAP: Record<string, number> = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000 };
const fmt = (n: number) => n.toLocaleString('pt-BR');

function Section({ n, title, desc, children, testId }: { n: number; title: string; desc?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="card ag-sec" data-testid={testId}>
      <header><span className="ag-sec-ic ds-n">{n}</span><div><b>{title}</b>{desc && <small>{desc}</small>}</div></header>
      <div className="ag-sec-body">{children}</div>
    </section>
  );
}

/** Filtros salvos ↔ estado da tela de Contatos. */
const toState = (f: SavedFilters | undefined): ContactFiltersState => ({ ...EMPTY_FILTERS, ...(f ?? {}) } as ContactFiltersState);
function toSaved(f: ContactFiltersState): SavedFilters {
  const out: SavedFilters = {};
  for (const [k, v] of Object.entries(f)) if (Array.isArray(v) ? v.length : v) (out as Record<string, unknown>)[k] = v;
  return out;
}
const durationText = (n: number, speed: number) => {
  const min = Math.ceil(n / Math.max(1, speed));
  return min < 60 ? `≈ ${min} min` : `≈ ${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim();
};

export function DispatchEditor() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const fromId = params.get('de');
  const { accountId } = useAuth();
  const tags = useTags();
  const [conns, setConns] = useState<ConnOpt[] | null>(null);
  const [flows, setFlows] = useState<FlowOpt[]>([]);
  const [fields, setFields] = useState<ContactField[]>([]);
  const [boards, setBoards] = useState<KBoardSummary[]>([]);
  const [name, setName] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [flowId, setFlowId] = useState('');
  const [filters, setFilters] = useState<ContactFiltersState>(EMPTY_FILTERS);
  const [showPanel, setShowPanel] = useState(false);
  const [excludeRecent, setExcludeRecent] = useState<number | null>(null);
  const [template, setTemplate] = useState<TemplateAction | null>(null);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [speed, setSpeed] = useState(30);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [webPacing, setWebPacing] = useState<WebPacing | null>(null);
  const [quota, setQuota] = useState<DispatchQuota | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ connections: ConnOpt[] }>('/connections').then((r) => { setConns(r.connections); if (r.connections.length === 1) setConnectionId((c) => c || r.connections[0].id); }).catch(() => setConns([]));
    api.get<{ flows: FlowOpt[] }>('/flows').then((r) => setFlows(r.flows.filter((f) => !f.archivedAt))).catch(() => {});
    api.get<{ fields: ContactField[] }>('/contacts/fields').then((r) => setFields(r.fields)).catch(() => {});
    api.get<{ boards: KBoardSummary[] }>('/kanban/boards').then((r) => setBoards(r.boards)).catch(() => {});
  }, [accountId]);
  // "Duplicar": vem com o público, o fluxo e o modelo do disparo escolhido
  useEffect(() => {
    if (!fromId) return;
    api.post<{ draft: { name: string; connectionId: string | null; flowId: string | null; template: TemplateAction | null; audience: { filters: SavedFilters; excludeRecentDays: number | null }; speed: number } }>(`/dispatch/${fromId}/duplicate`)
      .then(({ draft }) => {
        setName(draft.name); setConnectionId(draft.connectionId ?? ''); setFlowId(draft.flowId ?? ''); setTemplate(draft.template);
        setFilters(toState(draft.audience.filters)); setExcludeRecent(draft.audience.excludeRecentDays); setSpeed(draft.speed);
      }).catch((e) => toast(e instanceof Error ? e.message : 'Erro'));
  }, [fromId]);

  const audience = useMemo(() => ({ filters: toSaved(filters), excludeRecentDays: excludeRecent }), [filters, excludeRecent]);
  // prévia do público (com um respiro para não consultar a cada letra)
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<{ preview: AudiencePreview; quota: DispatchQuota; web?: WebPacing | null }>('/dispatch/preview', { audience, connectionId: connectionId || undefined })
        .then((r) => { setPreview(r.preview); setQuota(r.quota); setWebPacing(r.web ?? null); }).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [audience, connectionId]);

  const conn = conns?.find((c) => c.id === connectionId) ?? null;
  const isWeb = conn?.provider === 'web';
  const activeFlows = flows.filter((f) => f.status === 'active');
  const total = preview?.total ?? 0;
  const willSend = template && !isWeb ? total : preview?.windowOpen ?? 0;
  const cap = conn?.messagingLimit ? TIER_CAP[conn.messagingLimit] : undefined;
  const missing = !name.trim() ? 'Dê um nome ao disparo' : !connectionId ? 'Escolha a conexão' : !flowId ? 'Escolha o fluxo'
    : !total ? 'Nenhum contato no público' : !isWeb && !template && !preview?.windowOpen ? 'Escolha um modelo de mensagem (ninguém do público falou com você nas últimas 24h)'
      : when === 'later' && (!at || new Date(at).getTime() < Date.now() + 60_000) ? 'Escolha uma data e hora no futuro' : null;
  // QR Code: o ritmo é o de segurança (intervalo aleatório e limite por dia), não a velocidade escolhida
  const webLeft = webPacing ? Math.max(0, webPacing.dailyLimit - webPacing.usedLast24h) : 0;
  const webTime = (n: number) => {
    if (!webPacing || !n) return '';
    const perDay = webPacing.dailyLimit;
    const avg = (webPacing.minGapSec + webPacing.maxGapSec) / 2;
    const today = Math.min(n, webLeft);
    const mins = Math.ceil((today * avg) / 60);
    const days = n > webLeft ? Math.ceil((n - webLeft) / perDay) : 0;
    return `${mins < 60 ? `≈ ${mins} min` : `≈ ${Math.floor(mins / 60)} h ${mins % 60} min`} para os primeiros ${fmt(today)}${days ? `; o resto vai em mais ${days} dia${days > 1 ? 's' : ''} (até ${fmt(perDay)} por dia)` : ''}`;
  };

  async function create() {
    setBusy(true);
    try {
      const r = await api.post<{ campaign: { id: string } }>('/dispatch', {
        name, connectionId, flowId, template: isWeb ? null : template, audience, speed, scheduledAt: when === 'later' && at ? new Date(at).toISOString() : null,
      });
      toast(when === 'later' ? 'Disparo agendado' : 'Disparo iniciado');
      nav(`/dispatch/${r.campaign.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não foi possível criar');
      if (e instanceof ApiError && e.data?.code) setConfirm(false);
    }
    setBusy(false);
  }

  if (!conns) return <Spinner />;

  return (
    <div className="fade wh-editor ds-editor" data-testid="dispatch-new">
      <nav className="wh-crumbs"><Link to="/dispatch">Disparos em massa</Link><Icon name="chevronRight" size={13} /><b>Novo</b></nav>
      <div className="wh-head"><Icon name="send" size={22} /><div><h2>Novo disparo em massa</h2><small>Envie um fluxo para muitos contatos de uma vez</small></div></div>

      <div className="ag-ed-body">
        <div className="ag-ed-form">
          <Section n={1} title="Disparo" desc="O que vai e por qual número" testId="ds-sec-what">
            <div><label className="label">Nome do disparo</label><input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Black Friday — clientes" data-testid="ds-name" /></div>
            <div className="ag-two">
              <div>
                <label className="label">Conexão (número de envio)</label>
                <select className="select" value={connectionId} onChange={(e) => { setConnectionId(e.target.value); setTemplate(null); }} data-testid="ds-conn">
                  <option value="">Escolha…</option>
                  {conns.map((c) => <option key={c.id} value={c.id} disabled={c.status === 'disconnected'}>{c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}{c.status === 'disconnected' ? ' — desconectada' : ''}</option>)}
                </select>
                {conn?.labels?.limit && <small className="faint">Limite da Meta: {conn.labels.limit}</small>}
                {isWeb && <small className="faint" data-testid="ds-web-note">QR Code (API não oficial): sem modelo e sem janela de 24h, com ritmo de segurança.</small>}
              </div>
              <div>
                <label className="label">Fluxo</label>
                <select className="select" value={flowId} onChange={(e) => setFlowId(e.target.value)} data-testid="ds-flow">
                  <option value="">Escolha…</option>
                  {activeFlows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
                {!activeFlows.length && <small className="faint">Nenhum fluxo ativo. Crie e ative um em Fluxos.</small>}
              </div>
            </div>
            <small className="faint">Cada contato entra no fluxo a partir do primeiro bloco depois do gatilho. No fluxo, {'{{disparo}}'} é o nome deste disparo.</small>
          </Section>

          <Section n={2} title="Quem recebe" desc="Os mesmos filtros da tela de Contatos" testId="ds-sec-who">
            <div className="ct-bar">
              <select className={cx('select', filters.status && 'on')} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as ContactFiltersState['status'] }))} data-testid="ds-status-filter">
                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{v ? l : 'Todos os contatos'}</option>)}
              </select>
              <select className={cx('select', filters.origin && 'on')} value={filters.origin} onChange={(e) => setFilters((f) => ({ ...f, origin: e.target.value as ContactFiltersState['origin'] }))} data-testid="ds-origin-filter">
                <option value="">Todas as origens</option>
                {ORIGINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <button type="button" className={cx('btn', showPanel && 'on')} onClick={() => setShowPanel((x) => !x)} data-testid="ds-more-filters"><Icon name="filter" size={15} />Etiquetas, Kanban e mais</button>
            </div>
            {showPanel && <FiltersPanel value={filters} fields={fields} tags={tags} boards={boards} onApply={(p) => { setFilters((f) => ({ ...f, ...p })); setShowPanel(false); }} />}
            <div className="ds-chosen" data-testid="ds-chosen">
              {filters.tags.map((t) => <span key={t} className="pill teal">#{t}</span>)}
              {filters.stages.length > 0 && <span className="pill">{filters.stages.length} etapa(s) do funil</span>}
              {filters.columns.length > 0 && <span className="pill">{filters.columns.length} etapa(s) do Kanban</span>}
              {(filters.from || filters.to) && <span className="pill">criados {filters.from ? `de ${filters.from}` : ''} {filters.to ? `até ${filters.to}` : ''}</span>}
              {filters.field && <span className="pill">{fields.find((x) => x.key === filters.field)?.label ?? filters.field}{filters.fieldValue ? `: ${filters.fieldValue}` : ' preenchido'}</span>}
            </div>
            <label className="wh-check"><input type="checkbox" checked={excludeRecent !== null} onChange={(e) => setExcludeRecent(e.target.checked ? 7 : null)} data-testid="ds-exclude-recent" />
              Não mandar para quem recebeu disparo nos últimos
              <input className="input sm ds-days" type="number" min={1} max={365} disabled={excludeRecent === null} value={excludeRecent ?? 7}
                onChange={(e) => setExcludeRecent(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} /> dias
            </label>
            <div className="ds-preview" data-testid="ds-preview">
              <div className="ds-preview-n"><b data-testid="ds-total">{fmt(total)}</b><span>contato{total === 1 ? '' : 's'}</span></div>
              <ul>
                {isWeb ? (
                  <li><Icon name="flow" size={13} /><span><b>{fmt(preview?.windowOpen ?? 0)}</b> {pl(preview?.windowOpen ?? 0, 'recebe o fluxo direto pelo QR Code', 'recebem o fluxo direto pelo QR Code')}</span></li>
                ) : <>
                <li><Icon name="flow" size={13} /><span><b>{fmt(preview?.windowOpen ?? 0)}</b> {pl(preview?.windowOpen ?? 0, 'falou com você nas últimas 24h → recebe o fluxo na hora', 'falaram com você nas últimas 24h → recebem o fluxo na hora')}</span></li>
                <li className={cx(!template && (preview?.needTemplate ?? 0) > 0 && 'warn')}><Icon name="chat" size={13} />
                  <span><b>{fmt(preview?.needTemplate ?? 0)}</b> {(() => { const one = (preview?.needTemplate ?? 0) === 1; return template ? (one ? 'recebe o modelo de mensagem; o fluxo começa quando responder' : 'recebem o modelo de mensagem; o fluxo começa quando responderem') : (one ? 'precisa de um modelo de mensagem — sem modelo, fica de fora' : 'precisam de um modelo de mensagem — sem modelo, ficam de fora'); })()}</span></li>
                </>}
                {(preview?.optedOut ?? 0) > 0 && <li><Icon name="close" size={13} /><span><b>{fmt(preview!.optedOut)}</b> {pl(preview!.optedOut, 'pediu para sair (fica de fora)', 'pediram para sair (ficam de fora)')}</span></li>}
                {(preview?.recentExcluded ?? 0) > 0 && <li><Icon name="history" size={13} /><span><b>{fmt(preview!.recentExcluded)}</b> {pl(preview!.recentExcluded, 'recebeu', 'receberam')} disparo nos últimos {excludeRecent} dias ({pl(preview!.recentExcluded, 'fica', 'ficam')} de fora)</span></li>}
              </ul>
            </div>
          </Section>

          {isWeb ? (
            <Section n={3} title="Mensagem de abertura" desc="Pelo QR Code, o fluxo começa direto para todos" testId="ds-sec-template">
              <div className="hint warn" data-testid="ds-web-risk"><Icon name="alert" size={14} />
                <span>Disparo pela API não oficial: o WhatsApp pode banir o número se muita gente denunciar ou bloquear. Mande só para quem já é seu cliente ou pediu para receber, e escreva o começo do fluxo como uma conversa (sem cara de propaganda).</span>
              </div>
              <small className="faint">Não existem modelos da Meta no QR Code. Quem responder “SAIR” não recebe mais disparos.</small>
            </Section>
          ) : (
            <Section n={3} title="Mensagem de abertura" desc="Modelo aprovado para quem não falou com você nas últimas 24h" testId="ds-sec-template">
              <TemplateActionField connectionId={connectionId || null} hasWaba={!!conn?.wabaId} value={template} onChange={setTemplate} leaves={[]}
                vars={fields.map((f) => `campos.${f.key}`)} specials={CONTACT_TOKENS} noneLabel="Sem modelo (só quem falou nas últimas 24h)"
                noConnText="Escolha a conexão (no passo 1) para ver os modelos aprovados." />
              <small className="faint">A Meta só deixa mandar texto livre para quem falou com você nas últimas 24h. Para os outros, vai o modelo — e o fluxo começa quando a pessoa responder. Quem responder “SAIR” não recebe mais disparos.</small>
            </Section>
          )}

          <Section n={4} title="Quando e velocidade" testId="ds-sec-when">
            <div className="wh-radio">
              <label><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} />Começar agora</label>
              <label><input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} data-testid="ds-later" />Agendar</label>
            </div>
            {when === 'later' && <input className="input ds-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} data-testid="ds-at" />}
            {isWeb && webPacing ? (
              <div className="ds-web-pace" data-testid="ds-web-pace">
                <label className="label">Ritmo de segurança (QR Code)</label>
                <span>Um contato a cada <b>{webPacing.minGapSec}–{webPacing.maxGapSec} s</b> (aleatório) e no máximo <b>{fmt(webPacing.dailyLimit)}</b> por dia neste número{webPacing.usedLast24h ? ` — ${fmt(webPacing.usedLast24h)} já usados nas últimas 24h` : ''}.</span>
                {willSend > 0 && <small className="faint">{webTime(willSend)}. Ao bater o limite, o disparo pausa e continua sozinho.</small>}
              </div>
            ) : (
              <div>
                <label className="label">Velocidade</label>
                <select className="select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="ds-speed">
                  {SPEEDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {willSend > 0 && <small className="faint">{durationText(willSend, speed)} para {fmt(willSend)} contatos. Mais devagar protege a qualidade do número.</small>}
              </div>
            )}
            {cap && template && (preview?.needTemplate ?? 0) > cap && (
              <div className="hint warn"><Icon name="info" size={14} />O limite da Meta deste número é {fmt(cap)} contatos novos a cada 24h: quando chegar nele, o disparo pausa e continua sozinho quando liberar.</div>
            )}
          </Section>
        </div>

        <aside className="ag-ed-side">
          <section className="card ds-summary" data-testid="ds-summary">
            <b>Resumo</b>
            <div className="ds-sum-row"><span>Contatos</span><b>{fmt(total)}</b></div>
            <div className="ds-sum-row"><span>Usa até</span><b data-testid="ds-will-use">{fmt(willSend)} disparo{willSend === 1 ? '' : 's'}</b></div>
            <div className="ds-sum-row"><span>Você tem</span><b>{fmt(quota?.remaining ?? 0)} {pl(quota?.remaining ?? 0, 'restante', 'restantes')}</b></div>
            {quota && willSend > quota.remaining && <div className="hint warn" data-testid="ds-short"><Icon name="alert" size={14} />Faltam {fmt(willSend - quota.remaining)}: o disparo pausa quando a cota acabar e continua depois que você comprar disparos extras.</div>}
            <small className="faint">{isWeb ? 'Só conta quem recebe de verdade (fluxo iniciado). Pelo QR Code a Meta não cobra nada — mas o número corre risco de banimento.' : 'Só conta quem recebe de verdade (fluxo iniciado ou modelo aceito pela Meta). A Meta cobra cada modelo enviado direto na conta do WhatsApp Business.'}</small>
            {missing && <small className="ds-missing" data-testid="ds-missing">{missing}</small>}
            <button type="button" className="btn primary" disabled={!!missing} onClick={() => setConfirm(true)} data-testid="ds-create"><Icon name="send" size={15} />{when === 'later' ? 'Agendar disparo' : 'Criar disparo'}</button>
          </section>
        </aside>
      </div>

      {confirm && (
        <Modal title={when === 'later' ? 'Agendar disparo' : 'Começar o disparo?'} icon="send" width={480} onClose={() => setConfirm(false)} footer={<>
          <button type="button" className="btn" onClick={() => setConfirm(false)}>Voltar</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void create()} data-testid="ds-confirm">{busy ? 'Criando…' : when === 'later' ? 'Agendar' : 'Começar agora'}</button>
        </>}>
          <div className="ds-confirm" data-testid="ds-confirm-text">
            <p><b>{fmt(total)}</b> {pl(total, 'contato', 'contatos')} · fluxo <b>{flows.find((f) => f.id === flowId)?.name}</b> · por <b>{conn?.name}</b>.</p>
            <p>{fmt(preview?.windowOpen ?? 0)} {pl(preview?.windowOpen ?? 0, 'recebe', 'recebem')} o fluxo na hora{template ? `; ${fmt(preview?.needTemplate ?? 0)} ${pl(preview?.needTemplate ?? 0, 'recebe', 'recebem')} o modelo “${template.name}”` : ''}.</p>
            {when === 'later' && at && <p>Começa em {new Date(at).toLocaleString('pt-BR')}.</p>}
            <p className="faint">Você pode pausar ou cancelar a qualquer momento. O que já foi enviado não volta para a cota.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
