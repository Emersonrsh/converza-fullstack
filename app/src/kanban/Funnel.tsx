import type { KColumn } from './types';

/**
 * Funil do topo do quadro: uma faixa por coluna, na cor dela, com o nome embaixo.
 * Com cards, a largura acompanha quantos cards há em cada coluna (mínimo para todas aparecerem).
 */
export function Funnel({ columns, small }: { columns: Pick<KColumn, 'id' | 'name' | 'color' | 'cards'>[]; small?: boolean }) {
  const total = columns.reduce((a, c) => a + (c.cards ?? 0), 0);
  const min = columns.length ? Math.min(14, 100 / columns.length) : 0;
  const raw = columns.map((c) => (total ? Math.max(min, ((c.cards ?? 0) / total) * 100) : 100 / Math.max(1, columns.length)));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const widths = raw.map((w) => (w / sum) * 100);
  return (
    <div className={`kb-funnel${small ? ' sm' : ''}`} aria-label={`Funil: ${columns.map((c) => `${c.name} (${c.cards ?? 0})`).join(', ')}`}>
      <div className="kb-funnel-bar">
        {columns.map((c, i) => <i key={c.id ?? i} style={{ width: `${widths[i]}%`, background: c.color }} title={`${c.name}: ${c.cards ?? 0}`} />)}
      </div>
      <div className="kb-funnel-lb">
        {columns.map((c, i) => <span key={c.id ?? i} style={{ width: `${widths[i]}%`, color: c.color }}>{c.name}</span>)}
      </div>
    </div>
  );
}
