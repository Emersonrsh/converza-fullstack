import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { useAuth } from '../auth';
import { api, num } from '../api';
import { getSocket } from '../socket';
import { Avatar, Toaster, cx } from './ui';

const NAV: [string, [string, string, string][]][] = [
  ['Principal', [
    ['dashboard', 'Dashboard', '/'],
    ['chats', 'Chats ao vivo', '/inbox'],
    ['kanban', 'Kanban', '/kanban'],
    ['users', 'Contatos', '/contacts'],
  ]],
  ['Operações', [
    ['flow', 'Fluxos', '/flows'],
    ['bot', 'Agentes de IA', '/agents'],
    ['plug', 'Conexões', '/connections'],
    ['webhook', 'Webhooks de entrada', '/webhooks'],
    ['send', 'Disparos em massa', '/dispatch'],
    ['megaphone', 'Facebook', '/meta'],
  ]],
  ['Gestão', [
    ['card', 'Cobranças e assinaturas', '/billing'],
    ['gear', 'Configurações', '/settings'],
    ['help', 'Tutoriais', '/tutorials'],
  ]],
];

const TITLES: Record<string, [string, string]> = {
  '/': ['Dashboard', 'Visão geral da operação'],
  '/inbox': ['Chats ao vivo', 'Atendimento em tempo real'],
  '/kanban': ['Kanbans', 'Pipeline de vendas e gestão visual'],
  '/contacts': ['Contatos', 'Sua base de leads e clientes'],
  '/flows': ['Fluxos', 'Automações de conversa'],
  '/agents': ['Agentes de IA', 'Atendentes no WhatsApp que tiram dúvidas e disparam o fluxo'],
  '/connections': ['Conexões', 'Seus números de WhatsApp na API oficial da Meta'],
  '/webhooks': ['Webhooks de entrada', 'Gerencie múltiplos webhooks, cada um com sua conexão e mapeamento'],
  '/dispatch': ['Disparos em massa', 'Envie um fluxo para muitos contatos de uma vez, com cota por ciclo da assinatura'],
  '/meta': ['Facebook', 'Meta Ads, pixel e perfis conectados'],
  '/billing': ['Cobranças e assinaturas', 'Gerencie sua assinatura, suas instâncias contratadas e suas faturas'],
  '/billing/faturas': ['Faturas', 'Consulte o histórico de faturas da sua conta'],
  '/billing/reembolsos': ['Reembolsos', 'Consulte reembolsos processados na sua conta'],
  '/settings': ['Configurações', 'Empresa, equipe, automação e integrações'],
  '/tutorials': ['Tutoriais', 'Aprenda a usar cada parte do Converza'],
};

export function Layout() {
  const { user, accounts, accountId, switchAccount, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  // convites de equipe esperando resposta (aviso no topo)
  const [invites, setInvites] = useState<{ token: string; accountName: string; inviterName: string | null; roleLabel: string }[]>([]);
  const [hideInv, setHideInv] = useState(false);
  useEffect(() => {
    api.get<{ invites: typeof invites }>('/accounts/invites').then((r) => setInvites(r.invites)).catch(() => setInvites([]));
  }, [accountId, loc.pathname === '/']); // eslint-disable-line react-hooks/exhaustive-deps
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

  const [t, s] = TITLES[loc.pathname] ?? TITLES[`/${loc.pathname.split('/')[1]}`] ?? ['Converza', ''];
  // construtor de fluxos, quadro do Kanban e chats ao vivo ocupam a tela inteira (sem a barra do topo)
  const fullscreen = /^\/(flows|kanban)\/[^/]+/.test(loc.pathname) || loc.pathname === '/inbox' || /^\/settings(\/|$)/.test(loc.pathname);
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
            onChange={(e) => switchAccount(e.target.value)} data-testid="account-switch">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.support ? `🛟 ${a.name} (suporte)` : a.name}</option>)}
          </select>
        )}
        {account?.support && (
          <div className="support-badge" title="Você entrou nesta empresa pelo acesso de suporte" data-testid="support-badge">
            <Icon name="headset" size={13} />Acesso de suporte{account.supportUntil ? ` até ${new Date(account.supportUntil).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
          </div>
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
        {invites.length > 0 && !hideInv && !loc.pathname.startsWith('/convite') && (
          <div className="inv-banner" data-testid="invite-banner">
            <Icon name="mail" size={16} />
            <span><b>{invites[0].inviterName ?? 'Alguém'}</b> te convidou para a equipe da <b>{invites[0].accountName}</b> ({invites[0].roleLabel}).{invites.length > 1 ? ` E mais ${invites.length - 1} convite(s).` : ''}</span>
            <button type="button" className="btn sm primary" onClick={() => nav(`/convite/${invites[0].token}`)}>Ver convite</button>
            <button type="button" className="btn icon sm ghost" onClick={() => setHideInv(true)} aria-label="Esconder"><Icon name="close" size={14} /></button>
          </div>
        )}
        {!fullscreen && (
          <header className="topbar">
            <div><h1>{t}</h1><div className="sub"><span id="topbar-sub" /><span className="sub-default">{s}</span></div></div>
            <div className="spacer" />
            <div className="topbar-actions" id="topbar-actions" />
            {user && <div className="row" style={{ gap: 9 }}><Avatar name={user.name} size={34} /></div>}
          </header>
        )}
        <div className={cx('content', fullscreen && 'flush')}><Outlet /></div>
      </div>
      <Toaster />
    </div>
  );
}
