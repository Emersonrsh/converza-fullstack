/**
 * Disparos em massa: público (filtros de Contatos), envio em partes pela fila, cota, limite diário
 * do número na Meta e o que acontece com cada contato:
 * - falou com você nas últimas 24h → o fluxo começa na hora;
 * - não falou → vai o modelo de mensagem aprovado e o fluxo começa quando ele responder;
 * - sem modelo e fora da janela → fica de fora (a Meta não deixa mandar texto livre).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { isUuid } from '../utils/http';
import { contactsWhere, filtersSchema, STAGE_LABEL, type ContactFilters } from './contacts';
import { ensureConversation } from './conversationStore';
import { chargeDispatch, dispatchQuota, refundDispatch, type Charge } from './dispatchQuota';
import { startFlowForContact } from '../flows/runner';
import { CONNECTION_DOWN_CODES, sendTemplate, WhatsAppError } from '../whatsapp/cloud-api';
import { buildTemplate, type Resolved, type TemplateAction } from './webhookEngine';
import { enqueueCampaignChunk } from '../queue';
import { redis } from '../redis';

export type CampaignRow = typeof schema.campaigns.$inferSelect;
type ContactRow = typeof schema.contacts.$inferSelect;
const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
const PENDING_DAYS = 7;
const CHUNK_MS = 45_000;

/* ----------------------------------------------------------------- público */

export interface DispatchAudience { filters: ContactFilters; excludeRecentDays: number | null }

/** Público salvo (aceita o formato antigo: all / stage / contactIds). */
export function normalizeAudience(raw: unknown): DispatchAudience {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  if ('filters' in a || 'excludeRecentDays' in a) {
    const f = filtersSchema.safeParse(a.filters ?? {});
    const days = Number(a.excludeRecentDays);
    return { filters: f.success ? f.data : {}, excludeRecentDays: Number.isInteger(days) && days > 0 && days <= 365 ? days : null };
  }
  if (Array.isArray(a.contactIds) && a.contactIds.length) return { filters: { ids: a.contactIds.filter(isUuid).slice(0, 10_000) }, excludeRecentDays: null };
  if (typeof a.stage === 'string') return { filters: { stages: [a.stage as 'new'] }, excludeRecentDays: null };
  return { filters: {}, excludeRecentDays: null };
}

/** Quem pediu para sair nunca entra; quem já recebeu disparo há poucos dias pode ficar de fora. */
async function audienceWhere(accountId: string, a: DispatchAudience, opts: { includeOptedOut?: boolean } = {}): Promise<SQL> {
  const parts: SQL[] = [await contactsWhere(accountId, a.filters)];
  if (!opts.includeOptedOut) parts.push(sql`c.opted_out_at is null`);
  if (a.excludeRecentDays) {
    parts.push(sql`not exists (select 1 from campaign_recipients r where r.contact_id = c.id and r.status in ('sent','started')
      and r.processed_at > now() - (${a.excludeRecentDays} || ' days')::interval)`);
  }
  return sql.join(parts, sql` and `);
}

const windowSql = sql`exists (select 1 from messages m join conversations v on v.id = m.conversation_id
  where v.contact_id = c.id and m.direction = 'in' and m.created_at > now() - interval '24 hours')`;

/** Quantos entram, quantos estão na janela de 24h (recebem o fluxo direto) e quantos ficam de fora. */
export async function audiencePreview(accountId: string, a: DispatchAudience) {
  const base = await contactsWhere(accountId, a.filters);
  const where = await audienceWhere(accountId, a);
  const [r] = await rows<{ total: string; open: string; opted: string; matched: string }>(sql`
    select (select count(*) from contacts c where ${where}) as total,
      (select count(*) from contacts c where ${where} and ${windowSql}) as open,
      (select count(*) from contacts c where ${base} and c.opted_out_at is not null) as opted,
      (select count(*) from contacts c where ${base} and c.opted_out_at is null) as matched`);
  const total = Number(r?.total ?? 0);
  const matched = Number(r?.matched ?? 0);
  return { total, windowOpen: Number(r?.open ?? 0), needTemplate: total - Number(r?.open ?? 0), optedOut: Number(r?.opted ?? 0), recentExcluded: Math.max(0, matched - total) };
}

/* ------------------------------------------------------------------ formato */

export function publicCampaign(c: CampaignRow, extra: { flowName?: string | null; connectionName?: string | null } = {}) {
  const t = c.template as TemplateAction | null;
  return {
    id: c.id, name: c.name, status: c.status, pauseReason: c.pauseReason, scheduledAt: c.scheduledAt,
    connectionId: c.connectionId, connectionName: extra.connectionName ?? null, flowId: c.flowId, flowName: extra.flowName ?? null,
    template: t ? { name: t.name, language: t.language } : null, speed: c.speed,
    totalCount: c.totalCount, processed: c.sentCount, started: c.startedCount, templates: c.templateCount,
    failed: c.failedCount, skipped: c.skippedCount, charged: c.chargedQuota + c.chargedExtra, chargedExtra: c.chargedExtra,
    audience: normalizeAudience(c.audience), legacyMessage: c.flowId ? null : c.message || null,
    startedAt: c.startedAt, finishedAt: c.finishedAt, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

const lastEmit = new Map<string, number>();
function emitProgress(c: CampaignRow, force = false) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(c.id) ?? 0) < 700) return;
  lastEmit.set(c.id, now);
  emitToAccount(c.accountId, 'campaign:progress', { campaignId: c.id, campaign: publicCampaign(c) });
}

async function setCampaign(id: string, patch: Partial<typeof schema.campaigns.$inferInsert>) {
  const [row] = await db.update(schema.campaigns).set({ ...patch, updatedAt: new Date() }).where(eq(schema.campaigns.id, id)).returning();
  if (row) emitProgress(row, true);
  return row;
}

/* ---------------------------------------------------------------- envio */

const TIER_CAP: Record<string, number> = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10_000, TIER_100K: 100_000 };

/** Contatos que receberam modelo por este número nas últimas 24h (limite de conversas da Meta). */
async function templatesLast24h(connectionId: string) {
  const [r] = await rows<{ n: string }>(sql`
    select count(distinct v.contact_id) as n from messages m join conversations v on v.id = m.conversation_id
    where v.connection_id = ${connectionId} and m.type = 'template' and m.direction = 'out' and m.status <> 'failed'
      and m.created_at > now() - interval '24 hours'`);
  return Number(r?.n ?? 0);
}

async function windowOpen(contactId: string) {
  const [r] = await rows<{ ok: boolean }>(sql`select exists (select 1 from messages m join conversations v on v.id = m.conversation_id
    where v.contact_id = ${contactId} and m.direction = 'in' and m.created_at > now() - interval '24 hours') as ok`);
  return !!r?.ok;
}

/** Variáveis do modelo com os dados do contato: {{nome}}, {{primeiro_nome}}, {{telefone}}, {{email}}, {{etapa}}, {{campos.cpf}}. */
function contactScope(c: ContactRow, campaignName: string): { resolved: Resolved; payload: Record<string, unknown> } {
  return {
    resolved: {
      phone: c.phone, rawPhone: c.phone, name: c.name, email: c.email, amount: 0, status: 'pending', statusRaw: '', product: null,
      transaction: null, currency: 'BRL', state: null, event: null, fields: {}, detected: [],
      vars: { etapa: STAGE_LABEL[c.stage] ?? c.stage, disparo: campaignName },
    },
    payload: { campos: c.custom ?? {} },
  };
}

type Outcome =
  | { status: 'started' | 'sent'; messageId?: string | null }
  | { status: 'failed' | 'skipped'; error: string }
  | { pause: 'connection' | 'flow' | 'limit'; error: string };

async function deliverOne(c: CampaignRow, conn: typeof schema.connections.$inferSelect, contact: ContactRow): Promise<Outcome> {
  const vars = { disparo: c.name };
  if (await windowOpen(contact.id)) {
    if (!c.flowId) return { status: 'skipped', error: 'Disparo sem fluxo.' };
    const r = await startFlowForContact(c.accountId, c.flowId, contact.id, { lastMessage: '', connectionId: conn.id, vars });
    if (r === 'inactive') return { pause: 'flow', error: 'O fluxo do disparo foi pausado ou excluído.' };
    if (r === 'running') return { status: 'skipped', error: 'O contato já estava neste fluxo.' };
    return { status: 'started' };
  }
  const t = c.template as TemplateAction | null;
  if (!t?.name) return { status: 'skipped', error: 'Sem conversa nas últimas 24h e o disparo não tem modelo de mensagem.' };
  const cap = conn.messagingLimit ? TIER_CAP[conn.messagingLimit] : undefined;
  if (cap && await templatesLast24h(conn.id) >= cap) return { pause: 'limit', error: `Limite da Meta para este número: ${cap.toLocaleString('pt-BR')} contatos novos a cada 24h.` };

  const { resolved, payload } = contactScope(contact, c.name);
  const plan = buildTemplate(t, payload, resolved, contact.name !== contact.phone ? contact.name : null);
  let conv = await ensureConversation(c.accountId, contact.id, conn.id);
  if (conv.connectionId !== conn.id) {
    const [u] = await db.update(schema.conversations).set({ connectionId: conn.id }).where(eq(schema.conversations.id, conv.id)).returning();
    if (u) conv = u;
  }
  let waMessageId: string | null = null;
  try {
    const res = await sendTemplate({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, contact.waId ?? contact.phone, {
      name: plan.name, language: plan.language, body: plan.body, header: plan.header, buttons: plan.buttons,
    });
    waMessageId = res.waMessageId;
    if (res.waId && res.waId !== contact.waId) await db.update(schema.contacts).set({ waId: res.waId }).where(eq(schema.contacts.id, contact.id));
  } catch (err) {
    const e = err as WhatsAppError;
    if (e.code != null && CONNECTION_DOWN_CODES.has(e.code)) return { pause: 'connection', error: e.message };
    return { status: 'failed', error: e.message };
  }
  const media = plan.header && plan.header.type !== 'text' ? plan.header : null;
  const [msg] = await db.insert(schema.messages).values({
    accountId: c.accountId, conversationId: conv.id, direction: 'out', type: 'template', body: plan.preview,
    mediaUrl: media?.link ?? null, mimeType: media ? `${media.type}/*` : null, status: 'sent', waMessageId,
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
  emitToAccount(c.accountId, 'message:new', { conversationId: conv.id, message: msg });
  if (c.flowId) {
    // o fluxo começa quando o cliente responder o modelo
    const until = new Date(Date.now() + PENDING_DAYS * 86400_000);
    await db.insert(schema.flowPending).values({ contactId: contact.id, accountId: c.accountId, flowId: c.flowId, connectionId: conn.id, vars, expiresAt: until })
      .onConflictDoUpdate({ target: schema.flowPending.contactId, set: { flowId: c.flowId, connectionId: conn.id, webhookId: null, vars, expiresAt: until, createdAt: new Date() } });
  }
  return { status: 'sent', messageId: msg.id };
}

const PAUSE_TEXT: Record<string, string> = {
  quota: 'Os disparos do ciclo acabaram. Clique em Continuar quando tiver saldo de novo (novo ciclo ou disparos extras).',
  plan: 'A assinatura ficou inativa. Regularize em Cobranças e assinaturas e clique em Continuar.',
  limit: 'O número chegou ao limite diário da Meta. Continua sozinho quando liberar.',
  connection: 'A conexão de WhatsApp caiu. Reconecte o número e clique em Continuar.',
  flow: 'O fluxo do disparo foi pausado. Ative o fluxo e clique em Continuar.',
  flow_deleted: 'O fluxo deste disparo foi excluído. Duplique o disparo e escolha outro fluxo.',
  manual: 'Pausado por você.',
};
export const pauseText = (r: string | null) => (r ? PAUSE_TEXT[r] ?? r : null);

/** Cria a lista de contatos do disparo (na hora em que ele começa, com o público atual). */
async function materialize(c: CampaignRow) {
  const where = await audienceWhere(c.accountId, normalizeAudience(c.audience));
  await db.execute(sql`
    insert into campaign_recipients (campaign_id, account_id, contact_id, name, phone, status)
    select ${c.id}, ${c.accountId}, c.id, c.name, c.phone, 'queued' from contacts c where ${where}
    on conflict (campaign_id, contact_id) do nothing`);
  const [r] = await rows<{ n: string }>(sql`select count(*) as n from campaign_recipients where campaign_id = ${c.id}`);
  return Number(r?.n ?? 0);
}

/**
 * Uma parte do disparo (~45 s): pega os próximos contatos da fila, um de cada vez, no ritmo escolhido.
 * No fim agenda a próxima parte; pausa sozinho quando acaba a cota, cai a conexão ou bate o limite da Meta.
 */
export async function runCampaignChunk(campaignId: string, opts: { auto?: boolean } = {}) {
  // um disparo roda em uma parte por vez (clicar em Continuar no meio não dobra a velocidade)
  const token = await lock(campaignId);
  if (!token) { await enqueueCampaignChunk(campaignId, 20_000, opts); return; }
  let next: { delay: number; auto?: boolean } | null = null;
  try { next = await chunk(campaignId, opts); } finally { await unlock(campaignId, token); }
  if (next) await enqueueCampaignChunk(campaignId, next.delay, { auto: next.auto });
}

const LOCK_MS = CHUNK_MS + 45_000;
async function lock(id: string): Promise<string | null> {
  const token = Math.random().toString(36).slice(2);
  const ok = await redis.set(`campaign-lock:${id}`, token, 'PX', LOCK_MS, 'NX');
  return ok === 'OK' ? token : null;
}
async function unlock(id: string, token: string) {
  await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `campaign-lock:${id}`, token).catch(() => {});
}

async function chunk(campaignId: string, opts: { auto?: boolean }): Promise<{ delay: number; auto?: boolean } | null> {
  let [c] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1);
  if (!c) return null;
  if (c.status === 'scheduled') c = await setCampaign(c.id, { status: 'sending' });
  // retomada automática depois do limite diário da Meta
  if (opts.auto && c.status === 'paused' && c.pauseReason === 'limit') c = await setCampaign(c.id, { status: 'sending', pauseReason: null });
  if (c.status !== 'sending') return null;
  // disparo antigo (só texto, sem fluxo) não roda neste motor: nunca reenviar para a base
  if (!c.flowId) {
    if (c.message) { await setCampaign(c.id, { status: 'canceled', pauseReason: null, finishedAt: new Date() }); return null; }
    await setCampaign(c.id, { status: 'paused', pauseReason: 'flow_deleted' }); return null;
  }

  if (!c.startedAt) {
    const total = await materialize(c);
    c = await setCampaign(c.id, { totalCount: total, startedAt: new Date() });
    if (!total) { await setCampaign(c.id, { status: 'done', finishedAt: new Date() }); return null; }
  }
  // contato que ficou "enviando" num reinício do servidor: não arrisca mandar duas vezes
  await db.execute(sql`update campaign_recipients set status = 'failed', error = 'Interrompido (o servidor reiniciou no meio do envio).', processed_at = now()
    where campaign_id = ${c.id} and status = 'sending'`);

  const [conn] = c.connectionId ? await db.select().from(schema.connections).where(eq(schema.connections.id, c.connectionId)).limit(1) : [];
  if (!conn || conn.status === 'disconnected') { await setCampaign(c.id, { status: 'paused', pauseReason: 'connection' }); return null; }

  const gap = Math.max(150, Math.round(60_000 / Math.min(300, Math.max(5, c.speed))));
  const deadline = Date.now() + CHUNK_MS;
  while (Date.now() < deadline) {
    const [st] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, c.id)).limit(1);
    if (st?.status !== 'sending') return null;
    // pega o próximo da fila (sem dois envios disputando o mesmo contato)
    const [rec] = await rows<{ id: string; contact_id: string }>(sql`
      update campaign_recipients set status = 'sending' where id = (
        select id from campaign_recipients where campaign_id = ${c.id} and status = 'queued' order by id limit 1 for update skip locked
      ) returning id, contact_id`);
    if (!rec) break;
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, rec.contact_id)).limit(1);
    const finish = async (status: string, patch: Record<string, unknown>, counters: Partial<Record<'started' | 'template' | 'failed' | 'skipped' | 'quota' | 'extra', number>>) => {
      await db.update(schema.campaignRecipients).set({ status, processedAt: new Date(), ...patch }).where(eq(schema.campaignRecipients.id, rec.id));
      const [row] = await db.update(schema.campaigns).set({
        sentCount: sql`${schema.campaigns.sentCount} + 1`,
        startedCount: sql`${schema.campaigns.startedCount} + ${counters.started ?? 0}`,
        templateCount: sql`${schema.campaigns.templateCount} + ${counters.template ?? 0}`,
        failedCount: sql`${schema.campaigns.failedCount} + ${counters.failed ?? 0}`,
        skippedCount: sql`${schema.campaigns.skippedCount} + ${counters.skipped ?? 0}`,
        chargedQuota: sql`${schema.campaigns.chargedQuota} + ${counters.quota ?? 0}`,
        chargedExtra: sql`${schema.campaigns.chargedExtra} + ${counters.extra ?? 0}`,
        updatedAt: new Date(),
      }).where(eq(schema.campaigns.id, c.id)).returning();
      if (row) { c = row; emitProgress(row); }
    };
    const requeue = () => db.update(schema.campaignRecipients).set({ status: 'queued' }).where(eq(schema.campaignRecipients.id, rec.id));

    if (!contact) { await finish('skipped', { error: 'O contato foi excluído.' }, { skipped: 1 }); continue; }
    if (contact.optedOutAt) { await finish('skipped', { error: 'Pediu para não receber disparos.' }, { skipped: 1 }); continue; }

    const charge: Charge | null = await chargeDispatch(c.accountId);
    if (!charge) {
      await requeue();
      const q = await dispatchQuota(c.accountId);
      await setCampaign(c.id, { status: 'paused', pauseReason: q.active ? 'quota' : 'plan' });
      return null;
    }

    let out: Outcome;
    try { out = await deliverOne(c, conn, contact); } catch (err) { out = { status: 'failed', error: (err as Error).message }; }

    if ('pause' in out) {
      await refundDispatch(c.accountId, charge);
      await requeue();
      await setCampaign(c.id, { status: 'paused', pauseReason: out.pause });
      // limite diário: tenta de novo em 1 hora
      return out.pause === 'limit' ? { delay: 60 * 60_000, auto: true } : null;
    }
    const used = { [charge.from]: 1 } as { quota?: number; extra?: number };
    if (out.status === 'started') await finish('started', { charge: charge.from }, { started: 1, ...used });
    else if (out.status === 'sent') await finish('sent', { charge: charge.from, messageId: out.messageId ?? null }, { template: 1, ...used });
    else if ('error' in out) {
      // nada foi enviado: o disparo volta para o saldo
      await refundDispatch(c.accountId, charge);
      await finish(out.status, { error: out.error.slice(0, 500) }, out.status === 'failed' ? { failed: 1 } : { skipped: 1 });
    }
    await new Promise((r) => setTimeout(r, gap));
  }

  const [left] = await rows<{ n: string }>(sql`select count(*) as n from campaign_recipients where campaign_id = ${c.id} and status = 'queued'`);
  if (Number(left?.n ?? 0) > 0) return { delay: 0 };
  const [st] = await db.select({ status: schema.campaigns.status }).from(schema.campaigns).where(eq(schema.campaigns.id, c.id)).limit(1);
  if (st?.status === 'sending') await setCampaign(c.id, { status: 'done', finishedAt: new Date(), pauseReason: null });
  return null;
}

/** Disparo "enviando" que parou de andar (reinício, Redis vazio): agenda a continuação. */
export async function resumeStaleCampaigns() {
  const stale = await db.select({ id: schema.campaigns.id }).from(schema.campaigns)
    .where(and(eq(schema.campaigns.status, 'sending'), sql`${schema.campaigns.updatedAt} < now() - interval '3 minutes'`)).limit(100);
  for (const s of stale) await enqueueCampaignChunk(s.id, 0);
  // agendados cuja hora já passou e que não têm job (ex.: Redis apagado)
  const late = await db.select({ id: schema.campaigns.id }).from(schema.campaigns)
    .where(and(eq(schema.campaigns.status, 'scheduled'), sql`${schema.campaigns.scheduledAt} < now() - interval '3 minutes'`)).limit(100);
  for (const s of late) await enqueueCampaignChunk(s.id, 0);
}

/** Retoma os disparos parados por falta de cota (depois de uma compra de disparos extras). */
export async function resumeQuotaPaused(accountId: string) {
  const list = await db.update(schema.campaigns).set({ status: 'sending', pauseReason: null, updatedAt: new Date() })
    .where(and(eq(schema.campaigns.accountId, accountId), eq(schema.campaigns.status, 'paused'), eq(schema.campaigns.pauseReason, 'quota'))).returning();
  for (const c of list) { emitProgress(c, true); await enqueueCampaignChunk(c.id, 0); }
}

/* ------------------------------------------------------------- números */

/** Números do disparo: fila, enviados, entregues, lidos, responderam, fluxos iniciados, falhas. */
export async function campaignStats(c: CampaignRow) {
  const [r] = await rows<Record<string, string>>(sql`
    select count(*) filter (where r.status = 'queued') as queued,
      count(*) filter (where r.status = 'started') as started,
      count(*) filter (where r.status = 'sent') as sent,
      count(*) filter (where r.status = 'failed') as failed,
      count(*) filter (where r.status = 'skipped') as skipped,
      count(*) filter (where m.status in ('delivered', 'read')) as delivered,
      count(*) filter (where m.status = 'read') as read,
      count(*) filter (where r.status = 'sent' and m.status = 'failed') as undelivered,
      count(*) filter (where r.status in ('sent', 'started') and exists (
        select 1 from messages mi join conversations v on v.id = mi.conversation_id
        where v.contact_id = r.contact_id and mi.direction = 'in' and mi.created_at > r.processed_at)) as replied,
      count(*) filter (where r.status = 'sent' and ${c.flowId ? sql`exists (select 1 from flow_runs fr where fr.flow_id = ${c.flowId}
        and fr.contact_id = r.contact_id and fr.started_at > r.processed_at)` : sql`false`}) as flow_after_reply
    from campaign_recipients r left join messages m on m.id = r.message_id where r.campaign_id = ${c.id}`);
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    queued: n('queued'), startedNow: n('started'), templatesSent: n('sent'), failed: n('failed') + n('undelivered'), skipped: n('skipped'),
    delivered: n('delivered'), read: n('read'), replied: n('replied'), flowStarted: n('started') + n('flow_after_reply'),
  };
}
