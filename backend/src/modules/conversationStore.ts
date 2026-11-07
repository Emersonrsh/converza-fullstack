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
export async function systemNote(accountId: string, conversationId: string, body: string) {
  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId, direction: 'out', type: 'note', body, status: 'sent', senderUserId: null,
  }).returning();
  emitToAccount(accountId, 'message:new', { conversationId, message: msg });
  return msg;
}
