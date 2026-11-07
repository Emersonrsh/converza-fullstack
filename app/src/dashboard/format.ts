export function fmtMoney(v: number, currency = 'BRL') {
  try {
    return v.toLocaleString('pt-BR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}
export const fmtNum = (v: number) => v.toLocaleString('pt-BR');
export const fmtPct = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
export const fmtDec = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
export const fmtCompact = (v: number) => (Math.abs(v) < 1000 ? fmtNum(Math.round(v * 100) / 100) : compact.format(v));

/** Variação percentual em relação ao período anterior. */
export function trend(cur: number, prev: number): number {
  if (!prev) return cur > 0 ? 100 : 0;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** +55 (11) 98888-7777 */
export function fmtPhone(p: string | null | undefined): string {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return '—';
  const br = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d.length === 10 || d.length === 11 ? d : null;
  if (!br) return `+${d}`;
  const ddd = br.slice(0, 2);
  const rest = br.slice(2);
  const a = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
  return `+55 (${ddd}) ${a}-${rest.slice(a.length)}`;
}

export const STAGE_PT: Record<string, string> = {
  new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido',
};
export const SALE_STATUS: Record<string, [string, string]> = {
  approved: ['green', 'aprovada'], pending: ['amber', 'pendente'], refused: ['red', 'recusada'], refunded: ['', 'reembolsada'],
};
export const PALETTE = ['#0e9488', '#2f73e0', '#f59e0b', '#8b5cf6', '#e23b3b', '#1a9f52', '#db2777', '#0891b2', '#64748b', '#ea580c'];

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export { todayLocal };
