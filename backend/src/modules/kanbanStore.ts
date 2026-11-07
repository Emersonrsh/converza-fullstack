import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { firePixels } from '../pixels/sender';

/**
 * Regras do Kanban usadas pela API, pelo Chats ao vivo e pelos fluxos:
 * ordem dos cards (posição fracionária), "atualizado em" do quadro e
 * colocar/mover um contato num quadro.
 */

export type ColumnKind = 'open' | 'won' | 'lost';
export const DEFAULT_COLUMNS: { name: string; color: string; kind: ColumnKind }[] = [
  { name: 'Novo', color: '#0e9488', kind: 'open' },
  { name: 'Qualificação', color: '#ea580c', kind: 'open' },
  { name: 'Ganho', color: '#6366f1', kind: 'won' },
];

const GAP = 1024;
const MIN_GAP = 1e-6;

export async function touchBoard(accountId: string, boardId: string) {
  await db.update(schema.kanbanBoards).set({ updatedAt: new Date() }).where(eq(schema.kanbanBoards.id, boardId));
  emitToAccount(accountId, 'kanban:changed', { boardId });
}

async function columnPositions(columnId: string, excludeCardId?: string) {
  const rows = await db.select({ id: schema.kanbanCards.id, position: schema.kanbanCards.position }).from(schema.kanbanCards)
    .where(eq(schema.kanbanCards.columnId, columnId))
    .orderBy(asc(schema.kanbanCards.position), asc(schema.kanbanCards.createdAt));
  return excludeCardId ? rows.filter((r) => r.id !== excludeCardId) : rows;
}

async function renumber(list: { id: string }[]) {
  await Promise.all(list.map((c, i) => db.update(schema.kanbanCards).set({ position: (i + 1) * GAP }).where(eq(schema.kanbanCards.id, c.id))));
  return list.map((c, i) => ({ id: c.id, position: (i + 1) * GAP }));
}

/**
 * Posição para inserir um card numa coluna. `afterId` = card logo acima, `beforeId` = card logo abaixo
 * (com filtros na tela, os vizinhos visíveis podem não ser os vizinhos reais — usamos a ordem completa).
 */
export async function positionFor(columnId: string, opts: { afterId?: string | null; beforeId?: string | null; top?: boolean; excludeCardId?: string }) {
  let list = await columnPositions(columnId, opts.excludeCardId);
  const indexOf = (id?: string | null) => (id ? list.findIndex((c) => c.id === id) : -1);
  let idx: number;
  if (opts.top) idx = 0;
  else if (indexOf(opts.afterId) >= 0) idx = indexOf(opts.afterId) + 1;
  else if (indexOf(opts.beforeId) >= 0) idx = indexOf(opts.beforeId);
  else idx = list.length;

  const calc = () => {
    const prev = list[idx - 1];
    const next = list[idx];
    if (prev && next) return (prev.position + next.position) / 2;
    if (prev) return prev.position + GAP;
    if (next) return next.position - GAP;
    return GAP;
  };
  let pos = calc();
  const prev = list[idx - 1];
  const next = list[idx];
  if ((prev && Math.abs(pos - prev.position) < MIN_GAP) || (next && Math.abs(next.position - pos) < MIN_GAP)) {
    list = await renumber(list);
    pos = calc();
  }
  return pos;
}

/** Coloca o contato no quadro/coluna: cria o card (no topo) ou move o que já existe. */
export async function upsertContactCard(accountId: string, contactId: string, boardId: string, columnId: string) {
  const [col] = await db.select({ id: schema.kanbanColumns.id }).from(schema.kanbanColumns)
    .where(and(eq(schema.kanbanColumns.id, columnId), eq(schema.kanbanColumns.boardId, boardId), eq(schema.kanbanColumns.accountId, accountId))).limit(1);
  if (!col) return { error: 'Coluna não encontrada neste quadro' as const };
  const [contact] = await db.select({ id: schema.contacts.id, name: schema.contacts.name, phone: schema.contacts.phone, value: schema.contacts.value })
    .from(schema.contacts).where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
  if (!contact) return { error: 'Contato não encontrado' as const };

  const [existing] = await db.select().from(schema.kanbanCards)
    .where(and(eq(schema.kanbanCards.boardId, boardId), eq(schema.kanbanCards.contactId, contactId))).limit(1);
  if (existing) {
    if (existing.columnId === columnId) return { card: existing, created: false, moved: false };
    const position = await positionFor(columnId, { top: true, excludeCardId: existing.id });
    const [card] = await db.update(schema.kanbanCards).set({ columnId, position, movedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.kanbanCards.id, existing.id)).returning();
    await touchBoard(accountId, boardId);
    void firePixels(accountId, 'stage', { contactId, columnId });
    return { card, created: false, moved: true };
  }
  const position = await positionFor(columnId, { top: true });
  const [card] = await db.insert(schema.kanbanCards).values({
    accountId, boardId, columnId, contactId, title: contact.name || contact.phone, value: contact.value, position,
  }).onConflictDoNothing().returning();
  if (!card) { // outra requisição criou no mesmo instante
    const [again] = await db.select().from(schema.kanbanCards)
      .where(and(eq(schema.kanbanCards.boardId, boardId), eq(schema.kanbanCards.contactId, contactId))).limit(1);
    return { card: again, created: false, moved: false };
  }
  await touchBoard(accountId, boardId);
  void firePixels(accountId, 'stage', { contactId, columnId });
  return { card, created: true, moved: false };
}

/** Estatísticas de um quadro: cards, valor (sem os perdidos), conversões (colunas de ganho) e taxa. */
export function boardStats(columns: { id: string; kind: ColumnKind }[], counts: Map<string, { n: number; v: number }>) {
  let cards = 0; let value = 0; let won = 0;
  for (const c of columns) {
    const x = counts.get(c.id) ?? { n: 0, v: 0 };
    cards += x.n;
    if (c.kind !== 'lost') value += x.v;
    if (c.kind === 'won') won += x.n;
  }
  return { cards, value: Math.round(value * 100) / 100, won, conversion: cards ? Math.round((won / cards) * 1000) / 10 : 0 };
}

