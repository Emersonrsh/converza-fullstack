import type { Leaf, WebhookMapping } from './types';

export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'agora';
  if (s < 3600) return `há ${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
};

export const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const pct = (used: number, limit: number) =>
  `${(limit ? Math.min(999, (used / limit) * 100) : 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

/** Valor de um caminho no exemplo (para mostrar ao lado do campo). */
export function previewOf(leaves: Leaf[], sample: unknown, path: string | undefined): string {
  if (!path) return '';
  const l = leaves.find((x) => x.path === path);
  if (l) return l.value;
  // caminho digitado à mão: tenta ler direto do exemplo
  let cur: unknown = sample;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = Array.isArray(cur) ? cur[Number(k)] : (cur as Record<string, unknown>)[k];
  }
  if (cur == null) return '';
  return typeof cur === 'object' ? JSON.stringify(cur).slice(0, 160) : String(cur);
}

/** Mapeamento igual? (para saber se há alterações não salvas) */
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Completa só os campos vazios com o que foi detectado. */
export function mergeDetected(cur: WebhookMapping, det: WebhookMapping): WebhookMapping {
  const out: WebhookMapping = { ...cur };
  for (const k of ['phone', 'name', 'email', 'amount', 'status', 'product', 'transaction', 'currency', 'state', 'event'] as const) {
    if (!out[k] && det[k]) out[k] = det[k];
  }
  if (out.amount === det.amount && det.amountInCents) out.amountInCents = true;
  return out;
}

export const fmtMoney = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
