import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, toast } from '../components/ui';
import {
  Badge, CopyField, EmptyBox, Head, Kebab, LoadError, SearchBox, StatTile, copyText, errMsg, fmtDate, relTime, useDebounced, useLoad, useSocketEvent,
} from './common';

interface InviteRow {
  id: string; email: string; status: 'pending' | 'accepted' | 'declined' | 'expired' | 'canceled'; expiresAt: string; lastSentAt: string;
  respondedAt: string | null; createdAt: string; invitedByName: string | null; accountName: string; link: string;
}
interface Resp { invites: InviteRow[]; stats: { total: number; pending: number; accepted: number; declined: number; expired: number }; canEdit: boolean; emailConfigured: boolean }

export const INVITE_STATUS: Record<string, [string, string]> = {
  pending: ['Pendente', 'amber'], accepted: ['Aceito', 'green'], declined: ['Recusado', 'red'], expired: ['Expirado', ''], canceled: ['Cancelado', ''],
};

function NewInviteModal({ emailConfigured, onClose, onDone }: { emailConfigured: boolean; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  async function send() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ emailSent: boolean; link: string }>('/platform-invites', { email: email.trim() });
      onDone();
      if (r.emailSent) { toast(`Convite enviado para ${email.trim()}`); onClose(); } else setLink(r.link);
    } catch (e) { toast(errMsg(e, 'Não foi possível convidar')); }
    setBusy(false);
  }
  return (
    <Modal title={link ? 'Convite criado' : 'Convidar para a plataforma'} icon="mail" onClose={onClose} footer={link
      ? <button type="button" className="btn primary" onClick={onClose}>Pronto</button>
      : <><button type="button" className="btn" onClick={onClose}>Cancelar</button><button type="button" className="btn primary" disabled={!valid || busy} onClick={send} data-testid="pinvite-send">{busy ? 'Enviando…' : 'Enviar convite'}</button></>}>
      {link ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="hint"><Icon name="info" size={14} />{emailConfigured ? 'O e-mail não pôde ser enviado agora.' : 'O envio de e-mails não está configurado neste servidor.'} Copie o link e mande para a pessoa (vale 14 dias).</div>
          <CopyField value={link} testId="pinvite-link" />
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <Field label="E-mail"><input className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@empresa.com" onKeyDown={(e) => e.key === 'Enter' && send()} data-testid="pinvite-email" /></Field>
          <div className="hint"><Icon name="info" size={14} />A pessoa recebe um link para criar a conta dela no Converza, com a própria empresa e a própria assinatura. A conta fica registrada como indicação sua. Para colocar alguém na <b>sua</b> equipe, use Equipe › Convidar membro.</div>
        </div>
      )}
    </Modal>
  );
}

export function InvitesPage() {
  const { accountId } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const dq = useDebounced(q);
  const { data, error, reload } = useLoad(() => api.get<Resp>(`/platform-invites?status=${status}${dq.trim() ? `&q=${encodeURIComponent(dq.trim())}` : ''}`), [accountId, status, dq]);
  useSocketEvent('invites:changed', () => void reload());
  const [creating, setCreating] = useState(false);

  async function act(i: InviteRow, what: 'resend' | 'cancel') {
    try {
      if (what === 'cancel') { await api.del(`/platform-invites/${i.id}`); toast('Convite cancelado'); }
      else {
        const r = await api.post<{ emailSent: boolean; link: string }>(`/platform-invites/${i.id}/resend`);
        if (r.emailSent) toast('Convite reenviado'); else await copyText(r.link, 'E-mail indisponível — link do convite copiado');
      }
      void reload();
    } catch (e) { toast(errMsg(e)); }
  }

  const head = <Head slug="convites" actions={data?.canEdit && <button type="button" className="btn primary" onClick={() => setCreating(true)} data-testid="new-pinvite"><Icon name="plus" size={15} />Convidar</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const s = data.stats;
  return (
    <div data-testid="invites-page">
      {head}
      <div className="st-stats">
        <StatTile icon="mail" value={s.total} label="Total" testId="pi-total" />
        <StatTile icon="clock" tone="amber" value={s.pending} label="Pendentes" testId="pi-pending" />
        <StatTile icon="check" tone="green" value={s.accepted} label="Aceitos" testId="pi-accepted" />
        <StatTile icon="close" tone="red" value={s.declined} label="Recusados" />
        <StatTile icon="timer" tone="gray" value={s.expired} label="Expirados" />
      </div>
      <div className="st-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Buscar por e-mail" testId="pi-search" />
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" data-testid="pi-status">
          <option value="all">Todos os status</option>
          <option value="pending">Pendentes</option>
          <option value="accepted">Aceitos</option>
          <option value="declined">Recusados</option>
          <option value="expired">Expirados</option>
          <option value="canceled">Cancelados</option>
        </select>
      </div>
      {data.invites.length === 0 ? (
        <div className="st-card"><EmptyBox icon="mail" title={q || status !== 'all' ? 'Nenhum convite com esses filtros' : 'Nenhum convite enviado'} text="Convide alguém para criar uma conta no Converza: a pessoa recebe um link e a conta dela fica registrada como indicação da sua empresa."
          action={data.canEdit && !q && status === 'all' && <button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Convidar</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>E-mail</th><th>Status</th><th>Convidado por</th><th>Enviado</th><th>Vence / respondeu</th><th className="acts" /></tr></thead>
            <tbody>
              {data.invites.map((i) => {
                const [label, tone] = INVITE_STATUS[i.status] ?? [i.status, ''];
                return (
                  <tr key={i.id} data-testid="pi-row">
                    <td><b>{i.email}</b></td>
                    <td><Badge tone={tone}>{label}</Badge></td>
                    <td className="muted">{i.invitedByName ?? '—'}</td>
                    <td className="muted">{relTime(i.lastSentAt)}</td>
                    <td className="muted">{i.status === 'pending' ? fmtDate(i.expiresAt) : fmtDate(i.respondedAt ?? i.expiresAt)}</td>
                    <td className="acts">{data.canEdit && i.status === 'pending' && <Kebab items={[
                      { label: 'Copiar link', icon: 'copy', onClick: () => void copyText(i.link, 'Link do convite copiado') },
                      { label: 'Reenviar', icon: 'send', onClick: () => void act(i, 'resend') },
                      { label: 'Cancelar convite', icon: 'close', danger: true, onClick: () => void act(i, 'cancel') },
                    ]} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewInviteModal emailConfigured={data.emailConfigured} onClose={() => setCreating(false)} onDone={() => void reload()} />}
    </div>
  );
}
