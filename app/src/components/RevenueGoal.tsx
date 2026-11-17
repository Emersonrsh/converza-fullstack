import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { getSocket } from '../socket';
import { TrailModal } from '../dashboard/modals';
import { fmtMoney } from '../dashboard/format';

type Goal = { revenue: number; level: { key: string; label: string } | null; next: { key: string; label: string; target: number; progress: number } | null };

/** "R$ 7,5 mil", "R$ 1,2 mi": cabe no topo sem perder a ordem de grandeza. */
export function fmtShort(v: number): string {
  const a = Math.abs(v);
  const n = (x: number, d: number) => x.toLocaleString('pt-BR', { maximumFractionDigits: d });
  if (a >= 1_000_000) return `R$ ${n(v / 1_000_000, a >= 10_000_000 ? 0 : 1)} mi`;
  if (a >= 1_000) return `R$ ${n(v / 1_000, a >= 100_000 ? 0 : 1)} mil`;
  return fmtMoney(v);
}

/**
 * Contador de faturamento no topo de todas as telas: faturamento aprovado em reais rumo à próxima meta
 * da trilha de conquistas. Atualiza quando entra ou muda uma venda; clicar abre a trilha.
 */
export function RevenueGoal({ accountId }: { accountId: string | null }) {
  const [g, setG] = useState<Goal | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const load = useCallback(() => { api.get<Goal>('/dashboard/revenue-goal').then(setG).catch(() => undefined); }, []);

  useEffect(() => {
    setG(null);
    if (!accountId) return;
    load();
    const sock = getSocket();
    const onSale = () => { clearTimeout(timer.current); timer.current = setTimeout(load, 800); };
    sock?.on('sale:changed', onSale);
    const iv = setInterval(load, 5 * 60_000);
    const onFocus = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { sock?.off('sale:changed', onSale); clearInterval(iv); clearTimeout(timer.current); document.removeEventListener('visibilitychange', onFocus); };
  }, [accountId, load]);

  if (!g) return null;
  const pct = g.next ? g.next.progress : 100;
  const title = g.next
    ? `Faturamento aprovado: ${fmtMoney(g.revenue)} · faltam ${fmtMoney(Math.max(0, g.next.target - g.revenue))} para “${g.next.label}” (${fmtMoney(g.next.target)})`
    : `Faturamento aprovado: ${fmtMoney(g.revenue)} · você chegou ao último nível da trilha`;
  return (
    <>
      <button type="button" className="rev-goal" onClick={() => setOpen(true)} title={title} aria-label={title} data-testid="revenue-goal">
        <span className="rev-goal-ic"><Icon name="trophy" size={15} /></span>
        <span className="rev-goal-body">
          <span className="rev-goal-txt">
            <b data-testid="revenue-goal-value">{fmtShort(g.revenue)}</b>
            <span className="rev-goal-target">{g.next ? <> / {fmtShort(g.next.target)}</> : <> · {g.level?.label}</>}</span>
          </span>
          <span className="rev-goal-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.max(pct, g.revenue > 0 ? 2 : 0)}%` }} />
          </span>
        </span>
      </button>
      {open && <TrailModal onClose={() => { setOpen(false); load(); }} />}
    </>
  );
}
