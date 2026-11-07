import express, { Router, type Request } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { enqueueWebhookEvent } from '../queue';
import { cleanMapping, detectMapping, detectPlatform, leaves, payloadOf, type WebhookActions, type WebhookCondition, type WebhookMapping } from './webhookEngine';
import { dryRun, listEvents, processWebhookEvent, publicEvent, recordIncoming, usageOf, type WebhookRow } from './webhookProcessor';

/**
 * Webhooks de entrada: cada um tem a sua URL, a conexão de WhatsApp, o mapeamento dos dados
 * do lead, condições e ações (etiquetas, Kanban, venda, modelo de mensagem e fluxo).
 */
export const webhooksRouter = Router();

const newToken = () => randomBytes(24).toString('hex');
const manager = (req: Request) => req.role !== 'agent';
function managerOnly(req: Request) {
  if (!manager(req)) throw new AppError(403, 'Apenas donos e administradores mexem nos webhooks');
}
const urlOf = (req: Request, token: string) => `${publicBase(req, config.publicApiUrl)}/api/v1/hooks/${token}`;

async function ownWebhook(accountId: string, id: string): Promise<WebhookRow> {
  if (!isUuid(id)) throw new AppError(404, 'Webhook não encontrado');
  const [w] = await db.select().from(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.accountId, accountId))).limit(1);
  if (!w) throw new AppError(404, 'Webhook não encontrado');
  return w;
}

function summaryOf(w: WebhookRow) {
  const m = (w.mapping ?? {}) as WebhookMapping;
  const a = (w.actions ?? {}) as WebhookActions;
  const actions: string[] = [];
  if (a.tags?.length || a.removeTags?.length) actions.push('etiquetas');
  if (a.kanban?.columnId) actions.push('Kanban');
  if (a.sale !== false && m.amount) actions.push('venda');
  if (a.template?.name) actions.push('modelo');
  if (a.flowId) actions.push('fluxo');
  return { hasPhone: !!m.phone, conditions: ((w.conditions ?? []) as unknown[]).length, actions };
}

function publicWebhook(req: Request, w: WebhookRow, connectionName: string | null = null) {
  return {
    id: w.id, name: w.name, enabled: w.enabled, connectionId: w.connectionId, connectionName,
    hits: w.hits, lastEventAt: w.lastEventAt, lastStatus: w.lastStatus, createdAt: w.createdAt, updatedAt: w.updatedAt,
    platform: w.sample ? detectPlatform(w.sample) : null, setup: summaryOf(w),
    ...(manager(req) ? { url: urlOf(req, w.token) } : {}),
  };
}

function fullWebhook(req: Request, w: WebhookRow, connectionName: string | null = null) {
  return {
    ...publicWebhook(req, w, connectionName),
    mapping: w.mapping as WebhookMapping, conditions: w.conditions as WebhookCondition[], actions: w.actions as WebhookActions,
    sample: w.sample, sampleAt: w.sampleAt,
  };
}

async function connName(accountId: string, id: string | null) {
  if (!id) return null;
  const [c] = await db.select({ name: schema.connections.name }).from(schema.connections)
    .where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  return c?.name ?? null;
}

async function detailOf(req: Request, w: WebhookRow) {
  const fields = await db.select({ key: schema.contactFields.key, label: schema.contactFields.label }).from(schema.contactFields)
    .where(eq(schema.contactFields.accountId, w.accountId)).orderBy(asc(schema.contactFields.position));
  return {
    webhook: fullWebhook(req, w, await connName(w.accountId, w.connectionId)),
    leaves: w.sample ? leaves(w.sample) : [],
    detected: w.sample ? detectMapping(w.sample) : {},
    fields,
    usage: await usageOf(w.accountId),
  };
}

/* ------------------------------------------------------------------ lista */

webhooksRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const list = await db.select({ w: schema.webhooks, connectionName: schema.connections.name }).from(schema.webhooks)
    .leftJoin(schema.connections, eq(schema.connections.id, schema.webhooks.connectionId))
    .where(eq(schema.webhooks.accountId, accountId)).orderBy(desc(schema.webhooks.createdAt));
  res.json({
    webhooks: list.map((x) => publicWebhook(req, x.w, x.connectionName)),
    usage: await usageOf(accountId),
    canEdit: manager(req),
  });
}));

const nameSchema = z.string().trim().min(1, 'Dê um nome ao webhook').max(80, 'Nome muito longo (até 80 letras)');
const connField = z.union([z.string().uuid(), z.literal(''), z.null()]).optional();

async function checkConnection(accountId: string, id: string | null | undefined) {
  if (!id) return null;
  const [c] = await db.select({ id: schema.connections.id }).from(schema.connections)
    .where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(422, 'Conexão não encontrada');
  return c.id;
}

webhooksRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const d = z.object({ name: nameSchema, connectionId: connField, enabled: z.boolean().optional() }).parse(req.body ?? {});
  const connectionId = await checkConnection(req.accountId!, d.connectionId || null);
  const [w] = await db.insert(schema.webhooks).values({
    accountId: req.accountId!, name: d.name, token: newToken(), connectionId, enabled: d.enabled ?? true,
  }).returning();
  res.status(201).json({ webhook: fullWebhook(req, w, await connName(w.accountId, w.connectionId)) });
}));

/* --------------------------------------------------------------- detalhe */

webhooksRouter.get('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  res.json(await detailOf(req, await ownWebhook(req.accountId!, req.params.id)));
}));

const opSchema = z.enum(['eq', 'neq', 'contains', 'not_contains', 'exists', 'empty']);
const conditionsSchema = z.array(z.object({
  path: z.string().trim().min(1, 'Escolha o campo da condição').max(300),
  op: opSchema,
  value: z.string().max(500).optional(),
})).max(10, 'No máximo 10 condições');

const tplVar = z.object({ var: z.string().trim().min(1).max(60), name: z.string().trim().max(60).optional(), value: z.string().max(1024) });
export const templateSchema = z.object({
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(15),
  preview: z.string().max(4096).optional(),
  header: z.union([
    tplVar.extend({ type: z.literal('text') }),
    z.object({ type: z.enum(['image', 'video', 'document']), link: z.string().trim().max(2000), filename: z.string().trim().max(120).optional() }),
  ]).optional(),
  body: z.array(tplVar).max(30).optional(),
  buttons: z.array(z.object({ index: z.number().int().min(0).max(9), subType: z.enum(['url', 'copy_code']), value: z.string().max(2000) })).max(10).optional(),
});
const actionsSchema = z.object({
  overwrite: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  removeTags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  kanban: z.object({ boardId: z.string().uuid(), columnId: z.string().uuid() }).nullable().optional(),
  sale: z.boolean().optional(),
  template: templateSchema.nullable().optional(),
  flowId: z.string().uuid().nullable().optional(),
});
const updateSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  connectionId: connField,
  mapping: z.record(z.unknown()).optional(),
  conditions: conditionsSchema.optional(),
  actions: actionsSchema.optional(),
});

function zodMsg(e: z.ZodError) {
  const i = e.issues[0];
  return i?.message && !/^(Expected|Invalid|String must|Required|Number must|Array must)/.test(i.message) ? i.message : `Campo inválido: ${i?.path.join('.') || 'dados'}`;
}

/** Confere que Kanban, fluxo e modelo apontam para coisas desta conta e estão completos. */
async function checkActions(accountId: string, a: WebhookActions, connectionId: string | null) {
  if (a.kanban) {
    const [col] = await db.select({ id: schema.kanbanColumns.id }).from(schema.kanbanColumns)
      .where(and(eq(schema.kanbanColumns.id, a.kanban.columnId), eq(schema.kanbanColumns.boardId, a.kanban.boardId), eq(schema.kanbanColumns.accountId, accountId))).limit(1);
    if (!col) throw new AppError(422, 'A coluna do Kanban não é desse quadro');
  }
  if (a.flowId) {
    const [f] = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.id, a.flowId), eq(schema.flows.accountId, accountId))).limit(1);
    if (!f) throw new AppError(422, 'Fluxo não encontrado');
  }
  if (a.template) {
    if (!connectionId) throw new AppError(422, 'Para mandar um modelo de mensagem, escolha a conexão de WhatsApp do webhook.');
    checkTemplate(a.template);
  }
}

/** Modelo completo: todas as variáveis preenchidas e o link da mídia em https. */
export function checkTemplate(t: z.infer<typeof templateSchema>) {
  for (const v of t.body ?? []) if (!v.value.trim()) throw new AppError(422, `Preencha a variável {{${v.var}}} do modelo`);
  if (t.header?.type === 'text' && !t.header.value.trim()) throw new AppError(422, 'Preencha a variável do cabeçalho do modelo');
  if (t.header && t.header.type !== 'text' && !/^(https:\/\/\S+|\{\{[^{}]+\}\})/i.test(t.header.link.trim())) throw new AppError(422, 'O link da mídia do cabeçalho precisa começar com https://');
  for (const b of t.buttons ?? []) if (!b.value.trim()) throw new AppError(422, `Preencha o valor do botão ${b.index + 1} do modelo`);
}

webhooksRouter.put('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const p = updateSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  const d = p.data;
  const connectionId = d.connectionId !== undefined ? await checkConnection(w.accountId, d.connectionId || null) : w.connectionId;
  const actions = (d.actions ?? w.actions) as WebhookActions;
  if (d.actions || d.connectionId !== undefined) await checkActions(w.accountId, actions, connectionId);
  const [u] = await db.update(schema.webhooks).set({
    ...(d.name ? { name: d.name } : {}),
    ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
    ...(d.connectionId !== undefined ? { connectionId } : {}),
    ...(d.mapping ? { mapping: cleanMapping(d.mapping) } : {}),
    ...(d.conditions ? { conditions: d.conditions.map((c) => ({ path: c.path, op: c.op, ...(c.value !== undefined && !['exists', 'empty'].includes(c.op) ? { value: c.value.trim() } : {}) })) } : {}),
    ...(d.actions ? { actions: d.actions } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.webhooks.id, w.id)).returning();
  res.json(await detailOf(req, u));
}));

webhooksRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  await db.delete(schema.webhooks).where(eq(schema.webhooks.id, w.id));
  res.status(204).end();
}));

/** Nova URL (a antiga deixa de funcionar na hora). */
webhooksRouter.post('/:id/rotate', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const [u] = await db.update(schema.webhooks).set({ token: newToken(), updatedAt: new Date() }).where(eq(schema.webhooks.id, w.id)).returning();
  res.json(await detailOf(req, u));
}));

webhooksRouter.post('/:id/duplicate', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const [c] = await db.insert(schema.webhooks).values({
    accountId: w.accountId, name: `${w.name} (cópia)`.slice(0, 80), token: newToken(), enabled: false, connectionId: w.connectionId,
    mapping: w.mapping, conditions: w.conditions, actions: w.actions, sample: w.sample, sampleAt: w.sampleAt,
  }).returning();
  res.status(201).json({ webhook: fullWebhook(req, c, await connName(c.accountId, c.connectionId)) });
}));

/* ------------------------------------------------------------- exemplo */

function parseSample(raw: unknown): Record<string, unknown> {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { throw new AppError(422, 'Esse texto não é um JSON válido. Cole o corpo do evento como ele chega (começa com { ).'); }
  }
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) throw new AppError(422, 'O exemplo precisa ser um objeto JSON com os dados do lead.');
  if (JSON.stringify(v).length > 200_000) throw new AppError(413, 'Exemplo grande demais (máximo 200 KB).');
  return v as Record<string, unknown>;
}

/** Colar um exemplo de evento (quando a plataforma ainda não mandou nenhum). */
webhooksRouter.put('/:id/sample', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const sample = parseSample((req.body ?? {}).payload);
  const [u] = await db.update(schema.webhooks).set({ sample, sampleAt: new Date() }).where(eq(schema.webhooks.id, w.id)).returning();
  res.json(await detailOf(req, u));
}));

/** Simular: o que aconteceria com o exemplo (ou com um evento), com a configuração da tela, sem executar nada. */
webhooksRouter.post('/:id/test', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const b = (req.body ?? {}) as Record<string, unknown>;
  let payload = w.sample as Record<string, unknown> | null;
  if (typeof b.eventId === 'string' && isUuid(b.eventId)) {
    const [e] = await db.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, b.eventId), eq(schema.webhookEvents.webhookId, w.id))).limit(1);
    if (e) payload = e.payload as Record<string, unknown>;
  }
  if (!payload) throw new AppError(422, 'Ainda não há um evento de exemplo. Mande um teste pela plataforma ou cole um exemplo.');
  const conds = b.conditions !== undefined ? conditionsSchema.safeParse(b.conditions) : null;
  const acts = b.actions !== undefined ? actionsSchema.safeParse(b.actions) : null;
  if (conds && !conds.success) throw new AppError(422, zodMsg(conds.error));
  if (acts && !acts.success) throw new AppError(422, zodMsg(acts.error));
  const connectionId = b.connectionId !== undefined ? (typeof b.connectionId === 'string' && isUuid(b.connectionId) ? b.connectionId : null) : w.connectionId;
  const r = await dryRun(w, payload, {
    mapping: b.mapping !== undefined ? cleanMapping(b.mapping) : (w.mapping as WebhookMapping),
    conditions: conds ? conds.data as WebhookCondition[] : (w.conditions as WebhookCondition[]),
    actions: acts ? acts.data as WebhookActions : (w.actions as WebhookActions),
    connectionId,
  });
  res.json(r);
}));

/** Executar de verdade com o exemplo (como se a plataforma tivesse mandado agora). */
webhooksRouter.post('/:id/run-sample', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  if (!w.sample) throw new AppError(422, 'Ainda não há um evento de exemplo.');
  const e = await recordIncoming(w, w.sample as Record<string, unknown>);
  const done = e.status === 'queued' ? await processWebhookEvent(e.id) : e;
  res.status(201).json({ event: publicEvent(done ?? e) });
}));

/* --------------------------------------------------------------- eventos */

webhooksRouter.get('/:id/events', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  res.json(await listEvents(w.id, { status, before, limit: Number(req.query.limit) || 30 }));
}));

async function ownEvent(w: WebhookRow, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Evento não encontrado');
  const [e] = await db.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.id, id), eq(schema.webhookEvents.webhookId, w.id))).limit(1);
  if (!e) throw new AppError(404, 'Evento não encontrado');
  return e;
}

webhooksRouter.get('/:id/events/:eventId', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const e = await ownEvent(w, req.params.eventId);
  res.json({ event: publicEvent(e, true) });
}));

webhooksRouter.post('/:id/events/:eventId/reprocess', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const e = await ownEvent(w, req.params.eventId);
  if (!Object.keys((e.payload ?? {}) as object).length) throw new AppError(422, 'Este evento chegou sem dados.');
  const done = await processWebhookEvent(e.id, { reprocess: true });
  res.json({ event: publicEvent(done ?? e) });
}));

webhooksRouter.post('/:id/events/:eventId/sample', asyncHandler(async (req, res) => {
  managerOnly(req);
  const w = await ownWebhook(req.accountId!, req.params.id);
  const e = await ownEvent(w, req.params.eventId);
  const sample = parseSample(e.payload);
  const [u] = await db.update(schema.webhooks).set({ sample, sampleAt: new Date() }).where(eq(schema.webhooks.id, w.id)).returning();
  res.json(await detailOf(req, u));
}));

/* ======================================================= receptor público */

/**
 * Receptor público (Hotmart, Kiwify, Eduzz, N8N, Make, formulários…): /api/v1/hooks/:token.
 * Aceita JSON, formulário e texto; GET com parâmetros na URL também vale. Responde na hora e
 * processa em seguida (fila), para a plataforma não esperar.
 */
export const hooksInRouter = Router();
hooksInRouter.use(express.urlencoded({ extended: true, limit: '1mb' }));
hooksInRouter.use(express.text({ type: ['text/plain', 'text/*'], limit: '1mb' }));

const rate = new Map<string, { n: number; reset: number }>();
const PER_MINUTE = 120;
function rateOk(token: string) {
  const now = Date.now();
  const h = rate.get(token);
  if (!h || h.reset < now) { rate.set(token, { n: 1, reset: now + 60_000 }); return true; }
  h.n += 1;
  return h.n <= PER_MINUTE;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rate) if (v.reset < now) rate.delete(k); }, 5 * 60_000).unref();

hooksInRouter.all('/:token', asyncHandler(async (req, res) => {
  if (!['GET', 'POST', 'PUT'].includes(req.method)) { res.status(405).json({ error: 'Use POST (ou GET com os dados na URL).' }); return; }
  const token = String(req.params.token ?? '');
  const [w] = /^[a-f0-9]{12,64}$/.test(token) ? await db.select().from(schema.webhooks).where(eq(schema.webhooks.token, token)).limit(1) : [];
  if (!w) { res.status(404).json({ error: 'Webhook não encontrado. Confira a URL copiada no Converza.' }); return; }
  if (!rateOk(token)) { res.status(429).json({ error: `Mais de ${PER_MINUTE} chamadas por minuto para este webhook. Tente de novo em instantes.` }); return; }
  const payload = payloadOf(req.body, req.query as Record<string, unknown>);
  // abrir a URL no navegador só confere se está no ar
  if (req.method === 'GET' && !Object.keys(payload).length) {
    res.json({ ok: true, webhook: w.name, message: 'Webhook ativo. Envie os dados do lead por POST (JSON ou formulário).' });
    return;
  }
  const e = await recordIncoming(w, payload, {
    // multipart (upload de arquivo) não é lido: a plataforma precisa mandar JSON ou formulário comum
    emptyReason: req.is('multipart/form-data')
      ? 'Chegou no formato multipart/form-data, que não é lido. Configure a plataforma para enviar JSON ou formulário (x-www-form-urlencoded).'
      : undefined,
  });
  if (e.status === 'queued') {
    try { await enqueueWebhookEvent(e.id); } catch (err) {
      console.warn('[webhooks] fila indisponível, processando direto:', (err as Error).message);
      void processWebhookEvent(e.id).catch(() => {});
    }
  }
  res.json({ ok: true, id: e.id, status: e.status === 'queued' ? 'recebido' : e.status });
}));
