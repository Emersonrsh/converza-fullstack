import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, Switch, TopbarActions, cx, toast } from '../components/ui';
import { SubscriptionAlert } from '../components/SubscriptionAlert';
import { ConfirmModal } from '../kanban/modals';
import { EVENT_STATUS, type EventStatus, type Usage, type WebhookSummary } from '../webhooks/types';
import { ago, pct } from '../webhooks/util';

const ACTION_LABEL: Record<string, string> = { etiquetas: 'Etiquetas', Kanban: 'Kanban', venda: 'Venda', modelo: 'Mensagem', fluxo: 'Fluxo' };

/** Consumo do mês (eventos processados / limite: 10.000 por instância contratada). */
export function UsageMeter({ usage }: { usage: Usage }) {
  const p = usage.limit ? Math.min(100, (usage.used / usage.limit) * 100) : 100;
  const tone = !usage.limit ? 'red' : p >= 100 ? 'red' : p >= 80 ? 'amber' : '';
  return (
    <div className={cx('card wh-usage', tone)} data-testid="wh-usage" title="Eventos processados neste mês. Os que passarem do limite ficam guardados para reprocessar.">
      <Icon name="inbox" size={16} />
      <div>
        <span><b>Consumo: {usage.used.toLocaleString('pt-BR')}</b> / {usage.limit.toLocaleString('pt-BR')}</span>
        <div className="wh-usage-bar"><i style={{ width: `${p}%` }} /></div>
      </div>
      <small>{pct(usage.used, usage.limit)}</small>
    </div>
  );
}

function CopyUrl({ url }: { url: string }) {
  return (
    <div className="wh-url" onClick={(e) => e.stopPropagation()}>
      <code title={url}>{url}</code>
      <button type="button" className="btn icon sm ghost" aria-label="Copiar URL" data-testid="wh-copy"
        onClick={() => { void navigator.clipboard?.writeText(url); toast('URL copiada'); }}><Icon name="copy" size={14} /></button>
    </div>
  );
}

export function Webhooks() {
  const nav = useNavigate();
  const { accountId } = useAuth();
  const [data, setData] = useState<{ webhooks: WebhookSummary[]; usage: Usage; canEdit: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [del, setDel] = useState<WebhookSummary | null>(null);

  const load = useCallback(() => api.get<{ webhooks: WebhookSummary[]; usage: Usage; canEdit: boolean }>('/webhooks')
    .then((r) => { setData(r); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);

  // tempo real: evento chegando atualiza "último evento" e o consumo
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 600); };
    sock.on('webhook:event', on);
    return () => { sock.off('webhook:event', on); if (t) clearTimeout(t); };
  }, [load]);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  const list = data?.webhooks ?? [];
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? list.filter((w) => w.name.toLowerCase().includes(t)) : list;
  }, [list, q]);

  async function toggle(w: WebhookSummary) {
    try {
      await api.put(`/webhooks/${w.id}`, { enabled: !w.enabled });
      setData((d) => d && { ...d, webhooks: d.webhooks.map((x) => (x.id === w.id ? { ...x, enabled: !w.enabled } : x)) });
      toast(w.enabled ? `“${w.name}” pausado: os eventos ficam registrados, sem ações` : `“${w.name}” ativo`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }
  async function duplicate(w: WebhookSummary) {
    setMenu(null);
    try { const r = await api.post<{ webhook: WebhookSummary }>(`/webhooks/${w.id}/duplicate`); toast('Cópia criada (pausada, com outra URL)'); nav(`/webhooks/${r.webhook.id}`); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }

  if (err && !data) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar os webhooks</b><span>{err}</span><button type="button" className="btn" onClick={() => void load()}>Tentar de novo</button></div>;
  if (!data) return <Spinner />;
  const canEdit = data.canEdit;

  return (
    <div className="fade wh-page" data-testid="webhooks-page">
      {canEdit && (
        <TopbarActions>
          <button type="button" className="btn primary" onClick={() => nav('/webhooks/novo')} data-testid="new-webhook"><Icon name="plus" size={16} />Novo webhook</button>
        </TopbarActions>
      )}
      {canEdit && <SubscriptionAlert status={data.usage.active ? 'active' : 'inactive'} />}
      {data.usage.active && data.usage.limit > 0 && data.usage.used >= data.usage.limit && (
        <div className="hint bad" data-testid="wh-quota-full"><Icon name="alert" size={14} />
          <span>O limite de {data.usage.limit.toLocaleString('pt-BR')} eventos deste mês acabou. Os novos eventos ficam guardados sem executar as ações — faça upgrade e use “Reprocessar” em cada webhook.</span>
        </div>
      )}

      <div className="wh-bar">
        <div className="fl-search ct-search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="Buscar webhook pelo nome..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar webhook" data-testid="wh-search" />
        </div>
        <span className="spacer" />
        <UsageMeter usage={data.usage} />
      </div>

      {list.length === 0 ? (
        <div className="wh-empty" data-testid="webhooks-empty">
          <Icon name="webhook" size={36} />
          <b>Nenhum webhook cadastrado</b>
          <span>Crie o primeiro webhook para começar.</span>
          {canEdit ? <button type="button" className="btn primary" onClick={() => nav('/webhooks/novo')} data-testid="create-first-webhook"><Icon name="plus" size={15} />Criar webhook</button>
            : <small className="faint">Peça para o dono ou um administrador criar.</small>}
        </div>
      ) : shown.length === 0 ? (
        <div className="wh-empty" data-testid="webhooks-none">
          <Icon name="search" size={30} />
          <b>Nenhum webhook com esse nome</b>
          <button type="button" className="btn" onClick={() => setQ('')}>Limpar busca</button>
        </div>
      ) : (
        <div className="wh-grid">
          {shown.map((w) => {
            const st = w.lastStatus ? EVENT_STATUS[w.lastStatus as EventStatus] : null;
            const missingPhone = w.hits > 0 && !w.setup.hasPhone;
            return (
              <div key={w.id} className={cx('card wh-card', !w.enabled && 'off')} data-testid="wh-card">
                <div className="wh-card-top">
                  <span className="wh-ic"><Icon name="webhook" size={18} /></span>
                  <div className="wh-card-who">
                    {canEdit ? <Link to={`/webhooks/${w.id}`}><b>{w.name}</b></Link> : <b>{w.name}</b>}
                    <span>
                      <span className={cx('pill dot', w.enabled ? 'green' : '')} data-testid="wh-status">{w.enabled ? 'Ativo' : 'Pausado'}</span>
                      {w.platform && <span className="pill teal" data-testid="wh-platform">{w.platform}</span>}
                    </span>
                  </div>
                  {canEdit && <Switch on={w.enabled} onClick={() => void toggle(w)} />}
                </div>
                {w.url && <CopyUrl url={w.url} />}
                <div className="ag-chips">
                  <span className="ag-chip" title="Conexão de WhatsApp"><Icon name="phone" size={12} />{w.connectionName ?? 'Sem conexão'}</span>
                  {w.setup.conditions > 0 && <span className="ag-chip"><Icon name="filter" size={12} />{w.setup.conditions} {w.setup.conditions === 1 ? 'condição' : 'condições'}</span>}
                  {w.setup.actions.length ? w.setup.actions.map((a) => <span key={a} className="ag-chip">{ACTION_LABEL[a] ?? a}</span>)
                    : <span className="ag-chip">Só cria/atualiza o contato</span>}
                </div>
                {missingPhone && <div className="hint warn"><Icon name="info" size={14} />Falta escolher de onde vem o telefone do lead.</div>}
                <div className="ag-card-foot">
                  <small className="faint" data-testid="wh-last">
                    {w.hits ? <>{w.hits.toLocaleString('pt-BR')} recebido{w.hits === 1 ? '' : 's'} · último {ago(w.lastEventAt)}</> : 'Aguardando o primeiro evento'}
                  </small>
                  {st && <span className={cx('pill', st[1])}>{st[0]}</span>}
                  <span className="spacer" />
                  {canEdit && <button type="button" className="btn sm" onClick={() => nav(`/webhooks/${w.id}`)} data-testid="wh-open"><Icon name="gear" size={14} />Configurar</button>}
                  {canEdit && (
                    <div className="menu-wrap">
                      <button type="button" className="btn icon sm ghost" onClick={() => setMenu(menu === w.id ? null : w.id)} aria-label={`Ações de ${w.name}`} data-testid="wh-menu"><Icon name="dots" size={15} /></button>
                      {menu === w.id && (
                        <div className="menu fade">
                          <button type="button" onClick={() => void duplicate(w)}><Icon name="copy" size={15} />Duplicar</button>
                          <div className="sep" />
                          <button type="button" className="danger" onClick={() => { setMenu(null); setDel(w); }} data-testid="wh-delete"><Icon name="trash" size={15} />Excluir</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {del && (
        <ConfirmModal title="Excluir webhook" confirm="Excluir webhook" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/webhooks/${del.id}`); toast(`Webhook “${del.name}” excluído`); setDel(null); void load(); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>
          Excluir <b>{del.name}</b>? A URL para de funcionar na hora e o histórico de eventos é apagado. Os contatos e vendas que ele criou continuam.
        </ConfirmModal>
      )}
    </div>
  );
}
