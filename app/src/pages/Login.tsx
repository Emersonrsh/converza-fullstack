import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError, api } from '../api';
import { Icon } from '../icons';

export interface InviteInfo {
  kind: 'team' | 'platform'; accountName: string; inviterName: string | null; email: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'canceled'; role?: string; roleLabel?: string;
}

const LS_INVITE = 'converza:invite';
/** Convite que trouxe a pessoa até aqui (?convite= no link ou /convite/:token antes do login). */
export function pendingInviteToken(): string | null {
  const q = new URLSearchParams(window.location.search).get('convite');
  if (q && /^[\w-]{20,80}$/.test(q)) { try { sessionStorage.setItem(LS_INVITE, q); } catch { /* sem armazenamento */ } return q; }
  try { return sessionStorage.getItem(LS_INVITE); } catch { return null; }
}
export function clearInviteToken() { try { sessionStorage.removeItem(LS_INVITE); } catch { /* ok */ } }

export function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect width="40" height="40" rx="11" fill="#0e9488" />
      <path d="M11 13a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 4v-4V13Z" fill="#fff" />
      <path d="M18 17h7M18 20.5h4.5" stroke="#0e9488" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Login() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [token] = useState(pendingInviteToken);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  // link de indicação (?ref=CODIGO): guarda o código e abre direto em "Criar conta"
  const [mode, setMode] = useState<'login' | 'register'>(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && /^[A-Za-z0-9]{4,20}$/.test(ref)) { localStorage.setItem('converza:ref', ref.toUpperCase()); return 'register'; }
    return 'login';
  });
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api.get<InviteInfo>(`/invites/${token}`).then((i) => {
      setInvite(i);
      if (i.kind === 'platform' && i.status === 'pending') { setMode('register'); setEmail(i.email); }
    }).catch(() => clearInviteToken());
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'register' && !terms) { setError('Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.'); return; }
    setError(null); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password, company || name, invite?.kind === 'platform' ? token : null);
      if (invite?.kind === 'team' && invite.status === 'pending' && token) nav(`/convite/${token}`);
      else { clearInviteToken(); nav('/'); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao entrar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card card pad fade">
        <div className="row" style={{ gap: 11, marginBottom: 18 }}>
          <Logo />
          <div><b style={{ fontSize: 20, letterSpacing: '-.02em' }}>Converza</b>
            <div className="muted" style={{ fontSize: 12.5 }}>Vendas no WhatsApp, no automático</div></div>
        </div>

        {invite && invite.status === 'pending' && (
          <div className="st-banner" style={{ marginBottom: 14 }} data-testid="login-invite">
            <Icon name="mail" size={16} />
            <span>{invite.kind === 'team'
              ? <><b>{invite.inviterName ?? 'Alguém'}</b> te convidou para a equipe da <b>{invite.accountName}</b>. Entre com o e-mail {invite.email} para aceitar.</>
              : <><b>{invite.inviterName ?? invite.accountName}</b> te convidou para o Converza. Crie sua conta.</>}</span>
          </div>
        )}
        {invite && invite.status !== 'pending' && (
          <div className="st-banner amber" style={{ marginBottom: 14 }}><Icon name="alert" size={16} /><span>Este convite {invite.status === 'expired' ? 'venceu' : 'não vale mais'}. Peça um novo para quem convidou.</span></div>
        )}

        <div className="seg" style={{ width: '100%', marginBottom: 16 }}>
          <button className={mode === 'login' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setMode('login')}>Entrar</button>
          <button className={mode === 'register' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setMode('register')} data-testid="mode-register">Criar conta</button>
        </div>

        <form onSubmit={submit} className="grid" style={{ gap: 12 }}>
          {mode === 'register' && <>
            <div><label className="label">Seu nome</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required data-testid="reg-name" /></div>
            <div><label className="label">Nome da empresa</label><input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Minha Loja" data-testid="reg-company" /></div>
          </>}
          <div><label className="label">E-mail</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="login-email" /></div>
          <div><label className="label">Senha</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} data-testid="login-password" /></div>
          {mode === 'register' && (
            <label className="auth-terms">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} data-testid="reg-terms" />
              <span>Li e aceito os <Link to="/termos" target="_blank">Termos de Uso</Link> e a <Link to="/privacidade" target="_blank">Política de Privacidade</Link>.</span>
            </label>
          )}
          {error && <div className="pill red dot" style={{ height: 'auto', padding: '8px 12px' }}>{error}</div>}
          <button className="btn primary" style={{ width: '100%', height: 42 }} disabled={busy} data-testid="login-submit">
            {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>
        <div className="faint auth-foot">
          <span>© {new Date().getFullYear()} Converza</span>
          <Link to="/termos" data-testid="foot-terms">Termos</Link>
          <Link to="/privacidade" data-testid="foot-privacy">Privacidade</Link>
          <Link to="/exclusao-de-dados">Exclusão de dados</Link>
        </div>
      </div>
    </div>
  );
}
