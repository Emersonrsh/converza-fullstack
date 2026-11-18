import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError, api } from '../api';
import { Icon } from '../icons';
import { Logo } from '../components/Logo';

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card card pad fade">
        <div className="row" style={{ gap: 11, marginBottom: 18 }}>
          <Logo />
          <div><b style={{ fontSize: 20, letterSpacing: '-.02em' }}>Converza</b>
            <div className="muted" style={{ fontSize: 12.5 }}>Vendas no WhatsApp, no automático</div></div>
        </div>
        {children}
      </div>
    </div>
  );
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const tokenFromUrl = () => new URLSearchParams(window.location.search).get('token') ?? '';

/** Conta criada, e-mail ainda não confirmado: o app fica parado aqui. */
export function VerifyEmailWait() {
  const { user, logout, refreshSession } = useAuth();
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  // confirmou em outra aba: ao voltar para esta, segue sozinho
  useEffect(() => {
    const onFocus = () => { refreshSession().catch(() => undefined); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const resend = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.post('/auth/resend-verification', {});
      setMsg({ tone: 'green', text: 'Mandamos um link novo. Confira também a caixa de spam.' });
      setCooldown(60);
    } catch (e) { setMsg({ tone: 'red', text: errText(e, 'Não deu para reenviar agora.') }); }
    finally { setBusy(false); }
  };
  const done = async () => {
    setBusy(true); setMsg(null);
    try {
      if (!(await refreshSession())) setMsg({ tone: 'amber', text: 'Ainda não vimos a confirmação. Clique no botão do e-mail e tente de novo.' });
    } catch (e) { setMsg({ tone: 'red', text: errText(e, 'Não deu para conferir agora.') }); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <div data-testid="verify-wait">
        <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Confirme o seu e-mail</h2>
        <p className="muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          Mandamos um link para <b>{user?.email}</b>. Clique no botão do e-mail para liberar a sua conta. O link vale por 48 horas.
        </p>
        {msg && <div className={`pill ${msg.tone} dot`} style={{ height: 'auto', padding: '8px 12px', marginBottom: 12 }} data-testid="verify-msg">{msg.text}</div>}
        <div className="grid" style={{ gap: 10 }}>
          <button className="btn primary" style={{ height: 42 }} onClick={done} disabled={busy} data-testid="verify-done">Já confirmei</button>
          <button className="btn" style={{ height: 42 }} onClick={resend} disabled={busy || cooldown > 0} data-testid="verify-resend">
            <Icon name="mail" size={15} />{cooldown ? `Reenviar em ${cooldown}s` : 'Reenviar o e-mail'}
          </button>
          <button className="btn ghost" onClick={logout} data-testid="verify-logout">Entrar com outra conta</button>
        </div>
      </div>
    </Card>
  );
}

/** /confirmar-email?token=…: o link do e-mail. */
export function ConfirmEmailLink() {
  const { verifyEmail } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    verifyEmail(tokenFromUrl()).then(() => nav('/', { replace: true })).catch((e) => setError(errText(e, 'Não deu para confirmar agora. Tente de novo.')));
  }, []);
  return (
    <Card>
      {error ? (
        <div data-testid="confirm-error">
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Link inválido</h2>
          <p className="muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>{error}</p>
          <Link className="btn primary" to="/" style={{ width: '100%', height: 42 }}>Ir para o Converza</Link>
        </div>
      ) : <p className="muted" data-testid="confirm-busy">Confirmando o seu e-mail…</p>}
    </Card>
  );
}

/** /esqueci-senha: pede o link por e-mail. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.post('/auth/forgot-password', { email }); setSent(true); }
    catch (err) { setError(errText(err, 'Não deu para enviar agora.')); }
    finally { setBusy(false); }
  };
  return (
    <Card>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Esqueci minha senha</h2>
      {sent ? (
        <div data-testid="forgot-sent">
          <p className="muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
            Se existir uma conta com <b>{email}</b>, mandamos um link para criar uma senha nova. Ele vale por 1 hora. Confira também a caixa de spam.
          </p>
          <Link className="btn" to="/" style={{ width: '100%', height: 42 }}>Voltar para o login</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="grid" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>Digite o e-mail da sua conta. Vamos mandar um link para você escolher uma senha nova.</p>
          <div><label className="label">E-mail</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="forgot-email" /></div>
          {error && <div className="pill red dot" style={{ height: 'auto', padding: '8px 12px' }}>{error}</div>}
          <button className="btn primary" style={{ height: 42 }} disabled={busy} data-testid="forgot-submit">{busy ? 'Aguarde…' : 'Mandar o link'}</button>
          <Link to="/" className="faint" style={{ textAlign: 'center', fontSize: 13 }}>Voltar para o login</Link>
        </form>
      )}
    </Card>
  );
}

/** /redefinir-senha?token=…: escolhe a senha nova e entra. */
export function ResetPassword() {
  const { resetPassword } = useAuth();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    if (pw !== pw2) { setError('As duas senhas não são iguais.'); return; }
    setBusy(true);
    try { await resetPassword(tokenFromUrl(), pw); nav('/', { replace: true }); }
    catch (err) { setError(errText(err, 'Não deu para trocar a senha agora.')); }
    finally { setBusy(false); }
  };
  return (
    <Card>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Escolha uma senha nova</h2>
      <form onSubmit={submit} className="grid" style={{ gap: 12 }}>
        <div><label className="label">Senha nova</label><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={8} data-testid="reset-pw" /></div>
        <div><label className="label">Repita a senha</label><input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={8} data-testid="reset-pw2" /></div>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>Ao trocar a senha, os outros aparelhos conectados à sua conta precisam entrar de novo.</p>
        {error && <div className="pill red dot" style={{ height: 'auto', padding: '8px 12px' }} data-testid="reset-error">{error}</div>}
        <button className="btn primary" style={{ height: 42 }} disabled={busy} data-testid="reset-submit">{busy ? 'Aguarde…' : 'Salvar e entrar'}</button>
      </form>
    </Card>
  );
}
