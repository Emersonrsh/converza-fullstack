import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import { Logo, clearInviteToken, type InviteInfo } from './Login';

/** Link do convite (/convite/:token): mostra quem convidou e deixa aceitar ou recusar. */
export function InviteAccept() {
  const { token = '' } = useParams();
  const { user, reloadAccounts, switchAccount, logout } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'declined' | null>(null);

  useEffect(() => {
    try { sessionStorage.setItem('converza:invite', token); } catch { /* ok */ }
    api.get<InviteInfo>(`/invites/${token}`).then(setInfo).catch((e) => setError(e instanceof Error ? e.message : 'Convite não encontrado'));
  }, [token]);

  async function accept() {
    setBusy(true);
    try {
      const r = await api.post<{ account: { id: string; name: string } }>(`/invites/${token}/accept`);
      clearInviteToken();
      await reloadAccounts(r.account.id);
      switchAccount(r.account.id);
      nav('/');
      // o aviso aparece quando o app (com o Toaster) já estiver na tela
      setTimeout(() => toast(`Bem-vindo(a) à equipe da ${r.account.name}!`), 400);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível aceitar');
    }
    setBusy(false);
  }
  async function decline() {
    setBusy(true);
    try { await api.post(`/invites/${token}/decline`); clearInviteToken(); setDone('declined'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível recusar'); }
    setBusy(false);
  }

  const card = (body: React.ReactNode) => (
    <div className="auth-wrap">
      <div className="auth-card card pad fade" style={{ maxWidth: 440 }} data-testid="invite-page">
        <div className="row" style={{ gap: 11, marginBottom: 18 }}><Logo /><b style={{ fontSize: 20, letterSpacing: '-.02em' }}>Converza</b></div>
        {body}
      </div>
    </div>
  );

  if (error && !info) return card(<><div className="st-banner red"><Icon name="alert" size={16} /><span>{error}</span></div><button type="button" className="btn" onClick={() => nav('/')}>Ir para o início</button></>);
  if (!info) return card(<div style={{ height: 120 }}><Spinner /></div>);
  if (done) return card(<><b style={{ fontSize: 16 }}>Convite recusado</b><p className="muted" style={{ fontSize: 13.5 }}>Tudo bem — avisamos quem convidou.</p><button type="button" className="btn" onClick={() => nav('/')}>Continuar</button></>);

  // convite para criar conta na plataforma: o cadastro é na tela de login
  if (info.kind === 'platform') {
    return card(<>
      <b style={{ fontSize: 16 }}>{info.inviterName ?? info.accountName} te convidou para o Converza</b>
      <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>Crie sua conta com o e-mail <b>{info.email}</b> para começar a vender no WhatsApp.</p>
      {info.status !== 'pending' && <div className="st-banner amber"><Icon name="alert" size={16} /><span>Este convite {info.status === 'expired' ? 'venceu' : 'não vale mais'}.</span></div>}
      <div className="row" style={{ gap: 8 }}>
        {user ? <button type="button" className="btn primary" onClick={() => nav('/')}>Você já tem conta — ir para o Converza</button>
          : <button type="button" className="btn primary" onClick={() => { window.location.href = `/?convite=${token}`; }} data-testid="invite-register">Criar minha conta</button>}
        {info.status === 'pending' && <button type="button" className="btn ghost" disabled={busy} onClick={decline}>Recusar</button>}
      </div>
    </>);
  }

  const pending = info.status === 'pending';
  return card(<>
    <div className="st-empty-ic" style={{ width: 48, height: 48, marginBottom: 10 }}><Icon name="users" size={22} /></div>
    <b style={{ fontSize: 17 }} data-testid="invite-title">Convite para a equipe da {info.accountName}</b>
    <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, margin: '8px 0 14px' }}>
      {info.inviterName ?? 'Alguém'} te convidou como <b>{info.roleLabel ?? 'Membro'}</b>. O convite é para o e-mail <b>{info.email}</b>.
    </p>
    {!pending && <div className="st-banner amber" style={{ marginBottom: 12 }}><Icon name="alert" size={16} /><span>Este convite {info.status === 'expired' ? 'venceu — peça um novo' : info.status === 'accepted' ? 'já foi aceito' : 'não vale mais'}.</span></div>}
    {error && <div className="st-banner red" style={{ marginBottom: 12 }}><Icon name="alert" size={16} /><span>{error}</span></div>}
    {user ? (
      <>
        <div className="st-mini" style={{ marginBottom: 10 }}>Você está como <b>{user.email}</b>.</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {pending && <button type="button" className="btn primary" disabled={busy} onClick={accept} data-testid="invite-accept"><Icon name="check" size={15} />Aceitar e entrar na equipe</button>}
          {pending && <button type="button" className="btn ghost" disabled={busy} onClick={decline} data-testid="invite-decline">Recusar</button>}
          {!pending && <button type="button" className="btn" onClick={() => nav('/')}>Ir para o Converza</button>}
          {error?.includes('Entre com esse e-mail') && <button type="button" className="btn" onClick={() => { logout(); nav(`/convite/${token}`); }}>Entrar com outro e-mail</button>}
        </div>
      </>
    ) : (
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary" onClick={() => nav('/')} data-testid="invite-login">Entrar para aceitar</button>
        <small className="faint">Ainda não tem conta? Crie na tela de entrada com esse e-mail e volte para este link.</small>
      </div>
    )}
  </>);
}
