import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { ensureConversation, systemNote } from '../modules/conversationStore';
import { findContactByPhone } from '../modules/contactStore';
import { extractContent } from './inbound';
import { signedMediaPath } from '../utils/mediaSign';
import { emitConnection } from '../modules/connectionView';

/**
 * Coexistência (WhatsApp Business do celular + Converza no mesmo número):
 * - smb_message_echoes: o que o dono responde pelo celular aparece no chat (e pausa a automação);
 * - history: conversas antigas do celular (até 180 dias) entram no Chats;
 * - smb_app_state_sync: contatos da agenda do WhatsApp Business viram contatos;
 * - account_update: número desconectado pelo app (PARTNER_REMOVED) e outros avisos da Meta.
 */

type Conn = typeof schema.connections.$inferSelect;
type MsgType = typeof schema.messages.$inferInsert['type'];
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
const at = (ts: unknown) => { const n = Number(ts); return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(); };

async function contactFor(accountId: string, conn: Conn, phone: string, name?: string | null) {
  const known = await findContactByPhone(accountId, phone);
  if (known) {
    if (name && known.name === known.phone) {
      const [u] = await db.update(schema.contacts).set({ name }).where(eq(schema.contacts.id, known.id)).returning();
      return u ?? known;
    }
    return known;
  }
  const [c] = await db.insert(schema.contacts).values({
    accountId, name: name || phone, phone, waId: phone, firstConnectionId: conn.id, origin: 'whatsapp',
  }).onConflictDoUpdate({ target: [schema.contacts.accountId, schema.contacts.phone], set: { waId: phone } }).returning();
  return c;
}

/** Mensagens que o dono mandou pelo WhatsApp Business do celular. */
export async function handleEchoes(accountId: string, conn: Conn, echoes: any[]) {
  for (const e of echoes) {
    try {
      const to = digits(e.to);
      if (!to || !e.id) continue;
      const [dup] = await db.select({ id: schema.messages.id }).from(schema.messages)
        .where(and(eq(schema.messages.waMessageId, String(e.id)), eq(schema.messages.accountId, accountId))).limit(1);
      if (dup) continue;
      const contact = await contactFor(accountId, conn, to);
      let conv = await ensureConversation(accountId, contact.id, conn.id);
      const x = extractContent(e);
      if (x.silent && x.mediaType !== 'text') continue; // reações etc.
      const [msg] = await db.insert(schema.messages).values({
        accountId, conversationId: conv.id, direction: 'out', type: x.mediaType as MsgType, body: x.body,
        waMessageId: String(e.id), status: 'sent', waMediaId: x.media?.id ?? null, mimeType: x.media?.mime ?? null,
        fileName: x.media?.filename ?? null, via: 'phone', createdAt: at(e.timestamp),
      }).returning();
      // alguém respondeu pelo celular: a automação para nesta conversa (como quando a equipe responde no Converza)
      const pause = !conv.botPaused;
      const [upd] = await db.update(schema.conversations).set({ lastMessageAt: new Date(), ...(pause ? { botPaused: true } : {}) })
        .where(eq(schema.conversations.id, conv.id)).returning();
      if (upd) conv = upd;
      emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: { ...msg, mediaUrl: msg.waMediaId ? signedMediaPath(msg.id) : null } });
      if (pause) {
        await systemNote(accountId, conv.id, '📱 Respondido pelo WhatsApp do celular — a automação desta conversa foi pausada.');
        emitToAccount(accountId, 'conversation:updated', { conversation: conv });
      }
    } catch (err) {
      console.error('[coexistência] eco falhou:', (err as Error).message);
    }
  }
}

const HISTORY_STATUS: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  SENT: 'sent', DELIVERED: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed', PENDING: 'sent',
};

/** Histórico do celular (em fases e pedaços). Guarda as mensagens com a data original; não dispara automação. */
export async function handleHistory(accountId: string, conn: Conn, items: any[]) {
  let progress: number | null = null;
  let declined = false;
  const touched = new Set<string>();
  for (const h of items) {
    if (Array.isArray(h.errors) && h.errors.length) { declined = true; continue; }
    const p = Number(h.metadata?.progress);
    if (Number.isFinite(p)) progress = Math.max(progress ?? 0, Math.min(100, p));
    for (const t of h.threads ?? []) {
      try {
        const customer = digits(t.id);
        if (!customer) continue;
        const msgs = (t.messages ?? []).filter((m: any) => m?.id);
        if (!msgs.length) continue;
        const contact = await contactFor(accountId, conn, customer);
        const conv = await ensureConversation(accountId, contact.id, conn.id);
        const ids = msgs.map((m: any) => String(m.id));
        const known = new Set((await db.select({ wa: schema.messages.waMessageId }).from(schema.messages)
          .where(and(eq(schema.messages.accountId, accountId), inArray(schema.messages.waMessageId, ids)))).map((r) => r.wa));
        const values = msgs.filter((m: any) => !known.has(String(m.id))).map((m: any) => {
          const x = extractContent(m);
          const inbound = digits(m.from) === customer;
          return {
            accountId, conversationId: conv.id, direction: (inbound ? 'in' : 'out') as 'in' | 'out', type: x.mediaType as MsgType,
            body: x.body, waMessageId: String(m.id), status: inbound ? 'delivered' as const : HISTORY_STATUS[String(m.history_context?.status ?? '').toUpperCase()] ?? 'sent',
            waMediaId: x.media?.id ?? null, mimeType: x.media?.mime ?? null, fileName: x.media?.filename ?? null,
            via: 'history', createdAt: at(m.timestamp),
          };
        });
        if (!values.length) continue;
        await db.insert(schema.messages).values(values);
        touched.add(conv.id);
        const newest = values.reduce((a: Date, v: { createdAt: Date }) => (v.createdAt > a ? v.createdAt : a), new Date(0));
        await db.update(schema.conversations).set({ lastMessageAt: sql`greatest(${schema.conversations.lastMessageAt}, ${newest})` })
          .where(eq(schema.conversations.id, conv.id));
        const lastIn = values.filter((v: { direction: string }) => v.direction === 'in').reduce((a: Date | null, v: { createdAt: Date }) => (!a || v.createdAt > a ? v.createdAt : a), null);
        if (lastIn) await db.update(schema.contacts).set({ lastContactAt: sql`greatest(coalesce(${schema.contacts.lastContactAt}, ${lastIn}), ${lastIn})` }).where(eq(schema.contacts.id, contact.id));
      } catch (err) {
        console.error('[coexistência] histórico falhou:', (err as Error).message);
      }
    }
  }
  const patch: Partial<typeof schema.connections.$inferInsert> = {};
  if (progress !== null) patch.historyProgress = progress;
  if (declined) { patch.historyProgress = null; patch.lastError = 'O dono do número não compartilhou o histórico do celular — as conversas novas aparecem normalmente.'; }
  if (Object.keys(patch).length) {
    const [row] = await db.update(schema.connections).set(patch).where(eq(schema.connections.id, conn.id)).returning();
    if (row) emitConnection(row);
  }
  // várias conversas ganharam mensagens antigas de uma vez: as telas recarregam a lista
  if (touched.size) emitToAccount(accountId, 'conversations:changed', { conversationIds: [...touched] });
}

/** Contatos da agenda do WhatsApp Business: cria/atualiza o nome (remoções não apagam do CRM). */
export async function handleStateSync(accountId: string, conn: Conn, items: any[]) {
  for (const it of items) {
    try {
      if (it.type !== 'contact' || it.action === 'remove') continue;
      const phone = digits(it.contact?.phone_number);
      if (phone.length < 10) continue;
      await contactFor(accountId, conn, phone, String(it.contact?.full_name ?? it.contact?.first_name ?? '').trim().slice(0, 120) || null);
    } catch (err) {
      console.error('[coexistência] contato falhou:', (err as Error).message);
    }
  }
}

/** account_update: desconectado pelo app/Meta ou restrição da conta. */
export async function handleAccountUpdate(wabaId: string, value: any) {
  const ev = String(value?.event ?? '').toUpperCase();
  const msg = ev === 'PARTNER_REMOVED' ? 'O número foi desconectado do Converza (pelo WhatsApp Business do celular ou pela Meta). Conecte de novo para voltar a atender.'
    : ev === 'ACCOUNT_VIOLATION' ? 'A Meta apontou violação de política nesta conta do WhatsApp Business.'
      : ev === 'DISABLED_UPDATE' || ev === 'ACCOUNT_RESTRICTION' ? 'A Meta restringiu esta conta do WhatsApp Business.'
        : null;
  if (!msg || !wabaId) return;
  const rows = await db.update(schema.connections)
    .set({ lastError: msg, ...(ev === 'PARTNER_REMOVED' ? { status: 'disconnected' as const } : {}) })
    .where(eq(schema.connections.wabaId, wabaId)).returning();
  rows.forEach(emitConnection);
}
