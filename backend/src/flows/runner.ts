/**
 * Execução real dos fluxos: guarda o estado em flow_runs, envia pelo WhatsApp,
 * registra no inbox, conta estatísticas por bloco e agenda esperas na fila.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';
import { ensureConversation, systemNote } from '../modules/conversationStore';
import { findContactByPhone } from '../modules/contactStore';
import { touchBoard, upsertContactCard } from '../modules/kanbanStore';
import { mediaIdFor } from '../modules/storedFiles';
import { recordSale as storeSale } from '../modules/salesStore';
import { enqueueFlowJob, type FlowJobData } from '../queue';
import { aiCall } from '../ai/usage';
import { byokBaseUrl, chatCompleteWith, transcribeWith, type ChatMsg } from '../ai/provider';
import { toChatParts } from './aiBlock';
import { chargeTokens, sttTokens, transcribe, voiceEnabled } from '../ai/voice';
import { isVoiceFormat, toMp3, toOggOpus } from '../utils/audio';
import { PLATFORMS, type Platform } from '../pixels/engine';
import { publicEvent } from '../pixels/sender';
import {
  sendText, showTyping, sendMedia, sendButtons, sendList, sendMediaId, sendSticker, sendStickerLink, sendContactCard, sendReaction,
  sendInteractive, sendTemplate as waSendTemplate, pixOrderInteractive, carouselInteractive, downloadMedia, uploadMedia,
  type WaConnection, type SendResult,
} from '../whatsapp/cloud-api';
import { templateAsText } from '../whatsapp/web/convert';
import { safeDownload, safeHttpRequest } from './http';
import { flowExtras, setGlobalValue } from './globals';
import { openNow } from '../modules/businessHours';
import { defaultFlowsFor } from '../modules/defaultFlows';
import { normalizeGraph, triggerOf, STAGES, type Dict, type FlowGraph } from './types';
import {
  runFrom, resumeInput, resumeAfterDelay, resumePayment, resumeTimeout, flushBuffer, normalizeState, triggerMatches, norm, formatBRL,
  type FlowExecutor, type Halt, type InboundMedia, type RunState,
} from './interpreter';
import type { Schedule } from '../utils/hours';

type FlowRow = typeof schema.flows.$inferSelect;
type RunRow = typeof schema.flowRuns.$inferSelect;
type ContactRow = typeof schema.contacts.$inferSelect;
type ConnectionRow = typeof schema.connections.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;
type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'template' | 'sticker' | 'contacts';

export const ACTIVE_RUN_STATUSES = ['running', 'waiting', 'waiting_input', 'waiting_payment'];
const DAY_MS = 24 * 3600 * 1000;
/** Mídia do cliente para o Bloco de IA: até 15 MB. */
const MAX_AI_MEDIA = 15 * 1024 * 1024;

export interface InboundEvent {
  accountId: string;
  contactId: string;
  text: string;
  replyId?: string | null;
  connectionId?: string | null;
  source: 'inbound_message' | 'webhook';
  isFirstMessage?: boolean;
  webhookId?: string | null;
  vars?: Dict;
  /** fluxos que não devem começar por este evento (o webhook já cuidou deles) */
  excludeFlowIds?: string[];
  /** wamid da mensagem do cliente (para citar ou reagir) */
  waId?: string | null;
  /** mensagem com áudio, imagem ou PDF (para o Bloco de IA) */
  mediaMsgId?: string | null;
  /** só retoma uma espera em andamento (a conversa está com um agente de IA) */
  onlyResume?: boolean;
}

/* -------------------------------------------------------------- executor */

interface DbExecutor extends FlowExecutor { pendingGoto: string | null; }

const mediaPreview: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', document: '📄 Arquivo', sticker: '🌟 Figurinha' };

function createDbExecutor(p: { accountId: string; flowId: string; contactId: string; runId: string; state: RunState }): DbExecutor {
  let contactRow: ContactRow | null = null;
  let connCache: ConnectionRow | null | undefined;
  let convCache: ConversationRow | null = null;
  let extrasCache: Record<string, string> | null = null;
  let tzCache: string | null = null;
  let mediaCache: InboundMedia | null | undefined;

  const contact = async (): Promise<ContactRow> => {
    if (!contactRow) {
      const [c] = await db.select().from(schema.contacts)
        .where(and(eq(schema.contacts.id, p.contactId), eq(schema.contacts.accountId, p.accountId))).limit(1);
      if (!c) throw new Error('Contato não encontrado');
      contactRow = c;
    }
    return contactRow;
  };

  const connection = async (): Promise<ConnectionRow | null> => {
    if (connCache !== undefined) return connCache;
    let row: ConnectionRow | undefined;
    if (p.state.connectionId && isUuid(p.state.connectionId)) {
      [row] = await db.select().from(schema.connections)
        .where(and(eq(schema.connections.id, p.state.connectionId), eq(schema.connections.accountId, p.accountId))).limit(1);
    }
    if (!row) {
      [row] = await db.select().from(schema.connections)
        .where(and(eq(schema.connections.accountId, p.accountId), eq(schema.connections.status, 'connected'))).limit(1);
    }
    connCache = row ?? null;
    return connCache;
  };

  const conversation = async (): Promise<ConversationRow> => {
    if (!convCache) {
      const c = await connection();
      convCache = await ensureConversation(p.accountId, p.contactId, c?.id ?? null);
    }
    return convCache;
  };

  const recipient = async () => {
    const c = await contact();
    return c.waId ?? c.phone.replace(/\D/g, '');
  };

  const timezone = async () => {
    if (!tzCache) {
      const [a] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, p.accountId)).limit(1);
      tzCache = a?.tz || 'America/Sao_Paulo';
    }
    return tzCache;
  };

  /** cita a mensagem do cliente se o Aguarda Resposta pediu (só na próxima mensagem) */
  const takeQuote = () => { const q = p.state.quoteNext; p.state.quoteNext = null; return q; };

  const deliver = async (
    send: (conn: WaConnection & { id: string }, to: string) => Promise<SendResult>,
    body: string, type: MsgType, mediaUrl: string | null,
    extra: { waMediaId?: string | null; mimeType?: string | null; fileName?: string | null } = {},
  ) => {
    const conn = await connection();
    let status: 'sent' | 'failed' = 'failed';
    let waMessageId: string | null = null;
    let error: string | null = conn ? null : 'Conversa sem conexão de WhatsApp';
    if (conn) {
      try {
        const r = await send({ id: conn.id, phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, await recipient());
        waMessageId = r.waMessageId;
        status = 'sent';
      } catch (err) {
        error = (err as Error).message;
        console.error('[flow] envio falhou:', error);
      }
    }
    // registra no inbox para a equipe acompanhar o que o fluxo enviou
    const conv = await conversation();
    const [msg] = await db.insert(schema.messages).values({
      accountId: p.accountId, conversationId: conv.id, direction: 'out', type, body, mediaUrl, status, waMessageId, error,
      waMediaId: extra.waMediaId ?? null, mimeType: extra.mimeType ?? null, fileName: extra.fileName ?? null,
    }).returning();
    await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
    emitToAccount(p.accountId, 'message:new', { conversationId: conv.id, message: msg });
    return status === 'sent';
  };

  const bump = async (nodeId: string, col: 'entries' | 'advances') => {
    try {
      await db.insert(schema.flowNodeStats)
        .values({ flowId: p.flowId, nodeId, entries: col === 'entries' ? 1 : 0, advances: col === 'advances' ? 1 : 0 })
        .onConflictDoUpdate({
          target: [schema.flowNodeStats.flowId, schema.flowNodeStats.nodeId],
          set: col === 'entries'
            ? { entries: sql`${schema.flowNodeStats.entries} + 1` }
            : { advances: sql`${schema.flowNodeStats.advances} + 1` },
        });
    } catch (err) {
      console.warn('[flow] estatística:', (err as Error).message);
    }
  };

  const updateContact = async (patch: Partial<ContactRow>) => {
    const [row] = await db.update(schema.contacts).set(patch)
      .where(and(eq(schema.contacts.id, p.contactId), eq(schema.contacts.accountId, p.accountId))).returning();
    if (row) contactRow = row;
  };

  const updateConversation = async (patch: Partial<ConversationRow>) => {
    const conv = await conversation();
    const [updated] = await db.update(schema.conversations).set(patch).where(eq(schema.conversations.id, conv.id)).returning();
    if (updated) {
      convCache = updated;
      emitToAccount(p.accountId, 'conversation:updated', { conversation: updated });
    }
    return updated ?? conv;
  };

  const note = async (body: string) => {
    try { const conv = await conversation(); await systemNote(p.accountId, conv.id, body); } catch { /* nota é só informativa */ }
  };

  /** mídia por link ou arquivo guardado (vira um ID da Meta para este número) */
  /** Áudio por link: baixa, converte para Ogg/Opus e envia como mensagem de voz nativa (com onda). */
  const sendVoiceLink = async (url: string) => {
    const conn = await connection();
    let mediaId: string | null = null;
    let err: string | null = null;
    if (conn) {
      try {
        const file = await safeDownload(url);
        const data = isVoiceFormat(file.mime) ? file.data : await toOggOpus(file.data);
        mediaId = await uploadMedia({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, data, 'audio/ogg', 'audio.ogg');
      } catch (e) { err = (e as Error).message; }
    }
    const quote = takeQuote();
    await deliver((c, to) => {
      if (!mediaId) throw new Error(err ?? 'O áudio do link não pôde ser enviado.');
      return sendMediaId(c, to, 'audio', mediaId, undefined, undefined, { contextId: quote, voice: true });
    }, '', 'audio', url, { waMediaId: mediaId, mimeType: 'audio/ogg', fileName: null });
  };

  const sendRef = async (kind: 'image' | 'video' | 'audio' | 'document' | 'sticker', ref: { url?: string; fileId?: string; filename?: string }, caption?: string) => {
    if (ref.fileId && isUuid(ref.fileId)) {
      const [f] = await db.select({ mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName }).from(schema.storedFiles)
        .where(and(eq(schema.storedFiles.id, ref.fileId), eq(schema.storedFiles.accountId, p.accountId))).limit(1);
      let mediaId: string | null = null;
      let upErr: string | null = f ? null : 'O arquivo do bloco não existe mais. Envie de novo no fluxo.';
      const conn = await connection();
      if (f && conn) {
        try { mediaId = await mediaIdFor(ref.fileId, { id: conn.id, phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, { asVoice: kind === 'audio' }); }
        catch (err) { upErr = (err as Error).message; }
      }
      const quote = takeQuote();
      await deliver((c, to) => {
        if (!mediaId) throw new Error(upErr ?? 'O arquivo não pôde ser enviado para o WhatsApp.');
        return kind === 'sticker' ? sendSticker(c, to, mediaId) : sendMediaId(c, to, kind, mediaId, caption, ref.filename || f?.fileName, { contextId: quote, voice: kind === 'audio' });
      }, caption ?? (kind === 'sticker' ? '' : ''), kind, null, { waMediaId: mediaId, mimeType: f?.mime ?? null, fileName: ref.filename || f?.fileName || null });
      return;
    }
    if (!ref.url) return;
    if (kind === 'audio') { await sendVoiceLink(ref.url); return; }
    const quote = takeQuote();
    await deliver((c, to) => (kind === 'sticker'
      ? sendStickerLink(c, to, ref.url!)
      : sendMedia(c, to, kind, ref.url!, caption, ref.filename, quote)), caption ?? '', kind, ref.url, { fileName: ref.filename ?? null });
  };

  /** imagem do cartão (Pix/carrossel): link público ou ID da Meta do arquivo guardado */
  const imageOf = async (ref: { url?: string; fileId?: string } | null): Promise<{ link?: string; id?: string } | null> => {
    if (!ref) return null;
    if (ref.url) return { link: ref.url };
    if (ref.fileId && isUuid(ref.fileId)) {
      const conn = await connection();
      if (!conn) return null;
      try { return { id: await mediaIdFor(ref.fileId, { id: conn.id, phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }) }; }
      catch (err) { console.warn('[flow] imagem do cartão:', (err as Error).message); return null; }
    }
    return null;
  };

  const exec: DbExecutor = {
    pendingGoto: null,
    async getContact() {
      const c = await contact();
      return { name: c.name, phone: c.phone, stage: c.stage, tags: [...c.tags], email: c.email, custom: { ...(c.custom as Record<string, unknown> ?? {}) } };
    },
    async typing(seconds, mode) {
      const conn = await connection();
      if (!conn) return;
      await showTyping({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, await recipient(), p.state.lastWaId, seconds, mode).catch(() => undefined);
    },
    async sendText(text) {
      const quote = takeQuote();
      await deliver((conn, to) => sendText(conn, to, text, quote), text, 'text', null);
    },
    async sendMedia(kind, url, caption, filename) {
      if (kind === 'audio') { await sendVoiceLink(url); return; }
      const quote = takeQuote();
      await deliver((conn, to) => sendMedia(conn, to, kind, url, caption, filename, quote), caption ?? '', kind, url);
    },
    async sendMenu(text, options, style, buttonLabel) {
      const numbered = `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`;
      const mode = style === 'auto' ? (options.length <= 3 ? 'buttons' : options.length <= 10 ? 'list' : 'text') : style;
      takeQuote();
      await deliver(async (conn, to) => {
        try {
          if (mode === 'buttons' && options.length <= 3) return await sendButtons(conn, to, text, options);
          if (mode === 'list' && options.length <= 10) return await sendList(conn, to, text, buttonLabel, options);
        } catch (err) {
          console.warn('[flow] menu interativo falhou, enviando como texto:', (err as Error).message);
        }
        return sendText(conn, to, numbered);
      }, numbered, 'text', null);
    },
    async setStage(stage) {
      if (!(STAGES as readonly string[]).includes(stage)) return;
      await updateContact({ stage: stage as ContactRow['stage'] });
    },
    async addTag(tag) {
      const t = tag.trim();
      const c = await contact();
      if (!t || c.tags.some((x) => norm(x) === norm(t))) return;
      await updateContact({ tags: [...c.tags, t] });
    },
    async removeTag(tag) {
      const c = await contact();
      const tags = c.tags.filter((x) => norm(x) !== norm(tag));
      if (tags.length !== c.tags.length) await updateContact({ tags });
    },
    async setContactName(name) {
      await updateContact({ name: name.slice(0, 120) });
    },
    async setContactField(key, value) {
      const [f] = await db.select().from(schema.contactFields)
        .where(and(eq(schema.contactFields.accountId, p.accountId), eq(schema.contactFields.key, key))).limit(1);
      if (!f) { console.warn('[flow] campo personalizado não existe:', key); return; }
      const c = await contact();
      const custom = { ...((c.custom ?? {}) as Record<string, unknown>) };
      if (value) custom[key] = value.slice(0, 500); else delete custom[key];
      await updateContact({ custom });
    },
    async moveToKanban(boardId, columnId) {
      if (!isUuid(boardId) || !isUuid(columnId)) return;
      const r = await upsertContactCard(p.accountId, p.contactId, boardId, columnId);
      if ('error' in r) console.warn('[flow] Kanban:', r.error);
    },
    async handoff(assignUserId, departmentId) {
      let assigned: string | null = null;
      if (assignUserId && isUuid(assignUserId)) {
        const [m] = await db.select().from(schema.memberships)
          .where(and(eq(schema.memberships.userId, assignUserId), eq(schema.memberships.accountId, p.accountId))).limit(1);
        if (m) assigned = assignUserId;
      }
      // fila do setor: fica em Aguardando só para os membros do setor
      let dept: string | null = null;
      if (!assigned && departmentId && isUuid(departmentId)) {
        const [d] = await db.select({ id: schema.departments.id }).from(schema.departments)
          .where(and(eq(schema.departments.id, departmentId), eq(schema.departments.accountId, p.accountId))).limit(1);
        dept = d?.id ?? null;
      }
      await updateConversation({ botPaused: true, status: 'pending', ...(assigned ? { assignedUserId: assigned } : {}), ...(dept ? { departmentId: dept, assignedUserId: null } : {}) });
    },
    async gotoFlow(flowId) { exec.pendingGoto = flowId; },
    async extras() {
      if (!extrasCache) extrasCache = await flowExtras(p.accountId);
      return extrasCache;
    },
    async inBusinessHours() {
      const c = await connection();
      const h = await openNow(p.accountId, c?.id ?? null);
      return h.enabled ? h.open : null;
    },
    async setGlobal(key, op, value) {
      await setGlobalValue(p.accountId, key, op, value);
      extrasCache = null;
    },
    http: (req) => safeHttpRequest(req),
    async ai(req) {
      const messages: ChatMsg[] = [{ role: 'system', content: req.system }];
      if (req.history) {
        const conv = await conversation();
        const hist = await db.select().from(schema.messages)
          .where(eq(schema.messages.conversationId, conv.id))
          .orderBy(desc(schema.messages.createdAt)).limit(12);
        for (const m of hist.reverse()) {
          if (m.body && m.type !== 'note') messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body });
        }
      }
      if (req.user) messages.push({ role: 'user', content: req.user });
      // para "Uso da IA": a conversa do contato (sem criar uma nova só por isso)
      const convId = convCache?.id ?? (await db.select({ id: schema.conversations.id }).from(schema.conversations)
        .where(and(eq(schema.conversations.accountId, p.accountId), eq(schema.conversations.contactId, p.contactId)))
        .orderBy(desc(schema.conversations.lastMessageAt)).limit(1))[0]?.id ?? null;
      return aiCall(p.accountId, messages, {
        model: req.model, maxTokens: req.maxTokens,
        usage: { kind: 'flow_ai', conversationId: convId, contactId: p.contactId, flowId: p.flowId, label: 'Bloco de IA do fluxo' },
      });
    },
    async getProduct(id) {
      if (!isUuid(id)) return null;
      const [r] = await db.select().from(schema.products)
        .where(and(eq(schema.products.id, id), eq(schema.products.accountId, p.accountId))).limit(1);
      return r ? { id: r.id, name: r.name, price: Number(r.price), checkoutUrl: r.checkoutUrl } : null;
    },
    onEnter: (nodeId) => bump(nodeId, 'entries'),
    onAdvance: (nodeId) => bump(nodeId, 'advances'),
    note: () => {},
    random: () => Math.random(),

    /* ---- blocos da barra Ferramentas ---- */
    async sendMediaRef(kind, ref, caption) { await sendRef(kind, ref, caption); },
    async sendContactCard(name, phone) {
      takeQuote();
      await deliver((c, to) => sendContactCard(c, to, name, phone), `👤 ${name} · +${phone.replace(/\D/g, '')}`, 'contacts', null);
    },
    async react(waMessageId, emoji) {
      const conn = await connection();
      if (!conn) return;
      try { await sendReaction({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, await recipient(), waMessageId, emoji); }
      catch (err) { console.warn('[flow] reação:', (err as Error).message); }
    },
    async sendPix(pix) {
      const image = await imageOf(pix.image);
      const conn = await connection();
      let sentCard = false;
      // QR Code não tem o cartão de pagamento da Meta: vai direto o texto com a chave e o código
      if (conn && conn.provider !== 'web') {
        try {
          const r = await sendInteractive({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, await recipient(), pixOrderInteractive({
            referenceId: pix.referenceId, code: pix.code, merchantName: pix.merchantName, key: pix.key, keyType: pix.keyType,
            amount: pix.amount, text: pix.text, itemName: pix.text.split('\n')[0] || 'Pagamento via Pix', header: image,
          }));
          sentCard = true;
          const conv = await conversation();
          const [msg] = await db.insert(schema.messages).values({
            accountId: p.accountId, conversationId: conv.id, direction: 'out', type: 'text', status: 'sent', waMessageId: r.waMessageId,
            body: `💠 Botão PIX · ${formatBRL(pix.amount)}${pix.text ? `\n${pix.text}` : ''}\n\nCopia e cola:\n${pix.code}`,
          }).returning();
          await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
          emitToAccount(p.accountId, 'message:new', { conversationId: conv.id, message: msg });
        } catch (err) {
          console.warn('[flow] cartão Pix recusado, enviando como texto:', (err as Error).message);
        }
      }
      if (sentCard) return;
      // sem o cartão de pagamento (conta não liberada para pagamentos): texto + código para copiar
      const intro = `${pix.text ? `${pix.text}\n\n` : ''}💠 Pix de ${formatBRL(pix.amount)} para ${pix.merchantName}\nChave: ${pix.key}\n\nCopie o código abaixo e cole no app do banco (Pix copia e cola) 👇`;
      await exec.sendText(intro);
      await exec.sendText(pix.code);
    },
    async sendCarousel(text, cards) {
      const resolved = await Promise.all(cards.map(async (c) => ({ ...c, image: (await imageOf(c.image)) ?? {} })));
      const summary = `🎠 Carrossel: ${text}\n${cards.map((c, i) => `${i + 1}. ${c.text || '(sem texto)'}${c.buttons.length ? ` [${c.buttons.map((b) => b.title).join(' | ')}]` : ''}`).join('\n')}`;
      takeQuote();
      await deliver((conn, to) => {
        if (resolved.some((c) => !c.image.link && !c.image.id)) throw new Error('Um cartão do carrossel está sem imagem.');
        return sendInteractive(conn, to, carouselInteractive(text, resolved));
      }, summary, 'text', null);
    },
    async sendTemplate(t) {
      const values = t.body.map((b) => b.value).join(' · ');
      const { preview, replyButtons, ...send } = t;
      takeQuote();
      const conn = await connection();
      if (conn?.provider === 'web') {
        // QR Code: não existem modelos da Meta — vai o texto do modelo, com os botões como opções numeradas
        const text = templateAsText(preview || values || t.name, replyButtons ?? []);
        await deliver((c, to) => sendText(c, to, text), text, 'text', null);
        return;
      }
      await deliver((conn, to) => waSendTemplate(conn, to, send), preview || `📄 Template “${t.name}”${values ? ` — ${values}` : ''}`, 'template', null);
    },
    async setChatStatus(status, assignUserId, pause) {
      let assigned: string | null = null;
      if (assignUserId && isUuid(assignUserId)) {
        const [m] = await db.select().from(schema.memberships)
          .where(and(eq(schema.memberships.userId, assignUserId), eq(schema.memberships.accountId, p.accountId))).limit(1);
        if (m) assigned = assignUserId;
      }
      const conv = await conversation();
      const patch: Partial<ConversationRow> = { status };
      if (status === 'pending') Object.assign(patch, { assignedUserId: null, botPaused: pause });
      else if (status === 'open') Object.assign(patch, { assignedUserId: assigned ?? conv.assignedUserId, botPaused: pause });
      else Object.assign(patch, { botPaused: false });
      await updateConversation(patch);
    },
    async notify(n) {
      const conn = await connection();
      if (!conn) {
        await note(`🔔 Notificação “${n.name}” não enviada: nenhuma conexão de WhatsApp.`);
        return { ok: false, info: 'sem conexão' };
      }
      const wa = { phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken };
      // janela de 24h aberta com quem vai receber? (só dá para mandar texto livre se a pessoa falou com o número)
      // QR Code não tem essa regra: o texto sai sempre
      let windowOpen = conn.provider === 'web';
      const person = windowOpen ? null : await findContactByPhone(p.accountId, n.phone);
      if (person) {
        const [last] = await db.select({ at: schema.messages.createdAt }).from(schema.messages)
          .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
          .where(and(eq(schema.conversations.contactId, person.id), eq(schema.messages.direction, 'in')))
          .orderBy(desc(schema.messages.createdAt)).limit(1);
        windowOpen = !!last && Date.now() - last.at.getTime() < DAY_MS;
      }
      try {
        if (!windowOpen && n.template) {
          const oneLine = n.text.replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, '   ').slice(0, 1000);
          await waSendTemplate(wa, n.phone, { name: n.template.name, language: n.template.language, body: n.template.withText ? [{ ...(n.template.paramName ? { name: n.template.paramName } : {}), value: oneLine }] : [] });
          await note(`🔔 Notificação “${n.name}” enviada para +${n.phone} (pelo template “${n.template.name}”).`);
          return { ok: true, info: 'template' };
        }
        await sendText(wa, n.phone, n.text);
        await note(windowOpen
          ? `🔔 Notificação “${n.name}” enviada para +${n.phone}.`
          : `🔔 Notificação “${n.name}” enviada para +${n.phone}. Atenção: essa pessoa não falou com o número nas últimas 24 h, então o WhatsApp pode não entregar (escolha um template reserva no bloco).`);
        return { ok: true, info: windowOpen ? 'texto' : 'texto sem janela' };
      } catch (err) {
        await note(`🔔 Notificação “${n.name}” para +${n.phone} falhou: ${(err as Error).message}`);
        return { ok: false, info: (err as Error).message };
      }
    },
    async setDepartment(departmentId) {
      if (departmentId) {
        if (!isUuid(departmentId)) return;
        const [d] = await db.select({ id: schema.departments.id, name: schema.departments.name }).from(schema.departments)
          .where(and(eq(schema.departments.id, departmentId), eq(schema.departments.accountId, p.accountId))).limit(1);
        if (!d) { console.warn('[flow] setor não existe:', departmentId); return; }
        await updateConversation({ departmentId: d.id });
        return;
      }
      await updateConversation({ departmentId: null });
    },
    async assignAgent(agentId) {
      if (agentId) {
        if (!isUuid(agentId)) return;
        const [a] = await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)
          .where(and(eq(schema.agents.id, agentId), eq(schema.agents.accountId, p.accountId))).limit(1);
        if (!a) { console.warn('[flow] agente não existe:', agentId); return; }
        await updateConversation({ aiAgentId: a.id, botPaused: false });
        await note(`🤖 Conversa entregue ao agente de IA “${a.name}”.`);
        return;
      }
      const conv = await conversation();
      if (!conv.aiAgentId) return;
      await updateConversation({ aiAgentId: null });
      await note('↩️ O agente de IA saiu da conversa: ela voltou para os fluxos.');
    },
    async kanbanAction(action, boardId, columnId) {
      if (!isUuid(boardId)) return;
      if (action === 'remove') {
        const del = await db.delete(schema.kanbanCards)
          .where(and(eq(schema.kanbanCards.boardId, boardId), eq(schema.kanbanCards.contactId, p.contactId), eq(schema.kanbanCards.accountId, p.accountId)))
          .returning({ id: schema.kanbanCards.id });
        if (del.length) await touchBoard(p.accountId, boardId);
        return;
      }
      let col = isUuid(columnId) ? columnId : '';
      if (!col) {
        const [first] = await db.select({ id: schema.kanbanColumns.id }).from(schema.kanbanColumns)
          .where(and(eq(schema.kanbanColumns.boardId, boardId), eq(schema.kanbanColumns.accountId, p.accountId)))
          .orderBy(schema.kanbanColumns.position).limit(1);
        col = first?.id ?? '';
      }
      if (!col) return;
      if (action === 'move') {
        const [card] = await db.select({ id: schema.kanbanCards.id }).from(schema.kanbanCards)
          .where(and(eq(schema.kanbanCards.boardId, boardId), eq(schema.kanbanCards.contactId, p.contactId))).limit(1);
        if (!card) return; // "mover" só mexe em quem já está no quadro
      }
      const r = await upsertContactCard(p.accountId, p.contactId, boardId, col);
      if ('error' in r) console.warn('[flow] Kanban:', r.error);
    },
    async saveToContact(key, value) {
      const k = key.toLowerCase();
      if (['nome', 'name', 'nome_completo'].includes(k)) {
        if (value.trim()) await updateContact({ name: value.trim().slice(0, 120) });
        return true;
      }
      if (['email', 'e_mail'].includes(k)) {
        const e = value.trim().toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) await updateContact({ email: e.slice(0, 160) });
        return true;
      }
      const [f] = await db.select({ key: schema.contactFields.key }).from(schema.contactFields)
        .where(and(eq(schema.contactFields.accountId, p.accountId), eq(schema.contactFields.key, k))).limit(1);
      if (!f) return false;
      const c = await contact();
      const custom = { ...((c.custom ?? {}) as Record<string, unknown>) };
      if (value) custom[k] = value.slice(0, 500); else delete custom[k];
      await updateContact({ custom });
      return true;
    },
    async firePixel(px) {
      if (!isUuid(px.pixelId)) return;
      const [pixel] = await db.select().from(schema.pixels)
        .where(and(eq(schema.pixels.id, px.pixelId), eq(schema.pixels.accountId, p.accountId))).limit(1);
      if (!pixel) { await note('📈 Pixel do bloco não existe mais.'); return; }
      if (!PLATFORMS[pixel.platform as Platform]?.events.includes(px.event)) {
        await note(`📈 O evento “${px.event}” não é aceito pelo pixel “${pixel.name}”.`);
        return;
      }
      const [ev] = await db.insert(schema.pixelEvents).values({
        accountId: p.accountId, pixelId: pixel.id, key: `flow:${p.runId}:${px.nodeId}`, trigger: 'flow', eventName: px.event,
        contactId: p.contactId, value: px.value === null ? null : px.value.toFixed(2), currency: px.currency, status: 'queued',
        ...(px.pageId ? { payload: { pageId: px.pageId } } : {}),
      }).onConflictDoNothing().returning();
      if (!ev) return;
      emitToAccount(p.accountId, 'pixel:event', { pixelId: pixel.id, event: publicEvent(ev) });
      const { enqueuePixelEvent } = await import('../queue');
      await enqueuePixelEvent(ev.id);
    },
    async recordSale(s) {
      const product = s.productId ? await exec.getProduct(s.productId) : null;
      // valor vazio ou inválido: usa o preço do produto
      const amount = s.amount ?? product?.price ?? 0;
      const currency = s.currency || 'BRL';
      const conn = await connection();
      const row = await storeSale({
        accountId: p.accountId, contactId: p.contactId, amount, status: 'approved', currency,
        productId: product?.id ?? null, productName: product?.name ?? null, origin: 'flow',
        customerName: s.customerName, connectionId: conn?.id ?? null, externalId: `flow-${p.runId}-${p.flowId.slice(0, 8)}`,
      });
      await note(`💰 Venda registrada pelo fluxo: ${formatBRL(Number(row.amount), row.currency)}${row.productName ? ` · ${row.productName}` : ''}.`);
      return { productName: row.productName ?? '', amount: Number(row.amount), currency: row.currency };
    },
    async notifyApp(title, body) {
      // a notificação abre a conversa do contato (sem criar uma nova só por isso)
      const conversationId = convCache?.id ?? (await db.select({ id: schema.conversations.id }).from(schema.conversations)
        .where(and(eq(schema.conversations.accountId, p.accountId), eq(schema.conversations.contactId, p.contactId)))
        .orderBy(desc(schema.conversations.lastMessageAt)).limit(1))[0]?.id ?? null;
      emitToAccount(p.accountId, 'app:notify', { kind: 'sale', title, body, contactId: p.contactId, conversationId, at: new Date().toISOString() });
    },
    async distribute(nodeId, outputIds, sticky) {
      if (sticky) {
        const [prev] = await db.select().from(schema.flowDistributions).where(and(
          eq(schema.flowDistributions.flowId, p.flowId), eq(schema.flowDistributions.nodeId, nodeId), eq(schema.flowDistributions.contactId, p.contactId),
        )).limit(1);
        if (prev && outputIds.includes(prev.outputId)) return prev.outputId;
      }
      const [row] = await db.insert(schema.flowNodeStats).values({ flowId: p.flowId, nodeId, rr: 1 })
        .onConflictDoUpdate({ target: [schema.flowNodeStats.flowId, schema.flowNodeStats.nodeId], set: { rr: sql`${schema.flowNodeStats.rr} + 1` } })
        .returning({ rr: schema.flowNodeStats.rr });
      const id = outputIds[((row?.rr ?? 1) - 1) % outputIds.length];
      if (sticky) {
        await db.insert(schema.flowDistributions).values({ flowId: p.flowId, nodeId, contactId: p.contactId, outputId: id })
          .onConflictDoUpdate({ target: [schema.flowDistributions.flowId, schema.flowDistributions.nodeId, schema.flowDistributions.contactId], set: { outputId: id } });
      }
      return id;
    },
    async aiComplete(spec) {
      const messages: ChatMsg[] = [{ role: 'system', content: spec.system }];
      if (spec.history > 0) {
        const conv = await conversation();
        const hist = await db.select().from(schema.messages)
          .where(and(eq(schema.messages.conversationId, conv.id), ne(schema.messages.type, 'note')))
          .orderBy(desc(schema.messages.createdAt)).limit(spec.history * 2 + 1);
        // a última mensagem do cliente já vai no pedido
        if (hist[0]?.direction === 'in') hist.shift();
        for (const m of hist.reverse()) {
          if (m.body) messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body });
        }
      }
      messages.push({ role: 'user', content: toChatParts(spec.user) });
      if (spec.provider === 'converza') {
        const conv = await conversation();
        return aiCall(p.accountId, messages, {
          model: spec.model, maxTokens: spec.maxTokens,
          usage: { kind: 'flow_ai', conversationId: conv.id, contactId: p.contactId, flowId: p.flowId, label: 'Bloco de IA do fluxo' },
        });
      }
      const r = await chatCompleteWith({ baseUrl: byokBaseUrl(spec.provider), apiKey: spec.apiKey ?? '' }, spec.model ?? '', messages, { maxTokens: spec.maxTokens });
      return r.text;
    },
    async aiAudio(provider, apiKey, media) {
      if (provider === 'converza') {
        if (!voiceEnabled()) throw new Error('a transcrição de áudio não está configurada no servidor (falta a ELEVENLABS_API_KEY).');
        const r = await transcribe({ data: media.data, mime: media.mime, filename: media.filename || 'audio.ogg' });
        const conv = await conversation();
        await chargeTokens(p.accountId, sttTokens(r.seconds), { kind: 'transcription', conversationId: conv.id, contactId: p.contactId, flowId: p.flowId, label: 'Áudio no Bloco de IA' });
        return { text: r.text };
      }
      if (provider === 'openai') {
        return { text: await transcribeWith({ baseUrl: byokBaseUrl('openai'), apiKey: apiKey ?? '' }, media.data, media.mime, media.filename || 'audio.ogg') };
      }
      const mp3 = await toMp3(media.data);
      return { part: { type: 'audio', format: 'mp3', data: mp3.toString('base64') } };
    },
    async lastInboundMedia() {
      if (mediaCache !== undefined) return mediaCache;
      mediaCache = null;
      const id = p.state.mediaMsgId;
      if (!id || !isUuid(id)) return null;
      const [row] = await db.select({ m: schema.messages, token: schema.connections.accessToken }).from(schema.messages)
        .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
        .leftJoin(schema.connections, eq(schema.connections.id, schema.conversations.connectionId))
        .where(and(eq(schema.messages.id, id), eq(schema.messages.accountId, p.accountId))).limit(1);
      if (!row?.m.waMediaId || !row.token) return null;
      const kind = row.m.type as InboundMedia['kind'];
      if (!['audio', 'image', 'document', 'video', 'sticker'].includes(kind)) return null;
      const file = await downloadMedia(row.token, row.m.waMediaId);
      if (file.data.length > MAX_AI_MEDIA) throw new Error('o arquivo do cliente é grande demais para a IA (até 15 MB).');
      mediaCache = { kind, mime: (row.m.mimeType || file.mime || '').split(';')[0], filename: row.m.fileName, data: file.data };
      return mediaCache;
    },
    timezone,
    async businessWindows() {
      const c = await connection();
      if (!c) return null;
      const [h] = await db.select().from(schema.businessHours).where(eq(schema.businessHours.connectionId, c.id)).limit(1);
      if (!h || !h.enabled || h.accountId !== p.accountId) return null;
      return { schedule: h.schedule as Schedule };
    },
    now: () => new Date(),
  };
  return exec;
}

/* ------------------------------------------------------------- execução */

async function persist(runId: string, halt: Halt, state: RunState) {
  const set = (patch: Partial<RunRow>) =>
    db.update(schema.flowRuns).set({ context: state as any, ...patch }).where(eq(schema.flowRuns.id, runId));
  switch (halt.kind) {
    case 'end':
      await set({ status: 'done', currentNodeId: null, finishedAt: new Date() });
      break;
    case 'input':
      await set({ status: 'waiting_input', currentNodeId: halt.nodeId });
      if (halt.timeoutSeconds && halt.token) {
        await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'input_timeout', token: halt.token }, halt.timeoutSeconds * 1000);
      }
      break;
    case 'buffer':
      await set({ status: 'waiting_input', currentNodeId: halt.nodeId });
      await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'buffer_flush', token: halt.token }, halt.seconds * 1000);
      break;
    case 'delay':
      await set({ status: 'waiting', currentNodeId: halt.nodeId });
      await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'delay' }, halt.seconds * 1000);
      break;
    case 'payment':
      await set({ status: 'waiting_payment', currentNodeId: halt.nodeId });
      await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'payment_timeout' }, halt.timeoutSeconds * 1000);
      break;
  }
}

async function execute(run: RunRow, flow: FlowRow, state: RunState, fn: (exec: FlowExecutor) => Promise<Halt>) {
  const exec = createDbExecutor({ accountId: flow.accountId, flowId: flow.id, contactId: run.contactId, runId: run.id, state });
  let halt: Halt;
  try {
    halt = await fn(exec);
  } catch (err) {
    console.error(`[flow ${flow.id}] erro na execução ${run.id}:`, (err as Error).message);
    await db.update(schema.flowRuns).set({ status: 'error', finishedAt: new Date(), context: state as any })
      .where(eq(schema.flowRuns.id, run.id));
    return;
  }
  await persist(run.id, halt, state);
  if (exec.pendingGoto) {
    await startFlowById(flow.accountId, exec.pendingGoto, run.contactId, state).catch((err) =>
      console.error('[flow] ir para fluxo falhou:', (err as Error).message));
  }
}

/** Troca o status de forma atômica — só um processo retoma cada execução. */
async function claim(runId: string, from: string, nodeId?: string | null): Promise<RunRow | null> {
  const conds = [eq(schema.flowRuns.id, runId), eq(schema.flowRuns.status, from)];
  if (nodeId) conds.push(eq(schema.flowRuns.currentNodeId, nodeId));
  const [row] = await db.update(schema.flowRuns).set({ status: 'running' }).where(and(...conds)).returning();
  return row ?? null;
}

async function loadRunnableFlow(run: RunRow): Promise<FlowRow | null> {
  const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, run.flowId)).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) {
    await db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(eq(schema.flowRuns.id, run.id));
    return null;
  }
  return flow;
}

async function startRun(flow: FlowRow, contactId: string, state: RunState, opts: { ignoreReentry?: boolean } = {}): Promise<boolean> {
  const graph = normalizeGraph(flow.graph);
  const t = triggerOf(flow.trigger, graph);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return false;

  if (!opts.ignoreReentry && (t.reentry === 'once' || t.reentry === 'cooldown')) {
    const [last] = await db.select({ startedAt: schema.flowRuns.startedAt }).from(schema.flowRuns)
      .where(and(eq(schema.flowRuns.flowId, flow.id), eq(schema.flowRuns.contactId, contactId)))
      .orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (last) {
      if (t.reentry === 'once') return false;
      const hours = Math.max(1, Number(t.cooldownHours ?? 24) || 24);
      if (Date.now() - last.startedAt.getTime() < hours * 3_600_000) return false;
    }
  }

  // índice único parcial: no máximo uma execução em andamento por fluxo + contato
  const [run] = await db.insert(schema.flowRuns)
    .values({ accountId: flow.accountId, flowId: flow.id, contactId, status: 'running', context: state as any })
    .onConflictDoNothing().returning();
  if (!run) return false;

  await execute(run, flow, state, (exec) => runFrom(graph, trigger.id, state, exec));
  return true;
}

/** Estado novo para um fluxo que começa a partir de outro (Conexão de Fluxo, agente, webhook…). */
const carryState = (from: Partial<RunState> & { lastMessage?: string }) => normalizeState({
  lastMessage: from.lastMessage ?? '', vars: from.vars ?? {}, connectionId: from.connectionId ?? null,
  lastWaId: from.lastWaId ?? null, mediaMsgId: from.mediaMsgId ?? null,
});

async function startFlowById(accountId: string, flowId: string, contactId: string, from: RunState) {
  if (!isUuid(flowId)) return;
  const [flow] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) return;
  await startRun(flow, contactId, carryState(from), { ignoreReentry: true });
}

/**
 * Dispara um fluxo para o contato por fora do gatilho (ex.: o agente de IA manda o checkout).
 * 'started' = começou; 'running' = já está em andamento para esse contato; 'inactive' = fluxo pausado/arquivado/inexistente.
 */
export async function startFlowForContact(accountId: string, flowId: string, contactId: string,
  from: { lastMessage?: string; connectionId?: string | null; vars?: Dict } = {}): Promise<'started' | 'running' | 'inactive'> {
  if (!isUuid(flowId)) return 'inactive';
  const [flow] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) return 'inactive';
  const state = carryState({ lastMessage: from.lastMessage ?? '', vars: from.vars ?? {}, connectionId: from.connectionId ?? null });
  return (await startRun(flow, contactId, state, { ignoreReentry: true })) ? 'started' : 'running';
}

/**
 * Fluxo que espera o cliente responder (o webhook mandou um modelo fora da janela de 24h).
 * Na próxima mensagem dele, o fluxo começa do início com as variáveis do evento.
 */
async function startPendingFlow(ev: InboundEvent): Promise<boolean> {
  const [p] = await db.delete(schema.flowPending)
    .where(and(eq(schema.flowPending.contactId, ev.contactId), eq(schema.flowPending.accountId, ev.accountId)))
    .returning();
  if (!p || p.expiresAt.getTime() < Date.now()) return false;
  const r = await startFlowForContact(ev.accountId, p.flowId, ev.contactId, {
    lastMessage: ev.text, connectionId: ev.connectionId ?? p.connectionId, vars: (p.vars ?? {}) as Dict,
  });
  return r === 'started';
}

/* ------------------------------------------------------------ entradas */

const inboundState = (ev: InboundEvent) => normalizeState({
  lastMessage: ev.text, lastReplyId: ev.replyId ?? null, vars: ev.vars ?? {}, connectionId: ev.connectionId ?? null,
  lastWaId: ev.waId ?? null, mediaMsgId: ev.mediaMsgId ?? null,
});

/**
 * Chamado a cada mensagem recebida ou evento de webhook.
 * Retorna true se algum fluxo tratou o evento (para o agente de IA não responder junto).
 */
export async function triggerFlowsForInbound(ev: InboundEvent): Promise<boolean> {
  // 1) o contato está respondendo uma espera (Aguarda Resposta, Menu, Carrossel, Template) → retoma a execução mais recente
  if (ev.source === 'inbound_message') {
    const [waiting] = await db.select().from(schema.flowRuns).where(and(
      eq(schema.flowRuns.accountId, ev.accountId),
      eq(schema.flowRuns.contactId, ev.contactId),
      eq(schema.flowRuns.status, 'waiting_input'),
    )).orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (waiting) {
      const run = await claim(waiting.id, 'waiting_input');
      if (run) {
        const flow = await loadRunnableFlow(run);
        if (flow) {
          const graph = normalizeGraph(flow.graph);
          const state = normalizeState(run.context);
          if (ev.connectionId) state.connectionId = ev.connectionId;
          await execute(run, flow, state, (exec) =>
            resumeInput(graph, run.currentNodeId ?? '', state, exec, {
              text: ev.text, replyId: ev.replyId ?? null, waId: ev.waId ?? null, mediaMsgId: ev.mediaMsgId ?? null,
            }));
          return true;
        }
      }
    }
  }
  if (ev.onlyResume) return false;

  // 1b) respondeu o modelo mandado pelo webhook → começa o fluxo que estava esperando
  if (ev.source === 'inbound_message' && await startPendingFlow(ev)) return true;

  // 2) inicia os fluxos cujo gatilho combina (palavra-chave tem prioridade)
  const flows = await db.select().from(schema.flows).where(and(
    eq(schema.flows.accountId, ev.accountId), eq(schema.flows.status, 'active'), isNull(schema.flows.archivedAt),
  ));
  const skip = new Set(ev.excludeFlowIds ?? []);
  const matched = flows
    .filter((f) => !skip.has(f.id))
    .map((f) => ({ flow: f, trigger: triggerOf(f.trigger, normalizeGraph(f.graph)) }))
    .filter(({ trigger }) => triggerMatches(trigger, ev));
  const byKeyword = matched.filter(({ trigger }) => trigger.type === 'keyword');

  // 3) fluxos padrões do número (palavra-chave continua valendo antes de tudo)
  if (!byKeyword.length && ev.source === 'inbound_message') {
    const defaults = await defaultFlowsFor(ev.connectionId);
    if (defaults?.offHoursFlowId) {
      const h = await openNow(ev.accountId, ev.connectionId);
      // fora do horário: só o aviso de fora do horário responde (uma vez a cada 12 h por contato)
      if (h.enabled && !h.open) {
        await startDefaultFlow(defaults.offHoursFlowId, ev, 12);
        return true;
      }
    }
    // boas-vindas: primeira mensagem de um contato novo, quando nenhum fluxo tem gatilho para ela
    if (!matched.length && ev.isFirstMessage && defaults?.welcomeFlowId && await startDefaultFlow(defaults.welcomeFlowId, ev, 0)) return true;
  }
  const selected = byKeyword.length ? byKeyword : matched;

  let started = false;
  for (const { flow } of selected) {
    try {
      if (await startRun(flow, ev.contactId, inboundState(ev))) started = true;
    } catch (err) {
      console.error(`[flow ${flow.id}] erro ao iniciar:`, (err as Error).message);
    }
  }
  return started;
}

/**
 * Começa um fluxo padrão (escolhido em Configurações › Fluxos Padrões). Vale para fluxos ativos e rascunhos
 * (o gatilho deles não importa aqui); fluxo pausado ou arquivado não roda. `throttleHours`: não repete para
 * o mesmo contato dentro desse tempo (0 = sem trava).
 */
async function startDefaultFlow(flowId: string, ev: InboundEvent, throttleHours: number): Promise<boolean> {
  const [flow] = await db.select().from(schema.flows).where(and(
    eq(schema.flows.id, flowId), eq(schema.flows.accountId, ev.accountId), isNull(schema.flows.archivedAt),
  )).limit(1);
  if (!flow || flow.status === 'paused') return false;
  if (throttleHours > 0) {
    const [last] = await db.select({ startedAt: schema.flowRuns.startedAt }).from(schema.flowRuns)
      .where(and(eq(schema.flowRuns.flowId, flow.id), eq(schema.flowRuns.contactId, ev.contactId)))
      .orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < throttleHours * 3_600_000) return false;
  }
  try {
    return await startRun(flow, ev.contactId, inboundState(ev), { ignoreReentry: true });
  } catch (err) {
    console.error(`[flow ${flow.id}] fluxo padrão não começou:`, (err as Error).message);
    return false;
  }
}

/** Nada respondeu a mensagem (nenhum fluxo e nenhum agente de IA): o fluxo padrão "quando nada responde". */
export async function startFallbackFlow(ev: InboundEvent): Promise<boolean> {
  const defaults = await defaultFlowsFor(ev.connectionId);
  if (!defaults?.fallbackFlowId) return false;
  return startDefaultFlow(defaults.fallbackFlowId, ev, 1);
}

/** Pagamento aprovado (webhook de venda) → retoma execuções aguardando pagamento do contato. */
export async function onPaymentApproved(accountId: string, contactId: string) {
  const runs = await db.select().from(schema.flowRuns).where(and(
    eq(schema.flowRuns.accountId, accountId), eq(schema.flowRuns.contactId, contactId),
    eq(schema.flowRuns.status, 'waiting_payment'),
  ));
  for (const r of runs) await resumePaymentRun(r.id, r.currentNodeId ?? '', true);
}

async function resumePaymentRun(runId: string, nodeId: string, paid: boolean) {
  const run = await claim(runId, 'waiting_payment', nodeId || null);
  if (!run) return;
  const flow = await loadRunnableFlow(run);
  if (!flow) return;
  const graph = normalizeGraph(flow.graph);
  const state = normalizeState(run.context);
  await execute(run, flow, state, (exec) => resumePayment(graph, nodeId, state, exec, paid));
}

/** Tempo limite de uma espera ou fim do buffer: só vale se a espera ainda for a mesma (mesmo token). */
async function resumeWaitJob(data: FlowJobData) {
  const [cur] = await db.select().from(schema.flowRuns).where(eq(schema.flowRuns.id, data.runId)).limit(1);
  if (!cur || cur.status !== 'waiting_input' || cur.currentNodeId !== data.nodeId) return;
  if (normalizeState(cur.context).waitToken !== data.token) return;
  const run = await claim(data.runId, 'waiting_input', data.nodeId);
  if (!run) return;
  const state = normalizeState(run.context);
  if (state.waitToken !== data.token) {
    // o cliente respondeu no meio do caminho: devolve a espera como estava
    await db.update(schema.flowRuns).set({ status: 'waiting_input' }).where(eq(schema.flowRuns.id, run.id));
    return;
  }
  const flow = await loadRunnableFlow(run);
  if (!flow) return;
  const graph = normalizeGraph(flow.graph);
  return execute(run, flow, state, (exec) => (data.kind === 'buffer_flush'
    ? flushBuffer(graph, data.nodeId, state, exec)
    : resumeTimeout(graph, data.nodeId, state, exec)));
}

/** Processa os jobs da fila de fluxos (fim de espera, tempo limite, buffer, tempo do pagamento). */
export async function handleFlowJob(data: FlowJobData) {
  if (data.kind === 'payment_timeout') return resumePaymentRun(data.runId, data.nodeId, false);
  if (data.kind === 'input_timeout' || data.kind === 'buffer_flush') return resumeWaitJob(data);

  if (data.kind === 'delay') {
    const run = await claim(data.runId, 'waiting', data.nodeId);
    if (!run) return;
    const flow = await loadRunnableFlow(run);
    if (!flow) return;
    const graph = normalizeGraph(flow.graph);
    const state = normalizeState(run.context);
    return execute(run, flow, state, (exec) => resumeAfterDelay(graph, data.nodeId, state, exec));
  }

  // job do motor antigo: nodeId era o PRÓXIMO bloco
  const run = await claim(data.runId, 'waiting');
  if (!run) return;
  const flow = await loadRunnableFlow(run);
  if (!flow) return;
  const graph: FlowGraph = normalizeGraph(flow.graph);
  const state = normalizeState(run.context);
  return execute(run, flow, state, (exec) => runFrom(graph, data.nodeId, state, exec));
}

/** Ao subir o servidor, execuções presas em "running" (processo reiniciado) viram erro. */
export async function cleanupOrphanRuns() {
  await db.update(schema.flowRuns).set({ status: 'error', finishedAt: new Date() })
    .where(eq(schema.flowRuns.status, 'running'));
}

export async function stopRunsForContact(accountId: string, contactId: string, runId?: string) {
  const conds = [
    eq(schema.flowRuns.accountId, accountId), eq(schema.flowRuns.contactId, contactId),
    inArray(schema.flowRuns.status, ACTIVE_RUN_STATUSES),
  ];
  if (runId) conds.push(eq(schema.flowRuns.id, runId));
  return db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(and(...conds)).returning({ id: schema.flowRuns.id });
}

/** Anexos enviados no editor de fluxos que nenhum fluxo usa mais (depois de 1 dia): apaga. */
export async function sweepFlowFiles() {
  const cutoff = new Date(Date.now() - DAY_MS);
  const r = await db.execute(sql`
    delete from stored_files f
    where f.purpose = 'flow' and f.created_at < ${cutoff}
      and not exists (select 1 from flows w where w.account_id = f.account_id and w.graph::text like '%' || f.id::text || '%')
    returning f.id`);
  return r.rows.length;
}
