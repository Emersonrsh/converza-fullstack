import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler } from '../utils/http';
import { ensureConversation } from '../modules/conversations';
import { emitToAccount } from '../realtime/io';
import { triggerFlowsForInbound } from '../flows/engine';
import { runAgentForInbound } from '../ai/agent';

export const whatsappWebhookRouter = Router();

// 1) Verificação do webhook (a Meta chama via GET ao cadastrar a URL)
whatsappWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// 2) Recebimento de eventos (mensagens e status). Responde 200 rápido.
whatsappWebhookRouter.post('/', asyncHandler(async (req, res) => {
  res.sendStatus(200); // ACK imediato; processa depois
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('[whatsapp webhook] erro:', (err as Error).message);
  }
}));

async function processWebhook(payload: any) {
  const entries = payload?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const [conn] = await db.select().from(schema.connections)
        .where(eq(schema.connections.phoneNumberId, phoneNumberId)).limit(1);
      if (!conn) continue;
      const accountId = conn.accountId;

      // Atualizações de status de mensagens enviadas
      for (const st of value.statuses ?? []) {
        if (st.id && st.status) {
          await db.update(schema.messages).set({ status: mapStatus(st.status) })
            .where(and(eq(schema.messages.waMessageId, st.id), eq(schema.messages.accountId, accountId)));
        }
      }

      // Mensagens recebidas
      for (const m of value.messages ?? []) {
        const from: string = m.from;
        const profileName: string | undefined = value.contacts?.[0]?.profile?.name;
        const body = extractBody(m);

        const [contact] = await db.insert(schema.contacts).values({
          accountId, name: profileName ?? from, phone: from, waId: from, lastContactAt: new Date(),
        }).onConflictDoUpdate({
          target: [schema.contacts.accountId, schema.contacts.phone],
          set: { waId: from, lastContactAt: new Date() },
        }).returning();

        const conv = await ensureConversation(accountId, contact.id, conn.id);

        const [msg] = await db.insert(schema.messages).values({
          accountId, conversationId: conv.id, direction: 'in',
          type: mapType(m.type), body, waMessageId: m.id, status: 'delivered',
        }).returning();

        await db.update(schema.conversations)
          .set({ lastMessageAt: new Date(), unreadCount: sql`${schema.conversations.unreadCount} + 1` })
          .where(eq(schema.conversations.id, conv.id));

        emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: msg });

        // dispara automações cujo gatilho é "mensagem recebida"
        await triggerFlowsForInbound(accountId, contact.id, body ?? '', conn.id, 'inbound_message');
        // resposta automática do agente de IA (se houver agente ativo e saldo)
        await runAgentForInbound(accountId, conv.id);
      }
    }
  }
}

function extractBody(m: any): string | null {
  switch (m.type) {
    case 'text': return m.text?.body ?? null;
    case 'button': return m.button?.text ?? null;
    case 'interactive': return m.interactive?.list_reply?.title ?? m.interactive?.button_reply?.title ?? null;
    default: return null;
  }
}
function mapType(t: string): 'text' | 'image' | 'audio' | 'video' | 'document' | 'template' {
  return (['text', 'image', 'audio', 'video', 'document'].includes(t) ? t : 'text') as any;
}
function mapStatus(s: string): 'sent' | 'delivered' | 'read' | 'failed' {
  return (['sent', 'delivered', 'read', 'failed'].includes(s) ? s : 'sent') as any;
}
