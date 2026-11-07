import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { toast } from '../components/ui';
import { Logo } from './Login';

interface MyInvite { token: string; role: string; roleLabel: string; accountName: string; inviterName: string | null; expiresAt: string }

/** Logado, mas sem nenhuma empresa (saiu, foi removido ou a empresa foi excluída). */
export function NoCompany() {
  const { user, logout, reloadAccounts, switchAccount } = useAuth();
  const nav = useNavigate();
  const [invites, setInvites] = useState<MyInvite[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ invites: MyInvite[] }>('/accounts/invites').then((r) => setInvites(r.invites)).catch(() => {}); }, []);

  async function create() {
    if (name.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ account: { id: string; name: string } }>('/accounts', { name: name.trim() });
      await reloadAccounts(r.account.id);
      switchAccount(r.account.id);
      nav('/billing');
      setTimeout(() => toast(`Empresa ${r.account.name} criada — assine para ativar os números`), 400);
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível criar'); }
    setBusy(false);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card card pad fade" style={{ maxWidth: 460 }} data-testid="no-company">
        <div className="row" style={{ gap: 11, marginBottom: 16 }}><Logo /><div><b style={{ fontSize: 18 }}>Olá, {user?.name.split(' ')[0]}</b><div className="muted" style={{ fontSize: 12.5 }}>{user?.email}</div></div></div>
        <b style={{ fontSize: 15.5 }}>Você ainda não faz parte de nenhuma empresa</b>
        <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, margin: '6px 0 16px' }}>Aceite um convite de equipe ou crie a sua empresa para começar.</p>
        {invites.length > 0 && (
          <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
            {invites.map((i) => (
              <button type="button" key={i.token} className="st-file" style={{ cursor: 'pointer', textAlign: 'left' }} onClick={() => nav(`/convite/${i.token}`)} data-testid="my-invite">
                <span className="st-stat-ic" style={{ width: 36, height: 36 }}><Icon name="mail" size={16} /></span>
                <div style={{ flex: 1 }}><b>{i.accountName}</b><span className="st-mini">{i.inviterName ?? 'Alguém'} te convidou como {i.roleLabel}</span></div>
                <Icon name="chevronRight" size={15} />
              </button>
            ))}
          </div>
        )}
        <label className="label">Nome da empresa</label>
        <div className="row">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Minha Loja" onKeyDown={(e) => e.key === 'Enter' && create()} data-testid="nc-name" />
          <button type="button" className="btn primary" disabled={name.trim().length < 2 || busy} onClick={create} data-testid="nc-create">Criar</button>
        </div>
        <button type="button" className="btn ghost sm" style={{ marginTop: 16 }} onClick={logout}><Icon name="logout" size={14} />Sair</button>
      </div>
    </div>
  );
}
