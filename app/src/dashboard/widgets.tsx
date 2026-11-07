import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';

export type Tone = 'blue' | 'teal' | 'purple' | 'amber' | 'green' | 'red' | 'pink' | 'slate';
export const TONES: Record<Tone, string> = {
  blue: '#2f73e0', teal: '#0e9488', purple: '#8b5cf6', amber: '#f59e0b', green: '#1a9f52', red: '#e23b3b', pink: '#db2777', slate: '#64748b',
};

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="infotip" tabIndex={0} aria-label={text}>
      <Icon name="info" size={15} />
      <span className="infotip-b" role="tooltip">{text}</span>
    </span>
  );
}

export function KpiCard({ icon, tone, label, value, valueTone, trend, invertTrend, info, action, hideTrend, testId }: {
  icon: string; tone: Tone; label: string; value: string; valueTone?: Tone | null; trend: number; invertTrend?: boolean;
  info: string; action?: { icon: string; title: string; onClick: () => void }; hideTrend?: boolean; testId?: string;
}) {
  const up = trend > 0.05; const down = trend < -0.05;
  const good = invertTrend ? down : up;
  const bad = invertTrend ? up : down;
  return (
    <div className="card kcard" style={{ '--t': TONES[tone] } as CSSProperties} data-testid={testId}>
      <div className="kcard-top">
        <span className="kcard-ic"><Icon name={icon} size={16} /></span>
        <span className="spacer" />
        {action && (
          <button type="button" className="kcard-act" onClick={action.onClick} title={action.title} aria-label={action.title}>
            <Icon name={action.icon} size={14} />
          </button>
        )}
        {!hideTrend && (
          <span className={cx('ktrend', good && 'up', bad && 'down')} title="Comparado ao período anterior">
            <Icon name={up ? 'trendUp' : down ? 'trendDown' : 'trendUp'} size={12} stroke={2.4} />
            {`${trend > 0 ? '+' : ''}${trend.toFixed(1).replace('.', ',')}%`}
          </span>
        )}
      </div>
      <div className="kcard-v" style={valueTone ? { color: TONES[valueTone] } : undefined}>{value}</div>
      <div className="kcard-b">
        <span>{label}</span>
        <InfoTip text={info} />
      </div>
    </div>
  );
}

export function Panel({ title, sub, actions, children, className, testId }: {
  title: string; sub?: string; actions?: ReactNode; children: ReactNode; className?: string; testId?: string;
}) {
  return (
    <section className={cx('card dpanel', className)} data-testid={testId}>
      <header className="dpanel-h">
        <div><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
        {actions && <div className="dpanel-a">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function ValueQty({ value, onChange }: { value: 'valor' | 'qtd'; onChange: (v: 'valor' | 'qtd') => void }) {
  return (
    <div className="seg dseg">
      <button type="button" className={cx(value === 'valor' && 'active')} onClick={() => onChange('valor')}>Valor</button>
      <button type="button" className={cx(value === 'qtd' && 'active')} onClick={() => onChange('qtd')}>Qtd</button>
    </div>
  );
}

/** Bandeirinhas desenhadas (o Windows não mostra emoji de bandeira). */
export function Flag({ currency }: { currency: string }) {
  const c = currency.toUpperCase();
  if (c === 'BRL') return (
    <svg className="flag" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" rx="2" fill="#1a9f52" /><path d="M10 2 18 7 10 12 2 7Z" fill="#f7c600" /><circle cx="10" cy="7" r="2.6" fill="#1e3a8a" /></svg>
  );
  if (c === 'USD') return (
    <svg className="flag" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" rx="2" fill="#fff" />{[0, 2, 4, 6, 8, 10, 12].map((y) => <rect key={y} y={y} width="20" height="1" fill="#c8102e" />)}<rect width="9" height="7.5" fill="#1e3a8a" /></svg>
  );
  if (c === 'EUR') return (
    <svg className="flag" viewBox="0 0 20 14" aria-hidden="true"><rect width="20" height="14" rx="2" fill="#1e3a8a" /><circle cx="10" cy="7" r="3.6" fill="none" stroke="#f7c600" strokeWidth="1" strokeDasharray="1 1.25" /></svg>
  );
  return <span className="flag txt">{c.slice(0, 2)}</span>;
}

export function CurrencyPicker({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="dsel cur" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} data-testid="currency">
        <Flag currency={value} /><b>{value}</b><Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu fade" role="listbox" style={{ minWidth: 140 }}>
          {options.map((c) => (
            <button type="button" key={c} role="option" aria-selected={c === value} onClick={() => { onChange(c); setOpen(false); }}>
              <Flag currency={c} />{c}{c === value && <span className="spacer" />}{c === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function IconBtn({ icon, title, onClick, active, spinning, testId }: {
  icon: string; title: string; onClick: () => void; active?: boolean; spinning?: boolean; testId?: string;
}) {
  return (
    <button type="button" className={cx('dicon', active && 'on', spinning && 'spinning')} onClick={onClick} title={title} aria-label={title} data-testid={testId}>
      <Icon name={icon} size={16} />
    </button>
  );
}
