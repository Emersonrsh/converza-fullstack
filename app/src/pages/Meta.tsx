import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, cx } from '../components/ui';
import { Manager } from '../facebook/Manager';
import { Pixels } from '../facebook/Pixels';
import { Profiles } from '../facebook/Profiles';
import { Rules } from '../facebook/Rules';
import type { Overview } from '../facebook/types';

const TABS: [string, string, string][] = [
  ['', 'Gerenciador', 'fb-tab-manager'],
  ['regras', 'Regras automáticas', 'fb-tab-rules'],
  ['pixel', 'Pixel', 'fb-tab-pixel'],
  ['perfis', 'Perfis e contas', 'fb-tab-profiles'],
];

/** Facebook: Gerenciador (anúncios), Regras automáticas, Pixel (eventos de conversão) e Perfis e contas (login da Meta). */
export function Meta() {
  const loc = useLocation();
  const nav = useNavigate();
  const { accountId } = useAuth();
  const tab = loc.pathname.replace(/^\/meta\/?/, '').split('/')[0];
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => api.get<Overview>('/meta/overview').then((r) => { setOverview(r); setErr(null); })
    .catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 400); };
    sock.on('meta:changed', on);
    return () => { sock.off('meta:changed', on); if (t) clearTimeout(t); };
  }, [load, accountId]);

  return (
    <div className="fade fbm-page" data-testid="facebook-page">
      <div className="card fbm-tabs-card">
        <div className="seg fbm-tabs" role="tablist">
          {TABS.map(([k, l, id]) => (
            <button type="button" key={id} role="tab" aria-selected={tab === k} className={cx(tab === k && 'active')}
              onClick={() => nav(k ? `/meta/${k}` : '/meta')} data-testid={id}>{l}</button>
          ))}
        </div>
      </div>
      {err && !overview && (
        <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar</b><span>{err}</span>
          <button type="button" className="btn" onClick={() => void load()}>Tentar de novo</button></div>
      )}
      {!overview && !err && <Spinner />}
      {overview && tab === '' && <Manager overview={overview} />}
      {overview && tab === 'regras' && <Rules overview={overview} />}
      {overview && tab === 'pixel' && <Pixels canEdit={overview.canEdit} />}
      {overview && tab === 'perfis' && <Profiles overview={overview} onChanged={() => void load()} />}
    </div>
  );
}
