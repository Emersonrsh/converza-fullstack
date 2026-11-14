import { lazy, Suspense, useState, type ComponentType } from 'react';
import { ALL_PAGES, LEGACY, SETTINGS_GROUPS, canSee, type Role, type SettingsPage } from './meta';
import { Navigate, NavLink, useLocation, useParams } from 'react-router-dom';
import { Icon } from '../icons';
import { useAuth } from '../auth';
import { Spinner, cx } from '../components/ui';

const LS = 'converza:settingsNav';

const lazyCache = new Map<string, ComponentType>();
function pageComponent(p: SettingsPage): ComponentType {
  let c = lazyCache.get(p.slug);
  if (!c) { c = lazy(p.load); lazyCache.set(p.slug, c); }
  return c;
}

export function SettingsLayout() {
  const { page: slug } = useParams();
  const loc = useLocation();
  const { accounts, accountId } = useAuth();
  const role = accounts.find((a) => a.id === accountId)?.role as Role | undefined;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(LS) === '1'; } catch { return false; } });
  const toggle = () => setCollapsed((v) => { try { localStorage.setItem(LS, v ? '0' : '1'); } catch { /* sem armazenamento */ } return !v; });

  // links antigos: /settings?aba=equipe
  if (!slug) {
    const aba = new URLSearchParams(loc.search).get('aba') ?? '';
    return <Navigate to={`/settings/${LEGACY[aba] ?? 'empresa'}`} replace />;
  }
  const current = ALL_PAGES.find((p) => p.slug === slug);
  if (!current) return <Navigate to="/settings/empresa" replace />;
  if (!canSee(current, role)) return <Navigate to="/settings/empresa" replace />;
  const Page = pageComponent(current);

  return (
    <div className={cx('st', collapsed && 'collapsed')} data-testid="settings">
      <nav className="st-nav" aria-label="Configurações" ref={(el) => { if (el && window.innerWidth <= 760) el.querySelector('.st-item.active')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }}>
        <div className="st-nav-top">
          <b>Configurações</b>
          <button type="button" className="btn icon sm ghost" onClick={toggle} title={collapsed ? 'Abrir menu' : 'Recolher menu'} aria-label={collapsed ? 'Abrir menu' : 'Recolher menu'} data-testid="st-collapse">
            <Icon name="sidebar" size={16} />
          </button>
        </div>
        {SETTINGS_GROUPS.map((g, gi) => (
          <div key={g.label}>
            {collapsed && gi > 0 && <div className="st-sep" />}
            <div className="st-group">{g.label}</div>
            {g.items.filter((p) => canSee(p, role)).map((p) => (
              <NavLink key={p.slug} to={`/settings/${p.slug}`} className={({ isActive }) => cx('st-item', isActive && 'active')} title={collapsed ? p.label : undefined} data-testid={`st-nav-${p.slug}`}>
                <Icon name={p.icon} size={17} /><span>{p.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <main className="st-main">
        <div className="st-page fade" key={`${current.slug}-${accountId}`}>
          <Suspense fallback={<div style={{ height: 240 }}><Spinner /></div>}>
            <Page />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

