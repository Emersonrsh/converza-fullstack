/**
 * Trackeamento: links rastreáveis para o WhatsApp.
 * O link curto (/t/<endereço>) conta o clique e abre o WhatsApp do número escolhido com uma mensagem
 * pronta que leva um código (#K7Q2MX). Quando o cliente manda essa mensagem, o contato fica marcado
 * com o link (origem), ganha as etiquetas do link e as vendas dele passam a contar para o link.
 */
import { Router, type Request } from 'express';
import { createHmac, randomInt } from 'crypto';
import { z } from 'zod';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { config } from '../config';
import { emitToAccount } from '../realtime/io';

export const trackingRouter = Router();
export const trackingPublicRouter = Router();

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
type LinkRow = typeof schema.trackingLinks.$inferSelect;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** código na mensagem: # + 6 letras/números (sem 0, O, 1, I para não confundir) */
export const CODE_RE = /#([A-HJ-NP-Z2-9]{6})(?![A-Za-z0-9])/i;

const randomFrom = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

/** Texto que vai pronto no WhatsApp: a mensagem + o código. */
export function messageWithCode(message: string, code: string): string {
  return `${message.trim()} #${code}`;
}

/** Endereço do WhatsApp com a mensagem pronta. */
export function waLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

/** Robôs que abrem links para gerar a prévia (WhatsApp, Facebook, Telegram...) não contam como clique. */
export function isPreviewBot(ua: string): boolean {
  return /bot\b|crawler|spider|facebookexternalhit|facebot|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|twitterbot|skypeuripreview|preview|headless/i.test(ua);
}

/** Tira o código da mensagem (os gatilhos por palavra-chave comparam o texto sem ele). */
export function stripCode(text: string, code: string): string {
  return text.replace(new RegExp(`\\s*#${code}(?![A-Za-z0-9])`, 'i'), '').trim();
}

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mexem nos links rastreáveis.');
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const fields = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao link').max(80),
  connectionId: z.string().uuid('Escolha o número de WhatsApp'),
  message: z.string().trim().min(1, 'Escreva a mensagem que o cliente vai mandar').max(600, 'Mensagem muito longa (até 600 letras)'),
  slug: z.string().trim().toLowerCase().max(40).optional().or(z.literal('')),
  source: z.string().trim().max(60).optional().or(z.literal('')),
  campaign: z.string().trim().max(80).optional().or(z.literal('')),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  active: z.boolean().default(true),
});

async function checkConnection(accountId: string, connectionId: string) {
  const [c] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(422, 'Número de WhatsApp não encontrado');
  if (!c.displayPhone?.replace(/\D/g, '')) throw new AppError(422, 'Esse número ainda não tem o telefone confirmado pela Meta. Teste a conexão em Conexões e tente de novo.');
  return c;
}

async function checkTags(accountId: string, tags: string[]): Promise<string[]> {
  if (!tags.length) return [];
  const known = await db.select({ name: schema.tags.name }).from(schema.tags).where(eq(schema.tags.accountId, accountId));
  const byLower = new Map(known.map((t) => [t.name.toLowerCase(), t.name]));
  const out: string[] = [];
  for (const t of tags) {
    const name = byLower.get(t.toLowerCase());
    if (!name) throw new AppError(422, `A etiqueta “${t}” não existe. Crie em Configurações → Etiquetas.`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

async function newCode(accountId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomFrom(CODE_ALPHABET, 6);
    const [dup] = await db.select({ id: schema.trackingLinks.id }).from(schema.trackingLinks)
      .where(and(eq(schema.trackingLinks.accountId, accountId), eq(schema.trackingLinks.code, code))).limit(1);
    if (!dup) return code;
  }
  throw new AppError(500, 'Não deu para gerar um código. Tente de novo.');
}

async function slugFree(slug: string, exceptId?: string): Promise<boolean> {
  const [dup] = await db.select({ id: schema.trackingLinks.id }).from(schema.trackingLinks).where(eq(schema.trackingLinks.slug, slug)).limit(1);
  return !dup || dup.id === exceptId;
}

async function pickSlug(wanted: string | undefined, exceptId?: string): Promise<string> {
  if (wanted) {
    if (!slugRe.test(wanted)) throw new AppError(422, 'O endereço usa só letras minúsculas, números e hífen (3 a 40), sem hífen nas pontas.');
    if (!(await slugFree(wanted, exceptId))) throw new AppError(409, 'Esse endereço já está em uso. Escolha outro.');
    return wanted;
  }
  for (let i = 0; i < 20; i++) {
    const s = randomFrom(SLUG_ALPHABET, 7);
    if (await slugFree(s)) return s;
  }
  throw new AppError(500, 'Não deu para gerar o endereço. Tente de novo.');
}

function view(req: Request, l: LinkRow, extra: { connectionName?: string | null; phone?: string | null } = {}) {
  const text = messageWithCode(l.message, l.code);
  return {
    id: l.id, name: l.name, slug: l.slug, code: l.code, message: l.message, text,
    connectionId: l.connectionId, connectionName: extra.connectionName ?? null, phone: extra.phone ?? null,
    source: l.utmSource ?? '', campaign: l.utmCampaign ?? '', tags: l.tags, active: l.active,
    clicks: l.clicks, createdAt: l.createdAt,
    url: `${publicBase(req, config.publicApiUrl)}/t/${l.slug}`,
    whatsappUrl: extra.phone ? waLink(extra.phone, text) : null,
  };
}

async function ownLink(accountId: string, id: string): Promise<LinkRow> {
  if (!isUuid(id)) throw new AppError(404, 'Link não encontrado');
  const [l] = await db.select().from(schema.trackingLinks)
    .where(and(eq(schema.trackingLinks.id, id), eq(schema.trackingLinks.accountId, accountId))).limit(1);
  if (!l) throw new AppError(404, 'Link não encontrado');
  return l;
}

trackingRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const links = await db.select({ l: schema.trackingLinks, connectionName: schema.connections.name, phone: schema.connections.displayPhone })
    .from(schema.trackingLinks)
    .leftJoin(schema.connections, eq(schema.connections.id, schema.trackingLinks.connectionId))
    .where(eq(schema.trackingLinks.accountId, accountId))
    .orderBy(desc(schema.trackingLinks.createdAt));
  const since = new Date(Date.now() - 30 * 86_400_000);
  const stats = await rows<{ link_id: string; clicks30: number; contacts: number; sales: number; revenue: number }>(sql`
    select l.id as link_id,
      (select count(*)::int from tracking_clicks k where k.link_id = l.id and k.created_at >= ${since}) as clicks30,
      (select count(*)::int from contacts c where c.tracking_link_id = l.id) as contacts,
      (select count(*)::int from sales s join contacts c on c.id = s.contact_id
        where c.tracking_link_id = l.id and s.status = 'approved' and s.created_at >= c.tracked_at) as sales,
      (select coalesce(sum(s.amount), 0)::float from sales s join contacts c on c.id = s.contact_id
        where c.tracking_link_id = l.id and s.status = 'approved' and s.created_at >= c.tracked_at) as revenue
    from tracking_links l where l.account_id = ${accountId}`);
  const byId = new Map(stats.map((s) => [s.link_id, s]));
  const connections = await db.select({ id: schema.connections.id, name: schema.connections.name, phone: schema.connections.displayPhone })
    .from(schema.connections).where(eq(schema.connections.accountId, accountId)).orderBy(asc(schema.connections.createdAt));
  const list = links.map((r) => {
    const s = byId.get(r.l.id);
    return {
      ...view(req, r.l, { connectionName: r.connectionName, phone: r.phone }),
      clicks30: Number(s?.clicks30 ?? 0), contacts: Number(s?.contacts ?? 0), sales: Number(s?.sales ?? 0), revenue: Number(s?.revenue ?? 0),
    };
  });
  res.json({
    links: list,
    totals: {
      links: list.length, clicks: list.reduce((a, l) => a + l.clicks, 0), contacts: list.reduce((a, l) => a + l.contacts, 0),
      sales: list.reduce((a, l) => a + l.sales, 0), revenue: list.reduce((a, l) => a + l.revenue, 0),
    },
    connections: connections.map((c) => ({ ...c, ready: !!c.phone?.replace(/\D/g, '') })),
    canEdit: req.role !== 'agent',
    base: `${publicBase(req, config.publicApiUrl)}/t/`,
  });
}));

trackingRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = fields.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const conn = await checkConnection(accountId, p.data.connectionId);
  const tags = await checkTags(accountId, p.data.tags);
  const slug = await pickSlug(p.data.slug || undefined);
  const code = await newCode(accountId);
  const [l] = await db.insert(schema.trackingLinks).values({
    accountId, name: p.data.name, slug, connectionId: conn.id, message: p.data.message, code,
    utmSource: p.data.source || null, utmCampaign: p.data.campaign || null, tags, active: p.data.active,
  }).returning();
  res.status(201).json({ link: view(req, l, { connectionName: conn.name, phone: conn.displayPhone }) });
}));

trackingRouter.patch('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const cur = await ownLink(accountId, req.params.id);
  const p = fields.partial().safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const d = p.data;
  const patch: Partial<typeof schema.trackingLinks.$inferInsert> = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.message !== undefined) patch.message = d.message;
  if (d.source !== undefined) patch.utmSource = d.source || null;
  if (d.campaign !== undefined) patch.utmCampaign = d.campaign || null;
  if (d.active !== undefined) patch.active = d.active;
  if (d.tags !== undefined) patch.tags = await checkTags(accountId, d.tags);
  if (d.connectionId !== undefined) patch.connectionId = (await checkConnection(accountId, d.connectionId)).id;
  if (d.slug !== undefined && d.slug && d.slug !== cur.slug) patch.slug = await pickSlug(d.slug, cur.id);
  const [l] = Object.keys(patch).length
    ? await db.update(schema.trackingLinks).set(patch).where(eq(schema.trackingLinks.id, cur.id)).returning()
    : [cur];
  const [c] = l.connectionId ? await db.select().from(schema.connections).where(eq(schema.connections.id, l.connectionId)).limit(1) : [];
  res.json({ link: view(req, l, { connectionName: c?.name, phone: c?.displayPhone }) });
}));

trackingRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const l = await ownLink(req.accountId!, req.params.id);
  await db.delete(schema.trackingLinks).where(eq(schema.trackingLinks.id, l.id));
  res.status(204).end();
}));

/** Cliques e chegadas por dia (30 dias) + os contatos que vieram pelo link. */
trackingRouter.get('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const l = await ownLink(accountId, req.params.id);
  const [tz] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const zone = tz?.tz || 'America/Sao_Paulo';
  const since = new Date(Date.now() - 30 * 86_400_000);
  const clicks = await rows<{ day: string; n: number }>(sql`
    select to_char(date_trunc('day', created_at at time zone ${zone}), 'YYYY-MM-DD') as day, count(*)::int as n
      from tracking_clicks where link_id = ${l.id} and created_at >= ${since} group by 1 order by 1`);
  const arrivals = await rows<{ day: string; n: number }>(sql`
    select to_char(date_trunc('day', tracked_at at time zone ${zone}), 'YYYY-MM-DD') as day, count(*)::int as n
      from contacts where tracking_link_id = ${l.id} and tracked_at >= ${since} group by 1 order by 1`);
  const contacts = await rows<{ id: string; name: string; phone: string; tracked_at: Date; sales: number; revenue: number }>(sql`
    select c.id, c.name, c.phone, c.tracked_at,
      (select count(*)::int from sales s where s.contact_id = c.id and s.status = 'approved' and s.created_at >= c.tracked_at) as sales,
      (select coalesce(sum(s.amount), 0)::float from sales s where s.contact_id = c.id and s.status = 'approved' and s.created_at >= c.tracked_at) as revenue
      from contacts c where c.account_id = ${accountId} and c.tracking_link_id = ${l.id}
     order by c.tracked_at desc nulls last limit 200`);
  const recent = await db.select({ createdAt: schema.trackingClicks.createdAt, referer: schema.trackingClicks.referer, query: schema.trackingClicks.query })
    .from(schema.trackingClicks).where(eq(schema.trackingClicks.linkId, l.id)).orderBy(desc(schema.trackingClicks.createdAt)).limit(30);
  const [c] = l.connectionId ? await db.select().from(schema.connections).where(eq(schema.connections.id, l.connectionId)).limit(1) : [];
  res.json({
    link: view(req, l, { connectionName: c?.name, phone: c?.displayPhone }),
    clicksByDay: clicks.map((r) => ({ day: r.day, n: Number(r.n) })),
    arrivalsByDay: arrivals.map((r) => ({ day: r.day, n: Number(r.n) })),
    contacts: contacts.map((r) => ({ id: r.id, name: r.name, phone: r.phone, trackedAt: r.tracked_at, sales: Number(r.sales), revenue: Number(r.revenue) })),
    recentClicks: recent.map((r) => ({ createdAt: r.createdAt, referer: r.referer ? safeHost(r.referer) : null, query: r.query })),
  });
}));

function safeHost(u: string): string {
  try { return new URL(u).host; } catch { return ''; }
}

/* ----------------------------------------------------- link público */

const page = (title: string, text: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f6;color:#0f2b2e;display:grid;place-items:center;min-height:100vh">
<div style="background:#fff;border-radius:16px;padding:28px 32px;max-width:360px;text-align:center;box-shadow:0 8px 30px rgba(15,43,46,.08)"><h1 style="font-size:18px;margin:0 0 8px">${title}</h1><p style="margin:0;color:#4b6366;font-size:14px;line-height:1.5">${text}</p></div></body></html>`;

const KEEP_QUERY = /^(utm_[a-z]+|fbclid|gclid|ttclid|src|ref)$/;

trackingPublicRouter.get('/:slug', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const slug = String(req.params.slug).toLowerCase();
  const [l] = slugRe.test(slug) ? await db.select().from(schema.trackingLinks).where(eq(schema.trackingLinks.slug, slug)).limit(1) : [];
  if (!l || !l.active) {
    res.status(404).type('html').send(page('Link indisponível', 'Este link não existe mais ou foi pausado por quem o criou.'));
    return;
  }
  const [c] = l.connectionId ? await db.select({ phone: schema.connections.displayPhone }).from(schema.connections)
    .where(eq(schema.connections.id, l.connectionId)).limit(1) : [];
  const phone = c?.phone?.replace(/\D/g, '');
  if (!phone) {
    res.status(503).type('html').send(page('WhatsApp indisponível', 'Este link está sem número de WhatsApp no momento. Tente mais tarde.'));
    return;
  }
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
  if (!isPreviewBot(ua)) {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (KEEP_QUERY.test(k) && typeof v === 'string') query[k] = v.slice(0, 200);
    }
    try {
      await db.insert(schema.trackingClicks).values({
        linkId: l.id, accountId: l.accountId, referer: String(req.headers.referer ?? '').slice(0, 500) || null, userAgent: ua || null,
        ipHash: ip ? createHmac('sha256', config.jwtSecret).update(ip).digest('hex').slice(0, 32) : null, query,
      });
      await db.update(schema.trackingLinks).set({ clicks: sql`${schema.trackingLinks.clicks} + 1` }).where(eq(schema.trackingLinks.id, l.id));
      emitToAccount(l.accountId, 'tracking:click', { linkId: l.id });
    } catch (err) {
      console.error('[trackeamento] clique:', (err as Error).message);
    }
  }
  res.redirect(302, waLink(phone, messageWithCode(l.message, l.code)));
}));

/* ---------------------------------------------- chegada no WhatsApp */

/**
 * Mensagem recebida: se tiver o código de um link da conta, marca o contato com esse link
 * (o último link vale), põe as etiquetas do link e devolve o texto sem o código.
 */
export async function attributeTracking(accountId: string, contactId: string, text: string | null | undefined): Promise<{ text: string; linkId: string | null }> {
  const body = text ?? '';
  const m = body.match(CODE_RE);
  if (!m) return { text: body, linkId: null };
  const code = m[1].toUpperCase();
  const [l] = await db.select().from(schema.trackingLinks)
    .where(and(eq(schema.trackingLinks.accountId, accountId), eq(schema.trackingLinks.code, code))).limit(1);
  if (!l) return { text: body, linkId: null };
  const [cur] = await db.select({ tags: schema.contacts.tags }).from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
  if (!cur) return { text: body, linkId: null };
  const tags = [...(cur.tags ?? [])];
  for (const t of l.tags) if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
  const [c] = await db.update(schema.contacts).set({ trackingLinkId: l.id, trackedAt: new Date(), tags })
    .where(eq(schema.contacts.id, contactId)).returning();
  if (c) emitToAccount(accountId, 'contacts:changed', { contactId: c.id });
  return { text: stripCode(body, code), linkId: l.id };
}
