import { useId } from 'react';

/** Avatares próprios do Converza: robozinhos com cores e expressões diferentes. */
type Eyes = 'round' | 'visor' | 'happy' | 'square';
type Mouth = 'smile' | 'grin' | 'flat';
const AV: Record<string, { c1: string; c2: string; eyes: Eyes; mouth: Mouth; label: string }> = {
  teal: { c1: '#14b8a6', c2: '#0f766e', eyes: 'round', mouth: 'smile', label: 'Verde-água' },
  indigo: { c1: '#818cf8', c2: '#4338ca', eyes: 'visor', mouth: 'flat', label: 'Índigo' },
  amber: { c1: '#fbbf24', c2: '#b45309', eyes: 'happy', mouth: 'grin', label: 'Âmbar' },
  rose: { c1: '#fb7185', c2: '#be123c', eyes: 'round', mouth: 'grin', label: 'Rosa' },
  emerald: { c1: '#34d399', c2: '#047857', eyes: 'square', mouth: 'smile', label: 'Esmeralda' },
  sky: { c1: '#38bdf8', c2: '#0369a1', eyes: 'happy', mouth: 'smile', label: 'Céu' },
  violet: { c1: '#a78bfa', c2: '#6d28d9', eyes: 'visor', mouth: 'smile', label: 'Violeta' },
  slate: { c1: '#94a3b8', c2: '#334155', eyes: 'square', mouth: 'flat', label: 'Grafite' },
};
export const AVATAR_KEYS = Object.keys(AV);
export const avatarLabel = (k: string) => AV[k]?.label ?? k;

export function AgentAvatar({ avatar, size = 44, title }: { avatar: string; size?: number; title?: string }) {
  const a = AV[avatar] ?? AV.teal;
  const gid = `ag${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="ag-av" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a.c1} /><stop offset="1" stopColor={a.c2} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill={`url(#${gid})`} />
      <line x1="32" y1="10" x2="32" y2="17" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" opacity=".9" />
      <circle cx="32" cy="9" r="3.2" fill="#fff" />
      <rect x="9" y="27" width="5" height="11" rx="2.5" fill="#fff" opacity=".75" />
      <rect x="50" y="27" width="5" height="11" rx="2.5" fill="#fff" opacity=".75" />
      <rect x="13" y="17" width="38" height="31" rx="11" fill="#fff" />
      {a.eyes === 'round' && <>
        <circle cx="25" cy="31" r="3.8" fill={a.c2} /><circle cx="39" cy="31" r="3.8" fill={a.c2} />
        <circle cx="26.2" cy="29.8" r="1.2" fill="#fff" /><circle cx="40.2" cy="29.8" r="1.2" fill="#fff" />
      </>}
      {a.eyes === 'visor' && <>
        <rect x="19.5" y="26.5" width="25" height="9.5" rx="4.75" fill={a.c2} />
        <circle cx="26" cy="31.25" r="1.8" fill="#fff" /><circle cx="38" cy="31.25" r="1.8" fill="#fff" />
      </>}
      {a.eyes === 'happy' && <>
        <path d="M21 32.5q4-5.5 8 0" stroke={a.c2} strokeWidth="3" fill="none" strokeLinecap="round" />
        <path d="M35 32.5q4-5.5 8 0" stroke={a.c2} strokeWidth="3" fill="none" strokeLinecap="round" />
      </>}
      {a.eyes === 'square' && <>
        <rect x="21.5" y="27.5" width="7" height="7" rx="1.8" fill={a.c2} /><rect x="35.5" y="27.5" width="7" height="7" rx="1.8" fill={a.c2} />
      </>}
      {a.mouth === 'smile' && <path d="M26 39.5q6 5 12 0" stroke={a.c2} strokeWidth="2.6" fill="none" strokeLinecap="round" />}
      {a.mouth === 'grin' && <rect x="25" y="38.5" width="14" height="5" rx="2.5" fill={a.c2} />}
      {a.mouth === 'flat' && <line x1="27" y1="41" x2="37" y2="41" stroke={a.c2} strokeWidth="2.6" strokeLinecap="round" />}
      <path d="M21 56c3-3.6 6.8-5.4 11-5.4s8 1.8 11 5.4" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".85" />
    </svg>
  );
}
