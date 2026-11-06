import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from '../icons';
import { useAuth } from '../auth';
import { api, num } from '../api';
import { getSocket } from '../socket';
import { Avatar, Toaster, cx } from './ui';

const NAV: [string, [string, string, string][]][] = [
  ['Visão geral', [['dashboard', 'Dashboard', '/']]],
  ['Atendimento', [['inbox', 'Caixa de entrada', '/inbox'], ['users', 'Contatos', '/contacts'], ['kanban', 'Funil', '/kanban']]],
  ['Automação', [['flow', 'Fluxos', '/flows'], ['bot', 'Agentes de IA', '/agents'], ['send', 'Disparos', '/dispatch']]],
  ['Canais', [['plug', 'Conexões', '/connections'], ['webhook', 'Webhooks', '/webhooks'], ['meta', 'Meta Ads', '/meta']]],
  ['Conta', [['users', 'Equipe', '/team'], ['card', 'Assinatura', '/billing'], ['gear', 'Configurações', '/settings']]],
];

const TITLES: Record<string, [string, string]> = {
  '/': ['Dashboard', 'Visão geral da operação'],
  '/inbox': ['Caixa de entrada', 'Atendimento em tempo real'],
  '/contacts': ['Contatos', 'Sua base de leads e clientes'],
  '/kanban': ['Funil de vendas', 'Arraste os cards entre as etapas'],
  '/flows': ['Fluxos', 'Automações de conversa'],
  '/agents': ['Agentes de IA', 'Atendentes automáticos'],
  '/dispatch': ['Disparos em massa', 'Campanhas para sua base'],
  '/connections': ['Conexões', 'Números de WhatsApp'],
  '/webhooks': ['Webhooks de entrada', 'Eventos de plataformas externas'],
  '/meta': ['Meta Ads', 'Anúncios do Facebook e Instagram'],
  '/team': ['Equipe', 'Atendentes e permissões'],
  '/billing': ['Assinatura', 'Plano e cobrança'],
  '/settings': ['Configurações', 'Preferências da conta'],
};

export function Layout() {
  const { user, accounts, accountId, switchAccount, logout } = useAuth();
  const loc = useLocation();
  const [theme, setTheme] = useState<'light' | 'dark'>(
    (localStorage.getItem('theme') as 'light' | 'dark') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  const [tokens, setTokens] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ balance: number }>('/billing/tokens').then((r) => setTokens(r.balance)).catch(() => setTokens(0));
  }, [loc.pathname, accountId]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onTokens = (p: { balance: number }) => setTokens(p.balance);
    sock.on('tokens:update', onTokens);
    return () => { sock.off('tokens:update', onTokens); };
  }, [accountId]);

  const [t, s] = TITLES[loc.pathname] ?? ['Converza', ''];
  const fullscreen = /^\/flows\/[^/]+/.test(loc.pathname);
  const account = accounts.find((a) => a.id === accountId);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <svg className="logo" viewBox="0 0 40 40" fill="none">
            <rect width="40" height="40" rx="11" fill="#0e9488" />
            <path d="M11 13a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 4v-4V13Z" fill="#fff" fillOpacity=".95" />
            <path d="M18 17h7M18 20.5h4.5" stroke="#0e9488" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div><b>Converza</b><small>{account?.name ?? 'Conversational Sales'}</small></div>
        </div>

        {accounts.length > 1 && (
          <select className="select" style={{ marginBottom: 6 }} value={accountId ?? ''}
            onChange={(e) => switchAccount(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}

        {NAV.map(([group, items]) => (
          <div key={group}>
            <div className="navgroup">{group}</div>
            {items.map(([ic, label, to]) => (
              <NavLink key={to} to={to} end={to === '/'}
                className={({ isActive }) => cx('navitem', isActive && 'active')}>
                <Icon name={ic} /><span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}

        <div className="sidefoot">
          <div className="tokens">
            <Icon name="bolt" size={18} />
            <div><div className="n">{tokens === null ? '—' : num(tokens)}</div><small>tokens de IA</small></div>
          </div>
          <button className="navitem" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={{ marginTop: 6 }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} /><span>{theme === 'dark' ? 'Tema claro' : 'Tema escuro'}</span>
          </button>
          <button className="navitem" onClick={logout}><Icon name="logout" /><span>Sair</span></button>
        </div>
      </aside>

      <div className="main">
        {!fullscreen && (
          <header className="topbar">
            <div><h1>{t}</h1><div className="sub">{s}</div></div>
            <div className="spacer" />
            {user && <div className="row" style={{ gap: 9 }}><Avatar name={user.name} size={34} /></div>}
          </header>
        )}
        <div className={cx('content', fullscreen && 'flush')}><Outlet /></div>
      </div>
      <Toaster />
    </div>
  );
}
