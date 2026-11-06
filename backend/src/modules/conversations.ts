import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';
import { sendText } from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';

export const conversationsRouter = Router();

/** Garante que exista uma conversa aberta para o contato; cria se preciso. */
export async function ensureConversation(accountId: string, contactId: string, connectionId: string | null) {
  const [existing] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.accountId, accountId), eq(schema.conversations.contactId, contactId)))
    .orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.conversations)
    .values({ accountId, contactId, connectionId }).returning();
  return created;
}

conversationsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select({
    id: schema.conversations.id,
    status: schema.conversations.status,
    unreadCount: schema.conversations.unreadCount,
    lastMessageAt: schema.conversations.lastMessageAt,
    contactId: schema.contacts.id,
    contactName: schema.contacts.name,
    contactPhone: schema.contacts.phone,
    stage: schema.contacts.stage,
  }).from(schema.conversations)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.conversations.contactId))
    .where(eq(schema.conversations.accountId, req.accountId!))
    .orderBy(desc(schema.conversations.lastMessageAt)).limit(100);
  res.json({ conversations: rows });
}));

conversationsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const [conv] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.id, req.params.id), eq(schema.conversations.accountId, req.accountId!)))
    .limit(1);
  if (!conv) throw new AppError(404, 'Conversa não encontrada');
  const msgs = await db.select().from(schema.messages)
    .where(eq(schema.messages.conversationId, conv.id))
    .orderBy(asc(schema.messages.createdAt)).limit(500);
  // zera não lidas ao abrir
  await db.update(schema.conversations).set({ unreadCount: 0 }).where(eq(schema.conversations.id, conv.id));
  res.json({ conversation: conv, messages: msgs });
}));

const sendSchema = z.object({ body: z.string().min(1) });

conversationsRouter.post('/:id/messages', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const { body } = sendSchema.parse(req.body);

  const [conv] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.id, req.params.id), eq(schema.conversations.accountId, accountId))).limit(1);
  if (!conv) throw new AppError(404, 'Conversa não encontrada');

  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  if (!contact) throw new AppError(404, 'Contato não encontrado');

  // registra como "queued" antes de tentar enviar
  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'out', type: 'text', body,
    status: 'queued', senderUserId: req.user!.id,
  }).returning();

  let status: 'sent' | 'failed' = 'sent';
  let waMessageId: string | null = null;
  if (conv.connectionId) {
    const [conn] = await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1);
    try {
      const to = contact.waId ?? contact.phone.replace(/\D/g, '');
      const result = await sendText({ phoneNumberId: conn?.phoneNumberId ?? null, accessToken: conn?.accessToken ?? null }, to, body);
      waMessageId = result.waMessageId;
    } catch (err) {
      status = 'failed';
      console.error('[messages] envio falhou:', (err as Error).message);
    }
  } else {
    status = 'failed';
  }

  const [updated] = await db.update(schema.messages).set({ status, waMessageId })
    .where(eq(schema.messages.id, msg.id)).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));

  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: updated });
  res.status(status === 'sent' ? 201 : 502).json({ message: updated });
}));
