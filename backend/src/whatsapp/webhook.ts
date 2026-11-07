import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request } from 'express';
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler } from '../utils/http';
import { ensureConversation, systemNote } from '../modules/conversationStore';
import { findContactByPhone } from '../modules/contactStore';
import { emitToAccount } from '../realtime/io';
import { startFallbackFlow, triggerFlowsForInbound } from '../flows/runner';
import { scheduleAgentReply } from '../ai/agent';
import { attributeTracking } from '../modules/tracking';
import { friendlyWaError, sendText } from './cloud-api';
import { optKeyword } from '../utils/optout';
import { extractContent } from './inbound';
import { handleAccountUpdate, handleEchoes, handleHistory, handleStateSync } from './coexistence';

export { extractContent };
import { signedMediaPath } from '../utils/mediaSign';
import { firePixels } from '../pixels/sender';

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
const hmacOk = (secret: string, raw: Buffer, got: Buffer) => {
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  return got.length === expected.length && timingSafeEqual(got, expected);
};
/**
 * Assinatura: confere com a chave do app do operador e, para conexões manuais com o app da Meta
 * do próprio cliente, com a chave secreta cadastrada nessa conexão.
 */
async function signatureOk(req: Request): Promise<boolean> {
  if (config.whatsapp.skipSignature) return true;
  const body = (req.body ?? {}) as { entry?: { id?: string; changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[] };
  const phoneIds = [...new Set((body.entry ?? []).flatMap((e) => (e.changes ?? []).map((c) => c.value?.metadata?.phone_number_id)).filter((x): x is string => !!x))];
  const wabaIds = [...new Set((body.entry ?? []).map((e) => e.id).filter((x): x is string => !!x))];
  const secrets: string[] = config.whatsapp.appSecret ? [config.whatsapp.appSecret] : [];
  if (phoneIds.length || wabaIds.length) {
    const own = await db.select({ appSecret: schema.connections.appSecret }).from(schema.connections)
      .where(and(isNotNull(schema.connections.appSecret), or(
        phoneIds.length ? inArray(schema.connections.phoneNumberId, phoneIds) : sql`false`,
        wabaIds.length ? inArray(schema.connections.wabaId, wabaIds) : sql`false`,
      )));
    secrets.push(...own.map((r) => r.appSecret!).filter(Boolean));
  }
  if (!secrets.length) {
    if (!warnedNoSecret && config.env === 'production') {
      console.warn('[whatsapp webhook] META_APP_SECRET não configurado: a assinatura dos eventos não está sendo verificada.');
      warnedNoSecret = true;
    }
    return true;
  }
  const header = String(req.headers['x-hub-signature-256'] ?? '');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!header.startsWith('sha256=') || !raw) return false;
  const got = Buffer.from(header.slice(7));
  return secrets.some((sec) => hmacOk(sec, raw, got));
}

// 2) Recebimento de eventos (mensagens e status). Responde 200 rápido.
whatsappWebhookRouter.post('/', asyncHandler(async (req, res) => {
  if (!(await signatureOk(req))) {
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
      const field = String(change.field ?? 'messages');
      // eventos da conta (sem número): desconexão pelo app, restrições
      if (field === 'account_update') { await handleAccountUpdate(String(entry.id ?? value.waba_info?.waba_id ?? ''), value); continue; }
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const [conn] = await db.select().from(schema.connections)
        .where(eq(schema.connections.phoneNumberId, phoneNumberId)).limit(1);
      if (!conn) continue;
      const accountId = conn.accountId;

      // coexistência com o WhatsApp Business do celular
      if (field === 'smb_message_echoes') { await handleEchoes(accountId, conn, value.message_echoes ?? []); continue; }
      if (field === 'history') { await handleHistory(accountId, conn, value.history ?? []); continue; }
      if (field === 'smb_app_state_sync') { await handleStateSync(accountId, conn, value.state_sync ?? []); continue; }

      // Atualizações de status de mensagens enviadas
      for (const st of value.statuses ?? []) {
        if (!st.id || !st.status) continue;
        const status = mapStatus(st.status);
        const error = status === 'failed' && st.errors?.[0] ? friendlyWaError({ error: { ...st.errors[0], message: st.errors[0].title ?? st.errors[0].message } }).message : null;
        // não "volta" de lida para entregue se os eventos chegarem fora de ordem
        const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;
        const rows = await db.update(schema.messages).set({ status, ...(error ? { error } : {}) })
          .where(and(
            eq(schema.messages.waMessageId, st.id), eq(schema.messages.accountId, accountId),
            status === 'failed' ? sql`true` : sql`(case ${schema.messages.status} when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 4 end) < ${rank[status]}`,
          ))
          .returning({ id: schema.messages.id, conversationId: schema.messages.conversationId });
        for (const r of rows) emitToAccount(accountId, 'message:status', { conversationId: r.conversationId, id: r.id, status, error });
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
  // a conexão está recebendo: guarda o horário (saúde em Conexões)
  await db.update(schema.connections).set({ lastInboundAt: new Date() }).where(eq(schema.connections.id, connectionId));
  const { body, replyId, mediaType, media, silent } = extractContent(m);

  // lead vindo de anúncio "clique para o WhatsApp": a Meta manda o referral com o ID do anúncio
  const ref = m.referral ?? null;
  const adSource = ref?.source_id ? {
    sourceId: String(ref.source_id).slice(0, 120),
    sourceType: ref.source_type ? String(ref.source_type).slice(0, 40) : null,
    sourceUrl: ref.source_url ? String(ref.source_url).slice(0, 1000) : null,
    ctwaClid: ref.ctwa_clid ? String(ref.ctwa_clid).slice(0, 200) : null,
  } : null;

  // o mesmo cliente pode já existir com o número digitado de outro jeito (importado/cadastrado com o 9,
  // e o WhatsApp mandando o wa_id antigo sem o 9): atualiza esse contato em vez de criar um duplicado
  const known = await findContactByPhone(accountId, from);
  let contact: typeof schema.contacts.$inferSelect;
  if (known) {
    const [upd] = await db.update(schema.contacts).set({
      waId: from, lastContactAt: new Date(),
      firstConnectionId: known.firstConnectionId ?? connectionId,
      // primeiro anúncio que trouxe o lead (não sobrescreve)
      ...(adSource && !known.sourceId ? adSource : {}),
      // clique mais recente num anúncio de clique para o WhatsApp: é o que a Meta usa para atribuir a venda
      ...(adSource?.ctwaClid ? { ctwaClid: adSource.ctwaClid } : {}),
    }).where(eq(schema.contacts.id, known.id)).returning();
    contact = upd;
  } else {
    [contact] = await db.insert(schema.contacts).values({
      accountId, name: profileName ?? from, phone: from, waId: from, lastContactAt: new Date(),
      firstConnectionId: connectionId, origin: adSource ? 'ad' : 'whatsapp', ...(adSource ?? {}),
    }).onConflictDoUpdate({
      target: [schema.contacts.accountId, schema.contacts.phone],
      set: {
        waId: from, lastContactAt: new Date(),
        firstConnectionId: sql`coalesce(${schema.contacts.firstConnectionId}, excluded.first_connection_id)`,
        ...(adSource ? {
          sourceId: sql`coalesce(${schema.contacts.sourceId}, excluded.source_id)`,
          sourceType: sql`coalesce(${schema.contacts.sourceType}, excluded.source_type)`,
          sourceUrl: sql`coalesce(${schema.contacts.sourceUrl}, excluded.source_url)`,
          ctwaClid: sql`coalesce(${schema.contacts.ctwaClid}, excluded.ctwa_clid)`,
        } : {}),
      },
    }).returning();
  }

  // pixels: lead novo (ou cliente antigo que voltou por um anúncio)
  const newAdClick = !!(known && adSource?.ctwaClid && adSource.ctwaClid !== known.ctwaClid);
  if (!known || newAdClick) {
    void firePixels(accountId, 'lead', {
      contactId: contact.id, isNew: !known, newAdClick, fromAd: !!adSource, channel: 'whatsapp', ctwaClid: adSource?.ctwaClid ?? null,
    });
  }

  let conv = await ensureConversation(accountId, contact.id, connectionId);
  // conversa resolvida volta para "Aguardando" quando o cliente escreve de novo;
  // e a resposta sai pelo mesmo número por onde o cliente escreveu
  if (conv.status === 'resolved' || conv.connectionId !== connectionId) {
    const [upd] = await db.update(schema.conversations).set({
      connectionId,
      ...(conv.status === 'resolved' ? { status: 'open' as const, assignedUserId: null, botPaused: false } : {}),
    }).where(eq(schema.conversations.id, conv.id)).returning();
    if (upd) conv = upd;
  }

  // é a primeira mensagem desse contato? (gatilho "primeira mensagem")
  const [{ prior }] = await db.select({ prior: sql<number>`count(*)` }).from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.conversations.contactId, contact.id), eq(schema.messages.direction, 'in')));
  const isFirstMessage = Number(prior) === 0;

  // o WhatsApp reenvia eventos: ignora mensagem repetida
  if (m.id) {
    const [dup] = await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(and(eq(schema.messages.waMessageId, String(m.id)), eq(schema.messages.accountId, accountId))).limit(1);
    if (dup) return;
  }

  // cliente respondeu citando uma mensagem (ou reagiu a ela): liga as duas
  const quotedWa = m.context?.id ?? (m.type === 'reaction' ? m.reaction?.message_id : null);
  let replyToId: string | null = null;
  if (quotedWa) {
    const [q] = await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(and(eq(schema.messages.waMessageId, String(quotedWa)), eq(schema.messages.conversationId, conv.id))).limit(1);
    replyToId = q?.id ?? null;
  }

  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'in',
    type: mediaType, body, waMessageId: m.id ?? null, status: 'delivered',
    waMediaId: media?.id ?? null, mimeType: media?.mime ?? null, fileName: media?.filename ?? null, replyToId,
  }).returning();

  await db.update(schema.conversations)
    .set({ lastMessageAt: new Date(), unreadCount: sql`${schema.conversations.unreadCount} + 1` })
    .where(eq(schema.conversations.id, conv.id));

  // mídia recebida: link assinado (relativo à API) para o app exibir na hora
  emitToAccount(accountId, 'message:new', {
    conversationId: conv.id, message: { ...msg, mediaUrl: msg.waMediaId ? signedMediaPath(msg.id) : msg.mediaUrl },
  });

  // SAIR / PARAR: sai dos disparos em massa (e o fluxo que esperava a resposta do modelo não começa)
  const opt = silent ? null : optKeyword(body);
  if (opt === 'out' || (opt === 'in' && contact.optedOutAt)) {
    await handleOptOut(accountId, conv, connectionId, contact, opt, body ?? '');
    return;
  }

  // chegou por um link rastreável (#CÓDIGO na mensagem): marca a origem e põe as etiquetas do link.
  // Os gatilhos comparam o texto sem o código.
  let text = body ?? '';
  if (mediaType === 'text' && text) {
    try { text = (await attributeTracking(accountId, contact.id, text)).text; }
    catch (err) { console.error('[trackeamento] chegada:', (err as Error).message); }
  }

  // reações não disparam automação; atendimento humano: nenhuma automação responde
  if (silent || conv.botPaused) return;

  const handled = await triggerFlowsForInbound({
    accountId, contactId: contact.id, text, replyId, connectionId,
    source: 'inbound_message', isFirstMessage,
  });
  // o agente de IA só responde se nenhum fluxo tratou a mensagem; se nem ele, entra o fluxo padrão do número
  if (!handled && !(await scheduleAgentReply(accountId, conv.id, msg.id))) {
    await startFallbackFlow({ accountId, contactId: contact.id, text, replyId, connectionId, source: 'inbound_message', isFirstMessage });
  }
}


/** Registra o pedido (saída ou volta), avisa a equipe no chat e confirma para o cliente. */
async function handleOptOut(accountId: string, conv: typeof schema.conversations.$inferSelect, connectionId: string,
  contact: typeof schema.contacts.$inferSelect, kind: 'out' | 'in', said: string) {
  const out = kind === 'out';
  await db.update(schema.contacts).set({ optedOutAt: out ? (contact.optedOutAt ?? new Date()) : null }).where(eq(schema.contacts.id, contact.id));
  if (out) await db.delete(schema.flowPending).where(eq(schema.flowPending.contactId, contact.id));
  await systemNote(accountId, conv.id, out
    ? `🚫 Pediu para não receber mais disparos (respondeu “${said.trim().slice(0, 40)}”). Ele não entra mais nos disparos em massa.`
    : `✅ Voltou a aceitar disparos em massa (respondeu “${said.trim().slice(0, 40)}”).`);
  if (conv.botPaused) return; // alguém da equipe está atendendo: a pessoa responde
  const text = out
    ? 'Pronto! Você não vai mais receber nossas mensagens em massa. Se mudar de ideia, é só responder VOLTAR.'
    : 'Combinado! Você volta a receber nossas novidades por aqui.';
  const [conn] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
  let status: 'sent' | 'failed' = 'sent'; let waMessageId: string | null = null; let error: string | null = null;
  try { waMessageId = (await sendText({ phoneNumberId: conn?.phoneNumberId ?? null, accessToken: conn?.accessToken ?? null }, contact.waId ?? contact.phone, text)).waMessageId; }
  catch (err) { status = 'failed'; error = (err as Error).message; }
  const [msg] = await db.insert(schema.messages).values({ accountId, conversationId: conv.id, direction: 'out', type: 'text', body: text, status, waMessageId, error }).returning();
  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: msg });
}

function mapStatus(s: string): 'sent' | 'delivered' | 'read' | 'failed' {
  return (['sent', 'delivered', 'read', 'failed'].includes(s) ? s : 'sent') as any;
}
