import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Avatar, Field, Modal, Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import {
  Badge, ColorPill, CopyField, EmptyBox, Head, Kebab, LoadError, SearchBox, copyText, errMsg, relTime, useLoad, useSocketEvent,
} from './common';

export interface TeamMemberRow {
  membershipId: string; role: 'owner' | 'admin' | 'agent'; roleLabel: string; userId: string; name: string; email: string;
  departmentId: string | null; departmentName: string | null; departmentColor: string | null; createdAt: string; isMe: boolean;
}
export interface TeamInviteRow {
  id: string; email: string; role: 'admin' | 'agent'; roleLabel: string; departmentId: string | null; status: string;
  expiresAt: string; lastSentAt: string; createdAt: string; invitedByName: string | null; link: string;
}
export interface Dept { id: string; name: string; color: string }
export interface TeamResp { members: TeamMemberRow[]; invites: TeamInviteRow[]; departments: Dept[]; canManage: boolean; emailConfigured: boolean }

export const ROLE_TONE: Record<string, string> = { owner: 'teal', admin: 'blue', agent: '' };

/** Convidar alguém (que já tem conta) para a equipe. Usado em Equipe e em Empresa. */
export function InviteMemberModal({ departments, isOwner, emailConfigured, onClose, onDone }: {
  departments: Dept[]; isOwner: boolean; emailConfigured: boolean; onClose: () => void; onDone: () => void;
}) {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'agent' | 'admin'>('agent');
  const [dept, setDept] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  async function send() {
    if (!valid || busy) return;
    setBusy(true); setNotRegistered(false);
    try {
      const r = await api.post<{ emailSent: boolean; emailError: string | null; link: string }>('/team/invites', { email: email.trim(), role, departmentId: dept || null });
      onDone();
      if (r.emailSent) { toast(`Convite enviado para ${email.trim()}`); onClose(); }
      else setLink(r.link);
    } catch (e) {
      if (e instanceof ApiError && e.data.code === 'not_registered') setNotRegistered(true);
      else toast(errMsg(e, 'Não foi possível convidar'));
    }
    setBusy(false);
  }

  async function platformInvite() {
    setBusy(true);
    try {
      const r = await api.post<{ emailSent: boolean; link: string }>('/platform-invites', { email: email.trim() });
      if (r.emailSent) toast('Convite para criar a conta enviado por e-mail');
      else { await copyText(r.link, 'Link do convite copiado — mande para a pessoa'); }
      onClose();
      nav('/settings/convites');
    } catch (e) { toast(errMsg(e)); }
    setBusy(false);
  }

  if (link) {
    return (
      <Modal title="Convite criado" icon="mail" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Pronto</button>}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="hint"><Icon name="info" size={14} />{emailConfigured ? 'O e-mail não pôde ser enviado agora.' : 'O envio de e-mails não está configurado neste servidor.'} Copie o link e mande para a pessoa (vale 14 dias).</div>
          <CopyField value={link} testId="invite-link" />
          <small className="faint">Ela abre o link, entra com o e-mail <b>{email.trim()}</b> e aceita. Até lá, o convite aparece em “Convites pendentes”.</small>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Convidar membro" subtitle="A pessoa entra na equipe quando aceitar o convite" icon="users" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!valid || busy} onClick={send} data-testid="invite-send">{busy ? 'Enviando…' : 'Enviar convite'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="E-mail">
          <input className="input" type="email" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setNotRegistered(false); }} placeholder="pessoa@empresa.com" onKeyDown={(e) => e.key === 'Enter' && send()} data-testid="invite-email" />
        </Field>
        <div className="hint"><Icon name="info" size={14} />A pessoa precisa já ter uma conta no Converza com esse e-mail. Ela recebe o convite {emailConfigured ? 'por e-mail' : '(o link aparece aqui para você mandar)'} e passa a fazer parte da equipe quando aceitar.</div>
        {notRegistered && (
          <div className="st-banner amber" data-testid="not-registered">
            <Icon name="alert" size={16} /><span>Esse e-mail ainda não tem conta no Converza.</span>
            <button type="button" className="btn sm" disabled={busy} onClick={platformInvite}>Convidar para criar conta</button>
          </div>
        )}
        <Field label="Perfil">
          <div className="st-checks" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label className={cx('st-check', role === 'agent' && 'on')}>
              <input type="radio" name="role" checked={role === 'agent'} onChange={() => setRole('agent')} />
              <div><b>Membro</b><small>Acesso básico: atende conversas, contatos e Kanban.</small></div>
            </label>
            <label className={cx('st-check', role === 'admin' && 'on')} title={isOwner ? undefined : 'Só o proprietário convida administradores'} style={isOwner ? undefined : { opacity: 0.55, cursor: 'not-allowed' }}>
              <input type="radio" name="role" disabled={!isOwner} checked={role === 'admin'} onChange={() => setRole('admin')} data-testid="invite-admin" />
              <div><b>Administrador</b><small>Gerencia recursos: fluxos, conexões, equipe e configurações.</small></div>
            </label>
          </div>
        </Field>
        {departments.length > 0 && (
          <Field label="Setor (opcional)">
            <select className="select" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="invite-dept">
              <option value="">Sem setor</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function DeptModal({ member, departments, onClose, onSaved }: { member: TeamMemberRow; departments: Dept[]; onClose: () => void; onSaved: () => void }) {
  const [dept, setDept] = useState(member.departmentId ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Setor de ${member.name.split(' ')[0]}`} onClose={onClose} width={420} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy} data-testid="dept-save" onClick={async () => {
        setBusy(true);
        try { await api.patch(`/team/${member.membershipId}`, { departmentId: dept || null }); toast('Setor atualizado'); onSaved(); onClose(); }
        catch (e) { toast(errMsg(e)); }
        setBusy(false);
      }}>Salvar</button>
    </>}>
      <Field label="Setor">
        <select className="select" value={dept} onChange={(e) => setDept(e.target.value)} data-testid="dept-select">
          <option value="">Sem setor</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <div className="st-help">Conversas mandadas para um setor ficam em “Aguardando” só para quem é do setor (e para quem não tem setor nenhum ninguém fica de fora: o dono e os administradores veem tudo).</div>
    </Modal>
  );
}

export function TeamPage() {
  const { accounts, accountId, user } = useAuth();
  const myRole = accounts.find((a) => a.id === accountId)?.role;
  const isOwner = myRole === 'owner';
  const { data, error, reload } = useLoad(() => api.get<TeamResp>('/team'), [accountId]);
  useSocketEvent(['team:changed', 'departments:changed'], () => void reload());
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [dept, setDept] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editDept, setEditDept] = useState<TeamMemberRow | null>(null);
  const [removing, setRemoving] = useState<TeamMemberRow | null>(null);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.members ?? []).filter((m) =>
      (!term || m.name.toLowerCase().includes(term) || m.email.toLowerCase().includes(term))
      && (!role || m.role === role)
      && (!dept || (dept === 'none' ? !m.departmentId : m.departmentId === dept)));
  }, [data, q, role, dept]);

  if (error && !data) return <><Head slug="equipe" /><LoadError error={error} onRetry={reload} /></>;
  if (!data) return <><Head slug="equipe" /><Spinner /></>;

  async function changeRole(m: TeamMemberRow) {
    const to = m.role === 'admin' ? 'agent' : 'admin';
    try { await api.patch(`/team/${m.membershipId}`, { role: to }); toast(`${m.name.split(' ')[0]} agora é ${to === 'admin' ? 'administrador' : 'membro'}`); void reload(); }
    catch (e) { toast(errMsg(e)); }
  }
  async function inviteAct(i: TeamInviteRow, what: 'resend' | 'cancel') {
    try {
      if (what === 'cancel') { await api.del(`/team/invites/${i.id}`); toast('Convite cancelado'); }
      else {
        const r = await api.post<{ emailSent: boolean; link: string }>(`/team/invites/${i.id}/resend`);
        if (r.emailSent) toast('Convite reenviado'); else await copyText(r.link, 'E-mail indisponível — link do convite copiado');
      }
      void reload();
    } catch (e) { toast(errMsg(e)); }
  }

  const deptOf = (id: string | null) => data.departments.find((d) => d.id === id);

  return (
    <div data-testid="team-page">
      <Head slug="equipe" actions={data.canManage && <button type="button" className="btn primary" onClick={() => setInviting(true)} data-testid="invite-member"><Icon name="plus" size={15} />Convidar membro</button>} />
      <div className="st-toolbar">
        <b style={{ fontSize: 14 }} data-testid="team-count">{data.members.length} {data.members.length === 1 ? 'membro' : 'membros'}</b>
        <SearchBox value={q} onChange={setQ} placeholder="Buscar por nome ou e-mail" testId="team-search" />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Função" data-testid="team-role-filter">
          <option value="">Todas as funções</option>
          <option value="owner">Proprietário</option>
          <option value="admin">Administrador</option>
          <option value="agent">Membro</option>
        </select>
        {data.departments.length > 0 && (
          <select className="select" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Setor" data-testid="team-dept-filter">
            <option value="">Todos os setores</option>
            <option value="none">Sem setor</option>
            {data.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>

      <div className="st-tbl">
        <table>
          <thead><tr><th>Membro</th><th>Função</th><th>Setor</th><th>Na equipe desde</th><th className="acts">Ações</th></tr></thead>
          <tbody>
            {list.map((m) => {
              const d = deptOf(m.departmentId);
              const canTouch = data.canManage && m.role !== 'owner' && !m.isMe;
              return (
                <tr key={m.membershipId} data-testid="member-row">
                  <td><div className="st-who"><Avatar name={m.name} size={34} /><div><b>{m.name}{m.isMe && <span className="pill mini teal">você</span>}</b><small>{m.email}</small></div></div></td>
                  <td><Badge tone={ROLE_TONE[m.role]}>{m.roleLabel}</Badge></td>
                  <td>{d ? <ColorPill name={d.name} color={d.color} /> : <span className="faint">—</span>}</td>
                  <td className="muted">{new Date(m.createdAt).toLocaleDateString('pt-BR')}</td>
                  <td className="acts">
                    <Kebab testId="member-menu" items={[
                      { label: m.role === 'admin' ? 'Tornar membro' : 'Tornar administrador', icon: 'user', onClick: () => void changeRole(m), hidden: !isOwner || m.role === 'owner' || m.isMe },
                      { label: 'Mudar setor', icon: 'grid', onClick: () => setEditDept(m), hidden: !data.canManage || !data.departments.length },
                      { label: 'Remover da equipe', icon: 'trash', danger: true, onClick: () => setRemoving(m), hidden: !canTouch || (m.role === 'admin' && !isOwner) },
                    ]} />
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && <tr><td colSpan={5}><div className="empty" style={{ padding: 20 }}>Ninguém com esses filtros.</div></td></tr>}
          </tbody>
        </table>
      </div>

      {data.canManage && (
        <>
          <div className="st-section-t"><Icon name="mail" size={15} />Convites pendentes <small>({data.invites.length})</small></div>
          {data.invites.length === 0 ? (
            <div className="st-card" style={{ padding: 0 }}><EmptyBox icon="mail" title="Nenhum convite pendente" text="Quando você convidar alguém, o convite aparece aqui até a pessoa aceitar." /></div>
          ) : (
            <div className="st-tbl">
              <table>
                <thead><tr><th>E-mail</th><th>Perfil</th><th>Setor</th><th>Enviado</th><th>Vence</th><th className="acts" /></tr></thead>
                <tbody>
                  {data.invites.map((i) => {
                    const d = deptOf(i.departmentId);
                    return (
                      <tr key={i.id} data-testid="invite-row">
                        <td><b>{i.email}</b>{i.invitedByName && <div className="st-mini">por {i.invitedByName}</div>}</td>
                        <td><Badge tone={ROLE_TONE[i.role]}>{i.roleLabel}</Badge></td>
                        <td>{d ? <ColorPill name={d.name} color={d.color} /> : <span className="faint">—</span>}</td>
                        <td className="muted">{relTime(i.lastSentAt)}</td>
                        <td className="muted">{new Date(i.expiresAt).toLocaleDateString('pt-BR')}</td>
                        <td className="acts">
                          <Kebab testId="invite-menu" items={[
                            { label: 'Copiar link do convite', icon: 'copy', onClick: () => void copyText(i.link, 'Link do convite copiado') },
                            { label: 'Reenviar', icon: 'send', onClick: () => void inviteAct(i, 'resend') },
                            { label: 'Cancelar convite', icon: 'close', danger: true, onClick: () => void inviteAct(i, 'cancel') },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {inviting && <InviteMemberModal departments={data.departments} isOwner={isOwner} emailConfigured={data.emailConfigured} onClose={() => setInviting(false)} onDone={() => void reload()} />}
      {editDept && <DeptModal member={editDept} departments={data.departments} onClose={() => setEditDept(null)} onSaved={() => void reload()} />}
      {removing && (
        <ConfirmModal title="Remover da equipe" confirm="Remover" danger onClose={() => setRemoving(null)} onConfirm={async () => {
          try { await api.del(`/team/${removing.membershipId}`); toast(`${removing.name} saiu da equipe`); setRemoving(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>
          Remover <b>{removing.name}</b> da equipe? A pessoa perde o acesso a esta empresa na hora, e as conversas que estavam com ela voltam para a fila. {user?.id === removing.userId ? '' : 'A conta dela no Converza continua existindo.'}
        </ConfirmModal>
      )}
    </div>
  );
}
