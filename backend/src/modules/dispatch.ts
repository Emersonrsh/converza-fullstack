import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { enqueueCampaignChunk } from '../queue';
import { DISPATCH_PACKS } from './plans';
import { asaasConfigured, paddleConfigured } from '../billing/gateways';
import { filtersSchema } from './contacts';
import { dispatchQuota } from './dispatchQuota';
import { audiencePreview, campaignStats, normalizeAudience, pauseText, publicCampaign, webDispatchedLast24h, type CampaignRow } from './dispatchRunner';
import { config } from '../config';
import { checkTemplate, templateSchema } from './webhooks';

/**
 * Disparos em massa: envia um fluxo para muitos contatos de uma vez, com cota por ciclo da
 * assinatura + saldo extra. Quem não falou nas últimas 24h recebe primeiro um modelo aprovado.
 */
export const dispatchRouter = Router();

const manager = (req: Request) => req.role !== 'agent';
function managerOnly(req: Request) {
  if (!manager(req)) throw new AppError(403, 'Apenas donos e administradores fazem disparos em massa');
}

async function names(accountId: string, list: CampaignRow[]) {
  const flowIds = [...new Set(list.map((c) => c.flowId).filter((x): x is string => !!x))];
  const connIds = [...new Set(list.map((c) => c.connectionId).filter((x): x is string => !!x))];
  const [flows, conns] = await Promise.all([
    flowIds.length ? db.select({ id: schema.flows.id, name: schema.flows.name }).from(schema.flows).where(and(eq(schema.flows.accountId, accountId), inArray(schema.flows.id, flowIds))) : [],
    connIds.length ? db.select({ id: schema.connections.id, name: schema.connections.name }).from(schema.connections).where(and(eq(schema.connections.accountId, accountId), inArray(schema.connections.id, connIds))) : [],
  ]);
  return (c: CampaignRow) => ({ flowName: flows.find((f) => f.id === c.flowId)?.name ?? null, connectionName: conns.find((x) => x.id === c.connectionId)?.name ?? null });
}

async function ownCampaign(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Disparo não encontrado');
  const [c] = await db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, id), eq(schema.campaigns.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Disparo não encontrado');
  return c;
}

/** Compra de pacotes: Pix/cartão pela Asaas e internacional pela Paddle (cada um só se estiver configurado). */
async function purchaseInfo(accountId: string) {
  const asaas = asaasConfigured();
  const paddle = paddleConfigured();
  const [sub] = await db.select({ status: schema.subscriptions.status, taxId: schema.subscriptions.taxId }).from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const active = sub?.status === 'active';
  const message = !asaas && !paddle
    ? 'A compra de pacotes ainda não está configurada neste servidor (chaves da Asaas ou da Paddle).'
    : !active ? 'Os disparos extras só valem com a assinatura ativa. Assine em Cobranças e assinaturas.' : null;
  return { enabled: (asaas || paddle) && active, asaas, paddle, hasTaxId: !!sub?.taxId, message };
}

/* ------------------------------------------------------------------- lista */

dispatchRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const list = await db.select().from(schema.campaigns).where(eq(schema.campaigns.accountId, accountId)).orderBy(desc(schema.campaigns.createdAt)).limit(200);
  const nm = await names(accountId, list);
  res.json({
    campaigns: list.map((c) => ({ ...publicCampaign(c, nm(c)), pauseText: pauseText(c.status === 'paused' ? c.pauseReason : null) })),
    quota: await dispatchQuota(accountId),
    counts: {
      running: list.filter((c) => ['sending', 'scheduled', 'paused'].includes(c.status)).length,
      done: list.filter((c) => c.status === 'done').length,
    },
    packs: DISPATCH_PACKS,
    purchase: await purchaseInfo(accountId),
    canEdit: manager(req),
  });
}));

const audienceSchema = z.object({
  filters: filtersSchema.default({}),
  excludeRecentDays: z.number().int().min(1).max(365).nullable().optional(),
});

/** Quantos contatos entram no público, quantos recebem o fluxo direto e quantos recebem o modelo antes. */
dispatchRouter.post('/preview', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const p = audienceSchema.safeParse((req.body ?? {}).audience ?? {});
  if (!p.success) throw new AppError(422, 'Filtro do público inválido');
  // conexão escolhida (opcional): no QR Code todos recebem o fluxo direto, com o limite diário de segurança
  const connectionId = typeof req.body?.connectionId === 'string' && isUuid(req.body.connectionId) ? req.body.connectionId : null;
  const [conn] = connectionId ? await db.select().from(schema.connections)
    .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.accountId, accountId))).limit(1) : [];
  const isWeb = conn?.provider === 'web';
  res.json({
    preview: await audiencePreview(accountId, { filters: p.data.filters, excludeRecentDays: p.data.excludeRecentDays ?? null }, { web: isWeb }),
    quota: await dispatchQuota(accountId),
    web: isWeb ? {
      dailyLimit: config.waWeb.dailyLimit, usedLast24h: await webDispatchedLast24h(conn!.id),
      minGapSec: config.waWeb.dispatchMinGapSec, maxGapSec: config.waWeb.dispatchMaxGapSec,
    } : null,
  });
}));

/* ------------------------------------------------------------------ criar */

const createSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao disparo').max(80, 'Nome muito longo (até 80 letras)'),
  connectionId: z.string({ required_error: 'Escolha a conexão de envio' }).uuid('Escolha a conexão de envio'),
  flowId: z.string({ required_error: 'Escolha o fluxo' }).uuid('Escolha o fluxo'),
  template: templateSchema.nullable().optional(),
  audience: audienceSchema,
  scheduledAt: z.string().datetime().nullable().optional(),
  speed: z.number().int().min(5).max(300).default(30),
});

function zodMsg(e: z.ZodError) {
  const i = e.issues[0];
  return i?.message && !/^(Expected|Invalid|String must|Required|Number must)/.test(i.message) ? i.message : `Campo inválido: ${i?.path.join('.') || 'dados'}`;
}

dispatchRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = createSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  const d = p.data;
  const [conn] = await db.select().from(schema.connections).where(and(eq(schema.connections.id, d.connectionId), eq(schema.connections.accountId, accountId))).limit(1);
  if (!conn) throw new AppError(422, 'Conexão não encontrada');
  if (conn.status === 'disconnected') throw new AppError(422, `A conexão “${conn.name}” está desconectada. Reconecte em Conexões antes de disparar.`);
  const [flow] = await db.select().from(schema.flows).where(and(eq(schema.flows.id, d.flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow) throw new AppError(422, 'Fluxo não encontrado');
  if (flow.status !== 'active' || flow.archivedAt) throw new AppError(422, `O fluxo “${flow.name}” está pausado. Ative o fluxo antes de disparar.`);
  const isWeb = conn.provider === 'web';
  if (isWeb && d.template) throw new AppError(422, 'Na conexão por QR Code não existe modelo de mensagem da Meta: o disparo começa o fluxo direto. Tire o modelo e tente de novo.');
  if (d.template) checkTemplate(d.template);

  const quota = await dispatchQuota(accountId);
  if (!quota.active) throw new AppError(403, 'Sua assinatura está inativa. Assine para fazer disparos em massa.', { code: 'no_plan' });
  if (quota.remaining <= 0) throw new AppError(403, 'Os disparos do ciclo acabaram. A cota renova no próximo ciclo da assinatura (ou com disparos extras).', { code: 'no_quota' });
  const audience = { filters: d.audience.filters, excludeRecentDays: d.audience.excludeRecentDays ?? null };
  const preview = await audiencePreview(accountId, audience, { web: isWeb });
  if (!preview.total) throw new AppError(422, 'Nenhum contato no público escolhido.');
  if (!isWeb && !d.template && !preview.windowOpen) {
    throw new AppError(422, 'Nenhum desses contatos falou com você nas últimas 24h: escolha um modelo de mensagem para abrir a conversa (regra da Meta).');
  }

  const at = d.scheduledAt ? new Date(d.scheduledAt) : null;
  const later = at && at.getTime() > Date.now() + 60_000 ? at : null;
  const [c] = await db.insert(schema.campaigns).values({
    accountId, name: d.name, connectionId: conn.id, flowId: flow.id, template: d.template ?? null, audience, speed: d.speed,
    status: later ? 'scheduled' : 'sending', scheduledAt: later, totalCount: preview.total, createdBy: req.user!.id,
  }).returning();
  await enqueueCampaignChunk(c.id, later ? later.getTime() - Date.now() : 0);
  res.status(201).json({ campaign: publicCampaign(c, { flowName: flow.name, connectionName: conn.name }) });
}));

/* ---------------------------------------------------------------- detalhe */

dispatchRouter.get('/:id', asyncHandler(async (req, res) => {
  const c = await ownCampaign(req.accountId!, req.params.id);
  const nm = await names(c.accountId, [c]);
  res.json({
    campaign: { ...publicCampaign(c, nm(c)), pauseText: pauseText(c.status === 'paused' ? c.pauseReason : null), templateFull: c.template },
    stats: await campaignStats(c),
    canEdit: manager(req),
  });
}));

const REC_STATUS = ['queued', 'started', 'sent', 'failed', 'skipped', 'replied', 'undelivered'] as const;

dispatchRouter.get('/:id/recipients', asyncHandler(async (req, res) => {
  const c = await ownCampaign(req.accountId!, req.params.id);
  const status = REC_STATUS.find((s) => s === req.query.status) ?? null;
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const limit = 50;
  const replied = sql`exists (select 1 from messages mi join conversations v on v.id = mi.conversation_id
    where v.contact_id = r.contact_id and mi.direction = 'in' and mi.created_at > r.processed_at)`;
  const cond = status === 'replied' ? sql`r.status in ('sent','started') and ${replied}`
    : status === 'undelivered' ? sql`r.status = 'sent' and m.status = 'failed'`
      : status ? sql`r.status = ${status}` : sql`true`;
  const list = (await db.execute(sql`
    select r.id, r.contact_id as "contactId", r.name, r.phone, r.status, coalesce(r.error, m.error) as error, m.status as "messageStatus",
      r.charge, to_char(r.processed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "processedAt",
      ${replied} as replied,
      (select id from conversations where contact_id = r.contact_id order by last_message_at desc limit 1) as "conversationId"
    from campaign_recipients r left join messages m on m.id = r.message_id
    where r.campaign_id = ${c.id} and ${cond}
    order by r.processed_at desc nulls last, r.id limit ${limit} offset ${(page - 1) * limit}`)).rows;
  const [{ n }] = (await db.execute(sql`select count(*) as n from campaign_recipients r left join messages m on m.id = r.message_id where r.campaign_id = ${c.id} and ${cond}`)).rows as { n: string }[];
  const total = Number(n);
  res.json({ recipients: list, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
}));

/* ----------------------------------------------------------------- ações */

async function patchCampaign(c: CampaignRow, patch: Partial<typeof schema.campaigns.$inferInsert>) {
  const [row] = await db.update(schema.campaigns).set({ ...patch, updatedAt: new Date() }).where(eq(schema.campaigns.id, c.id)).returning();
  return row;
}

dispatchRouter.post('/:id/pause', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCampaign(req.accountId!, req.params.id);
  if (!['sending', 'scheduled'].includes(c.status)) throw new AppError(409, 'Este disparo não está enviando.');
  const row = await patchCampaign(c, { status: 'paused', pauseReason: 'manual' });
  res.json({ campaign: publicCampaign(row) });
}));

dispatchRouter.post('/:id/resume', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCampaign(req.accountId!, req.params.id);
  if (c.status !== 'paused') throw new AppError(409, 'Este disparo não está pausado.');
  if (c.pauseReason === 'flow_deleted' || !c.flowId) throw new AppError(409, 'O fluxo deste disparo foi excluído. Duplique o disparo e escolha outro fluxo.');
  if (c.pauseReason === 'quota' || c.pauseReason === 'plan') {
    const q = await dispatchQuota(c.accountId);
    if (!q.active) throw new AppError(403, 'Sua assinatura está inativa. Assine para continuar o disparo.', { code: 'no_plan' });
    if (q.remaining <= 0) throw new AppError(403, 'Os disparos do ciclo acabaram. O disparo continua quando houver saldo: no próximo ciclo ou com disparos extras.', { code: 'no_quota' });
  }
  // agendado que foi pausado antes da hora volta a ser agendado
  const scheduled = !c.startedAt && c.scheduledAt && c.scheduledAt.getTime() > Date.now();
  const row = await patchCampaign(c, { status: scheduled ? 'scheduled' : 'sending', pauseReason: null });
  await enqueueCampaignChunk(c.id, scheduled ? c.scheduledAt!.getTime() - Date.now() : 0);
  res.json({ campaign: publicCampaign(row) });
}));

dispatchRouter.post('/:id/cancel', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCampaign(req.accountId!, req.params.id);
  if (['done', 'canceled'].includes(c.status)) throw new AppError(409, 'Este disparo já terminou.');
  const r = await db.execute(sql`update campaign_recipients set status = 'skipped', error = 'Disparo cancelado.', processed_at = now()
    where campaign_id = ${c.id} and status = 'queued'`);
  const [row] = await db.update(schema.campaigns).set({
    status: 'canceled', pauseReason: null, finishedAt: new Date(), updatedAt: new Date(),
    skippedCount: sql`${schema.campaigns.skippedCount} + ${r.rowCount ?? 0}`,
  }).where(eq(schema.campaigns.id, c.id)).returning();
  res.json({ campaign: publicCampaign(row) });
}));

dispatchRouter.post('/:id/duplicate', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCampaign(req.accountId!, req.params.id);
  // volta como rascunho para revisar: público, fluxo e modelo vêm iguais
  res.json({ draft: { name: `${c.name} (cópia)`.slice(0, 80), connectionId: c.connectionId, flowId: c.flowId, template: c.template, audience: normalizeAudience(c.audience), speed: c.speed } });
}));

dispatchRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCampaign(req.accountId!, req.params.id);
  if (['sending', 'scheduled', 'paused'].includes(c.status)) throw new AppError(409, 'Cancele o disparo antes de excluir.');
  await db.delete(schema.campaigns).where(eq(schema.campaigns.id, c.id));
  res.status(204).end();
}));
