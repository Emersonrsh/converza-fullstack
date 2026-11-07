import type { ChatItem, ChatMessage } from './types';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Horário na lista: "14:32", "Ontem", "seg", "06/11". */
export function listTime(iso: string): string {
  const d = new Date(iso); const now = new Date();
  if (sameDay(d, now)) return hhmm(d);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Ontem';
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export const msgTime = (iso: string) => hhmm(new Date(iso));

/** Separador de dia no histórico. */
export function dayLabel(iso: string): string {
  const d = new Date(iso); const now = new Date();
  if (sameDay(d, now)) return 'Hoje';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Ontem';
  // "1 de novembro" (sem "De Novembro": em português só a primeira letra da frase é maiúscula)
  const s = d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  const week = d.toLocaleDateString('pt-BR', { weekday: 'long' });
  const label = now.getTime() - d.getTime() < 6 * 864e5 ? `${week}, ${s}` : s;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const TYPE_LABEL: Record<string, string> = {
  image: '📷 Foto', video: '🎬 Vídeo', audio: '🎤 Áudio', document: '📄 Documento', sticker: '💟 Figurinha',
  location: '📍 Localização', contacts: '👤 Contato', template: '🧾 Modelo', unsupported: 'Mensagem não suportada',
};

export function previewOf(last: ChatItem['last']): string {
  if (!last) return 'Sem mensagens';
  const body = (last.body ?? '').replace(/\s+/g, ' ').trim();
  if (last.type === 'text') return body || 'Mensagem';
  if (last.type === 'document' && last.fileName) return `📄 ${last.fileName}`;
  const label = TYPE_LABEL[last.type] ?? 'Mensagem';
  return body && last.type !== 'location' ? `${label} · ${body}` : label;
}

export function fmtPhone(p: string | null | undefined): string {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return '';
  const br = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : null;
  if (!br) return `+${d}`;
  const rest = br.slice(2);
  const a = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
  return `+55 (${br.slice(0, 2)}) ${a}-${rest.slice(a.length)}`;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Variáveis das respostas rápidas. */
export function fillVars(text: string, contactName: string): string {
  return text.replace(/\{\{\s*primeiro_nome\s*\}\}/gi, firstName(contactName)).replace(/\{\{\s*nome\s*\}\}/gi, contactName);
}

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** Status só avança (enviada → entregue → lida); falha sempre vale. Eventos podem chegar fora de ordem. */
export function mergeStatus<T extends { status: string; error: string | null }>(old: T, status: string, error: string | null): T {
  if (status === 'failed') return { ...old, status, error: error ?? old.error };
  if (old.status === 'failed') return old;
  if ((RANK[status] ?? -1) < (RANK[old.status] ?? -1)) return old;
  return { ...old, status, error: null };
}

/** Trecho curto de uma mensagem citada. */
export function quoteText(q: { body: string | null; type: string; fileName: string | null }): string {
  const body = (q.body ?? '').replace(/\s+/g, ' ').trim();
  if (q.type === 'text' || q.type === 'template') return body || 'Mensagem';
  if (q.type === 'document') return `📄 ${q.fileName ?? 'Documento'}`;
  const label = TYPE_LABEL[q.type] ?? 'Mensagem';
  return body && q.type !== 'location' ? `${label} · ${body}` : label;
}

export function upsertMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return [...list, m].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const old = list[i];
  const copy = [...list];
  copy[i] = mergeStatus({ ...old, ...m, status: old.status, error: old.error, senderName: m.senderName ?? old.senderName, mediaUrl: m.mediaUrl ?? old.mediaUrl, reply: m.reply ?? old.reply }, m.status, m.error);
  return copy;
}

export const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤩', '🥳', '😉', '🙂', '🤔', '😅', '😢', '😭', '😡', '🙏', '👍', '👎', '👏', '🙌', '💪', '🤝', '👋', '✌️', '👌', '❤️', '💚', '💙', '🔥', '✨', '🎉', '✅', '❌', '⚠️', '💰', '💳', '📦', '🚚', '📅', '⏰', '📍', '📞', '💬', '🛒', '🎁', '⭐'];
