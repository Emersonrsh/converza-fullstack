import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler } from '../utils/http';
import { ensureConversation } from '../modules/conversationStore';
import { emitToAccount } from '../realtime/io';
import { triggerFlowsForInbound } from '../flows/runner';
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

/**
 * A Meta assina cada evento com o App Secret (cabeçalho X-Hub-Signature-256).
 * Com META_APP_SECRET configurado, eventos sem assinatura válida são recusados —
 * assim ninguém consegue forjar mensagens para disparar fluxos ou gastar tokens de IA.
 */
let warnedNoSecret = false;
function signatureOk(req: Request): boolean {
  const secret = config.whatsapp.appSecret;
  if (!secret || config.whatsapp.skipSignature) {
    if (!warnedNoSecret && config.env === 'production') {
      console.warn('[whatsapp webhook] META_APP_SECRET não configurado: a assinatura dos eventos não está sendo verificada.');
      warnedNoSecret = true;
    }
    return true;
  }
  const header = String(req.headers['x-hub-signature-256'] ?? '');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header.startsWith('sha256=') || !raw) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// 2) Recebimento de eventos (mensagens e status). Responde 200 rápido.
whatsappWebhookRouter.post('/', asyncHandler(async (req, res) => {
  if (!signatureOk(req)) {
    console.warn('[whatsapp webhook] evento recusado: assinatura inválida. Confira se META_APP_SECRET é a "Chave secreta do app" do MESMO app da Meta onde o webhook está cadastrado.');
    res.sendStatus(401);
    return;
  }
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
        try {
          await handleInbound(accountId, conn.id, m, value.contacts?.[0]?.profile?.name);
        } catch (err) {
          console.error('[whatsapp webhook] mensagem falhou:', (err as Error).message);
        }
      }
    }
  }
}

async function handleInbound(accountId: string, connectionId: string, m: any, profileName?: string) {
  const from: string = String(m.from ?? '');
  if (!from) return;
  const { body, replyId, mediaType } = extractContent(m);

  const [contact] = await db.insert(schema.contacts).values({
    accountId, name: profileName ?? from, phone: from, waId: from, lastContactAt: new Date(),
  }).onConflictDoUpdate({
    target: [schema.contacts.accountId, schema.contacts.phone],
    set: { waId: from, lastContactAt: new Date() },
  }).returning();

  const conv = await ensureConversation(accountId, contact.id, connectionId);

  // é a primeira mensagem desse contato? (gatilho "primeira mensagem")
  const [{ prior }] = await db.select({ prior: sql<number>`count(*)` }).from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.conversations.contactId, contact.id), eq(schema.messages.direction, 'in')));
  const isFirstMessage = Number(prior) === 0;

  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'in',
    type: mediaType, body, waMessageId: m.id ?? null, status: 'delivered',
  }).returning();

  await db.update(schema.conversations)
    .set({ lastMessageAt: new Date(), unreadCount: sql`${schema.conversations.unreadCount} + 1` })
    .where(eq(schema.conversations.id, conv.id));

  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: msg });

  // atendimento humano: nenhuma automação responde
  if (conv.botPaused) return;

  const handled = await triggerFlowsForInbound({
    accountId, contactId: contact.id, text: body ?? '', replyId, connectionId,
    source: 'inbound_message', isFirstMessage,
  });
  // o agente de IA só responde se nenhum fluxo tratou a mensagem
  if (!handled) await runAgentForInbound(accountId, conv.id);
}

function extractContent(m: any): { body: string | null; replyId: string | null; mediaType: 'text' | 'image' | 'audio' | 'video' | 'document' } {
  const type = String(m.type ?? 'text');
  switch (type) {
    case 'text': return { body: m.text?.body ?? null, replyId: null, mediaType: 'text' };
    case 'button': return { body: m.button?.text ?? null, replyId: m.button?.payload ?? null, mediaType: 'text' };
    case 'interactive': {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? null;
      return { body: r?.title ?? null, replyId: r?.id ?? null, mediaType: 'text' };
    }
    case 'image': case 'video': case 'document': case 'audio':
      return { body: m[type]?.caption ?? null, replyId: null, mediaType: type };
    default: return { body: null, replyId: null, mediaType: 'text' };
  }
}

function mapStatus(s: string): 'sent' | 'delivered' | 'read' | 'failed' {
  return (['sent', 'delivered', 'read', 'failed'].includes(s) ? s : 'sent') as any;
}
