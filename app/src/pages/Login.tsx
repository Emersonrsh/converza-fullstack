import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';

export function Login() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(name, email, password, company || name);
      nav('/');
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
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="11" fill="#0e9488" />
            <path d="M11 13a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 4v-4V13Z" fill="#fff" />
            <path d="M18 17h7M18 20.5h4.5" stroke="#0e9488" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div><b style={{ fontSize: 20, letterSpacing: '-.02em' }}>Converza</b>
            <div className="muted" style={{ fontSize: 12.5 }}>Vendas no WhatsApp, no automático</div></div>
        </div>

        <div className="seg" style={{ width: '100%', marginBottom: 16 }}>
          <button className={mode === 'login' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setMode('login')}>Entrar</button>
          <button className={mode === 'register' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setMode('register')}>Criar conta</button>
        </div>

        <form onSubmit={submit} className="grid" style={{ gap: 12 }}>
          {mode === 'register' && <>
            <div><label className="label">Seu nome</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
            <div><label className="label">Nome da empresa</label><input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Minha Loja" /></div>
          </>}
          <div><label className="label">E-mail</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><label className="label">Senha</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
          {error && <div className="pill red dot" style={{ height: 'auto', padding: '8px 12px' }}>{error}</div>}
          <button className="btn primary" style={{ width: '100%', height: 42 }} disabled={busy}>
            {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>
        <div className="faint" style={{ fontSize: 11.5, textAlign: 'center', marginTop: 14 }}>© 2026 Converza</div>
      </div>
    </div>
  );
}
