import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { normalizePhone } from '../utils/phone';
import { findContactByPhone } from './contactStore';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { DEFAULT_COLUMNS, boardStats, positionFor, touchBoard, upsertContactCard, type ColumnKind } from './kanbanStore';
import { firePixels } from '../pixels/sender';

/**
 * Kanban: vários quadros (pipelines), cada um com colunas próprias (em andamento, ganho ou perdido)
 * e cards ligados a contatos. Tudo em tempo real ("kanban:changed").
 */
export const kanbanRouter = Router();

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
/** Consultas "cruas" devolvem datas como texto do Postgres: formata em ISO (UTC) para o navegador. */
const iso = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const COLOR = z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Cor inválida');
const KIND = z.enum(['open', 'won', 'lost']);
const uuid = z.string().uuid();

async function ownBoard(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Quadro não encontrado');
  const [b] = await db.select().from(schema.kanbanBoards)
    .where(and(eq(schema.kanbanBoards.id, id), eq(schema.kanbanBoards.accountId, accountId))).limit(1);
  if (!b) throw new AppError(404, 'Quadro não encontrado');
  return b;
}

async function ownColumn(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Coluna não encontrada');
  const [c] = await db.select().from(schema.kanbanColumns)
    .where(and(eq(schema.kanbanColumns.id, id), eq(schema.kanbanColumns.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Coluna não encontrada');
  return c;
}

async function ownCard(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Card não encontrado');
  const [c] = await db.select().from(schema.kanbanCards)
    .where(and(eq(schema.kanbanCards.id, id), eq(schema.kanbanCards.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Card não encontrado');
  return c;
}

async function ownMember(accountId: string, userId: string | null | undefined) {
  if (!userId) return null;
  const [m] = await db.select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.accountId, accountId), eq(schema.memberships.userId, userId))).limit(1);
  if (!m) throw new AppError(400, 'Essa pessoa não faz parte da equipe');
  return userId;
}

async function columnsOf(boardIds: string[]) {
  if (!boardIds.length) return [];
  return db.select().from(schema.kanbanColumns).where(inArray(schema.kanbanColumns.boardId, boardIds))
    .orderBy(asc(schema.kanbanColumns.position), asc(schema.kanbanColumns.createdAt));
}

async function countsByColumn(accountId: string, boardId?: string) {
  const list = await rows<{ column_id: string; n: string; v: string }>(sql`
    select column_id, count(*) as n, coalesce(sum(value), 0) as v from kanban_cards
    where account_id = ${accountId} ${boardId ? sql`and board_id = ${boardId}` : sql``}
    group by column_id`);
  return new Map(list.map((r) => [r.column_id, { n: Number(r.n), v: Number(r.v) }]));
}

const publicColumn = (c: typeof schema.kanbanColumns.$inferSelect, counts?: Map<string, { n: number; v: number }>) => ({
  id: c.id, name: c.name, color: c.color, kind: c.kind, position: c.position,
  ...(counts ? { cards: counts.get(c.id)?.n ?? 0, value: counts.get(c.id)?.v ?? 0 } : {}),
});

/* ------------------------------------------------------------------ quadros */

/** Lista de quadros com o funil (colunas), estatísticas e os totais do topo. */
kanbanRouter.get('/boards', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const boards = await db.select().from(schema.kanbanBoards).where(eq(schema.kanbanBoards.accountId, accountId))
    .orderBy(asc(schema.kanbanBoards.createdAt));
  const [cols, counts] = await Promise.all([columnsOf(boards.map((b) => b.id)), countsByColumn(accountId)]);
  const out = boards.map((b) => {
    const columns = cols.filter((c) => c.boardId === b.id);
    return {
      id: b.id, name: b.name, description: b.description, createdAt: b.createdAt, updatedAt: b.updatedAt,
      columns: columns.map((c) => publicColumn(c, counts)),
      stats: boardStats(columns.map((c) => ({ id: c.id, kind: c.kind as ColumnKind })), counts),
    };
  });
  const withCards = out.filter((b) => b.stats.cards > 0);
  res.json({
    boards: out,
    totals: {
      boards: out.length,
      cards: out.reduce((a, b) => a + b.stats.cards, 0),
      value: Math.round(out.reduce((a, b) => a + b.stats.value, 0) * 100) / 100,
      // média das taxas de conversão dos quadros que têm cards
      conversion: withCards.length ? Math.round((withCards.reduce((a, b) => a + b.stats.conversion, 0) / withCards.length) * 10) / 10 : 0,
    },
  });
}));

const boardBody = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao quadro').max(80),
  description: z.string().trim().max(300).optional().nullable(),
  columns: z.array(z.object({ name: z.string().trim().min(1).max(40), color: COLOR.optional(), kind: KIND.optional() })).min(1).max(20).optional(),
});

kanbanRouter.post('/boards', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = boardBody.parse(req.body);
  const [board] = await db.insert(schema.kanbanBoards).values({ accountId, name: d.name, description: d.description ?? null }).returning();
  const columns = d.columns ?? DEFAULT_COLUMNS;
  await db.insert(schema.kanbanColumns).values(columns.map((c, i) => ({
    accountId, boardId: board.id, name: c.name, color: c.color ?? DEFAULT_COLUMNS[i % DEFAULT_COLUMNS.length].color, kind: c.kind ?? 'open', position: i,
  })));
  await touchBoard(accountId, board.id);
  res.status(201).json({ board });
}));

/** Quadro aberto: colunas em ordem e todos os cards (com contato, responsável e conversa). */
kanbanRouter.get('/boards/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const board = await ownBoard(accountId, req.params.id);
  const [columns, counts] = await Promise.all([columnsOf([board.id]), countsByColumn(accountId, board.id)]);
  const cards = await rows(sql`
    select k.id, k.column_id as "columnId", k.title, k.value, k.notes, k.position, k.due_date as "dueDate",
      k.assigned_user_id as "assignedUserId", u.name as "assignedName",
      k.contact_id as "contactId", c.name as "contactName", c.phone as "contactPhone", coalesce(c.tags, '{}') as "contactTags",
      v.id as "conversationId", coalesce(v.unread_count, 0) as "unreadCount", ${iso('v.last_message_at')} as "lastMessageAt",
      ${iso('k.moved_at')} as "movedAt", ${iso('k.created_at')} as "createdAt", ${iso('k.updated_at')} as "updatedAt"
    from kanban_cards k
    left join contacts c on c.id = k.contact_id
    left join users u on u.id = k.assigned_user_id
    left join lateral (
      select id, unread_count, last_message_at from conversations where contact_id = k.contact_id order by last_message_at desc limit 1
    ) v on true
    where k.board_id = ${board.id}
    order by k.position asc, k.created_at asc`);
  res.json({
    board: { id: board.id, name: board.name, description: board.description, createdAt: board.createdAt, updatedAt: board.updatedAt },
    columns: columns.map((c) => publicColumn(c, counts)),
    stats: boardStats(columns.map((c) => ({ id: c.id, kind: c.kind as ColumnKind })), counts),
    cards: cards.map((k) => ({ ...k, value: Number(k.value), unreadCount: Number(k.unreadCount) })),
  });
}));

kanbanRouter.patch('/boards/:id', asyncHandler(async (req, res) => {
  const board = await ownBoard(req.accountId!, req.params.id);
  const d = boardBody.omit({ columns: true }).partial().parse(req.body);
  const [row] = await db.update(schema.kanbanBoards).set({
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.description !== undefined ? { description: d.description || null } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.kanbanBoards.id, board.id)).returning();
  await touchBoard(req.accountId!, board.id);
  res.json({ board: row });
}));

/** Duplica o quadro com as mesmas colunas (sem os cards). */
kanbanRouter.post('/boards/:id/duplicate', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const board = await ownBoard(accountId, req.params.id);
  const cols = await columnsOf([board.id]);
  const [copy] = await db.insert(schema.kanbanBoards).values({ accountId, name: `${board.name} (cópia)`.slice(0, 80), description: board.description }).returning();
  if (cols.length) {
    await db.insert(schema.kanbanColumns).values(cols.map((c, i) => ({ accountId, boardId: copy.id, name: c.name, color: c.color, kind: c.kind, position: i })));
  }
  await touchBoard(accountId, copy.id);
  res.status(201).json({ board: copy });
}));

kanbanRouter.delete('/boards/:id', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores excluem quadros');
  const board = await ownBoard(req.accountId!, req.params.id);
  await db.delete(schema.kanbanBoards).where(eq(schema.kanbanBoards.id, board.id));
  await touchBoard(req.accountId!, board.id);
  res.status(204).end();
}));

/* ------------------------------------------------------------------ colunas */

const columnBody = z.object({ name: z.string().trim().min(1, 'Dê um nome à coluna').max(40), color: COLOR.optional(), kind: KIND.optional() });

kanbanRouter.post('/boards/:id/columns', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const board = await ownBoard(accountId, req.params.id);
  const d = columnBody.parse(req.body);
  const [{ max }] = await rows<{ max: number | null }>(sql`select max(position) as max from kanban_columns where board_id = ${board.id}`);
  const count = (await columnsOf([board.id])).length;
  if (count >= 20) throw new AppError(400, 'Limite de 20 colunas por quadro');
  const [col] = await db.insert(schema.kanbanColumns).values({
    accountId, boardId: board.id, name: d.name, color: d.color ?? '#64748b', kind: d.kind ?? 'open', position: (max ?? -1) + 1,
  }).returning();
  await touchBoard(accountId, board.id);
  res.status(201).json({ column: publicColumn(col) });
}));

kanbanRouter.patch('/columns/:id', asyncHandler(async (req, res) => {
  const col = await ownColumn(req.accountId!, req.params.id);
  const d = columnBody.partial().parse(req.body);
  const [row] = await db.update(schema.kanbanColumns).set({
    ...(d.name !== undefined ? { name: d.name } : {}),
    ...(d.color !== undefined ? { color: d.color } : {}),
    ...(d.kind !== undefined ? { kind: d.kind } : {}),
  }).where(eq(schema.kanbanColumns.id, col.id)).returning();
  await touchBoard(req.accountId!, col.boardId);
  res.json({ column: publicColumn(row) });
}));

/** Nova ordem das colunas (ids na ordem desejada; precisa conter todas). */
kanbanRouter.put('/boards/:id/columns/order', asyncHandler(async (req, res) => {
  const board = await ownBoard(req.accountId!, req.params.id);
  const { ids } = z.object({ ids: z.array(uuid).min(1).max(20) }).parse(req.body);
  const cols = await columnsOf([board.id]);
  if (ids.length !== cols.length || new Set(ids).size !== ids.length || !ids.every((id) => cols.some((c) => c.id === id))) {
    throw new AppError(400, 'A lista de colunas não confere com o quadro');
  }
  await Promise.all(ids.map((id, i) => db.update(schema.kanbanColumns).set({ position: i }).where(eq(schema.kanbanColumns.id, id))));
  await touchBoard(req.accountId!, board.id);
  res.json({ ok: true });
}));

/**
 * Exclui a coluna. Se tiver cards: `moveTo` = coluna que recebe os cards, ou `deleteCards=1`.
 * O quadro precisa ficar com pelo menos uma coluna.
 */
kanbanRouter.delete('/columns/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const col = await ownColumn(accountId, req.params.id);
  const cols = await columnsOf([col.boardId]);
  if (cols.length <= 1) throw new AppError(400, 'O quadro precisa ter pelo menos uma coluna');
  const [{ n }] = await rows<{ n: string }>(sql`select count(*) as n from kanban_cards where column_id = ${col.id}`);
  if (Number(n) > 0) {
    const moveTo = typeof req.query.moveTo === 'string' ? req.query.moveTo : '';
    if (moveTo) {
      const target = cols.find((c) => c.id === moveTo && c.id !== col.id);
      if (!target) throw new AppError(400, 'Escolha outra coluna deste quadro para receber os cards');
      // vão para o fim da coluna de destino, mantendo a ordem
      const [{ max }] = await rows<{ max: number | null }>(sql`select max(position) as max from kanban_cards where column_id = ${target.id}`);
      await db.execute(sql`
        update kanban_cards k set column_id = ${target.id}, moved_at = now(), updated_at = now(),
          position = ${max ?? 0}::double precision + 1024 * s.rn
        from (select id, row_number() over (order by position, created_at) as rn from kanban_cards where column_id = ${col.id}) s
        where k.id = s.id`);
    } else if (req.query.deleteCards !== '1') {
      throw new AppError(409, `A coluna tem ${n} card(s): escolha para onde eles vão ou exclua os cards`);
    }
  }
  await db.delete(schema.kanbanColumns).where(eq(schema.kanbanColumns.id, col.id));
  const rest = cols.filter((c) => c.id !== col.id);
  await Promise.all(rest.map((c, i) => db.update(schema.kanbanColumns).set({ position: i }).where(eq(schema.kanbanColumns.id, c.id))));
  await touchBoard(accountId, col.boardId);
  res.status(204).end();
}));

/* -------------------------------------------------------------------- cards */

const cardFields = {
  title: z.string().trim().min(1, 'Dê um título ao card').max(120),
  value: z.number().min(0).max(100_000_000),
  notes: z.string().max(5000).nullable(),
  assignedUserId: uuid.nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullable(),
};

kanbanRouter.post('/boards/:id/cards', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const board = await ownBoard(accountId, req.params.id);
  const d = z.object({
    columnId: uuid,
    contactId: uuid.optional().nullable(),
    newContact: z.object({ name: z.string().trim().max(120).optional(), phone: z.string().trim().min(8).max(40) }).optional(),
    title: cardFields.title.optional(),
    value: cardFields.value.optional(),
    notes: cardFields.notes.optional(),
    assignedUserId: cardFields.assignedUserId.optional(),
    dueDate: cardFields.dueDate.optional(),
    top: z.boolean().optional(),
  }).parse(req.body);
  const col = await ownColumn(accountId, d.columnId);
  if (col.boardId !== board.id) throw new AppError(400, 'Essa coluna é de outro quadro');
  const assigned = await ownMember(accountId, d.assignedUserId);

  let contactId = d.contactId ?? null;
  let contactName: string | null = null;
  let contactValue = 0;
  if (d.newContact) {
    const phone = normalizePhone(d.newContact.phone);
    if (!phone) throw new AppError(400, 'Telefone inválido: use DDD + número (ex.: 11 98888-7777)');
    const name = d.newContact.name?.trim() || phone;
    const known = await findContactByPhone(accountId, phone);
    // contato que já existia só com o número no nome ganha o nome digitado
    const [c] = known
      ? (known.name === known.phone && name !== phone
        ? await db.update(schema.contacts).set({ name }).where(eq(schema.contacts.id, known.id)).returning()
        : [known])
      : await db.insert(schema.contacts).values({ accountId, name, phone, waId: phone })
        .onConflictDoUpdate({ target: [schema.contacts.accountId, schema.contacts.phone], set: { name: sql`case when ${schema.contacts.name} = ${schema.contacts.phone} then excluded.name else ${schema.contacts.name} end` } })
        .returning();
    contactId = c.id; contactName = c.name; contactValue = Number(c.value);
  } else if (contactId) {
    const [c] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
    if (!c) throw new AppError(404, 'Contato não encontrado');
    contactName = c.name; contactValue = Number(c.value);
  }
  if (contactId) {
    const [dup] = await db.select({ id: schema.kanbanCards.id, columnId: schema.kanbanCards.columnId }).from(schema.kanbanCards)
      .where(and(eq(schema.kanbanCards.boardId, board.id), eq(schema.kanbanCards.contactId, contactId))).limit(1);
    if (dup) {
      const [dc] = await db.select({ name: schema.kanbanColumns.name }).from(schema.kanbanColumns).where(eq(schema.kanbanColumns.id, dup.columnId)).limit(1);
      res.status(409).json({ error: `Esse contato já está neste quadro (coluna “${dc?.name ?? '?'}”)`, cardId: dup.id });
      return;
    }
  }
  const title = d.title ?? contactName;
  if (!title) throw new AppError(400, 'Dê um título ao card ou escolha um contato');
  const position = await positionFor(col.id, { top: !!d.top });
  const [card] = await db.insert(schema.kanbanCards).values({
    accountId, boardId: board.id, columnId: col.id, contactId, title,
    value: (d.value ?? contactValue).toFixed(2), notes: d.notes ?? null, assignedUserId: assigned, dueDate: d.dueDate ?? null, position,
  }).returning();
  await touchBoard(accountId, board.id);
  if (card.contactId) void firePixels(accountId, 'stage', { contactId: card.contactId, columnId: card.columnId });
  res.status(201).json({ card: { ...card, value: Number(card.value) } });
}));

kanbanRouter.patch('/cards/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const card = await ownCard(accountId, req.params.id);
  const d = z.object(cardFields).partial().parse(req.body);
  if (d.assignedUserId) await ownMember(accountId, d.assignedUserId);
  const [row] = await db.update(schema.kanbanCards).set({
    ...(d.title !== undefined ? { title: d.title } : {}),
    ...(d.value !== undefined ? { value: d.value.toFixed(2) } : {}),
    ...(d.notes !== undefined ? { notes: d.notes?.trim() ? d.notes : null } : {}),
    ...(d.assignedUserId !== undefined ? { assignedUserId: d.assignedUserId } : {}),
    ...(d.dueDate !== undefined ? { dueDate: d.dueDate } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.kanbanCards.id, card.id)).returning();
  await touchBoard(accountId, card.boardId);
  res.json({ card: { ...row, value: Number(row.value) } });
}));

/** Move o card (outra coluna e/ou outra posição). `afterId`/`beforeId` = vizinhos onde ele foi solto. */
kanbanRouter.post('/cards/:id/move', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const card = await ownCard(accountId, req.params.id);
  const d = z.object({ columnId: uuid, afterId: uuid.optional().nullable(), beforeId: uuid.optional().nullable(), top: z.boolean().optional() }).parse(req.body);
  const col = await ownColumn(accountId, d.columnId);
  if (col.boardId !== card.boardId) throw new AppError(400, 'O card só pode ser movido dentro do mesmo quadro');
  const position = await positionFor(col.id, { afterId: d.afterId, beforeId: d.beforeId, top: d.top, excludeCardId: card.id });
  const changedColumn = col.id !== card.columnId;
  const [row] = await db.update(schema.kanbanCards).set({
    columnId: col.id, position, updatedAt: new Date(), ...(changedColumn ? { movedAt: new Date() } : {}),
  }).where(eq(schema.kanbanCards.id, card.id)).returning();
  await touchBoard(accountId, card.boardId);
  if (changedColumn && row.contactId) void firePixels(accountId, 'stage', { contactId: row.contactId, columnId: row.columnId });
  res.json({ card: { ...row, value: Number(row.value) } });
}));

kanbanRouter.delete('/cards/:id', asyncHandler(async (req, res) => {
  const card = await ownCard(req.accountId!, req.params.id);
  await db.delete(schema.kanbanCards).where(eq(schema.kanbanCards.id, card.id));
  await touchBoard(req.accountId!, card.boardId);
  res.status(204).end();
}));

/* ---------------------------------------------- contato (Chats ao vivo) */

/** Em quais quadros o contato está + todos os quadros/colunas (para os seletores do painel). */
kanbanRouter.get('/contact/:contactId', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  if (!isUuid(req.params.contactId)) throw new AppError(404, 'Contato não encontrado');
  const [cards, boards] = await Promise.all([
    rows(sql`
      select k.id, k.board_id as "boardId", b.name as "boardName", k.column_id as "columnId", col.name as "columnName",
        col.color as "columnColor", col.kind as "columnKind", k.value, ${iso('k.moved_at')} as "movedAt"
      from kanban_cards k join kanban_boards b on b.id = k.board_id join kanban_columns col on col.id = k.column_id
      where k.account_id = ${accountId} and k.contact_id = ${req.params.contactId}
      order by b.created_at`),
    db.select({ id: schema.kanbanBoards.id, name: schema.kanbanBoards.name }).from(schema.kanbanBoards)
      .where(eq(schema.kanbanBoards.accountId, accountId)).orderBy(asc(schema.kanbanBoards.createdAt)),
  ]);
  const cols = await columnsOf(boards.map((b) => b.id));
  res.json({
    cards: cards.map((c) => ({ ...c, value: Number(c.value) })),
    boards: boards.map((b) => ({ ...b, columns: cols.filter((c) => c.boardId === b.id).map((c) => publicColumn(c)) })),
  });
}));

/** Coloca o contato num quadro/coluna (cria o card no topo ou move o existente). */
kanbanRouter.post('/contact/:contactId', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  if (!isUuid(req.params.contactId)) throw new AppError(404, 'Contato não encontrado');
  const d = z.object({ boardId: uuid, columnId: uuid }).parse(req.body);
  await ownBoard(accountId, d.boardId);
  const r = await upsertContactCard(accountId, req.params.contactId, d.boardId, d.columnId);
  if ('error' in r) throw new AppError(404, r.error ?? 'Não encontrado');
  res.status(r.created ? 201 : 200).json({ card: { ...r.card, value: Number(r.card.value) }, created: r.created, moved: r.moved });
}));
