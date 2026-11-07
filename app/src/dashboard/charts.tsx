import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { fmtCompact, PALETTE } from './format';

/* Gráficos em SVG, responsivos e com tooltip ao passar o mouse. */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Escala "bonita" para o eixo Y (topo e passo). */
export function niceScale(max: number, integer: boolean, ticks = 4) {
  if (!(max > 0)) return { top: integer ? ticks : 1, step: integer ? 1 : 0.25 };
  const raw = max / ticks;
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { top: Math.ceil(max / step) * step, step };
}

export function EmptyChart({ children = 'Nenhum dado no período selecionado.', height = 140 }: { children?: ReactNode; height?: number }) {
  return <div className="chart-empty" style={{ minHeight: height }}>{children}</div>;
}

export interface LineSeries { key: string; name: string; color: string; format: (v: number) => string; }

export function TimeChart({ data, series, height = 230, integer = false, area = true }: {
  data: ({ label: string } & Record<string, number | string>)[]; series: LineSeries[]; height?: number; integer?: boolean; area?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 46, r: 14, t: 12, b: 28 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const values = data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0));
  const { top, step } = niceScale(Math.max(0, ...values), integer);
  const n = data.length;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const gid = `tg${useId().replace(/:/g, '')}`;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (n <= 1) { setHover(0); return; }
    setHover(Math.min(n - 1, Math.max(0, Math.round(((px - pad.l) / iw) * (n - 1)))));
  }

  const hx = hover === null ? 0 : x(hover);
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Gráfico temporal">
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={series[0]?.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={series[0]?.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="axis">{fmtCompact(t)}</text>
            </g>
          ))}
          {data.map((d, i) => ((i % every === 0 && (n - 1 - i >= every * 0.75 || i === n - 1)) || i === n - 1) && (
            <text key={i} x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="axis">{d.label}</text>
          ))}
          {series.map((s, si) => {
            const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(Number(d[s.key]) || 0).toFixed(1)}`);
            const line = `M${pts.join('L')}`;
            return (
              <g key={s.key}>
                {area && si === 0 && n > 1 && <path d={`${line}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#${gid})`} />}
                <path d={line} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hover !== null && (
            <g>
              <line x1={hx} x2={hx} y1={pad.t} y2={pad.t + ih} className="cursor" />
              {series.map((s) => <circle key={s.key} cx={hx} cy={y(Number(data[hover][s.key]) || 0)} r={4.5} fill="var(--surface)" stroke={s.color} strokeWidth={2.5} />)}
            </g>
          )}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <div className="chart-tip" style={{ left: Math.min(w - 190, Math.max(0, hx + 12)), top: 6 }}>
          <b>{data[hover].label}</b>
          {series.map((s) => (
            <div key={s.key}><i style={{ background: s.color }} />{s.name}: <b>{s.format(Number(data[hover][s.key]) || 0)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HourBars({ data, height = 230, color = 'var(--primary)', tooltip }: {
  data: { hour: number; value: number }[]; height?: number; color?: string; tooltip: (i: number) => ReactNode;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 30, r: 6, t: 12, b: 26 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const { top, step } = niceScale(Math.max(0, ...data.map((d) => d.value)), true);
  const slot = iw / data.length;
  const bw = Math.max(3, Math.min(18, slot * 0.62));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const every = slot < 22 ? 3 : slot < 30 ? 2 : 1;
  return (
    <div ref={ref} className="chart" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} onMouseLeave={() => setHover(null)} role="img" aria-label="Gráfico por horário">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="axis">{fmtCompact(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.l + slot * i + slot / 2;
            return (
              <g key={d.hour} onMouseEnter={() => setHover(i)}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
                <rect x={cx - bw / 2} y={y(d.value)} width={bw} height={Math.max(0, pad.t + ih - y(d.value))} rx={3}
                  fill={d.value ? color : 'var(--surface-3)'} opacity={hover === null || hover === i ? 1 : 0.55} />
                {d.value === 0 && <rect x={cx - bw / 2} y={pad.t + ih - 2} width={bw} height={2} rx={1} fill="var(--surface-3)" />}
                {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="axis">{String(d.hour).padStart(2, '0')}h</text>}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && w > 0 && (
        <div className="chart-tip" style={{ left: Math.min(w - 170, Math.max(0, pad.l + slot * hover + slot / 2 + 10)), top: 6 }}>
          {tooltip(hover)}
        </div>
      )}
    </div>
  );
}

export function HBarList({ items, color = 'var(--primary)', empty }: {
  items: { key: string; label: string; sub?: string | null; value: number; display: string }[]; color?: string; empty?: ReactNode;
}) {
  if (!items.length || items.every((i) => !i.value)) return <EmptyChart>{empty}</EmptyChart>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="hbars">
      {items.map((it) => (
        <div key={it.key} className="hbar">
          <div className="hbar-top">
            <span className="hbar-l"><b>{it.label}</b>{it.sub && <small>{it.sub}</small>}</span>
            <span className="hbar-v">{it.display}</span>
          </div>
          <div className="hbar-track"><i style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: color }} /></div>
        </div>
      ))}
    </div>
  );
}

export function Donut({ items, format, centerLabel, centerFormat }: {
  items: { key: string; label: string; value: number }[]; format: (v: number) => string; centerLabel: string;
  centerFormat?: (v: number) => string;
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return <EmptyChart />;
  const R = 54; const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width={150} height={150} role="img" aria-label="Participação no total">
        <circle cx={70} cy={70} r={R} fill="none" stroke="var(--surface-3)" strokeWidth={18} />
        {items.map((it, i) => {
          const len = (it.value / total) * C;
          const seg = <circle key={it.key} cx={70} cy={70} r={R} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={18}
            strokeDasharray={`${Math.max(0, len - 1.2)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 70 70)"><title>{`${it.label}: ${format(it.value)}`}</title></circle>;
          acc += len;
          return seg;
        })}
        <text x={70} y={66} textAnchor="middle" className="donut-c">{(centerFormat ?? format)(total)}</text>
        <text x={70} y={84} textAnchor="middle" className="axis">{centerLabel}</text>
      </svg>
      <div className="donut-legend">
        {items.map((it, i) => (
          <div key={it.key}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="nm" title={it.label}>{it.label}</span>
            <b>{format(it.value)}</b>
            <span className="faint">{((it.value / total) * 100).toFixed(1).replace('.', ',')}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
