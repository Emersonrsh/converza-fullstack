import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, TopbarActions, cx, toast } from '../components/ui';
import { SubscriptionAlert } from '../components/SubscriptionAlert';
import { ConfirmModal } from '../kanban/modals';
import { CAMPAIGN_STATUS, pl, type Campaign, type DispatchList } from '../dispatch/types';
import { DispatchPackModal } from '../billing/modals';
import { QuotaPanel } from '../dispatch/QuotaPanel';

const fmt = (n: number) => n.toLocaleString('pt-BR');
const fdate = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });


export function CampaignCard({ c, canEdit, onAction }: { c: Campaign; canEdit: boolean; onAction: (a: 'pause' | 'resume' | 'cancel', c: Campaign) => void }) {
  const [label, tone] = CAMPAIGN_STATUS[c.status] ?? [c.status, ''];
  const p = c.totalCount ? Math.min(100, (c.processed / c.totalCount) * 100) : 0;
  const live = ['sending', 'scheduled', 'paused'].includes(c.status);
  return (
    <div className={cx('card ds-card', c.status)} data-testid="ds-card">
      <div className="ds-card-top">
        <span className="ds-ic"><Icon name="send" size={17} /></span>
        <Link to={`/dispatch/${c.id}`} className="ds-card-who">
          <b>{c.name}</b>
          <span>{c.flowName ? `Fluxo: ${c.flowName}` : c.legacyMessage ? 'Mensagem de texto (antigo)' : 'Sem fluxo'}{c.connectionName ? ` · ${c.connectionName}` : ''}</span>
        </Link>
        <span className={cx('pill dot', tone)} data-testid="ds-status">{label}</span>
      </div>
      {c.status === 'paused' && c.pauseText && <div className="hint warn" data-testid="ds-pause"><Icon name="pause" size={14} /><span>{c.pauseText}</span></div>}
      <div className="ds-progress">
        <div className="progress"><i style={{ width: `${p}%` }} /></div>
        <small data-testid="ds-progress">{fmt(c.processed)} de {fmt(c.totalCount)} {pl(c.totalCount, 'contato', 'contatos')}</small>
      </div>
      <div className="ag-chips">
        <span className="ag-chip" title="Falaram nas últimas 24h e receberam o fluxo na hora"><Icon name="flow" size={12} />{fmt(c.started)} fluxo na hora</span>
        <span className="ag-chip" title="Receberam o modelo; o fluxo começa quando responderem"><Icon name="chat" size={12} />{fmt(c.templates)} {pl(c.templates, 'modelo', 'modelos')}</span>
        {c.failed > 0 && <span className="ag-chip warn"><Icon name="alert" size={12} />{fmt(c.failed)} falha{c.failed === 1 ? '' : 's'}</span>}
        {c.skipped > 0 && <span className="ag-chip">{fmt(c.skipped)} de fora</span>}
      </div>
      <div className="ag-card-foot">
        <small className="faint">{c.status === 'scheduled' && c.scheduledAt ? `Agendado para ${fdate(c.scheduledAt)}` : c.finishedAt ? `${c.status === 'canceled' ? 'Cancelado' : c.status === 'failed' ? 'Falhou' : 'Terminou'} ${fdate(c.finishedAt)}` : `Criado ${fdate(c.createdAt)}`}</small>
        <span className="spacer" />
        {canEdit && (c.status === 'sending' || c.status === 'scheduled') && <button type="button" className="btn sm ghost" onClick={() => onAction('pause', c)} data-testid="ds-pause-btn"><Icon name="pause" size={13} />Pausar</button>}
        {canEdit && c.status === 'paused' && c.pauseReason !== 'flow_deleted' && <button type="button" className="btn sm" onClick={() => onAction('resume', c)} data-testid="ds-resume-btn"><Icon name="play" size={13} />Continuar</button>}
        {canEdit && live && <button type="button" className="btn sm ghost danger" onClick={() => onAction('cancel', c)} data-testid="ds-cancel-btn">Cancelar</button>}
        <Link to={`/dispatch/${c.id}`} className="btn sm" data-testid="ds-open">Detalhes</Link>
      </div>
    </div>
  );
}

export function useCampaignActions(onDone: (c: Campaign) => void) {
  const [cancel, setCancel] = useState<Campaign | null>(null);
  const act = async (a: 'pause' | 'resume' | 'cancel', c: Campaign) => {
    if (a === 'cancel') { setCancel(c); return; }
    try {
      const r = await api.post<{ campaign: Campaign }>(`/dispatch/${c.id}/${a}`);
      onDone(r.campaign); toast(a === 'pause' ? 'Disparo pausado' : 'Disparo retomado');
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  };
  const modal = cancel && (
    <ConfirmModal title="Cancelar disparo" confirm="Cancelar disparo" danger onClose={() => setCancel(null)} onConfirm={async () => {
      try { const r = await api.post<{ campaign: Campaign }>(`/dispatch/${cancel.id}/cancel`); onDone(r.campaign); toast('Disparo cancelado'); setCancel(null); }
      catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    }}>
      Cancelar <b>{cancel.name}</b>? Quem ainda está na fila não recebe. O que já foi enviado não volta para a cota.
    </ConfirmModal>
  );
  return { act, modal };
}

export function Dispatch() {
  const nav = useNavigate();
  const { accountId } = useAuth();
  const [data, setData] = useState<DispatchList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [buy, setBuy] = useState<{ pack: DispatchList['packs'][number]; gateway: 'asaas' | 'paddle' } | null>(null);
  const load = useCallback(() => api.get<DispatchList>('/dispatch').then((r) => { setData(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);
  const upsert = useCallback((c: Campaign) => setData((d) => d && { ...d, campaigns: d.campaigns.some((x) => x.id === c.id) ? d.campaigns.map((x) => (x.id === c.id ? { ...x, ...c } : x)) : [c, ...d.campaigns] }), []);
  const { act, modal } = useCampaignActions((c) => { upsert(c); void load(); });

  // tempo real: progresso dos disparos e a cota mudando
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (p: { campaign: Campaign }) => {
      if (p?.campaign) upsert(p.campaign);
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 1500);
    };
    sock.on('campaign:progress', on);
    return () => { sock.off('campaign:progress', on); if (t) clearTimeout(t); };
  }, [load, upsert]);

  if (err && !data) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar os disparos</b><span>{err}</span><button type="button" className="btn" onClick={() => void load()}>Tentar de novo</button></div>;
  if (!data) return <Spinner />;
  const q = data.quota;
  const blocked = !q.active || q.remaining <= 0;
  const why = !q.active ? 'Assine para fazer disparos em massa' : q.remaining <= 0 ? `Os disparos do ciclo acabaram — a cota renova em ${new Date(q.cycleEnd).toLocaleDateString('pt-BR')}` : undefined;
  const newBtn = (testId: string) => (
    <button type="button" className="btn primary" disabled={blocked} title={why} onClick={() => nav('/dispatch/novo')} data-testid={testId}>
      <Icon name="plus" size={16} />Novo disparo em massa
    </button>
  );

  return (
    <div className="fade ds-page" data-testid="dispatch-page">
      {data.canEdit && <TopbarActions>{newBtn('new-dispatch')}</TopbarActions>}
      {data.canEdit && <SubscriptionAlert status={q.active ? 'active' : 'inactive'} />}

      <QuotaPanel data={data} onBuy={setBuy} />

      {data.campaigns.length === 0 ? (
        <div className="wh-empty" data-testid="dispatch-empty">
          <Icon name="send" size={36} />
          <b>Nenhum disparo em massa ainda</b>
          <span>Crie o primeiro disparo em massa para enviar um fluxo a muitos contatos de uma vez.</span>
          {data.canEdit ? newBtn('create-first-dispatch') : <small className="faint">Peça para o dono ou um administrador criar.</small>}
          {data.canEdit && blocked && <small className="faint">{why}.</small>}
        </div>
      ) : (
        <div className="ds-grid">
          {data.campaigns.map((c) => <CampaignCard key={c.id} c={c} canEdit={data.canEdit} onAction={act} />)}
        </div>
      )}
      {modal}
      {buy && <DispatchPackModal pack={buy.pack} gateway={buy.gateway} hasTaxId={data.purchase.hasTaxId} onClose={() => { setBuy(null); void load(); }} />}
    </div>
  );
}
