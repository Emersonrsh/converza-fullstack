import { API_BASE, getAccountId, getToken } from '../api';
import type { ContactFiltersState, Origin } from './types';

export const STAGES: [string, string][] = [['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido']];
export const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES);
export const STAGE_TONE: Record<string, string> = { new: 'blue', in_service: 'amber', negotiating: 'teal', won: 'green', lost: 'red' };
export const ORIGINS: [Origin, string][] = [['whatsapp', 'WhatsApp'], ['ad', 'Anúncio (Meta)'], ['import', 'Importação CSV'], ['manual', 'Cadastro manual'], ['webhook', 'Integração']];
export const ORIGIN_LABEL: Record<string, string> = Object.fromEntries(ORIGINS);
export const ORIGIN_ICON: Record<string, string> = { whatsapp: 'chats', ad: 'megaphone', import: 'download', manual: 'user', webhook: 'webhook' };
export const STATUS_OPTIONS: [string, string][] = [
  ['', 'Todos os status'], ['active', 'Ativos (últimos 30 dias)'], ['inactive', 'Inativos (+30 dias)'], ['lead', 'Leads (sem compra)'], ['customer', 'Clientes (com compra)'],
];

export const EMPTY_FILTERS: ContactFiltersState = { q: '', status: '', origin: '', from: '', to: '', field: '', fieldValue: '', tags: [], columns: [], stages: [] };

/** Filtros → query string (listas repetem o parâmetro: tags=a&tags=b). */
export function filtersQuery(f: ContactFiltersState, extra: Record<string, string | number> = {}) {
  const qs = new URLSearchParams();
  (['q', 'status', 'origin', 'from', 'to', 'field'] as const).forEach((k) => { if (f[k]) qs.set(k, f[k]); });
  if (f.field && f.fieldValue) qs.set('fieldValue', f.fieldValue);
  f.tags.forEach((t) => qs.append('tags', t));
  f.columns.forEach((c) => qs.append('columns', c));
  f.stages.forEach((s) => qs.append('stages', s));
  Object.entries(extra).forEach(([k, v]) => qs.set(k, String(v)));
  return qs.toString();
}

/** Filtros → corpo JSON (exportação e ações em massa). */
export const filtersBody = (f: ContactFiltersState, ids?: string[]) => ({
  ...(f.q ? { q: f.q } : {}), ...(f.status ? { status: f.status } : {}), ...(f.origin ? { origin: f.origin } : {}),
  ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}),
  ...(f.field ? { field: f.field, ...(f.fieldValue ? { fieldValue: f.fieldValue } : {}) } : {}),
  ...(f.tags.length ? { tags: f.tags } : {}), ...(f.columns.length ? { columns: f.columns } : {}), ...(f.stages.length ? { stages: f.stages } : {}),
  ...(ids?.length ? { ids } : {}),
});

/** Quantos filtros do painel "Filtros" estão em uso. */
export const panelCount = (f: ContactFiltersState) =>
  (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.field ? 1 : 0) + (f.tags.length ? 1 : 0) + (f.columns.length ? 1 : 0) + (f.stages.length ? 1 : 0);

/** Resumo em português dos filtros (aparece nas exportações recentes). */
export function filtersLabel(f: ContactFiltersState, ctx: { fields: { key: string; label: string }[]; columns: Map<string, string> }, selected?: number) {
  if (selected) return `${selected} contato${selected === 1 ? '' : 's'} selecionado${selected === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (f.q) parts.push(`busca “${f.q}”`);
  if (f.status) parts.push(STATUS_OPTIONS.find(([k]) => k === f.status)?.[1] ?? f.status);
  if (f.origin) parts.push(`origem ${ORIGIN_LABEL[f.origin]}`);
  if (f.from || f.to) parts.push(`criados ${f.from ? `de ${br(f.from)}` : ''}${f.to ? ` até ${br(f.to)}` : ''}`.replace('criados  ', 'criados '));
  if (f.field) parts.push(`${ctx.fields.find((x) => x.key === f.field)?.label ?? f.field}${f.fieldValue ? ` contém “${f.fieldValue}”` : ' preenchido'}`);
  if (f.tags.length) parts.push(`etiquetas ${f.tags.join(', ')}`);
  if (f.stages.length) parts.push(`etapa ${f.stages.map((s) => STAGE_LABEL[s]).join(', ')}`);
  if (f.columns.length) parts.push(`Kanban: ${f.columns.map((c) => ctx.columns.get(c) ?? '?').join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Todos os contatos';
}
const br = (ymd: string) => ymd.split('-').reverse().join('/');

export const dateTimeBR = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const dateBR = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');

/** Baixa um arquivo da API com o login (cabeçalhos), respeitando o nome enviado pelo servidor. */
export async function downloadFromApi(path: string, fallback: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}`, 'x-account-id': getAccountId() ?? '' } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `Erro ${res.status}`);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  return name;
}

/** CSV salvo pelo Excel costuma vir em Windows-1252: tenta UTF-8 e cai para o padrão do Windows. */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
