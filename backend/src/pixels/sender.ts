/**
 * Envio dos eventos dos pixels: grava o evento quando algo acontece (lead, venda, etapa do Kanban),
 * manda pela fila (com novas tentativas) e guarda o resultado no histórico do pixel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { emitToAccount } from '../realtime/io';
import { MetaApiError, sendCapi } from '../meta/graphAds';
import { buildEvent, eventKey, ruleMatches, type Person, type Platform, type Rule, type Trigger, type TriggerCtx } from './engine';

type PixelRow = typeof schema.pixels.$inferSelect;
type EventRow = typeof schema.pixelEvents.$inferSelect;

export class PixelSendError extends Error {
  retryable: boolean;
  tokenProblem: boolean;
  constructor(message: string, retryable: boolean, tokenProblem: boolean) {
    super(message);
    this.retryable = retryable;
    this.tokenProblem = tokenProblem;
  }
}

export function publicEvent(e: EventRow & { contactName?: string | null }) {
  return {
    id: e.id, pixelId: e.pixelId, trigger: e.trigger, eventName: e.eventName, status: e.status, error: e.error,
    contactId: e.contactId, contactName: e.contactName ?? null, saleId: e.saleId,
    value: e.value === null ? null : Number(e.value), currency: e.currency, attempts: e.attempts,
    response: e.response, payload: e.payload, eventTime: e.eventTime, sentAt: e.sentAt, createdAt: e.createdAt,
  };
}

/** Algo aconteceu: cria o evento de cada pixel com uma regra para isso (uma vez só) e põe na fila. Nunca lança. */
export async function firePixels(accountId: string, trigger: Trigger, ctx: TriggerCtx): Promise<number> {
  try {
    const base = eventKey(trigger, ctx);
    if (!base) return 0;
    const list = await db.select().from(schema.pixels)
      .where(and(eq(schema.pixels.accountId, accountId), inArray(schema.pixels.status, ['active', 'error'])));
    let n = 0;
    for (const px of list) {
      for (const r of (px.rules as Rule[]) ?? []) {
        if (!ruleMatches(r, trigger, ctx)) continue;
        const [ev] = await db.insert(schema.pixelEvents).values({
          accountId, pixelId: px.id, key: `${base}#${r.event}`, trigger, eventName: r.event,
          contactId: ctx.contactId ?? null, saleId: ctx.saleId ?? null, status: 'queued',
        }).onConflictDoNothing().returning();
        if (!ev) continue;
        emitToAccount(accountId, 'pixel:event', { pixelId: px.id, event: publicEvent(ev) });
        // import na hora: a fila abre conexão com o Redis, e este módulo é importado por partes puras (Kanban)
        const { enqueuePixelEvent } = await import('../queue');
        await enqueuePixelEvent(ev.id);
        n++;
      }
    }
    return n;
  } catch (err) {
    console.error(`[pixels] gatilho ${trigger}:`, (err as Error).message);
    return 0;
  }
}

/* ------------------------------------------------------------------ envio */

async function sendTikTok(token: string, body: Record<string, unknown>) {
  let resp: Response;
  try {
    resp = await fetch(`${config.tiktok.apiBase}/open_api/v1.3/event/track/`, {
      method: 'POST', headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new PixelSendError(`Sem conexão com o TikTok (${(err as Error).message})`, true, false);
  }
  const data = (await resp.json().catch(() => ({}))) as { code?: number; message?: string; request_id?: string };
  const code = Number(data?.code);
  if (resp.ok && code === 0) return data;
  const msg = String(data?.message || `HTTP ${resp.status}`).slice(0, 300);
  const tokenProblem = resp.status === 401 || [40001, 40002, 40104, 40105].includes(code);
  const retryable = resp.status >= 500 || code === 40100 || code >= 50000;
  throw new PixelSendError(tokenProblem ? `O TikTok recusou o token ou o pixel: ${msg}` : `O TikTok recusou o evento: ${msg}`, retryable, tokenProblem);
}

/** Manda um corpo já montado para a plataforma do pixel. */
export async function deliver(platform: Platform, pixelId: string, token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (platform === 'tiktok') return sendTikTok(token, body);
  try {
    return await sendCapi(pixelId, token, body);
  } catch (err) {
    const e = err as MetaApiError;
    const tokenProblem = e.tokenExpired || e.code === 10 || e.code === 200 || (e.code === 100 && e.subcode === 33);
    const msg = e.tokenExpired
      ? 'O token do pixel venceu ou foi revogado. Gere um token novo no Gerenciador de Eventos e troque em Ajustes.'
      : e.code === 100 && e.subcode === 33 ? 'A Meta não encontrou o pixel ou o token não tem acesso a ele.' : e.message;
    throw new PixelSendError(msg, e.status >= 500 || e.rateLimited, tokenProblem);
  }
}

/** Token e WABA de um pixel (o do WhatsApp usa o token da conexão quando não tem um próprio). */
export async function pixelCredentials(px: PixelRow): Promise<{ token: string | null; wabaId: string | null }> {
  if (px.platform !== 'meta_whatsapp') return { token: px.accessToken, wabaId: null };
  const [conn] = px.connectionId
    ? await db.select({ token: schema.connections.accessToken, wabaId: schema.connections.wabaId }).from(schema.connections)
      .where(eq(schema.connections.id, px.connectionId)).limit(1)
    : [];
  return { token: px.accessToken ?? conn?.token ?? null, wabaId: conn?.wabaId ?? px.wabaId };
}

async function finish(ev: EventRow, patch: Partial<typeof schema.pixelEvents.$inferInsert>) {
  const [row] = await db.update(schema.pixelEvents).set(patch).where(eq(schema.pixelEvents.id, ev.id)).returning();
  if (row) emitToAccount(row.accountId, 'pixel:event', { pixelId: row.pixelId, event: publicEvent(row) });
  return row;
}

async function markPixel(px: PixelRow, patch: Partial<typeof schema.pixels.$inferInsert>) {
  const [row] = await db.update(schema.pixels).set({ ...patch, updatedAt: new Date() }).where(eq(schema.pixels.id, px.id)).returning();
  if (row) emitToAccount(row.accountId, 'pixel:changed', { pixelId: row.id });
}

/** Worker: monta e manda um evento. Lança só quando vale tentar de novo (a fila repete). */
export async function sendPixelEvent(eventId: string, attempt = 1, maxAttempts = 1): Promise<void> {
  const [ev] = await db.select().from(schema.pixelEvents).where(eq(schema.pixelEvents.id, eventId)).limit(1);
  if (!ev || ev.status === 'sent' || ev.status === 'skipped') return;
  const [px] = await db.select().from(schema.pixels).where(eq(schema.pixels.id, ev.pixelId)).limit(1);
  if (!px) return;
  if (px.status === 'paused') { await finish(ev, { status: 'skipped', error: 'O pixel estava pausado.' }); return; }

  const [contact] = ev.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, ev.contactId)).limit(1) : [];
  const [sale] = ev.saleId ? await db.select().from(schema.sales).where(eq(schema.sales.id, ev.saleId)).limit(1) : [];
  if (ev.trigger === 'sale' && (!sale || sale.status !== 'approved')) { await finish(ev, { status: 'skipped', error: 'A venda não está mais aprovada.' }); return; }

  const person: Person | null = contact
    ? { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, ctwaClid: contact.ctwaClid, state: sale?.state ?? null }
    : sale ? { id: sale.id, name: sale.customerName, phone: sale.customerPhone, email: null, state: sale.state } : null;
  // evento do bloco Pixel do fluxo: valor e moeda vêm do próprio evento
  const money = sale
    ? { value: Number(sale.amount), currency: sale.currency, product: sale.productName, orderId: sale.externalId ?? sale.id }
    : ev.trigger === 'flow' && ev.value !== null ? { value: Number(ev.value), currency: ev.currency || 'BRL', product: null, orderId: ev.id } : null;

  const { token, wabaId } = await pixelCredentials(px);
  if (!token) { await finish(ev, { status: 'failed', error: 'O pixel está sem token de acesso.' }); return; }
  const built = buildEvent({ platform: px.platform as Platform, pixelId: px.pixelId, wabaId, event: ev.eventName, key: ev.key, time: ev.eventTime, person, money });
  if (!built.ok) { await finish(ev, { status: 'skipped', error: built.skip }); return; }

  const extra = { value: money ? money.value.toFixed(2) : null, currency: money?.currency ?? null, payload: built.preview, attempts: attempt };
  try {
    const resp = await deliver(px.platform as Platform, px.pixelId, token, built.body);
    await finish(ev, { ...extra, status: 'sent', error: null, response: resp, sentAt: new Date() });
    await markPixel(px, { lastEventAt: new Date(), ...(px.status === 'error' ? { status: 'active', lastError: null } : {}) });
  } catch (err) {
    const e = err instanceof PixelSendError ? err : new PixelSendError((err as Error).message, true, false);
    if (e.retryable && attempt < maxAttempts) {
      await finish(ev, { ...extra, error: `${e.message} (vai tentar de novo)` });
      throw e;
    }
    await finish(ev, { ...extra, status: 'failed', error: e.message });
    if (e.tokenProblem) await markPixel(px, { status: 'error', lastError: e.message });
  }
}
