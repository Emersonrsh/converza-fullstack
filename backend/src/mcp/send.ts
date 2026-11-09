/** Envio de texto pelo MCP: mesma regra da tela de conversas (janela de 24h), sem assumir a conversa. */
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { sendText } from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';
import { ToolError } from './tools';

type Conv = typeof schema.conversations.$inferSelect;
const WINDOW_MS = 24 * 3600_000;

export async function sendTextInConversation(accountId: string, conv: Conv, text: string) {
  const [conn] = conv.connectionId
    ? await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1) : [];
  if (!conn) throw new ToolError('Esta conversa não tem um número de WhatsApp conectado.');
  // QR Code (WhatsApp Web) não tem a regra das 24h da Cloud API
  if (conn.provider !== 'web') {
    const [lastIn] = await db.select({ at: schema.messages.createdAt }).from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'in')))
      .orderBy(desc(schema.messages.createdAt)).limit(1);
    if (!lastIn || Date.now() - new Date(lastIn.at).getTime() >= WINDOW_MS) {
      throw new ToolError('Fora da janela de 24h: o cliente não escreve há mais de 24 horas. A Meta só deixa mandar um modelo aprovado (use os Disparos ou um fluxo com modelo).');
    }
  }
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  if (!contact) throw new ToolError('Contato não encontrado.');
  const to = contact.waId ?? contact.phone.replace(/\D/g, '');

  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'out', type: 'text', body: text, status: 'queued',
  }).returning();
  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: msg });
  let status: 'sent' | 'failed' = 'sent';
  let waMessageId: string | null = null;
  let error: string | null = null;
  try {
    const r = await sendText({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, to, text);
    waMessageId = r.waMessageId;
  } catch (err) {
    status = 'failed';
    error = (err as Error).message;
  }
  const [updated] = await db.update(schema.messages).set({ status, waMessageId, error }).where(eq(schema.messages.id, msg.id)).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
  emitToAccount(accountId, 'message:status', { conversationId: conv.id, id: updated.id, status, error, waMessageId });
  return { id: updated.id, status, error };
}
