import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';

/** Garante que exista uma conversa para o contato; cria se preciso. */
export async function ensureConversation(accountId: string, contactId: string, connectionId: string | null) {
  const [existing] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.accountId, accountId), eq(schema.conversations.contactId, contactId)))
    .orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.conversations)
    .values({ accountId, contactId, connectionId }).returning();
  return created;
}

/** Evento do atendimento (transferência, resolução, agente…): nota sem autor, exibida como aviso central no chat. */
/**
 * A automação (fluxo ou agente de IA) respondeu o cliente: a conversa deixa de contar como não lida.
 * Só fica "não lida" o que chegou e ninguém respondeu.
 */
export async function markAnsweredByAutomation(accountId: string, conversationId: string) {
  const [row] = await db.update(schema.conversations).set({ lastMessageAt: new Date(), unreadCount: 0 })
    .where(eq(schema.conversations.id, conversationId)).returning({ id: schema.conversations.id, unreadCount: schema.conversations.unreadCount });
  if (row) emitToAccount(accountId, 'conversation:updated', { conversation: row });
}

export async function systemNote(accountId: string, conversationId: string, body: string) {
  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId, direction: 'out', type: 'note', body, status: 'sent', senderUserId: null,
  }).returning();
  emitToAccount(accountId, 'message:new', { conversationId, message: msg });
  return msg;
}
