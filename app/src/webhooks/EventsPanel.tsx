import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { JsonView } from './JsonView';
import { EVENT_STATUS, type WebhookDetail, type WebhookEvent } from './types';
import { ago, when } from './util';

const resultIcon = (r: { ok: boolean; warn?: boolean }) => (!r.ok ? 'alert' : r.warn ? 'info' : 'check');

export function EventsPanel({ webhookId, onSample, onSimulate }: {
  webhookId: string; onSample: (d: WebhookDetail) => void; onSimulate: (eventId: string) => void;
}) {
  const [events, setEvents] = useState<WebhookEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<'' | 'failed'>('');
  const [open, setOpen] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WebhookEvent | null>(null);

  const load = useCallback(async (before?: string) => {
    const qs = new URLSearchParams({ limit: '30', ...(filter ? { status: filter } : {}), ...(before ? { before } : {}) });
    const r = await api.get<{ events: WebhookEvent[]; hasMore: boolean }>(`/webhooks/${webhookId}/events?${qs}`);
    setEvents((cur) => (before ? [...(cur ?? []), ...r.events] : r.events));
    setHasMore(r.hasMore);
  }, [webhookId, filter]);
  useEffect(() => { setEvents(null); void load().catch((e) => { toast(e instanceof Error ? e.message : 'Erro'); setEvents([]); }); }, [load]);

  // tempo real: evento novo entra no topo; o mesmo evento processado é atualizado
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = (p: { webhookId: string; event: WebhookEvent }) => {
      if (p.webhookId !== webhookId) return;
      const bad = ['error', 'partial', 'blocked'].includes(p.event.status);
      setEvents((cur) => {
        if (!cur) return cur;
        const i = cur.findIndex((x) => x.id === p.event.id);
        if (i >= 0) return cur.map((x) => (x.id === p.event.id ? { ...x, ...p.event } : x));
        if (filter === 'failed' && !bad) return cur;
        return [p.event, ...cur];
      });
    };
    sock.on('webhook:event', on);
    return () => { sock.off('webhook:event', on); };
  }, [webhookId, filter]);

  async function expand(e: WebhookEvent) {
    if (open === e.id) { setOpen(null); return; }
    setOpen(e.id);
    if (!payloads[e.id]) {
      try {
        const r = await api.get<{ event: WebhookEvent }>(`/webhooks/${webhookId}/events/${e.id}`);
        setPayloads((p) => ({ ...p, [e.id]: r.event.payload ?? {} }));
      } catch (err) { toast(err instanceof Error ? err.message : 'Erro'); }
    }
  }
  async function reprocess(e: WebhookEvent) {
    setBusy(e.id);
    try {
      const r = await api.post<{ event: WebhookEvent }>(`/webhooks/${webhookId}/events/${e.id}/reprocess`);
      setEvents((cur) => cur?.map((x) => (x.id === e.id ? { ...x, ...r.event } : x)) ?? cur);
      toast(`Reprocessado: ${EVENT_STATUS[r.event.status]?.[0] ?? r.event.status}`);
    } catch (err) { toast(err instanceof Error ? err.message : 'Erro'); }
    setBusy(null);
  }
  async function useSample(e: WebhookEvent) {
    try { onSample(await api.post<WebhookDetail>(`/webhooks/${webhookId}/events/${e.id}/sample`)); toast('Este evento agora é o exemplo do mapeamento'); }
    catch (err) { toast(err instanceof Error ? err.message : 'Erro'); }
  }

  return (
    <section className="card wh-events" data-testid="wh-events">
      <header>
        <Icon name="history" size={15} /><b>Eventos recebidos</b>
        <span className="spacer" />
        <div className="seg">
          <button type="button" className={cx(!filter && 'active')} onClick={() => setFilter('')}>Todos</button>
          <button type="button" className={cx(filter === 'failed' && 'active')} onClick={() => setFilter('failed')} data-testid="wh-ev-failed">Com problema</button>
        </div>
      </header>
      {!events ? <div style={{ height: 80 }}><Spinner /></div> : events.length === 0 ? (
        <div className="wh-ev-empty" data-testid="wh-ev-empty"><span className="wh-live" />{filter ? 'Nenhum evento com problema.' : 'Aguardando eventos… eles aparecem aqui na hora.'}</div>
      ) : (
        <div className="wh-ev-list">
          {events.map((e) => {
            const st = EVENT_STATUS[e.status] ?? [e.status, ''];
            const isOpen = open === e.id;
            return (
              <div key={e.id} className={cx('wh-ev', isOpen && 'open')} data-testid="wh-event">
                <button type="button" className="wh-ev-row" onClick={() => void expand(e)}>
                  <span className={cx('pill', st[1])} data-testid="wh-ev-status">{st[0]}</span>
                  <span className="wh-ev-sum">{e.summary ?? (e.status === 'queued' ? 'Processando…' : '—')}</span>
                  <small title={when(e.createdAt)}>{ago(e.createdAt)}</small>
                  <Icon name={isOpen ? 'chevronUp' : 'chevron'} size={13} />
                </button>
                {isOpen && (
                  <div className="wh-ev-body">
                    {e.results.length > 0 && (
                      <ul className="wh-results" data-testid="wh-ev-results">
                        {e.results.map((r, i) => <li key={i} className={cx(!r.ok && 'bad', r.warn && 'warn')}><Icon name={resultIcon(r)} size={13} />{r.text}</li>)}
                      </ul>
                    )}
                    <small className="faint">Recebido em {when(e.createdAt)}{e.processedAt ? ` · processado em ${when(e.processedAt)}` : ''}</small>
                    {payloads[e.id] ? <JsonView value={payloads[e.id]} /> : <Spinner />}
                    <div className="wh-ev-act">
                      <button type="button" className="btn sm" disabled={busy === e.id} onClick={() => (['processed', 'partial'].includes(e.status) ? setConfirm(e) : void reprocess(e))} data-testid="wh-ev-reprocess">
                        <Icon name="refresh" size={13} />{busy === e.id ? 'Processando…' : 'Reprocessar'}
                      </button>
                      <button type="button" className="btn sm" onClick={() => onSimulate(e.id)} data-testid="wh-ev-simulate"><Icon name="play" size={13} />Simular</button>
                      <button type="button" className="btn sm ghost" onClick={() => void useSample(e)} data-testid="wh-ev-sample"><Icon name="bookmark" size={13} />Usar como exemplo</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && <button type="button" className="btn sm ghost wh-more" onClick={() => void load(events[events.length - 1]?.createdAt)}>Carregar mais</button>}
        </div>
      )}
      {confirm && (
        <ConfirmModal title="Reprocessar evento" confirm="Reprocessar" onClose={() => setConfirm(null)} onConfirm={async () => { const e = confirm; setConfirm(null); await reprocess(e); }}>
          As ações vão rodar de novo com a configuração atual — inclusive mandar o modelo de mensagem e disparar o fluxo outra vez. Continuar?
        </ConfirmModal>
      )}
    </section>
  );
}
