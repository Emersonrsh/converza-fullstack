import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Spinner, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { Badge, EmptyBox, Head, LoadError, errMsg, fmtDateTime, relTime, useLoad, useSocketEvent } from './common';

interface Access {
  id: string; status: 'active' | 'expired' | 'revoked'; reason: string; expiresAt: string; createdAt: string; revokedAt: string | null;
  lastUsedAt: string | null; lastUsedBy: string | null; grantedByName: string | null;
}
interface Resp { active: Access[]; history: Access[]; supportConfigured: boolean; canEdit: boolean; isSupport: boolean }

const DURATIONS: [number, string][] = [[24, '24 horas'], [72, '3 dias'], [168, '7 dias']];

export function SupportPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/support-access'), [accountId]);
  useSocketEvent('support:changed', () => void reload());
  const [hours, setHours] = useState(24);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Access | null>(null);

  if (error && !data) return <><Head slug="suporte" /><LoadError error={error} onRetry={reload} /></>;
  if (!data) return <><Head slug="suporte" /><Spinner /></>;
  const active = data.active[0];

  async function grant() {
    setBusy(true);
    try {
      await api.post('/support-access', { hours, reason: reason.trim() || undefined });
      toast('Acesso do suporte liberado');
      setReason('');
      void reload();
    } catch (e) { toast(errMsg(e, 'Não foi possível liberar')); }
    setBusy(false);
  }

  return (
    <div data-testid="support-page">
      <Head slug="suporte" />
      {data.isSupport && <div className="st-banner amber"><Icon name="headset" size={16} /><span>Você está nesta empresa como <b>suporte do Converza</b>. O acesso termina sozinho no prazo ou quando a empresa revogar.</span></div>}
      {!data.supportConfigured && <div className="st-banner"><Icon name="info" size={16} /><span>A equipe de suporte ainda não foi definida neste servidor (variável <b>SUPPORT_EMAILS</b>). Sem ela, não há para quem liberar o acesso.</span></div>}

      <section className="st-card">
        <div className="st-card-h">
          <span className={active ? 'st-stat-ic green' : 'st-stat-ic gray'}><Icon name="shield" size={18} /></span>
          <div><b>{active ? 'Acesso liberado' : 'Acesso fechado'}</b><small>{active ? `O suporte pode entrar até ${fmtDateTime(active.expiresAt)} (${relTime(active.expiresAt)})` : 'A equipe do Converza não consegue ver nada da sua conta.'}</small></div>
          <span className="spacer" />
          {active && data.canEdit && <button type="button" className="btn danger" onClick={() => setRevoking(active)} data-testid="support-revoke">Revogar agora</button>}
        </div>
        {active && (
          <div className="stack" style={{ gap: 6, fontSize: 13 }} data-testid="support-active">
            {active.reason && <div><span className="muted">Motivo:</span> {active.reason}</div>}
            <div><span className="muted">Liberado por:</span> {active.grantedByName ?? '—'} em {fmtDateTime(active.createdAt)}</div>
            <div><span className="muted">Último uso:</span> {active.lastUsedAt ? `${fmtDateTime(active.lastUsedAt)}${active.lastUsedBy ? ` (${active.lastUsedBy})` : ''}` : 'ainda não entrou'}</div>
          </div>
        )}
        {!active && data.canEdit && data.supportConfigured && (
          <div className="st-form" style={{ marginTop: 4 }}>
            <Field label="Por quanto tempo">
              <select className="select" value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="support-hours">
                {DURATIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
              </select>
            </Field>
            <Field label="Motivo (opcional)"><input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: ajuda para configurar o fluxo de vendas" data-testid="support-reason" /></Field>
            <div className="full row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn primary" disabled={busy} onClick={grant} data-testid="support-grant"><Icon name="shield" size={15} />{busy ? 'Liberando…' : 'Liberar acesso'}</button>
            </div>
          </div>
        )}
      </section>

      <section className="st-card">
        <div className="st-card-h"><b>O que o suporte pode fazer</b></div>
        <div className="st-grid2" style={{ gap: 10 }}>
          <div className="hint"><Icon name="check" size={14} />Ver e configurar a conta como um administrador: fluxos, agentes, conexões, contatos e conversas.</div>
          <div className="hint"><Icon name="close" size={14} />Não paga nada, não exclui a empresa, não libera o próprio acesso nem cria chaves de API. Quando e com qual e-mail ele entrou pela última vez aparece aqui.</div>
        </div>
      </section>

      <div className="st-section-t"><Icon name="history" size={15} />Histórico</div>
      {data.history.length === 0 ? (
        <div className="st-card" style={{ padding: 0 }}><EmptyBox icon="history" title="Nenhum acesso anterior" text="Quando um acesso terminar (no prazo ou revogado), ele aparece aqui." /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Liberado em</th><th>Por</th><th>Motivo</th><th>Terminou</th><th>Status</th></tr></thead>
            <tbody>
              {data.history.map((a) => (
                <tr key={a.id} data-testid="support-history">
                  <td className="muted">{fmtDateTime(a.createdAt)}</td>
                  <td>{a.grantedByName ?? '—'}</td>
                  <td className="muted">{a.reason || '—'}</td>
                  <td className="muted">{fmtDateTime(a.revokedAt ?? a.expiresAt)}</td>
                  <td><Badge tone={a.status === 'revoked' ? 'red' : ''}>{a.status === 'revoked' ? 'Revogado' : 'Expirou'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoking && (
        <ConfirmModal title="Revogar acesso do suporte" confirm="Revogar" danger onClose={() => setRevoking(null)} onConfirm={async () => {
          try { await api.del(`/support-access/${revoking.id}`); toast('Acesso revogado'); setRevoking(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>
          O suporte perde o acesso na hora. Você pode liberar de novo quando quiser.
        </ConfirmModal>
      )}
    </div>
  );
}
