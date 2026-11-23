/** Regras de preço do produto: moeda, faixa (mínimo–máximo) e valor padrão (fallback). */
export interface PricedProduct { price: number; currency: string; minPrice: number | null; maxPrice: number | null }

type Row = { price: string | number; currency?: string | null; minPrice?: string | number | null; maxPrice?: string | number | null };
const num = (v: string | number | null | undefined) => (v == null || v === '' ? null : Number(v));

/** Linha do banco → números. */
export function priced(p: Row): PricedProduct {
  return { price: Number(p.price), currency: (p.currency || 'BRL').toUpperCase(), minPrice: num(p.minPrice), maxPrice: num(p.maxPrice) };
}

export const hasRange = (p: PricedProduct) => p.minPrice != null && p.maxPrice != null;

/** O valor cabe na faixa do produto? Sem faixa, ou em outra moeda, não dá para julgar: conta como dentro. */
export function inRange(p: PricedProduct, amount: number, currency?: string | null): boolean {
  if (!hasRange(p)) return true;
  if (currency && currency.toUpperCase() !== p.currency) return true;
  return amount >= (p.minPrice as number) - 0.005 && amount <= (p.maxPrice as number) + 0.005;
}

export function rangeText(p: PricedProduct, fmt: (n: number, c: string) => string): string {
  return hasRange(p) ? `${fmt(p.minPrice as number, p.currency)} a ${fmt(p.maxPrice as number, p.currency)}` : 'sem faixa';
}

/**
 * Valor final de uma venda deste produto: sem valor (ou inválido) usa o padrão; fora da faixa também usa o padrão.
 * `reason` explica quando o padrão entrou.
 */
export function resolveAmount(p: PricedProduct, amount: number | null | undefined, currency?: string | null): { amount: number; currency: string; reason: 'missing' | 'out_of_range' | null } {
  const cur = (currency || p.currency).toUpperCase();
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return { amount: p.price, currency: p.currency, reason: 'missing' };
  if (!inRange(p, amount, cur)) return { amount: p.price, currency: p.currency, reason: 'out_of_range' };
  return { amount, currency: cur, reason: null };
}
