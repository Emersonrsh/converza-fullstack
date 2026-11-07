import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { DispatchEditor } from './DispatchEditor';
import { useCampaignActions } from '../pages/Dispatch';
import { CAMPAIGN_STATUS, REC_STATUS, pl, type Campaign, type CampaignStats, type Recipient } from './types';

const fmt = (n: number) => n.toLocaleString('pt-BR');
const fdate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const MSG_STATUS: Record<string, string> = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'não entregue' };
const TABS: [string, string][] = [['', 'Todos'], ['queued', 'Na fila'], ['started', 'Fluxo na hora'], ['sent', 'Modelo enviado'], ['replied', 'Responderam'], ['failed', 'Falharam'], ['undelivered', 'Não entregues'], ['skipped', 'De fora']];

export function DispatchRoute() {
  const { id = 'novo' } = useParams();
  return id === 'novo' ? <DispatchEditor /> : <CampaignView id={id} />;
}

function CampaignView({ id }: { id: string }) {
  const nav = useNavigate();
  const { accountId } = useAuth();
  const [c, setC] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState('');
  const [page, setPage] = useState(1);
  const [recs, setRecs] = useState<{ recipients: Recipient[]; total: number; pages: number } | null>(null);
  const [del, setDel] = useState(false);

  const load = useCallback(() => api.get<{ campaign: Campaign; stats: CampaignStats; canEdit: boolean }>(`/dispatch/${id}`)
    .then((r) => { setC(r.campaign); setStats(r.stats); setCanEdit(r.canEdit); }).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), [id]);
  const loadRecs = useCallback(() => api.get<{ recipients: Recipient[]; total: number; pages: number }>(`/dispatch/${id}/recipients?${new URLSearchParams({ ...(tab ? { status: tab } : {}), page: String(page) })}`)
    .then(setRecs).catch(() => {}), [id, tab, page]);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => { void loadRecs(); }, [loadRecs]);
  const { act, modal } = useCampaignActions((x) => { setC((cur) => (cur ? { ...cur, ...x } : x)); void load(); });

  // tempo real: contadores andam enquanto envia
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (p: { campaignId: string; campaign: Campaign }) => {
      if (p.campaignId !== id) return;
      setC((cur) => (cur ? { ...cur, ...p.campaign } : cur));
      if (t) clearTimeout(t);
      t = setTimeout(() => { void load(); void loadRecs(); }, 900);
    };
    sock.on('campaign:progress', on);
    // entregue/lido/respondeu chegam pelas mensagens
    const onMsg = () => { if (t) clearTimeout(t); t = setTimeout(() => { void load(); void loadRecs(); }, 1500); };
    sock.on('message:status', onMsg);
    sock.on('message:new', onMsg);
    return () => { sock.off('campaign:progress', on); sock.off('message:status', onMsg); sock.off('message:new', onMsg); if (t) clearTimeout(t); };
  }, [id, load, loadRecs]);

  if (err) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível abrir</b><span>{err}</span><Link className="btn" to="/dispatch">Voltar para disparos</Link></div>;
  if (!c || !stats) return <Spinner />;
  const [label, tone] = CAMPAIGN_STATUS[c.status] ?? [c.status, ''];
  const p = c.totalCount ? Math.min(100, (c.processed / c.totalCount) * 100) : 0;
  const live = ['sending', 'scheduled', 'paused'].includes(c.status);
  const cards: [string, number, string, string][] = [
    ['Fluxo iniciado', stats.flowStarted, 'flow', 'Na hora (falaram nas últimas 24h) ou depois de responder o modelo'],
    ['Modelos enviados', stats.templatesSent, 'chat', 'Modelos aceitos pela Meta'],
    ['Entregues', stats.delivered, 'check', 'Modelos entregues no celular'],
    ['Lidos', stats.read, 'checkCircle', 'Abriram a mensagem'],
    ['Responderam', stats.replied, 'reply', 'Mandaram mensagem depois do disparo'],
    ['Falharam', stats.failed, 'alert', 'A Meta recusou ou não entregou'],
    ['Ficaram de fora', stats.skipped, 'close', 'Pediram para sair, já estavam no fluxo, sem modelo fora da janela ou cancelados'],
  ];

  return (
    <div className="fade wh-editor ds-view" data-testid="campaign-view">
      <nav className="wh-crumbs"><Link to="/dispatch">Disparos em massa</Link><Icon name="chevronRight" size={13} /><b>{c.name}</b></nav>
      <div className="card ag-ed-head">
        <button type="button" className="btn icon ghost" onClick={() => nav('/dispatch')} aria-label="Voltar"><Icon name="arrowLeft" size={17} /></button>
        <span className="ds-ic"><Icon name="send" size={17} /></span>
        <div className="ag-ed-who"><b>{c.name}</b><small>{c.flowName ? `Fluxo ${c.flowName}` : 'Sem fluxo'}{c.connectionName ? ` · ${c.connectionName}` : ''}{c.template ? ` · modelo ${c.template.name}` : ' · sem modelo'}</small></div>
        <span className="spacer" />
        <span className={cx('pill dot', tone)} data-testid="cv-status">{label}</span>
        {canEdit && (c.status === 'sending' || c.status === 'scheduled') && <button type="button" className="btn sm" onClick={() => void act('pause', c)} data-testid="cv-pause"><Icon name="pause" size={13} />Pausar</button>}
        {canEdit && c.status === 'paused' && c.pauseReason !== 'flow_deleted' && <button type="button" className="btn sm primary" onClick={() => void act('resume', c)} data-testid="cv-resume"><Icon name="play" size={13} />Continuar</button>}
        {canEdit && live && <button type="button" className="btn sm ghost danger" onClick={() => void act('cancel', c)} data-testid="cv-cancel">Cancelar</button>}
        {canEdit && <button type="button" className="btn sm ghost" onClick={() => nav(`/dispatch/novo?de=${c.id}`)} data-testid="cv-duplicate"><Icon name="copy" size={13} />Duplicar</button>}
        {canEdit && !live && <button type="button" className="btn sm ghost danger" onClick={() => setDel(true)} aria-label="Excluir disparo" data-testid="cv-delete"><Icon name="trash" size={14} /></button>}
      </div>

      {c.status === 'paused' && c.pauseText && (
        <div className="hint warn" data-testid="cv-pause-text"><Icon name="pause" size={14} /><span style={{ flex: 1 }}>{c.pauseText}</span>
          {c.pauseReason === 'connection' && <Link className="linkbtn" to="/connections">Abrir Conexões</Link>}
          {c.pauseReason === 'flow' && c.flowId && <Link className="linkbtn" to={`/flows/${c.flowId}`}>Abrir o fluxo</Link>}
          {c.pauseReason === 'plan' && <Link className="linkbtn" to="/billing">Abrir Cobranças e assinaturas</Link>}
        </div>
      )}
      {c.legacyMessage && <div className="hint"><Icon name="info" size={14} />Disparo antigo (mensagem de texto): {c.legacyMessage}</div>}

      <section className="card ds-bar">
        <div className="ds-bar-top">
          <b data-testid="cv-progress">{fmt(c.processed)} de {fmt(c.totalCount)} {pl(c.totalCount, 'contato', 'contatos')}</b>
          <small className="faint">{stats.queued ? `${fmt(stats.queued)} na fila · ` : ''}{c.speed}/min · {c.status === 'scheduled' ? `começa ${fdate(c.scheduledAt)}` : `começou ${fdate(c.startedAt)}`}{c.finishedAt ? ` · terminou ${fdate(c.finishedAt)}` : ''}</small>
          <span className="spacer" />
          <small className="faint" title="Disparos debitados (cota do ciclo + saldo extra)">{fmt(c.charged)} disparo{c.charged === 1 ? '' : 's'} usado{c.charged === 1 ? '' : 's'}{c.chargedExtra ? ` (${fmt(c.chargedExtra)} do saldo extra)` : ''}</small>
        </div>
        <div className="progress big"><i style={{ width: `${p}%` }} /></div>
      </section>

      <div className="ds-kpis">
        {cards.map(([l, n, ic, help]) => (
          <div key={l} className="card ds-kpi" title={help} data-testid="cv-kpi"><Icon name={ic} size={15} /><b>{fmt(n)}</b><span>{l}</span></div>
        ))}
      </div>

      <section className="card ds-recs" data-testid="cv-recipients">
        <header>
          <b>Contatos do disparo</b>
          <span className="spacer" />
          <div className="ds-tabs">
            {TABS.map(([v, l]) => <button type="button" key={v} className={cx(tab === v && 'on')} onClick={() => { setTab(v); setPage(1); }} data-testid={`cv-tab-${v || 'all'}`}>{l}</button>)}
          </div>
        </header>
        {!recs ? <div style={{ height: 120 }}><Spinner /></div> : recs.recipients.length === 0 ? (
          <div className="wh-ev-empty">{c.status === 'scheduled' ? 'A lista de contatos é montada na hora em que o disparo começa.' : 'Nenhum contato aqui.'}</div>
        ) : (
          <table className="ds-table">
            <thead><tr><th>Contato</th><th>Situação</th><th>Detalhe</th><th>Quando</th><th /></tr></thead>
            <tbody>
              {recs.recipients.map((r) => {
                const [sl, st] = REC_STATUS[r.status] ?? [r.status, ''];
                return (
                  <tr key={r.id} data-testid="cv-rec">
                    <td><b>{r.name}</b><small>{r.phone}</small></td>
                    <td>
                      <span className={cx('pill', st)}>{sl}</span>
                      {r.messageStatus && r.status === 'sent' && <small className={cx('ds-msg', r.messageStatus)}>{MSG_STATUS[r.messageStatus] ?? r.messageStatus}</small>}
                      {r.replied && <small className="ds-replied">respondeu</small>}
                    </td>
                    <td className="ds-err">{r.error ?? (r.charge === 'extra' ? 'Saldo extra' : '')}</td>
                    <td className="faint">{fdate(r.processedAt)}</td>
                    <td>{r.conversationId && <Link className="btn sm ghost" to={`/inbox?c=${r.conversationId}`}>Conversa</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {recs && recs.pages > 1 && (
          <div className="ct-foot">
            <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>Anterior</button>
            <span className="ct-page-n">Página {page} de {recs.pages}</span>
            <button type="button" className="btn sm" disabled={page >= recs.pages} onClick={() => setPage((x) => x + 1)}>Próxima</button>
          </div>
        )}
      </section>
      {modal}
      {del && (
        <ConfirmModal title="Excluir disparo" confirm="Excluir" danger onClose={() => setDel(false)} onConfirm={async () => {
          try { await api.del(`/dispatch/${c.id}`); toast('Disparo excluído'); nav('/dispatch'); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>Excluir <b>{c.name}</b> e a lista de contatos dele? As conversas e mensagens enviadas continuam no Chats ao vivo.</ConfirmModal>
      )}
    </div>
  );
}
