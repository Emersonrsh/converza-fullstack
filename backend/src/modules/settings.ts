import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { notSupport } from '../auth/middleware';
import { emailConfigured } from '../email/mailer';
import { emitToAccount } from '../realtime/io';
import { validTimezone } from '../utils/hours';
import { renameTagDeep } from '../utils/tagRename';

export const settingsRouter = Router();

/* ---- empresa (conta) ---- */
const manager = (req: Request) => req.role === 'owner' || req.role === 'admin';
function managerOnly(req: Request) {
  if (!manager(req)) throw new AppError(403, 'Só o dono e os administradores mudam os dados da empresa.');
}

export const slugOk = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length >= 3 && s.length <= 60;

settingsRouter.get('/account', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const [sub] = await db.select({ status: schema.subscriptions.status, instances: schema.subscriptions.instances })
    .from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.accountId, accountId));
  res.json({
    account: {
      id: row.id, number: row.number, name: row.name, description: row.description, slug: row.slug, timezone: row.timezone,
      notifyInstanceEmail: row.notifyInstanceEmail, createdAt: row.createdAt, subscriptionStatus: sub?.status ?? 'inactive',
      instances: sub?.status === 'active' ? sub.instances : 0, members: Number(n),
    },
    role: req.role, canEdit: manager(req), isOwner: req.role === 'owner', support: !!req.support,
    emailConfigured: emailConfigured(),
  });
}));

settingsRouter.patch('/account', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = z.object({
    name: z.string().trim().min(2, 'O nome da empresa precisa de pelo menos 2 letras').max(80).optional(),
    description: z.string().trim().max(300).optional(),
    slug: z.string().trim().toLowerCase().optional(),
    timezone: z.string().trim().optional(),
    notifyInstanceEmail: z.boolean().optional(),
  }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const data = p.data;
  if (data.timezone !== undefined && !validTimezone(data.timezone)) throw new AppError(422, 'Fuso horário inválido');
  if (data.slug !== undefined) {
    if (!slugOk(data.slug)) throw new AppError(422, 'O slug usa só letras minúsculas, números e hífens (3 a 60).');
    const [taken] = await db.select({ id: schema.accounts.id }).from(schema.accounts)
      .where(and(eq(schema.accounts.slug, data.slug), ne(schema.accounts.id, req.accountId!))).limit(1);
    if (taken) throw new AppError(409, 'Esse slug já é usado por outra empresa.');
  }
  const [row] = await db.update(schema.accounts).set(data).where(eq(schema.accounts.id, req.accountId!)).returning();
  emitToAccount(req.accountId!, 'account:changed', { name: row.name });
  res.json({ account: row });
}));

/** Sair da empresa (o proprietário não sai: ele exclui a empresa). */
settingsRouter.post('/leave', asyncHandler(async (req, res) => {
  if (req.support) throw new AppError(409, 'O acesso do suporte termina sozinho no prazo (ou quando a empresa revoga).');
  if (req.role === 'owner') {
    throw new AppError(409, 'O proprietário não pode sair da empresa. Para encerrar, exclua a empresa (ícone vermelho no topo).', { code: 'owner_cannot_leave' });
  }
  await db.delete(schema.memberships)
    .where(and(eq(schema.memberships.accountId, req.accountId!), eq(schema.memberships.userId, req.user!.id)));
  await db.update(schema.conversations).set({ assignedUserId: null })
    .where(and(eq(schema.conversations.accountId, req.accountId!), eq(schema.conversations.assignedUserId, req.user!.id), ne(schema.conversations.status, 'resolved')));
  emitToAccount(req.accountId!, 'team:changed', {});
  res.status(204).end();
}));

/** Excluir a empresa e tudo dela. Só o proprietário, digitando o nome; nunca com a assinatura renovando. */
settingsRouter.delete('/account', asyncHandler(async (req, res) => {
  notSupport(req, 'Excluir a empresa');
  if (req.role !== 'owner') throw new AppError(403, 'Só o proprietário exclui a empresa.');
  const accountId = req.accountId!;
  const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
  const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  if (!acc || confirm.trim().toLowerCase() !== acc.name.trim().toLowerCase()) {
    throw new AppError(422, 'Digite o nome da empresa exatamente como está para confirmar.', { code: 'confirm_mismatch' });
  }
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const charging = sub && sub.gatewaySubscriptionId && ((sub.status === 'active' && !sub.cancelAtPeriodEnd) || sub.status === 'past_due');
  if (charging) {
    throw new AppError(409, 'A assinatura desta empresa ainda está sendo cobrada. Cancele em Cobranças e assinaturas antes de excluir.', { code: 'subscription_active' });
  }
  await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
  res.status(204).end();
}));

/* ---- etiquetas ---- */
settingsRouter.get('/tags', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const rows = await db.select().from(schema.tags).where(eq(schema.tags.accountId, accountId)).orderBy(asc(schema.tags.name));
  const counts = await db.execute(sql`select t as name, count(*)::int as n from contacts, unnest(tags) as t where account_id = ${accountId} group by t`);
  const byName = new Map((counts.rows as { name: string; n: number }[]).map((r) => [r.name.toLowerCase(), Number(r.n)]));
  res.json({ tags: rows.map((t) => ({ ...t, contacts: byName.get(t.name.toLowerCase()) ?? 0 })), canEdit: manager(req) });
}));

const tagName = z.string().trim().min(1, 'Dê um nome à etiqueta').max(40, 'Nome muito longo (até 40 letras)');
const tagColor = z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Cor inválida');

settingsRouter.post('/tags', asyncHandler(async (req, res) => {
  const p = z.object({ name: tagName, color: tagColor.optional() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const [dup] = await db.select().from(schema.tags)
    .where(and(eq(schema.tags.accountId, req.accountId!), sql`lower(${schema.tags.name}) = ${p.data.name.toLowerCase()}`)).limit(1);
  if (dup) return res.status(200).json({ tag: dup, existed: true });
  const [row] = await db.insert(schema.tags)
    .values({ accountId: req.accountId!, name: p.data.name, color: p.data.color ?? '#0e9488' })
    .onConflictDoNothing().returning();
  res.status(201).json({ tag: row });
}));

/** Renomear/mudar a cor. O nome novo vale nos contatos, agentes, fluxos, webhooks e disparos ainda não enviados. */
settingsRouter.patch('/tags/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  if (!isUuid(req.params.id)) throw new AppError(404, 'Etiqueta não encontrada');
  const p = z.object({ name: tagName.optional(), color: tagColor.optional() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const [tag] = await db.select().from(schema.tags).where(and(eq(schema.tags.id, req.params.id), eq(schema.tags.accountId, accountId))).limit(1);
  if (!tag) throw new AppError(404, 'Etiqueta não encontrada');
  let renamed = 0;
  const to = p.data.name;
  if (to && to !== tag.name) {
    const [dup] = await db.select({ id: schema.tags.id }).from(schema.tags)
      .where(and(eq(schema.tags.accountId, accountId), sql`lower(${schema.tags.name}) = ${to.toLowerCase()}`, ne(schema.tags.id, tag.id))).limit(1);
    if (dup) throw new AppError(409, 'Já existe uma etiqueta com esse nome.');
    renamed = await renameTagEverywhere(accountId, tag.name, to);
  }
  const [row] = await db.update(schema.tags).set({ ...(to ? { name: to } : {}), ...(p.data.color ? { color: p.data.color } : {}) })
    .where(eq(schema.tags.id, tag.id)).returning();
  emitToAccount(accountId, 'tags:changed', {});
  res.json({ tag: row, renamed });
}));

/** Apaga a etiqueta da lista e tira dos contatos (fluxos e agentes que usam o nome não mudam). */
settingsRouter.delete('/tags/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Etiqueta não encontrada');
  const [tag] = await db.delete(schema.tags)
    .where(and(eq(schema.tags.id, req.params.id), eq(schema.tags.accountId, req.accountId!))).returning();
  if (tag) {
    await db.execute(sql`update contacts set tags = array(select x from unnest(tags) as x where lower(x) <> lower(${tag.name}))
      where account_id = ${req.accountId!} and exists (select 1 from unnest(tags) as y where lower(y) = lower(${tag.name}))`);
    emitToAccount(req.accountId!, 'tags:changed', {});
  }
  res.status(204).end();
}));

async function renameTagEverywhere(accountId: string, from: string, to: string) {
  let total = 0;
  const r = await db.execute(sql`update contacts set tags = array(select case when lower(x) = lower(${from}) then ${to} else x end from unnest(tags) as x)
    where account_id = ${accountId} and exists (select 1 from unnest(tags) as y where lower(y) = lower(${from}))`);
  total += r.rowCount ?? 0;
  await db.execute(sql`update agents set
      flow_tag = case when lower(flow_tag) = lower(${from}) then ${to} else flow_tag end,
      handoff_tag = case when lower(handoff_tag) = lower(${from}) then ${to} else handoff_tag end,
      audience_tags = array(select case when lower(x) = lower(${from}) then ${to} else x end from unnest(audience_tags) as x)
    where account_id = ${accountId}`);
  await db.execute(sql`update tracking_links set tags = array(select case when lower(x) = lower(${from}) then ${to} else x end from unnest(tags) as x)
    where account_id = ${accountId}`);
  for (const f of await db.select({ id: schema.flows.id, graph: schema.flows.graph, trigger: schema.flows.trigger }).from(schema.flows).where(eq(schema.flows.accountId, accountId))) {
    const [graph, n1] = renameTagDeep(f.graph, from, to);
    const [trigger, n2] = renameTagDeep(f.trigger, from, to);
    if (n1 + n2) await db.update(schema.flows).set({ graph, trigger }).where(eq(schema.flows.id, f.id));
  }
  for (const w of await db.select({ id: schema.webhooks.id, actions: schema.webhooks.actions }).from(schema.webhooks).where(eq(schema.webhooks.accountId, accountId))) {
    const [actions, n] = renameTagDeep(w.actions, from, to);
    if (n) await db.update(schema.webhooks).set({ actions }).where(eq(schema.webhooks.id, w.id));
  }
  for (const c of await db.select({ id: schema.campaigns.id, audience: schema.campaigns.audience }).from(schema.campaigns)
    .where(and(eq(schema.campaigns.accountId, accountId), inArray(schema.campaigns.status, ['draft', 'scheduled', 'paused'])))) {
    const [audience, n] = renameTagDeep(c.audience, from, to);
    if (n) await db.update(schema.campaigns).set({ audience }).where(eq(schema.campaigns.id, c.id));
  }
  return total;
}

/* ---- produtos ---- */
settingsRouter.get('/products', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.products).where(eq(schema.products.accountId, req.accountId!));
  res.json({ products: rows });
}));

const checkoutUrl = z.string().trim().max(1000)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'O link precisa começar com http:// ou https://')
  .optional();

settingsRouter.post('/products', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(1), price: z.number().nonnegative(), cost: z.number().nonnegative().optional(), checkoutUrl }).parse(req.body);
  const [row] = await db.insert(schema.products)
    .values({ accountId: req.accountId!, name: data.name, price: data.price.toFixed(2), cost: (data.cost ?? 0).toFixed(2), checkoutUrl: data.checkoutUrl || null })
    .returning();
  res.status(201).json({ product: row });
}));

settingsRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Produto não encontrado');
  const data = z.object({
    name: z.string().trim().min(1).optional(), price: z.number().nonnegative().optional(), cost: z.number().nonnegative().optional(), checkoutUrl,
  }).parse(req.body);
  const [row] = await db.update(schema.products).set({
    ...(data.name ? { name: data.name } : {}),
    ...(data.price !== undefined ? { price: data.price.toFixed(2) } : {}),
    ...(data.cost !== undefined ? { cost: data.cost.toFixed(2) } : {}),
    ...(data.checkoutUrl !== undefined ? { checkoutUrl: data.checkoutUrl || null } : {}),
  }).where(and(eq(schema.products.id, req.params.id), eq(schema.products.accountId, req.accountId!))).returning();
  if (!row) throw new AppError(404, 'Produto não encontrado');
  res.json({ product: row });
}));

settingsRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Produto não encontrado');
  const [row] = await db.delete(schema.products)
    .where(and(eq(schema.products.id, req.params.id), eq(schema.products.accountId, req.accountId!)))
    .returning({ id: schema.products.id });
  if (!row) throw new AppError(404, 'Produto não encontrado');
  res.status(204).end();
}));
