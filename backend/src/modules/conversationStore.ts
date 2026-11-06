import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';

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
