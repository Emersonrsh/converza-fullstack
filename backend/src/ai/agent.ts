import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { chatComplete, aiEnabled, type ChatMsg } from './provider';
import { sendText } from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';
import { ensureRecharged, hasTokens, debit } from '../modules/tokens';

const MAX_HISTORY = 12;

/**
 * Responde automaticamente a uma mensagem recebida usando o agente ativo da
 * conta. Consome tokens (debitados do saldo) e respeita a trava de saldo zero.
 */
export async function runAgentForInbound(accountId: string, conversationId: string): Promise<void> {
  if (!aiEnabled()) return; // operador não configurou a chave de IA

  const [agent] = await db.select().from(schema.agents)
    .where(and(eq(schema.agents.accountId, accountId), eq(schema.agents.enabled, true))).limit(1);
  if (!agent) return; // nenhum agente ativo

  await ensureRecharged(accountId);
  if (!(await hasTokens(accountId))) return; // trava: sem saldo de tokens

  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1);
  if (!conv?.connectionId) return;
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  const [conn] = await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId)).limit(1);
  if (!contact || !conn) return;

  const history = await db.select().from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt)).limit(100);
  const recent = history.slice(-MAX_HISTORY);

  const messages: ChatMsg[] = [{
    role: 'system',
    content: agent.systemPrompt || 'Você é um atendente de vendas cordial e objetivo pelo WhatsApp. Responda em português, de forma curta.',
  }];
  for (const m of recent) {
    if (!m.body) continue;
    messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body });
  }

  let result;
  try {
    result = await chatComplete(agent.model, messages);
  } catch (err) {
    console.error('[agent] IA falhou:', (err as Error).message);
    return;
  }
  const reply = result.text.trim();
  if (!reply) return;

  const to = contact.waId ?? contact.phone.replace(/\D/g, '');
  let status: 'sent' | 'failed' = 'sent';
  let waMessageId: string | null = null;
  try {
    const sent = await sendText({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, to, reply);
    waMessageId = sent.waMessageId;
  } catch (err) {
    status = 'failed';
    console.error('[agent] envio falhou:', (err as Error).message);
  }

  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId, direction: 'out', type: 'text', body: reply, status, waMessageId,
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conversationId));

  // Débito automático do consumo (fallback por estimativa se o provedor não informar).
  const used = result.tokens || Math.ceil((reply.length + recent.reduce((a, m) => a + (m.body?.length ?? 0), 0)) / 4);
  const balance = await debit(accountId, used);

  emitToAccount(accountId, 'message:new', { conversationId, message: msg });
  emitToAccount(accountId, 'tokens:update', { balance });
}
