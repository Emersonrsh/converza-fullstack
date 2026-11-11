import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { normalizePhone } from '../utils/phone';
import { findContactByPhone } from './contactStore';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { signedMediaPath } from '../utils/mediaSign';
import {
  markRead, mediaKind, sendMediaId, sendSticker, sendTemplate, sendText, uploadMedia, WhatsAppError, type MediaKind, type TemplateSend,
} from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';
import { ACTIVE_RUN_STATUSES, stopRunsForContact } from '../flows/runner';
import { ensureConversation, systemNote } from './conversationStore';
import { queueVisibility } from './queueRules';
import { FfmpegMissingError, toOggOpus } from '../utils/audio';
import { quickReplyFor, type QuickAction } from './quickReplies';
import { mediaIdFor } from './storedFiles';
import { normalizeState, render, scopeOf } from '../flows/interpreter';
import { flowExtras } from '../flows/globals';

export { ensureConversation } from './conversationStore';

/**
 * Chats ao vivo: fila (Aguardando / Atendendo / Resolvidos), busca e filtros,
 * ações de atendimento e envio de mensagens (texto, mídia, modelos e notas internas).
 */
export const conversationsRouter = Router();

type Conv = typeof schema.conversations.$inferSelect;
const WINDOW_MS = 24 * 3600 * 1000;
const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];

async function ownConversation(accountId: string, id: string): Promise<Conv> {
  if (!isUuid(id)) throw new AppError(404, 'Conversa não encontrada');
  const [conv] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.id, id), eq(schema.conversations.accountId, accountId))).limit(1);
  if (!conv) throw new AppError(404, 'Conversa não encontrada');
  return conv;
}

async function setConv(accountId: string, id: string, patch: Partial<typeof schema.conversations.$inferInsert>) {
  const [row] = await db.update(schema.conversations).set(patch).where(eq(schema.conversations.id, id)).returning();
  emitToAccount(accountId, 'conversation:updated', { conversation: row });
  return row;
}

async function userName(id: string) {
  const [u] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  return u?.name ?? 'Alguém';
}

/* ------------------------------------------------------------------ lista */

const listQuery = z.object({
  tab: z.enum(['waiting', 'attending', 'resolved']).default('waiting'),
  q: z.string().trim().max(100).optional(),
  chip: z.enum(['all', 'unread', 'unanswered']).default('all'),
  connectionId: z.string().uuid().optional().or(z.literal('')),
  tag: z.string().trim().max(60).optional(),
  stage: z.enum(['new', 'in_service', 'negotiating', 'won', 'lost']).optional().or(z.literal('')),
  assignee: z.string().trim().max(40).optional(),
  // setor: id do setor ou "none" (fila geral)
  department: z.string().trim().max(40).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(5).max(100).default(40),
});

const TAB_SQL: Record<string, SQL> = {
  waiting: sql`v.status <> 'resolved' and v.assigned_user_id is null`,
  attending: sql`v.status <> 'resolved' and v.assigned_user_id is not null`,
  resolved: sql`v.status = 'resolved'`,
};

/** Setor de quem pede: atendentes com setor só veem a fila do próprio setor (e a geral) em Aguardando. */
async function viewerDepartment(req: Request) {
  if (req.role !== 'agent') return { manager: true, departmentId: null as string | null };
  const [m] = await db.select({ d: schema.memberships.departmentId }).from(schema.memberships)
    .where(and(eq(schema.memberships.accountId, req.accountId!), eq(schema.memberships.userId, req.user!.id))).limit(1);
  return { manager: false, departmentId: m?.d ?? null };
}

/** Fila do setor: em Aguardando, conversa de um setor só aparece para os membros dele e para os gestores. */
export { queueVisibility } from './queueRules';

conversationsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const f = listQuery.parse(req.query);
  const viewer = await viewerDepartment(req);
  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const tz = acc?.tz || 'America/Sao_Paulo';

  // filtros comuns (as contagens das abas respeitam busca e filtros)
  const base: SQL[] = [sql`v.account_id = ${accountId}`, queueVisibility(viewer)];
  if (f.q) {
    const like = `%${f.q}%`;
    const digits = f.q.replace(/\D/g, '');
    base.push(sql`(c.name ilike ${like} or c.phone ilike ${like}
      ${digits.length >= 3 ? sql`or regexp_replace(c.phone, '[^0-9]', '', 'g') like ${`%${digits}%`}` : sql``}
      or exists (select 1 from messages m2 where m2.conversation_id = v.id and m2.body ilike ${like}))`);
  }
  if (f.connectionId) base.push(sql`v.connection_id = ${f.connectionId}`);
  if (f.tag) base.push(sql`${f.tag} = any(c.tags)`);
  if (f.stage) base.push(sql`c.stage = ${f.stage}`);
  if (f.assignee === 'me') base.push(sql`v.assigned_user_id = ${req.user!.id}`);
  else if (f.assignee === 'none') base.push(sql`v.assigned_user_id is null`);
  else if (f.assignee && isUuid(f.assignee)) base.push(sql`v.assigned_user_id = ${f.assignee}`);
  if (f.department === 'none') base.push(sql`v.department_id is null`);
  else if (f.department && isUuid(f.department)) base.push(sql`v.department_id = ${f.department}`);
  if (f.from) base.push(sql`v.last_message_at >= (${f.from}::date::timestamp at time zone ${tz})`);
  if (f.to) base.push(sql`v.last_message_at < ((${f.to}::date + 1)::timestamp at time zone ${tz})`);

  const chip: SQL[] = [];
  if (f.chip === 'unread') chip.push(sql`v.unread_count > 0`);
  if (f.chip === 'unanswered') chip.push(sql`lm.direction = 'in'`);

  const lateral = sql`left join lateral (
      select m.id, m.body, m.type, m.direction, m.status, m.created_at, m.file_name
      from messages m where m.conversation_id = v.id and m.type <> 'note'
      order by m.created_at desc limit 1
    ) lm on true`;
  const where = sql.join([...base, TAB_SQL[f.tab], ...chip, ...(f.before ? [sql`v.last_message_at < ${f.before}`] : [])], sql` and `);

  const [list, [counts]] = await Promise.all([
    rows(sql`select v.id, v.status, v.bot_paused as "botPaused", v.unread_count as "unreadCount",
        to_char(v.last_message_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastMessageAt",
        v.connection_id as "connectionId", cn.name as "connectionName",
        v.assigned_user_id as "assignedUserId", u.name as "assignedName",
        v.department_id as "departmentId", dp.name as "departmentName", dp.color as "departmentColor",
        c.id as "contactId", c.name as "contactName", c.phone as "contactPhone", c.tags as "contactTags", c.stage as "contactStage",
        lm.id as "lastId", lm.body as "lastBody", lm.type as "lastType", lm.direction as "lastDirection", lm.status as "lastStatus", lm.file_name as "lastFileName"
      from conversations v
      join contacts c on c.id = v.contact_id
      left join connections cn on cn.id = v.connection_id
      left join users u on u.id = v.assigned_user_id
      left join departments dp on dp.id = v.department_id
      ${lateral}
      where ${where}
      order by v.last_message_at desc
      limit ${f.limit + 1}`),
    rows(sql`select
        count(*) filter (where ${TAB_SQL.waiting}) as waiting,
        count(*) filter (where ${TAB_SQL.attending}) as attending,
        count(*) filter (where ${TAB_SQL.resolved}) as resolved,
        count(*) filter (where v.status <> 'resolved' and v.unread_count > 0) as unread
      from conversations v join contacts c on c.id = v.contact_id
      where ${sql.join(base, sql` and `)}`),
  ]);

  const more = list.length > f.limit;
  const page = more ? list.slice(0, f.limit) : list;
  res.json({
    conversations: page.map((x) => ({
      id: x.id, status: x.status, botPaused: x.botPaused, unreadCount: Number(x.unreadCount), lastMessageAt: x.lastMessageAt,
      connectionId: x.connectionId, connectionName: x.connectionName, assignedUserId: x.assignedUserId, assignedName: x.assignedName,
      departmentId: x.departmentId, departmentName: x.departmentName, departmentColor: x.departmentColor,
      contactId: x.contactId, contactName: x.contactName, contactPhone: x.contactPhone, contactTags: x.contactTags ?? [], stage: x.contactStage,
      last: x.lastType ? { id: x.lastId, body: x.lastBody, type: x.lastType, direction: x.lastDirection, status: x.lastStatus, fileName: x.lastFileName } : null,
      awaitingReply: x.lastDirection === 'in',
    })),
    counts: { waiting: Number(counts?.waiting ?? 0), attending: Number(counts?.attending ?? 0), resolved: Number(counts?.resolved ?? 0), unread: Number(counts?.unread ?? 0) },
    nextBefore: more ? page[page.length - 1].lastMessageAt : null,
  });
}));

/* ------------------------------------------------------------ nova conversa */

conversationsRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = z.object({
    contactId: z.string().uuid().optional(),
    phone: z.string().trim().max(40).optional(),
    name: z.string().trim().max(120).optional(),
    connectionId: z.string().uuid(),
  }).parse(req.body);
  const [conn] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.id, d.connectionId), eq(schema.connections.accountId, accountId))).limit(1);
  if (!conn) throw new AppError(400, 'Escolha a conexão (número) para conversar');

  let contactId = d.contactId ?? null;
  if (contactId) {
    const [c] = await db.select({ id: schema.contacts.id }).from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
    if (!c) throw new AppError(404, 'Contato não encontrado');
  } else {
    const phone = normalizePhone(d.phone);
    if (!phone) throw new AppError(400, 'Telefone inválido: use DDD + número (ex.: 11 98888-7777)');
    // o número pode já ser de um contato (inclusive escrito com/sem o 9): usa esse
    const known = await findContactByPhone(accountId, phone);
    if (known) contactId = known.id;
    else {
      const [c] = await db.insert(schema.contacts).values({
        accountId, name: d.name || phone, phone, waId: phone, firstConnectionId: conn.id,
      }).onConflictDoUpdate({ target: [schema.contacts.accountId, schema.contacts.phone], set: { phone } }).returning();
      contactId = c.id;
    }
  }

  let conv = await ensureConversation(accountId, contactId, conn.id);
  conv = await setConv(accountId, conv.id, {
    connectionId: conn.id,
    ...(conv.status === 'resolved' || !conv.assignedUserId ? { status: 'open' as const, assignedUserId: req.user!.id, botPaused: true } : {}),
  });
  res.status(201).json({ conversation: conv });
}));

/* ------------------------------------------------------------------ detalhe */

conversationsRouter.get('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  const [[contact], [conn], [last]] = await Promise.all([
    db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1),
    conv.connectionId
      ? db.select({ id: schema.connections.id, name: schema.connections.name, displayPhone: schema.connections.displayPhone, status: schema.connections.status, wabaId: schema.connections.wabaId, provider: schema.connections.provider })
        .from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1)
      : Promise.resolve([]),
    rows<{ at: Date | null }>(sql`select max(created_at) as at from messages where conversation_id = ${conv.id} and direction = 'in'`),
  ]);
  const lastInboundAt = last?.at ? new Date(last.at) : null;
  res.json({
    conversation: conv,
    contact,
    connection: conn ? { id: conn.id, name: conn.name, displayPhone: conn.displayPhone, status: conn.status, hasWaba: !!conn.wabaId, provider: conn.provider } : null,
    assignedName: conv.assignedUserId ? await userName(conv.assignedUserId) : null,
    department: conv.departmentId
      ? (await db.select({ id: schema.departments.id, name: schema.departments.name, color: schema.departments.color }).from(schema.departments)
        .where(eq(schema.departments.id, conv.departmentId)).limit(1))[0] ?? null
      : null,
    lastInboundAt,
    // QR Code (WhatsApp Web) não tem a regra das 24h da Cloud API: dá para escrever a qualquer momento
    windowOpen: conn?.provider === 'web' || (!!lastInboundAt && Date.now() - lastInboundAt.getTime() < WINDOW_MS),
    windowClosesAt: conn?.provider === 'web' ? null : lastInboundAt ? new Date(lastInboundAt.getTime() + WINDOW_MS) : null,
  });
}));

/* -------------------------------------------------------------- mensagens */

function withMedia(req: Request, m: typeof schema.messages.$inferSelect & { senderName?: string | null }) {
  const base = publicBase(req, config.publicApiUrl);
  return { ...m, mediaUrl: m.waMediaId ? `${base}${signedMediaPath(m.id)}` : m.mediaUrl };
}

type ReplyPreview = { id: string; body: string | null; type: string; direction: 'in' | 'out'; fileName: string | null; senderUserId: string | null };
/** Resumo das mensagens citadas ("responder"), para mostrar o trecho em cima da resposta. */
async function replyPreviews(ids: (string | null | undefined)[]): Promise<Map<string, ReplyPreview>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const m = schema.messages;
  const list = await db.select({ id: m.id, body: m.body, type: m.type, direction: m.direction, fileName: m.fileName, senderUserId: m.senderUserId })
    .from(m).where(inArray(m.id, uniq));
  return new Map(list.map((r) => [r.id, r]));
}

/** A mensagem citada precisa ser desta conversa; devolve o wamid para o "context" do WhatsApp. */
async function quotedOf(conv: Conv, replyToId: string | null | undefined) {
  if (!replyToId) return null;
  const [q] = await db.select({ id: schema.messages.id, waMessageId: schema.messages.waMessageId, type: schema.messages.type })
    .from(schema.messages).where(and(eq(schema.messages.id, replyToId), eq(schema.messages.conversationId, conv.id))).limit(1);
  if (!q || q.type === 'note') throw new AppError(400, 'A mensagem citada não é desta conversa');
  return q;
}

conversationsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const conv = await ownConversation(req.accountId!, req.params.id);
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 60));
  const list = await db.select({ m: schema.messages, senderName: schema.users.name, agentName: schema.agents.name }).from(schema.messages)
    .leftJoin(schema.users, eq(schema.users.id, schema.messages.senderUserId))
    .leftJoin(schema.agents, eq(schema.agents.id, schema.messages.agentId))
    .where(and(eq(schema.messages.conversationId, conv.id), ...(before ? [sql`${schema.messages.createdAt} < ${before}`] : [])))
    .orderBy(desc(schema.messages.createdAt)).limit(limit + 1);
  const more = list.length > limit;
  const page = (more ? list.slice(0, limit) : list).reverse();
  const previews = await replyPreviews(page.map((r) => r.m.replyToId));
  res.json({
    conversation: conv,
    messages: page.map((r) => ({
      ...withMedia(req, { ...r.m, senderName: r.senderName }),
      agentName: r.agentName ?? null,
      reply: r.m.replyToId ? previews.get(r.m.replyToId) ?? null : null,
    })),
    hasMore: more,
  });
}));

/** Zera as não lidas e manda o "lido" (tique azul) para o WhatsApp do cliente. */
conversationsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  if (conv.unreadCount > 0) {
    await setConv(accountId, conv.id, { unreadCount: 0 });
    const [lastIn] = await db.select({ wa: schema.messages.waMessageId }).from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'in'), sql`${schema.messages.waMessageId} is not null`))
      .orderBy(desc(schema.messages.createdAt)).limit(1);
    const conn = await connectionOf(conv);
    if (lastIn?.wa && conn) void markRead(conn, lastIn.wa);
  }
  res.json({ ok: true });
}));

async function connectionOf(conv: Conv) {
  if (!conv.connectionId) return null;
  const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1);
  return c ? { phoneNumberId: c.phoneNumberId, accessToken: c.accessToken, wabaId: c.wabaId } : null;
}

async function recipientOf(conv: Conv) {
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  if (!contact) throw new AppError(404, 'Contato não encontrado');
  return contact.waId ?? contact.phone.replace(/\D/g, '');
}

async function isWebConversation(conv: Conv) {
  if (!conv.connectionId) return false;
  const [c] = await db.select({ provider: schema.connections.provider }).from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1);
  return c?.provider === 'web';
}

async function windowOpen(conv: Conv) {
  if (await isWebConversation(conv)) return true; // QR Code: sem janela de 24h
  const [r] = await rows<{ at: Date | null }>(sql`select max(created_at) as at from messages where conversation_id = ${conv.id} and direction = 'in'`);
  return !!r?.at && Date.now() - new Date(r.at).getTime() < WINDOW_MS;
}

/** Quem responde assume a conversa (sai de "Aguardando" e pausa a automação). */
async function autoAssign(accountId: string, conv: Conv, userId: string) {
  if (conv.assignedUserId && conv.status !== 'resolved') return conv;
  return setConv(accountId, conv.id, { assignedUserId: userId, status: 'open', botPaused: true });
}

type Outgoing = { type: 'text' | 'template' | 'sticker' | MediaKind; body: string | null; waMediaId?: string | null; mediaUrl?: string | null; mimeType?: string | null; fileName?: string | null; replyToId?: string | null };

/** Grava a mensagem, tenta enviar e guarda o resultado (inclusive o motivo da falha). */
async function deliver(req: Request, conv: Conv, out: Outgoing, send: (conn: { phoneNumberId: string | null; accessToken: string | null }, to: string) => Promise<{ waMessageId: string | null; waId?: string | null }>) {
  const accountId = req.accountId!;
  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'out', type: out.type, body: out.body,
    waMediaId: out.waMediaId ?? null, mediaUrl: out.mediaUrl ?? null, mimeType: out.mimeType ?? null, fileName: out.fileName ?? null,
    replyToId: out.replyToId ?? null, status: 'queued', senderUserId: req.user!.id,
  }).returning();
  const reply = out.replyToId ? (await replyPreviews([out.replyToId])).get(out.replyToId) ?? null : null;
  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: { ...withMedia(req, msg), reply } });

  let status: 'sent' | 'failed' = 'sent';
  let waMessageId: string | null = null;
  let error: string | null = null;
  try {
    const conn = await connectionOf(conv);
    if (!conn) throw new WhatsAppError('Esta conversa não tem um número de WhatsApp conectado. Escolha a conexão em "Nova conversa".');
    const to = await recipientOf(conv);
    const r = await send(conn, to);
    waMessageId = r.waMessageId;
    // o WhatsApp devolve o wa_id "oficial" do número (ex.: celular antigo sem o 9): guarda para reconhecer a resposta
    if (r.waId && r.waId !== to) await db.update(schema.contacts).set({ waId: r.waId }).where(eq(schema.contacts.id, conv.contactId));
  } catch (err) {
    status = 'failed';
    error = (err as Error).message;
  }
  const [updated] = await db.update(schema.messages).set({ status, waMessageId, error }).where(eq(schema.messages.id, msg.id)).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
  emitToAccount(accountId, 'message:status', { conversationId: conv.id, id: updated.id, status, error, waMessageId });
  return { ...withMedia(req, updated), reply };
}

const OUTSIDE_WINDOW = 'Fora da janela de 24h: o cliente não fala com você há mais de 24 horas. Envie um modelo de mensagem aprovado.';

conversationsRouter.post('/:id/messages', asyncHandler(async (req, res) => {
  const { body, replyToId } = z.object({
    body: z.string().trim().min(1).max(4096),
    replyToId: z.string().uuid().optional().nullable(),
  }).parse(req.body);
  let conv = await ownConversation(req.accountId!, req.params.id);
  if (!(await windowOpen(conv))) throw new AppError(422, OUTSIDE_WINDOW);
  const quoted = await quotedOf(conv, replyToId);
  conv = await autoAssign(req.accountId!, conv, req.user!.id);
  const message = await deliver(req, conv, { type: 'text', body, replyToId: quoted?.id },
    (c, to) => sendText(c, to, body, quoted?.waMessageId));
  res.status(201).json({ message });
}));

/** Texto da resposta rápida já com as variáveis do contato (para o rascunho no Chats ao vivo). */
conversationsRouter.get('/:id/quick-replies/:qrId/render', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  const qr = await quickReplyFor(accountId, req.params.qrId);
  if (!qr) throw new AppError(404, 'Resposta rápida não encontrada');
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  const scope = scopeOf({ name: contact.name, phone: contact.phone, stage: contact.stage, tags: contact.tags, email: contact.email, custom: (contact.custom ?? {}) as Record<string, unknown> },
    normalizeState({}), await flowExtras(accountId));
  const texts = (qr.actions as QuickAction[]).filter((a) => a.type === 'text').map((a) => render(a.text ?? '', scope).trim()).filter(Boolean);
  res.json({ text: texts.join('\n\n') });
}));

/**
 * Resposta rápida com anexos: envia todas as ações em ordem (texto com as variáveis do contato).
 * Para na primeira que falhar, para não chegar fora de ordem.
 */
conversationsRouter.post('/:id/quick-replies/:qrId', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  let conv = await ownConversation(accountId, req.params.id);
  const qr = await quickReplyFor(accountId, req.params.qrId);
  if (!qr) throw new AppError(404, 'Resposta rápida não encontrada');
  if (!(await windowOpen(conv))) throw new AppError(422, OUTSIDE_WINDOW);
  const connRow = conv.connectionId
    ? (await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1))[0]
    : undefined;
  if (!connRow) throw new AppError(422, 'Esta conversa não tem um número de WhatsApp conectado.');
  conv = await autoAssign(accountId, conv, req.user!.id);
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  const scope = scopeOf({ name: contact.name, phone: contact.phone, stage: contact.stage, tags: contact.tags, email: contact.email, custom: (contact.custom ?? {}) as Record<string, unknown> },
    normalizeState({}), await flowExtras(accountId));
  const sent: unknown[] = [];
  for (const a of qr.actions as QuickAction[]) {
    let msg: { status: string; error?: string | null } & Record<string, unknown>;
    if (a.type === 'text') {
      const text = render(a.text ?? '', scope).trim();
      if (!text) continue;
      msg = await deliver(req, conv, { type: 'text', body: text }, (c, to) => sendText(c, to, text));
    } else {
      const [f] = await db.select({ mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName }).from(schema.storedFiles)
        .where(eq(schema.storedFiles.id, a.fileId ?? '')).limit(1);
      let mediaId: string | null = null;
      let upErr: string | null = null;
      try { mediaId = await mediaIdFor(a.fileId!, connRow, { asVoice: a.type === 'audio' }); } catch (err) { upErr = (err as Error).message; }
      const caption = a.caption ? render(a.caption, scope) : null;
      const kind = a.type;
      msg = await deliver(req, conv, { type: kind, body: caption, waMediaId: mediaId, mimeType: f?.mime ?? null, fileName: f?.fileName ?? null },
        (c, to) => {
          if (!mediaId) throw new WhatsAppError(upErr ?? 'O anexo não pôde ser enviado para o WhatsApp.');
          return kind === 'sticker' ? sendSticker(c, to, mediaId) : sendMediaId(c, to, kind, mediaId, caption ?? undefined, f?.fileName, { voice: kind === 'audio' });
        });
    }
    sent.push(msg);
    if (msg.status === 'failed') break;
  }
  res.status(201).json({ messages: sent });
}));

const KIND_LIMIT: Record<MediaKind, number> = { image: 5, video: 16, audio: 16, document: 30 };
export { mediaKind };

/**
 * Envio de arquivo: o corpo da requisição é o próprio arquivo (até 16 MB; documentos até 30 MB).
 * `?voice=1`: áudio gravado no app — é convertido para Ogg/Opus e vai como mensagem de voz.
 */
conversationsRouter.post('/:id/media', express.raw({ type: () => true, limit: '31mb' }), asyncHandler(async (req, res) => {
  let data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'Arquivo vazio');
  // o app manda o arquivo como octet-stream e o tipo real em x-file-type (evita outros parsers)
  let mime = String(req.headers['x-file-type'] ?? req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  let fileName = String(req.query.filename ?? 'arquivo').replace(/[\r\n"]/g, '').slice(0, 120) || 'arquivo';
  const caption = String(req.query.caption ?? '').slice(0, 1024) || null;
  const voice = req.query.voice === '1';
  const replyToId = typeof req.query.replyToId === 'string' && isUuid(req.query.replyToId) ? req.query.replyToId : null;

  let conv = await ownConversation(req.accountId!, req.params.id);
  if (!(await windowOpen(conv))) throw new AppError(422, OUTSIDE_WINDOW);
  const conn = await connectionOf(conv);
  if (!conn) throw new AppError(422, 'Esta conversa não tem um número de WhatsApp conectado.');
  const quoted = await quotedOf(conv, replyToId);

  // áudio gravado (WebM do Chrome, MP4 do Safari…) → Ogg/Opus, o formato de mensagem de voz
  if (voice || /^audio\/webm$/.test(mime)) {
    if (!mime.startsWith('audio/')) throw new AppError(400, 'O áudio gravado veio num formato inesperado');
    try {
      data = await toOggOpus(data);
    } catch (err) {
      throw new AppError(422, err instanceof FfmpegMissingError ? err.message : (err as Error).message);
    }
    mime = 'audio/ogg';
    fileName = `${fileName.replace(/\.[^.]*$/, '') || 'audio'}.ogg`;
  }
  const kind = mediaKind(mime);
  if (data.length > KIND_LIMIT[kind] * 1024 * 1024) throw new AppError(413, `Arquivo grande demais: o limite para ${kind === 'image' ? 'imagens' : 'este tipo'} é ${KIND_LIMIT[kind]} MB`);

  let mediaId: string;
  try { mediaId = await uploadMedia(conn, data, mime, fileName); } catch (err) { throw new AppError(502, (err as Error).message); }
  conv = await autoAssign(req.accountId!, conv, req.user!.id);
  const message = await deliver(req, conv, { type: kind, body: kind === 'audio' ? null : caption, waMediaId: mediaId, mimeType: mime, fileName, replyToId: quoted?.id },
    (c, to) => sendMediaId(c, to, kind, mediaId, caption ?? undefined, fileName, { voice: voice && kind === 'audio', contextId: quoted?.waMessageId }));
  res.status(201).json({ message });
}));

/** Modelo de mensagem aprovado (funciona fora da janela de 24h e para iniciar conversas). */
const templateBody = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  body: z.array(z.object({ name: z.string().max(60).optional(), value: z.string().trim().min(1).max(1024) })).max(30).optional(),
  /** formato antigo: só as variáveis do corpo, na ordem */
  params: z.array(z.string().trim().min(1).max(1024)).max(30).optional(),
  header: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), name: z.string().max(60).optional(), value: z.string().trim().min(1).max(60) }),
    z.object({ type: z.enum(['image', 'video', 'document']), link: z.string().trim().url().max(2000).refine((u) => /^https:\/\//i.test(u), 'O link precisa começar com https://'), filename: z.string().max(120).optional() }),
  ]).optional(),
  buttons: z.array(z.object({ index: z.number().int().min(0).max(9), subType: z.enum(['url', 'copy_code']), value: z.string().trim().min(1).max(2000) })).max(10).optional(),
  preview: z.string().max(4096).optional(),
});

conversationsRouter.post('/:id/template', asyncHandler(async (req, res) => {
  const d = templateBody.parse(req.body);
  const send: TemplateSend = {
    name: d.name, language: d.language,
    body: d.body ?? (d.params ?? []).map((value) => ({ value })),
    header: d.header, buttons: d.buttons,
  };
  let conv = await ownConversation(req.accountId!, req.params.id);
  // QR Code não tem modelos da Meta: o texto do modelo (já com as variáveis) vai como mensagem normal
  if (await isWebConversation(conv)) {
    const text = (d.preview ?? '').trim();
    if (!text) throw new AppError(422, 'Modelos de mensagem são da API oficial da Meta. Nesta conversa (QR Code), escreva a mensagem normalmente.');
    conv = await autoAssign(req.accountId!, conv, req.user!.id);
    const message = await deliver(req, conv, { type: 'text', body: text }, (c, to) => sendText(c, to, text));
    res.status(201).json({ message });
    return;
  }
  conv = await autoAssign(req.accountId!, conv, req.user!.id);
  const media = d.header && d.header.type !== 'text' ? d.header : null;
  const message = await deliver(req, conv, {
    type: 'template', body: d.preview ?? `Modelo: ${d.name}`,
    mediaUrl: media?.link ?? null, mimeType: media ? `${media.type}/*` : null, fileName: media?.filename ?? null,
  }, (c, to) => sendTemplate(c, to, send));
  res.status(201).json({ message });
}));

/** Nota interna: só a equipe vê, não vai para o WhatsApp. */
conversationsRouter.post('/:id/notes', asyncHandler(async (req, res) => {
  const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
  const conv = await ownConversation(req.accountId!, req.params.id);
  const [msg] = await db.insert(schema.messages).values({
    accountId: req.accountId!, conversationId: conv.id, direction: 'out', type: 'note', body, status: 'sent', senderUserId: req.user!.id,
  }).returning();
  const full = { ...msg, senderName: await userName(req.user!.id) };
  emitToAccount(req.accountId!, 'message:new', { conversationId: conv.id, message: full });
  res.status(201).json({ message: full });
}));

/* ---------------------------------------------------------------- ações */

conversationsRouter.post('/:id/accept', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  await stopRunsForContact(accountId, conv.contactId);
  const row = await setConv(accountId, conv.id, { assignedUserId: req.user!.id, status: 'open', botPaused: true });
  if (conv.assignedUserId !== req.user!.id) {
    const me = await userName(req.user!.id);
    await systemNote(accountId, conv.id, conv.assignedUserId && conv.status !== 'resolved'
      ? `🙋 ${me} assumiu a conversa (estava com ${await userName(conv.assignedUserId)})`
      : `🙋 ${me} começou o atendimento`);
  }
  res.json({ conversation: row });
}));

conversationsRouter.post('/:id/transfer', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  const conv = await ownConversation(accountId, req.params.id);
  const [m] = await db.select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.accountId, accountId), eq(schema.memberships.userId, userId))).limit(1);
  if (!m) throw new AppError(400, 'Essa pessoa não faz parte da equipe');
  await stopRunsForContact(accountId, conv.contactId);
  const row = await setConv(accountId, conv.id, { assignedUserId: userId, status: 'open', botPaused: true });
  await systemNote(accountId, conv.id, `↪️ ${await userName(req.user!.id)} transferiu a conversa para ${await userName(userId)}`);
  res.json({ conversation: row });
}));

/** Manda para a fila de um setor (ou para a fila geral, com departmentId null): ninguém atende até alguém do setor pegar. */
conversationsRouter.post('/:id/department', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const p = z.object({ departmentId: z.string().uuid().nullable() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, 'Setor inválido');
  const conv = await ownConversation(accountId, req.params.id);
  let deptName = 'a fila geral';
  if (p.data.departmentId) {
    const [d] = await db.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments)
      .where(and(eq(schema.departments.id, p.data.departmentId), eq(schema.departments.accountId, accountId))).limit(1);
    if (!d) throw new AppError(422, 'Setor não encontrado');
    deptName = `o setor ${d.name}`;
  }
  await stopRunsForContact(accountId, conv.contactId);
  const row = await setConv(accountId, conv.id, { departmentId: p.data.departmentId, assignedUserId: null, status: 'pending', botPaused: true });
  await systemNote(accountId, conv.id, `🏷️ ${await userName(req.user!.id)} mandou a conversa para ${deptName}`);
  res.json({ conversation: row });
}));

/** Devolve para a fila (Aguardando), sem responsável. */
conversationsRouter.post('/:id/release', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  const row = await setConv(accountId, conv.id, { assignedUserId: null, status: 'pending' });
  await systemNote(accountId, conv.id, `↩️ ${await userName(req.user!.id)} devolveu a conversa para a fila`);
  res.json({ conversation: row });
}));

conversationsRouter.post('/:id/resolve', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  await stopRunsForContact(accountId, conv.contactId);
  // a automação volta a valer para o próximo contato deste cliente
  const row = await setConv(accountId, conv.id, { status: 'resolved', botPaused: false, unreadCount: 0 });
  await systemNote(accountId, conv.id, `✅ Conversa resolvida por ${await userName(req.user!.id)}`);
  res.json({ conversation: row });
}));

conversationsRouter.post('/:id/reopen', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const conv = await ownConversation(accountId, req.params.id);
  const row = await setConv(accountId, conv.id, { status: 'open', assignedUserId: req.user!.id, botPaused: true });
  await systemNote(accountId, conv.id, `🔄 ${await userName(req.user!.id)} reabriu a conversa`);
  res.json({ conversation: row });
}));

/** Pausa (atendimento humano) ou retoma a automação (fluxos + IA) desta conversa. */
conversationsRouter.patch('/:id/automation', asyncHandler(async (req, res) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
  const conv = await ownConversation(req.accountId!, req.params.id);
  if (paused) await stopRunsForContact(req.accountId!, conv.contactId);
  const row = await setConv(req.accountId!, conv.id, { botPaused: paused, ...(paused ? {} : { status: 'open' as const }) });
  res.json({ conversation: row });
}));

/** Fluxos em andamento para o contato desta conversa. */
conversationsRouter.get('/:id/flow-runs', asyncHandler(async (req, res) => {
  const conv = await ownConversation(req.accountId!, req.params.id);
  const runs = await db.select({
    id: schema.flowRuns.id, status: schema.flowRuns.status, startedAt: schema.flowRuns.startedAt,
    flowId: schema.flows.id, flowName: schema.flows.name,
  }).from(schema.flowRuns)
    .innerJoin(schema.flows, eq(schema.flows.id, schema.flowRuns.flowId))
    .where(and(eq(schema.flowRuns.accountId, req.accountId!), eq(schema.flowRuns.contactId, conv.contactId), inArray(schema.flowRuns.status, ACTIVE_RUN_STATUSES)))
    .orderBy(desc(schema.flowRuns.startedAt));
  res.json({ runs });
}));

conversationsRouter.post('/:id/flow-runs/:runId/stop', asyncHandler(async (req, res) => {
  const conv = await ownConversation(req.accountId!, req.params.id);
  if (!isUuid(req.params.runId)) throw new AppError(404, 'Execução não encontrada');
  const stopped = await stopRunsForContact(req.accountId!, conv.contactId, req.params.runId);
  if (!stopped.length) throw new AppError(404, 'Execução não encontrada ou já finalizada');
  res.json({ ok: true });
}));

/** Vendas do contato (painel lateral do chat). */
conversationsRouter.get('/:id/sales', asyncHandler(async (req, res) => {
  const conv = await ownConversation(req.accountId!, req.params.id);
  const list = await db.select({
    id: schema.sales.id, amount: schema.sales.amount, currency: schema.sales.currency, status: schema.sales.status,
    productName: schema.sales.productName, createdAt: schema.sales.createdAt,
  }).from(schema.sales).where(and(eq(schema.sales.accountId, req.accountId!), eq(schema.sales.contactId, conv.contactId)))
    .orderBy(desc(schema.sales.createdAt)).limit(20);
  res.json({ sales: list.map((s) => ({ ...s, amount: Number(s.amount) })) });
}));
