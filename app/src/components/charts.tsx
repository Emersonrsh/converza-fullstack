export function AreaChart({ data, height = 180, color = 'var(--primary)' }:
  { data: number[]; height?: number; color?: string }) {
  const w = 720, h = height, pad = 10;
  const max = Math.max(...data, 1);
  const step = (w - pad * 2) / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2 - 14)] as const);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L ${pts[0][0].toFixed(1)} ${h - pad} Z`;
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.28" /><stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={pad} x2={w - pad} y1={(h - pad * 2 - 14) * f + pad} y2={(h - pad * 2 - 14) * f + pad}
          stroke="var(--border)" strokeWidth="1" />
      ))}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" />
    </svg>
  );
}

export function Bars({ data, labels, height = 180, color = 'var(--primary)' }:
  { data: number[]; labels?: string[]; height?: number; color?: string }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height, paddingTop: 10 }}>
      {data.map((v, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
          <div title={String(v)} style={{ width: '100%', maxWidth: 16, borderRadius: '5px 5px 0 0', background: v ? color : 'var(--surface-3)', height: `${Math.max(3, (v / max) * 100)}%`, transition: 'height .4s' }} />
          <span style={{ fontSize: 9.5, color: 'var(--faint)', fontWeight: 600 }}>{labels && i % 3 === 0 ? labels[i] : ' '}</span>
        </div>
      ))}
    </div>
  );
}
