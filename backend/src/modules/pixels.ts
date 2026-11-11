import { Router, type Request } from 'express';
import { z } from 'zod';
import { pageIdForAd } from '../pixels/adPage';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { enqueuePixelEvent } from '../queue';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { fetchPixel, MetaApiError, sendCapi, wabaDataset } from '../meta/graphAds';
import { PLATFORMS, buildEvent, checkRules, defaultRules, ruleSchema, type Platform, type Rule } from '../pixels/engine';
import { PixelSendError, deliver, pixelCredentials, publicEvent } from '../pixels/sender';

/** Pixels: para onde vão os eventos de conversão (lead, venda, etapa do Kanban) — Meta e TikTok. */
export const pixelsRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores mexem nos pixels');
}

type PixelRow = typeof schema.pixels.$inferSelect;

const mask = (t: string | null) => (t ? `••••${t.slice(-4)}` : null);

function publicPixel(p: PixelRow, stats?: { sent: number; failed: number; skipped: number; queued: number }, connName?: string | null) {
  return {
    id: p.id, name: p.name, platform: p.platform, platformLabel: PLATFORMS[p.platform as Platform]?.label ?? p.platform,
    pixelId: p.pixelId, remoteName: p.remoteName, tokenHint: mask(p.accessToken), usesConnectionToken: p.platform === 'meta_whatsapp' && !p.accessToken,
    connectionId: p.connectionId, connectionName: connName ?? null, wabaId: p.wabaId, pageId: p.pageId,
    rules: (p.rules as Rule[]) ?? [], status: p.status, lastError: p.lastError, lastEventAt: p.lastEventAt,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
    stats: stats ?? { sent: 0, failed: 0, skipped: 0, queued: 0 },
  };
}

async function ownPixel(accountId: string, id: string): Promise<PixelRow> {
  if (!isUuid(id)) throw new AppError(404, 'Pixel não encontrado');
  const [p] = await db.select().from(schema.pixels).where(and(eq(schema.pixels.id, id), eq(schema.pixels.accountId, accountId))).limit(1);
  if (!p) throw new AppError(404, 'Pixel não encontrado');
  return p;
}

async function ownConnection(accountId: string, id: string | null | undefined) {
  if (!id) return null;
  if (!isUuid(id)) throw new AppError(400, 'Conexão inválida');
  const [c] = await db.select().from(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(400, 'Conexão não encontrada');
  return c;
}

/** Confere na plataforma se o ID e o token valem (TikTok não tem como conferir sem mandar um evento). */
async function verify(platform: Platform, pixelId: string, token: string): Promise<string | null> {
  if (platform === 'tiktok') return null;
  try {
    const px = await fetchPixel(pixelId, token);
    return px.name;
  } catch (err) {
    // O token gerado em "API de Conversões > Gerar token de acesso" só envia eventos: ler o pixel
    // dá "(#100) Missing Permission". Nesse caso, confere mandando um evento de teste (só aparece
    // na aba "Eventos de teste" do Gerenciador, não conta como conversão).
    if (err instanceof MetaApiError && platform === 'meta' && !err.tokenExpired && !err.rateLimited) {
      const probe = buildEvent({
        platform, pixelId, event: 'Lead', key: `converza-verify-${Date.now()}`, time: new Date(),
        person: { id: 'converza-verify', name: null, phone: '5511999999999', email: null }, testCode: 'TEST_CONVERZA',
      });
      if (probe.ok) {
        try {
          await sendCapi(pixelId, token, probe.body);
          return null;
        } catch { /* mostra o erro original da leitura */ }
      }
    }
    if (err instanceof MetaApiError) {
      throw new AppError(422, err.tokenExpired
        ? 'A Meta recusou o token: ele venceu ou foi revogado. Gere um token novo no Gerenciador de Eventos.'
        : `A Meta não aceitou o ID e o token: ${err.message}`, { field: err.tokenExpired ? 'accessToken' : 'pixelId' });
    }
    throw err;
  }
}

async function statsFor(accountId: string) {
  const rows = (await db.execute(sql`select pixel_id, status, count(*)::int as n from pixel_events
    where account_id = ${accountId} and created_at > now() - interval '30 days' and trigger <> 'test' group by 1, 2`)).rows as { pixel_id: string; status: string; n: number }[];
  const out = new Map<string, { sent: number; failed: number; skipped: number; queued: number }>();
  for (const r of rows) {
    const s = out.get(r.pixel_id) ?? { sent: 0, failed: 0, skipped: 0, queued: 0 };
    if (r.status in s) s[r.status as keyof typeof s] = Number(r.n);
    out.set(r.pixel_id, s);
  }
  return out;
}

pixelsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const list = await db.select().from(schema.pixels).where(eq(schema.pixels.accountId, accountId)).orderBy(desc(schema.pixels.createdAt));
  const stats = await statsFor(accountId);
  const conns = await db.select({ id: schema.connections.id, name: schema.connections.name }).from(schema.connections).where(eq(schema.connections.accountId, accountId));
  const cname = new Map(conns.map((c) => [c.id, c.name]));
  res.json({
    pixels: list.map((p) => publicPixel(p, stats.get(p.id), p.connectionId ? cname.get(p.connectionId) : null)),
    platforms: Object.entries(PLATFORMS).map(([id, v]) => ({ id, label: v.label, events: v.events })),
    canEdit: req.role !== 'agent',
  });
}));

const baseSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao pixel').max(80),
  platform: z.enum(['meta', 'meta_whatsapp', 'tiktok']),
  pixelId: z.string().trim().max(60).optional().default(''),
  accessToken: z.string().trim().max(1000).optional().nullable(),
  connectionId: z.string().uuid().optional().nullable(),
  rules: z.array(ruleSchema).max(12).optional(),
});

function checkPixelId(platform: Platform, id: string) {
  if (platform === 'tiktok') {
    if (!/^[A-Za-z0-9]{8,40}$/.test(id)) throw new AppError(400, 'O ID do pixel do TikTok é um código de letras e números (ex.: CXXXXXXXXXXXXXXXXXX0)', { field: 'pixelId' });
  } else if (!/^\d{6,25}$/.test(id)) throw new AppError(400, 'O ID do pixel da Meta tem só números (ex.: 726668042287)', { field: 'pixelId' });
}

pixelsRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const d = baseSchema.parse(req.body);
  const platform = d.platform as Platform;
  const token = d.accessToken?.trim() || null;
  let pixelId = d.pixelId.trim();
  let wabaId: string | null = null;
  let connectionId: string | null = null;
  let remoteName: string | null = null;

  if (platform === 'meta_whatsapp') {
    const conn = await ownConnection(accountId, d.connectionId);
    if (!conn) throw new AppError(400, 'Escolha a conexão do WhatsApp', { field: 'connectionId' });
    if (!conn.wabaId || !conn.accessToken) throw new AppError(422, 'Essa conexão não tem a conta do WhatsApp Business (WABA) ou o token. Ajuste em Conexões.', { field: 'connectionId' });
    connectionId = conn.id; wabaId = conn.wabaId;
    const useToken = token ?? conn.accessToken;
    if (!pixelId) {
      try { pixelId = await wabaDataset(conn.wabaId, useToken); } catch (err) {
        const msg = err instanceof MetaApiError ? err.message : (err as Error).message;
        throw new AppError(422, `Não consegui o conjunto de dados do WhatsApp na Meta: ${msg}. O token precisa da permissão whatsapp_business_manage_events.`);
      }
    }
    checkPixelId(platform, pixelId);
    remoteName = await verify(platform, pixelId, useToken);
  } else {
    if (!token) throw new AppError(400, 'Cole o Access Token', { field: 'accessToken' });
    if (!pixelId) throw new AppError(400, 'Informe o ID do pixel', { field: 'pixelId' });
    checkPixelId(platform, pixelId);
    remoteName = await verify(platform, pixelId, token);
  }
  const rules = (d.rules as Rule[] | undefined) ?? defaultRules(platform);
  const bad = checkRules(platform, rules);
  if (bad) throw new AppError(400, bad);
  const [dup] = await db.select({ id: schema.pixels.id }).from(schema.pixels)
    .where(and(eq(schema.pixels.accountId, accountId), eq(schema.pixels.platform, platform), eq(schema.pixels.pixelId, pixelId))).limit(1);
  if (dup) throw new AppError(409, 'Esse pixel já está configurado nesta conta', { field: 'pixelId' });

  const [row] = await db.insert(schema.pixels).values({
    accountId, name: d.name, platform, pixelId, accessToken: token, connectionId, wabaId, remoteName, rules, createdBy: req.user!.id,
  }).returning();
  emitToAccount(accountId, 'pixel:changed', { pixelId: row.id });
  res.status(201).json({ pixel: publicPixel(row) });
}));

/** Busca (ou cria) o conjunto de dados do WhatsApp de uma conexão — o "ID do pixel" do tipo WhatsApp. */
pixelsRouter.post('/whatsapp-dataset', asyncHandler(async (req, res) => {
  managerOnly(req);
  const d = z.object({ connectionId: z.string().uuid(), accessToken: z.string().trim().max(1000).optional().nullable() }).parse(req.body);
  const conn = await ownConnection(req.accountId!, d.connectionId);
  if (!conn?.wabaId || !conn.accessToken) throw new AppError(422, 'Essa conexão não tem a conta do WhatsApp Business (WABA) ou o token. Ajuste em Conexões.');
  try {
    res.json({ datasetId: await wabaDataset(conn.wabaId, d.accessToken?.trim() || conn.accessToken), wabaId: conn.wabaId });
  } catch (err) {
    const msg = err instanceof MetaApiError ? err.message : (err as Error).message;
    throw new AppError(422, `A Meta não devolveu o conjunto de dados: ${msg}. O token precisa da permissão whatsapp_business_manage_events.`);
  }
}));

pixelsRouter.put('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  const d = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    pixelId: z.string().trim().max(60).optional(),
    accessToken: z.string().trim().max(1000).optional().nullable(),
    rules: z.array(ruleSchema).max(12).optional(),
    status: z.enum(['active', 'paused']).optional(),
    pageId: z.string().trim().max(40).optional().nullable(),
  }).parse(req.body);
  const platform = px.platform as Platform;
  const patch: Partial<typeof schema.pixels.$inferInsert> = { updatedAt: new Date() };
  if (d.name) patch.name = d.name;
  if (d.pageId !== undefined) {
    const pg = String(d.pageId ?? '').replace(/\D/g, '');
    if (d.pageId && !pg) throw new AppError(400, 'O ID da Página tem só números', { field: 'pageId' });
    patch.pageId = pg || null;
  }
  if (d.rules) {
    const bad = checkRules(platform, d.rules as Rule[]);
    if (bad) throw new AppError(400, bad);
    patch.rules = d.rules;
  }
  const newId = d.pixelId?.trim() && d.pixelId.trim() !== px.pixelId ? d.pixelId.trim() : undefined;
  // token: em branco mantém o atual; no WhatsApp, em branco volta a usar o token da conexão
  let tokenSet = false;
  let token = px.accessToken;
  if (d.accessToken !== undefined) {
    const t = d.accessToken?.trim() || null;
    if (t) { tokenSet = true; token = t; } else if (platform === 'meta_whatsapp' && px.accessToken) { tokenSet = true; token = null; }
  }
  if (tokenSet || newId) {
    if (newId) checkPixelId(platform, newId);
    const creds = platform === 'meta_whatsapp' ? await pixelCredentials({ ...px, accessToken: token }) : { token };
    if (!creds.token) throw new AppError(400, 'Cole o Access Token', { field: 'accessToken' });
    const remote = await verify(platform, newId ?? px.pixelId, creds.token);
    if (tokenSet) patch.accessToken = token;
    if (newId) patch.pixelId = newId;
    patch.remoteName = remote ?? px.remoteName;
    patch.status = px.status === 'paused' ? 'paused' : 'active';
    patch.lastError = null;
  }
  if (d.status) { patch.status = d.status; if (d.status === 'active') patch.lastError = null; }
  const [row] = await db.update(schema.pixels).set(patch).where(eq(schema.pixels.id, px.id)).returning();
  emitToAccount(accountId, 'pixel:changed', { pixelId: row.id });
  res.json({ pixel: publicPixel(row) });
}));

/**
 * Páginas dos anúncios de clique para o WhatsApp que trouxeram contatos recentes (para preencher a Página do pixel).
 */
pixelsRouter.get('/:id/ad-pages', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  const rows = await db.select({ sourceId: schema.contacts.sourceId }).from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, accountId), isNotNull(schema.contacts.ctwaClid), isNotNull(schema.contacts.sourceId)))
    .orderBy(desc(schema.contacts.lastContactAt)).limit(40);
  const ads = [...new Set(rows.map((r) => String(r.sourceId)))].slice(0, 12);
  const counts = new Map<string, number>();
  for (const ad of ads) {
    const page = await pageIdForAd(accountId, ad, [px.accessToken]);
    if (page) counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  res.json({ adsChecked: ads.length, pages: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([pageId, ads]) => ({ pageId, ads })) });
}));

pixelsRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const px = await ownPixel(req.accountId!, req.params.id);
  await db.delete(schema.pixels).where(eq(schema.pixels.id, px.id));
  emitToAccount(req.accountId!, 'pixel:changed', { pixelId: px.id });
  res.status(204).end();
}));

/** Evento de teste: aparece em "Testar eventos" (Meta) / "Test events" (TikTok) e não conta nos anúncios. */
pixelsRouter.post('/:id/test', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  const platform = px.platform as Platform;
  const d = z.object({ testEventCode: z.string().trim().max(60).optional().default(''), event: z.string().trim().max(60).optional() }).parse(req.body);
  const { token, wabaId } = await pixelCredentials(px);
  if (!token) throw new AppError(400, 'O pixel está sem token de acesso');

  if (platform === 'meta_whatsapp') {
    // a Meta só aceita evento do WhatsApp com o ctwa_clid de um clique real: o teste confere o acesso ao conjunto de dados
    const name = await verify(platform, px.pixelId, token);
    res.json({ ok: true, message: `Token e conjunto de dados conferidos na Meta${name ? ` (“${name}”)` : ''}. Os eventos saem quando um cliente vindo de anúncio converter.` });
    return;
  }
  if (!d.testEventCode) throw new AppError(400, platform === 'tiktok' ? 'Cole o código de teste do Gerenciador de Eventos do TikTok' : 'Cole o código de teste do Gerenciador de Eventos da Meta (aba Testar eventos)', { field: 'testEventCode' });
  const event = d.event && PLATFORMS[platform].events.includes(d.event) ? d.event : 'Lead';
  const key = `test:${Date.now()}`;
  const built = buildEvent({
    platform, pixelId: px.pixelId, wabaId, event, key, time: new Date(), testCode: d.testEventCode,
    person: { id: `converza-teste-${accountId}`, name: 'Cliente Teste', phone: '5511999999999', email: 'teste@converza.app' },
    money: event === 'Purchase' ? { value: 1, currency: 'BRL', product: 'Teste do Converza' } : null,
  });
  if (!built.ok) throw new AppError(422, built.skip);
  const [ev] = await db.insert(schema.pixelEvents).values({
    accountId, pixelId: px.id, key, trigger: 'test', eventName: event, status: 'queued', payload: built.preview,
  }).returning();
  try {
    const resp = await deliver(platform, px.pixelId, token, built.body);
    const [row] = await db.update(schema.pixelEvents).set({ status: 'sent', response: resp, sentAt: new Date(), attempts: 1 }).where(eq(schema.pixelEvents.id, ev.id)).returning();
    await db.update(schema.pixels).set({ ...(px.status === 'error' ? { status: 'active', lastError: null } : {}), updatedAt: new Date() }).where(eq(schema.pixels.id, px.id));
    emitToAccount(accountId, 'pixel:event', { pixelId: px.id, event: publicEvent(row) });
    res.json({ ok: true, message: platform === 'tiktok' ? 'Evento de teste aceito pelo TikTok. Confira em Eventos › Teste de eventos.' : 'Evento de teste aceito pela Meta. Confira na aba Testar eventos do Gerenciador de Eventos.', response: resp, event: publicEvent(row) });
  } catch (err) {
    const e = err instanceof PixelSendError ? err : new PixelSendError((err as Error).message, false, false);
    const [row] = await db.update(schema.pixelEvents).set({ status: 'failed', error: e.message, attempts: 1 }).where(eq(schema.pixelEvents.id, ev.id)).returning();
    if (e.tokenProblem) await db.update(schema.pixels).set({ status: 'error', lastError: e.message, updatedAt: new Date() }).where(eq(schema.pixels.id, px.id));
    emitToAccount(accountId, 'pixel:event', { pixelId: px.id, event: publicEvent(row) });
    throw new AppError(422, e.message);
  }
}));

pixelsRouter.get('/:id/events', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  const st = String(req.query.status ?? '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 30;
  const where = and(eq(schema.pixelEvents.pixelId, px.id),
    ['sent', 'failed', 'skipped', 'queued'].includes(st) ? eq(schema.pixelEvents.status, st) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.pixelEvents).where(where);
  const list = await db.select({ e: schema.pixelEvents, contactName: schema.contacts.name }).from(schema.pixelEvents)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.pixelEvents.contactId))
    .where(where).orderBy(desc(schema.pixelEvents.createdAt)).limit(limit).offset((page - 1) * limit);
  res.json({ events: list.map((x) => publicEvent({ ...x.e, contactName: x.contactName })), total: Number(n), page, pages: Math.max(1, Math.ceil(Number(n) / limit)) });
}));

/** Manda de novo um evento que falhou (ex.: depois de trocar o token). */
pixelsRouter.post('/:id/events/:eventId/retry', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  if (!isUuid(req.params.eventId)) throw new AppError(404, 'Evento não encontrado');
  const [ev] = await db.select().from(schema.pixelEvents).where(and(eq(schema.pixelEvents.id, req.params.eventId), eq(schema.pixelEvents.pixelId, px.id))).limit(1);
  if (!ev) throw new AppError(404, 'Evento não encontrado');
  if (ev.trigger === 'test') throw new AppError(409, 'Evento de teste não é reenviado — use Testar de novo');
  if (ev.status === 'sent') throw new AppError(409, 'Esse evento já foi aceito pela plataforma');
  const [row] = await db.update(schema.pixelEvents).set({ status: 'queued', error: null }).where(eq(schema.pixelEvents.id, ev.id)).returning();
  await enqueuePixelEvent(ev.id);
  emitToAccount(accountId, 'pixel:event', { pixelId: px.id, event: publicEvent(row) });
  res.json({ event: publicEvent(row) });
}));

/** Reenvia as falhas dos últimos 7 dias (a Meta não aceita eventos mais velhos que isso). */
pixelsRouter.post('/:id/retry-failed', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const px = await ownPixel(accountId, req.params.id);
  const list = await db.update(schema.pixelEvents).set({ status: 'queued', error: null })
    .where(and(eq(schema.pixelEvents.pixelId, px.id), eq(schema.pixelEvents.status, 'failed'), inArray(schema.pixelEvents.trigger, ['lead', 'sale', 'stage']),
      gte(schema.pixelEvents.eventTime, new Date(Date.now() - 7 * 86400_000))))
    .returning({ id: schema.pixelEvents.id });
  for (const e of list) await enqueuePixelEvent(e.id);
  emitToAccount(accountId, 'pixel:changed', { pixelId: px.id });
  res.json({ requeued: list.length });
}));
