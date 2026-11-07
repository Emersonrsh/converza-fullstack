import type { ColumnKind, KColumn } from './types';

export const COLUMN_COLORS = ['#0e9488', '#2f73e0', '#6366f1', '#8b5cf6', '#db2777', '#e23b3b', '#ea580c', '#f59e0b', '#1a9f52', '#64748b'];
export const DEFAULT_PREVIEW: Pick<KColumn, 'name' | 'color' | 'kind'>[] = [
  { name: 'Novo', color: '#0e9488', kind: 'open' },
  { name: 'Qualificação', color: '#ea580c', kind: 'open' },
  { name: 'Ganho', color: '#6366f1', kind: 'won' },
];
export const KIND_LABEL: Record<ColumnKind, string> = { open: 'Em andamento', won: 'Ganho', lost: 'Perdido' };

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Nome da coluna com o tipo, quando o nome não diz ("Fechados (Ganho)"). */
export const columnLabel = (c: { name: string; kind: ColumnKind }) =>
  (c.kind === 'open' || fold(c.name).includes(fold(KIND_LABEL[c.kind])) ? c.name : `${c.name} (${KIND_LABEL[c.kind]})`);

/** "há cerca de 2 horas", "há 3 dias"… (como o date-fns em português). */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  const m = s / 60; const h = m / 60; const d = h / 24; const mo = d / 30;
  if (s < 30) return 'há menos de um minuto';
  if (m < 1.5) return 'há 1 minuto';
  if (m < 44.5) return `há ${Math.round(m)} minutos`;
  if (m < 89.5) return 'há cerca de 1 hora';
  if (h < 23.5) return `há cerca de ${Math.round(h)} horas`;
  if (h < 41.5) return 'há 1 dia';
  if (d < 29.5) return `há ${Math.round(d)} dias`;
  if (d < 44.5) return 'há cerca de 1 mês';
  if (mo < 11.5) return `há ${Math.round(mo)} meses`;
  const y = d / 365;
  return y < 1.5 ? 'há cerca de 1 ano' : `há cerca de ${Math.round(y)} anos`;
}

/** Tempo curto na etapa: "agora", "5 min", "3 h", "2 d". */
export function shortSince(iso: string, now = Date.now()): string {
  const m = Math.max(0, (now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${Math.floor(m)} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

export const dateBR = (ymd: string) => { const [y, mo, d] = ymd.split('-'); return `${d}/${mo}${y !== String(new Date().getFullYear()) ? `/${y.slice(2)}` : ''}`; };
export function dueState(ymd: string | null): 'none' | 'late' | 'today' | 'soon' | 'ok' {
  if (!ymd) return 'none';
  const today = new Date(); const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (ymd < t) return 'late';
  if (ymd === t) return 'today';
  const diff = (new Date(`${ymd}T00:00:00`).getTime() - new Date(`${t}T00:00:00`).getTime()) / 864e5;
  return diff <= 2 ? 'soon' : 'ok';
}

export const rateTone = (p: number) => (p >= 50 ? 'good' : p >= 20 ? 'mid' : 'low');
