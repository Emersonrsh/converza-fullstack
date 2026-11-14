import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { cx } from '../components/ui';

interface Acc { actId: string; name: string; currency: string; selected: boolean; profileName: string }

/** Filtro de contas de anúncios do Dashboard: vazio = todas. Mudanças só valem ao clicar em Aplicar. */
export function AdAccountFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [accs, setAccs] = useState<Acc[] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { api.get<{ accounts: Acc[] }>('/dashboard/ad-accounts').then((r) => setAccs(r.accounts)).catch(() => setAccs([])); }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const usable = useMemo(() => (accs ?? []).filter((a) => a.selected), [accs]);
  // conta que saiu do painel deixa de valer no filtro
  const active = value.filter((id) => usable.some((a) => a.actId === id));
  const allIds = usable.map((a) => a.actId);
  const label = !active.length || active.length === usable.length ? 'Todas as contas'
    : active.length === 1 ? usable.find((a) => a.actId === active[0])?.name ?? '1 conta' : `${active.length} contas`;
  const term = q.trim().toLowerCase();
  const shown = (accs ?? []).filter((a) => !term || a.name.toLowerCase().includes(term) || a.actId.includes(term));
  const sel = shown.filter((a) => a.selected); const off = shown.filter((a) => !a.selected);

  function openMenu() {
    setDraft(active.length ? active : allIds);
    setQ(''); setOpen(true);
  }
  function apply() {
    const v = draft.length === allIds.length || !draft.length ? [] : allIds.filter((id) => draft.includes(id));
    onChange(v); setOpen(false);
  }
  const same = (() => { const cur = active.length ? active : allIds; return cur.length === draft.length && cur.every((x) => draft.includes(x)); })();

  if (accs && !accs.length) return null; // sem Facebook conectado: o filtro não faz sentido
  return (
    <div className="aaf" ref={box}>
      <button type="button" className={cx('select dsel aaf-btn', open && 'open', active.length > 0 && active.length < usable.length && 'on')} onClick={() => (open ? setOpen(false) : openMenu())} data-testid="ad-account-filter">
        <span>{label}</span><Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="aaf-pop" role="dialog" aria-label="Contas de anúncios" data-testid="ad-account-pop">
          <div className="aaf-h">
            <b>Contas de anúncios</b>
            <span className="spacer" />
            <button type="button" className="aaf-link" onClick={() => setDraft(allIds)} data-testid="aaf-all">Selecionar todas</button>
            <button type="button" className="aaf-link danger" onClick={() => setDraft([])} data-testid="aaf-clear">Limpar</button>
          </div>
          <p className="faint">Escolha as contas e clique em Aplicar. Gasto, vendas e leads passam a contar só o que veio dos anúncios delas.</p>
          <label className="aaf-search"><Icon name="search" size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou ID..." autoFocus data-testid="aaf-search" /></label>
          <div className="aaf-list">
            {accs === null && <small className="faint">carregando…</small>}
            {sel.map((a) => (
              <label key={a.actId} className="aaf-i" data-testid="aaf-item">
                <input type="checkbox" checked={draft.includes(a.actId)} onChange={(e) => setDraft(e.target.checked ? [...draft, a.actId] : draft.filter((x) => x !== a.actId))} />
                <span><b>{a.name}</b><small>{a.profileName} · {a.actId}{a.currency !== 'BRL' ? ` · ${a.currency}` : ''}</small></span>
              </label>
            ))}
            {off.length > 0 && <div className="aaf-sep" />}
            {off.map((a) => (
              <label key={a.actId} className="aaf-i off" title="Esta conta não está no painel. Escolha em Facebook → Perfis e contas.">
                <input type="checkbox" disabled checked={false} readOnly />
                <span><b>{a.name}</b><small>{a.profileName} · {a.actId}</small></span>
              </label>
            ))}
            {accs !== null && !shown.length && <small className="faint">Nenhuma conta encontrada.</small>}
          </div>
          {off.length > 0 && <small className="faint aaf-note">As contas apagadas não estão no painel: escolha em <Link to="/meta/perfis">Facebook → Perfis e contas</Link>.</small>}
          <div className="aaf-f">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancelar</button>
            <button type="button" className="btn primary" onClick={apply} disabled={same || !draft.length} title={!draft.length ? "Escolha pelo menos uma conta" : undefined} data-testid="aaf-apply">Aplicar</button>
          </div>
        </div>
      )}
    </div>
  );
}
