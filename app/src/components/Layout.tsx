import { Logo } from './Logo';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { useAuth } from '../auth';
import { api, num } from '../api';
import { getSocket } from '../socket';
import { RevenueGoal } from './RevenueGoal';
import { InstanceAlerts } from './InstanceAlerts';
import { Avatar, Toaster, cx } from './ui';
import { AppNotices } from './AppNotices';
import { DiscordInvite, DiscordMark, setDiscordHidden, useDiscordHidden } from '../dashboard/DiscordInvite';

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
    ['book', 'Converza Members', '/members'],
  ]],
  ['Gestão', [
    ['card', 'Cobranças e assinaturas', '/billing'],
    ['gear', 'Configurações', '/settings'],
    ['help', 'Tutoriais', '/tutorials'],
  ]],
];

const TITLES: Record<string, [string, string]> = {
  '/': ['Dashboards', 'Visão geral da operação'],
  '/inbox': ['Chats ao vivo', 'Atendimento em tempo real'],
  '/members': ['Converza Members', 'Área de membros com os seus cursos em PDF'],
  '/kanban': ['Kanbans', 'Pipeline de vendas e gestão visual'],
  '/contacts': ['Contatos', 'Sua base de leads e clientes'],
  '/flows': ['Fluxos', 'Automações de conversa'],
  '/agents': ['Agentes de IA', 'Atendentes no WhatsApp que tiram dúvidas e disparam o fluxo'],
  '/connections': ['Conexões', 'Seus números de WhatsApp: API oficial da Meta ou QR Code'],
  '/webhooks': ['Webhooks de entrada', 'Gerencie múltiplos webhooks, cada um com sua conexão e mapeamento'],
  '/dispatch': ['Disparos em massa', 'Envie um fluxo para muitos contatos de uma vez, com cota por ciclo da assinatura'],
  '/meta': ['Facebook', 'Meta Ads, pixel e perfis conectados'],
  '/billing': ['Cobranças e assinaturas', 'Gerencie sua assinatura, suas instâncias contratadas e suas faturas'],
  '/billing/faturas': ['Faturas', 'Consulte o histórico de faturas da sua conta'],
  '/billing/reembolsos': ['Reembolsos', 'Consulte reembolsos processados na sua conta'],
  '/settings': ['Configurações', 'Empresa, equipe, automação e integrações'],
  '/tutorials': ['Tutoriais', 'Aprenda a usar cada parte do Converza'],
  '/platform': ['Painel da plataforma', 'Todas as empresas, receita e assinaturas do Converza'],
};

/**
 * Menu "Dashboards": o geral (todos os produtos) e um item por produto, que abre o dashboard filtrado
 * (?produto=<id>). Abre sozinho quando um produto está escolhido.
 */
function DashboardNav({ accountId }: { accountId: string | null }) {
  const loc = useLocation();
  const nav = useNavigate();
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const onDash = loc.pathname === '/';
  const current = onDash ? new URLSearchParams(loc.search).get('produto') ?? '' : '';
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('cz.nav.dash') !== '0'; } catch { return true; } });
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem('cz.nav.dash', v ? '1' : '0'); } catch { /* sem storage */ } };
  const load = useCallback(() => {
    if (!accountId) return;
    api.get<{ products: { id: string; name: string; active?: boolean }[] }>('/settings/products')
      .then((r) => setProducts(r.products.filter((p) => p.active !== false))).catch(() => {});
  }, [accountId]);
  useEffect(() => { load(); }, [load]);
  // produto criado, renomeado ou apagado nas configurações
  useEffect(() => { window.addEventListener('converza:products', load); return () => window.removeEventListener('converza:products', load); }, [load]);
  useEffect(() => { if (current) setOpen(true); }, [current]);
  const hasKids = products.length > 0;
  return (
    <div className={cx('navtree', open && hasKids && 'open')} data-testid="nav-dashboards">
      <div className={cx('navitem', onDash && !current && 'active')} role="link" tabIndex={0}
        onClick={() => { nav('/'); if (hasKids && (!onDash || !current)) toggle(onDash ? !open : true); }}
        onKeyDown={(e) => { if (e.key === 'Enter') nav('/'); }} data-testid="nav-dash-all">
        <Icon name="layers" /><span>Dashboards</span>
        {hasKids && (
          <button type="button" className="navtree-caret" aria-label={open ? 'Fechar a lista de produtos' : 'Abrir a lista de produtos'}
            onClick={(e) => { e.stopPropagation(); toggle(!open); }} data-testid="nav-dash-toggle">
            <Icon name={open ? 'chevronUp' : 'chevron'} size={15} />
          </button>
        )}
      </div>
      {hasKids && open && (
        <div className="navtree-kids">
          {products.map((p) => (
            <button type="button" key={p.id} className={cx('navitem navsub', current === p.id && 'active')} title={p.name}
              onClick={() => nav(`/?produto=${encodeURIComponent(p.id)}`)} data-testid="nav-dash-product">
              <Icon name="box" size={16} /><span>{p.name}</span><Icon name="chevronRight" size={14} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Empresa suspensa no painel da plataforma: ninguém da empresa usa até reativar. */
function Suspended({ name, reason, others, onSwitch, onLogout }: { name: string; reason: string | null | undefined; others: { id: string; name: string }[]; onSwitch: (id: string) => void; onLogout: () => void }) {
  return (
    <div className="susp-wrap" data-testid="suspended-screen">
      <div className="card susp-card">
        <span className="susp-ic"><Icon name="alert" size={26} /></span>
        <h2>{name} está suspensa</h2>
        <p>O acesso a esta empresa foi pausado pela equipe do Converza. Nada foi apagado: assim que a situação for resolvida, tudo volta como estava.</p>
        {reason && <div className="susp-why"><b>Motivo:</b> {reason}</div>}
        <p>Os números desta empresa não enviam mensagens enquanto ela estiver suspensa (as recebidas continuam chegando). Para resolver, fale com o suporte.</p>
        <div className="row">
          {others.map((o) => <button key={o.id} type="button" className="btn" onClick={() => onSwitch(o.id)}>Ir para {o.name}</button>)}
          <button type="button" className="btn" onClick={onLogout}><Icon name="logout" size={15} />Sair</button>
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const { user, accounts, accountId, switchAccount, logout, reloadAccounts } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  // convites de equipe esperando resposta (aviso no topo)
  const [invites, setInvites] = useState<{ token: string; accountName: string; inviterName: string | null; roleLabel: string }[]>([]);
  const [hideInv, setHideInv] = useState(false);
  // barra lateral escondida (fica lembrado neste navegador)
  const [sideHidden, setSideHidden] = useState(() => { try { return localStorage.getItem('cz-side-hidden') === '1'; } catch { return false; } });
  // celular: o menu lateral vira gaveta (abre pelo botão ☰ e fecha ao trocar de tela)
  const [mOpen, setMOpen] = useState(false);
  useEffect(() => { setMOpen(false); }, [loc.pathname]);
  const toggleSide = (v: boolean) => { setSideHidden(v); try { localStorage.setItem('cz-side-hidden', v ? '1' : '0'); } catch { /* sem storage */ } };
  useEffect(() => {
    api.get<{ invites: typeof invites }>('/accounts/invites').then((r) => setInvites(r.invites)).catch(() => setInvites([]));
  }, [accountId, loc.pathname === '/']); // eslint-disable-line react-hooks/exhaustive-deps
  const discordHidden = useDiscordHidden();
  const [theme, setTheme] = useState<'light' | 'dark'>(
    (localStorage.getItem('theme') as 'light' | 'dark') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

  useEffect(() => {
    document.documentElement.className = theme === 'dark' ? 'dark' : '';
    localStorage.setItem('theme', theme);
  }, [theme]);

  const [tokens, setTokens] = useState<number | null>(null);
  const [house, setHouse] = useState(false);
  useEffect(() => {
    api.get<{ balance: number; house?: boolean }>('/billing/tokens').then((r) => { setTokens(r.balance); setHouse(!!r.house); }).catch(() => setTokens(0));
  }, [loc.pathname, accountId]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onTokens = (p: { balance: number }) => setTokens(p.balance);
    sock.on('tokens:update', onTokens);
    return () => { sock.off('tokens:update', onTokens); };
  }, [accountId]);

  // suspensa/reativada agora (painel da plataforma): relê as empresas para mostrar (ou tirar) o aviso
  useEffect(() => {
    const again = () => { void reloadAccounts(accountId); };
    window.addEventListener('converza:suspended', again);
    const sock = getSocket();
    sock?.on('account:suspended', again);
    sock?.on('account:reactivated', again);
    return () => { window.removeEventListener('converza:suspended', again); sock?.off('account:suspended', again); sock?.off('account:reactivated', again); };
  }, [accountId, reloadAccounts]);

  const navGroups: typeof NAV = user?.platformAdmin ? [...NAV, ['Plataforma', [['shield', 'Painel da plataforma', '/platform']]]] : NAV;
  const [t, s] = TITLES[loc.pathname] ?? TITLES[`/${loc.pathname.split('/')[1]}`] ?? ['Converza', ''];
  // construtor de fluxos, quadro do Kanban e chats ao vivo ocupam a tela inteira (sem a barra do topo)
  const fullscreen = /^\/(flows|kanban)\/[^/]+/.test(loc.pathname) || loc.pathname === '/inbox' || /^\/settings(\/|$)/.test(loc.pathname);
  const account = accounts.find((a) => a.id === accountId);

  return (
    <div className={cx('shell', sideHidden && 'side-hidden', mOpen && 'm-open')}>
      <button type="button" className="m-menu" onClick={() => setMOpen(true)} aria-label="Abrir o menu" data-testid="m-menu"><Icon name="menu" size={20} /></button>
      {mOpen && <div className="m-backdrop" onClick={() => setMOpen(false)} />}
      {sideHidden && (
        <button type="button" className="side-open" onClick={() => toggleSide(false)} title="Mostrar a barra lateral" aria-label="Mostrar a barra lateral" data-testid="side-show">
          <Icon name="chevronRight" size={16} />
        </button>
      )}
      <aside className="sidebar" aria-hidden={sideHidden}>
        <div className="brand">
          <Logo size={34} className="logo" />
          <div><b>Converza</b><small>{account?.name ?? 'Conversational Sales'}</small></div>
          <button type="button" className="side-hide" onClick={() => toggleSide(true)} title="Esconder a barra lateral" aria-label="Esconder a barra lateral" data-testid="side-hide">
            <Icon name="sidebar" size={17} />
          </button>
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

        {navGroups.map(([group, items]) => (
          <div key={group}>
            <div className="navgroup">{group}</div>
            {items.map(([ic, label, to]) => to === '/' ? <DashboardNav key={to} accountId={accountId} /> : (
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
            <div><div className="n" data-testid="side-tokens">{house ? '∞' : tokens === null ? '—' : num(tokens)}</div><small>{house ? 'tokens de IA · conta da casa' : 'tokens de IA'}</small></div>
          </div>
          {discordHidden && <button className="navitem" onClick={() => setDiscordHidden(false)} style={{ marginTop: 6 }} data-testid="discord-show"><DiscordMark size={18} /><span>Comunidade no Discord</span></button>}
          <button className="navitem" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={{ marginTop: discordHidden ? 0 : 6 }}>
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
            {user && !account?.suspended && <RevenueGoal accountId={accountId} />}
            {user && <div className="row" style={{ gap: 9 }}><Avatar name={user.name} size={34} /></div>}
          </header>
        )}
        {account?.suspended && !(user?.platformAdmin && loc.pathname === '/platform')
          ? <Suspended name={account.name} reason={account.suspendedReason} others={accounts.filter((a) => a.id !== account.id && !a.suspended)} onSwitch={switchAccount} onLogout={logout} />
          : <div className={cx('content', fullscreen && 'flush')}><Outlet /></div>}
      </div>
      <Toaster />
      <DiscordInvite />
      <AppNotices accountId={accountId} />
      <InstanceAlerts accountId={accountId} />
    </div>
  );
}
