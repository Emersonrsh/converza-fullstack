/**
 * Painel da plataforma: visão do dono do Converza sobre todas as empresas (PLATFORM_ADMIN_EMAILS).
 * Números do negócio, lista de empresas, detalhes, suspender/reativar, dias de cortesia e registro de tudo.
 * Não dá acesso aos dados internos das empresas (conversas, contatos): para isso existe o acesso de suporte,
 * que só a própria empresa libera (Termos de Uso).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';
import { patchSub } from '../billing/store';
import { creditTokens, removeTokens } from './tokens';
import { PRICING } from './plans';
import { emitToAccount } from '../realtime/io';
import { config } from '../config';
import { SAMPLE_VARS, deliverDetailed, pushConfigured, pushSaleToAccount } from './push';

export const platformRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
const n = (v: unknown) => Number(v ?? 0) || 0;

async function audit(req: Request, accountId: string | null, accountName: string, action: string, detail: Record<string, unknown> = {}) {
  await db.insert(schema.platformAudit).values({
    actorUserId: req.user!.id, actorEmail: req.user!.email.toLowerCase(), accountId, accountName, action, detail,
  });
}

/** Situação da empresa em uma palavra (a mesma regra na lista, no filtro e nos números). */
const STATUS_SQL = sql`case
  when a.suspended_at is not null then 'suspended'
  when s.house then 'house'
  when s.status = 'active' and s.gateway is null then 'courtesy'
  when s.status = 'active' and s.cancel_at_period_end then 'canceling'
  when s.status = 'active' then 'paying'
  when s.status = 'past_due' then 'past_due'
  when s.status = 'canceled' then 'canceled'
  else 'inactive' end`;

/* ------------------------------------------------------------------ números do negócio */

platformRouter.get('/overview', asyncHandler(async (_req, res) => {
  const price = PRICING.instanceBRL;
  const [k] = rows<Record<string, unknown>>(await db.execute(sql`
    select
      count(*) as companies,
      count(*) filter (where x.created_at > now() - interval '30 days') as "new30",
      count(*) filter (where x.st = 'paying') as paying,
      count(*) filter (where x.st = 'canceling') as canceling,
      count(*) filter (where x.st = 'past_due') as "pastDue",
      count(*) filter (where x.st = 'house') as house,
      count(*) filter (where x.st = 'courtesy') as courtesy,
      count(*) filter (where x.st = 'suspended') as suspended,
      count(*) filter (where x.st in ('inactive', 'canceled')) as inactive,
      coalesce(sum(x.instances) filter (where x.st = 'paying' and x.country = 'BR'), 0) as "payingInstancesBR",
      count(*) filter (where x.st = 'paying' and x.country <> 'BR') as "payingIntl",
      count(*) filter (where x.sub_status = 'canceled' and x.canceled_at > now() - interval '30 days') as "canceled30"
    from (
      select a.created_at, s.instances, s.billing_country as country, s.status as sub_status, s.canceled_at, ${STATUS_SQL} as st
      from accounts a left join subscriptions s on s.account_id = a.id
    ) x`));
  const [inv] = rows<Record<string, unknown>>(await db.execute(sql`
    select
      coalesce(sum(amount - coalesce(refund_amount, 0)) filter (where status in ('paid', 'refunded') and paid_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' and currency = 'BRL'), 0) as "revenueMonth",
      coalesce(sum(amount - coalesce(refund_amount, 0)) filter (where status in ('paid', 'refunded') and paid_at >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' - interval '1 month'
        and paid_at < date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' and currency = 'BRL'), 0) as "revenueLastMonth",
      count(*) filter (where status = 'overdue') as "overdueCount",
      coalesce(sum(amount) filter (where status = 'overdue' and currency = 'BRL'), 0) as "overdueAmount"
    from invoices`));
  const months = rows<{ month: string; total: string }>(await db.execute(sql`
    with m as (select generate_series(date_trunc('month', now() at time zone 'America/Sao_Paulo') - interval '5 months', date_trunc('month', now() at time zone 'America/Sao_Paulo'), interval '1 month') as month)
    select to_char(m.month, 'YYYY-MM') as month,
      coalesce(sum(i.amount - coalesce(i.refund_amount, 0)), 0) as total
    from m left join invoices i on i.status in ('paid', 'refunded') and i.currency = 'BRL'
      and (i.paid_at at time zone 'America/Sao_Paulo') >= m.month and (i.paid_at at time zone 'America/Sao_Paulo') < m.month + interval '1 month'
    group by m.month order by m.month`));
  const [use] = rows<Record<string, unknown>>(await db.execute(sql`
    select
      (select count(*) from connections where status = 'connected') as "numbersConnected",
      (select count(*) from connections) as "numbersTotal",
      (select coalesce(sum(tokens), 0) from ai_usage where created_at > now() - interval '30 days') as "aiTokens30",
      (select count(distinct user_id) from access_logs where created_at > now() - interval '7 days') as "activeUsers7"`));
  res.json({
    price,
    companies: {
      total: n(k.companies), new30: n(k.new30), paying: n(k.paying), canceling: n(k.canceling), pastDue: n(k.pastDue),
      house: n(k.house), courtesy: n(k.courtesy), suspended: n(k.suspended), inactive: n(k.inactive), canceled30: n(k.canceled30),
    },
    // receita mensal recorrente estimada: instâncias de quem paga e renova (Brasil) × preço da instância
    mrr: Math.round(n(k.payingInstancesBR) * price * 100) / 100,
    payingInstances: n(k.payingInstancesBR),
    payingIntl: n(k.payingIntl),
    revenue: { month: n(inv.revenueMonth), lastMonth: n(inv.revenueLastMonth), months: months.map((m) => ({ month: m.month, total: n(m.total) })) },
    overdue: { count: n(inv.overdueCount), amount: n(inv.overdueAmount) },
    usage: { numbersConnected: n(use.numbersConnected), numbersTotal: n(use.numbersTotal), aiTokens30: n(use.aiTokens30), activeUsers7: n(use.activeUsers7) },
  });
}));

/* ------------------------------------------------------------------ empresas */

const STATUSES = ['paying', 'canceling', 'past_due', 'courtesy', 'house', 'inactive', 'canceled', 'suspended'] as const;

platformRouter.get('/accounts', asyncHandler(async (req, res) => {
  const q = z.object({
    q: z.string().trim().max(120).optional().default(''),
    status: z.enum(['all', ...STATUSES]).optional().default('all'),
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  }).parse(req.query);
  const size = 30;
  const like = `%${q.q.toLowerCase()}%`;
  const digits = q.q.replace(/\D/g, '');
  const where = sql`where (${q.q === ''}
      or lower(x.name) like ${like} or lower(coalesce(x."ownerEmail", '')) like ${like} or lower(coalesce(x."ownerName", '')) like ${like}
      or (${digits !== ''} and x.number::text = ${digits}))
    and (${q.status === 'all'} or x.status = ${q.status})`;
  const base = sql`
    select a.id, a.name, a.number, a.created_at as "createdAt", a.suspended_at as "suspendedAt", a.suspended_reason as "suspendedReason",
      ${STATUS_SQL} as status,
      s.instances, s.ai_tokens_balance as "aiBalance", s.current_period_end as "periodEnd", s.gateway, s.payment_method as "paymentMethod", s.billing_country as country,
      (select u.name from memberships m join users u on u.id = m.user_id where m.account_id = a.id and m.role = 'owner' order by m.created_at limit 1) as "ownerName",
      (select u.email from memberships m join users u on u.id = m.user_id where m.account_id = a.id and m.role = 'owner' order by m.created_at limit 1) as "ownerEmail",
      (select count(*) from memberships m where m.account_id = a.id) as members,
      (select count(*) from connections c where c.account_id = a.id) as numbers,
      (select count(*) from connections c where c.account_id = a.id and c.status = 'connected') as "numbersOn",
      (select max(l.created_at) from access_logs l join memberships m on m.user_id = l.user_id where m.account_id = a.id) as "lastAccess",
      (select coalesce(sum(tokens), 0) from ai_usage u where u.account_id = a.id and u.created_at > now() - interval '30 days') as "aiTokens30"
    from accounts a left join subscriptions s on s.account_id = a.id`;
  const list = rows<Record<string, unknown>>(await db.execute(sql`
    select * from (${base}) x ${where} order by x."createdAt" desc limit ${size} offset ${(q.page - 1) * size}`));
  const [{ total }] = rows<{ total: string }>(await db.execute(sql`select count(*) as total from (${base}) x ${where}`));
  res.json({
    accounts: list.map((r) => ({ ...r, members: n(r.members), numbers: n(r.numbers), numbersOn: n(r.numbersOn), aiTokens30: n(r.aiTokens30), aiBalance: n(r.aiBalance), instances: n(r.instances) })),
    total: n(total), page: q.page, pageSize: size,
  });
}));

async function accountOr404(id: string) {
  if (!UUID.test(id)) throw new AppError(404, 'Empresa não encontrada');
  const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
  if (!a) throw new AppError(404, 'Empresa não encontrada');
  return a;
}

platformRouter.get('/accounts/:id', asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, a.id)).limit(1);
  const [st] = rows<{ status: string }>(await db.execute(sql`select ${STATUS_SQL} as status from accounts a left join subscriptions s on s.account_id = a.id where a.id = ${a.id}`));
  const members = rows<Record<string, unknown>>(await db.execute(sql`
    select u.name, u.email, m.role, m.created_at as "joinedAt",
      (select max(l.created_at) from access_logs l where l.user_id = u.id) as "lastAccess"
    from memberships m join users u on u.id = m.user_id where m.account_id = ${a.id} order by (m.role = 'owner') desc, m.created_at`));
  const numbers = rows<Record<string, unknown>>(await db.execute(sql`
    select name, provider, status, display_phone as "displayPhone", created_at as "createdAt"
    from connections where account_id = ${a.id} order by created_at`));
  const invoices = rows<Record<string, unknown>>(await db.execute(sql`
    select number, kind, description, amount, currency, status, method, due_date as "dueDate", paid_at as "paidAt", created_at as "createdAt"
    from invoices where account_id = ${a.id} order by created_at desc limit 12`));
  const [paid] = rows<{ total: string }>(await db.execute(sql`
    select coalesce(sum(amount - coalesce(refund_amount, 0)), 0) as total from invoices where account_id = ${a.id} and status in ('paid', 'refunded') and currency = 'BRL'`));
  const [ai] = rows<{ t30: string }>(await db.execute(sql`select coalesce(sum(tokens), 0) as t30 from ai_usage where account_id = ${a.id} and created_at > now() - interval '30 days'`));
  const [support] = rows<{ expiresAt: string }>(await db.execute(sql`
    select expires_at as "expiresAt" from support_access where account_id = ${a.id} and revoked_at is null and expires_at > now() order by expires_at desc limit 1`));
  const log = await db.select().from(schema.platformAudit).where(eq(schema.platformAudit.accountId, a.id))
    .orderBy(sql`${schema.platformAudit.createdAt} desc`).limit(20);
  res.json({
    account: {
      id: a.id, name: a.name, number: a.number, createdAt: a.createdAt, timezone: a.timezone,
      suspendedAt: a.suspendedAt, suspendedReason: a.suspendedReason, status: st?.status ?? 'inactive',
    },
    subscription: sub ? {
      status: sub.status, instances: sub.instances, periodEnd: sub.currentPeriodEnd, startedAt: sub.startedAt, gateway: sub.gateway,
      paymentMethod: sub.paymentMethod, country: sub.billingCountry, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, house: sub.house,
      renewing: sub.status === 'active' && !!sub.gatewaySubscriptionId && !sub.cancelAtPeriodEnd,
      aiTokensBalance: sub.aiTokensBalance,
    } : null,
    members, numbers, invoices: invoices.map((i) => ({ ...i, amount: n(i.amount) })),
    totals: { paid: n(paid.total), aiTokens30: n(ai.t30) },
    supportUntil: support?.expiresAt ?? null,
    audit: log,
  });
}));

platformRouter.post('/accounts/:id/suspend', asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Escreva o motivo (ele aparece para a empresa)').max(200) }).parse(req.body ?? {});
  if (a.suspendedAt) throw new AppError(409, 'Esta empresa já está suspensa');
  await db.update(schema.accounts).set({ suspendedAt: new Date(), suspendedReason: reason }).where(eq(schema.accounts.id, a.id));
  await audit(req, a.id, a.name, 'suspend', { reason });
  emitToAccount(a.id, 'account:suspended', { reason });
  res.json({ ok: true });
}));

platformRouter.post('/accounts/:id/reactivate', asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  if (!a.suspendedAt) throw new AppError(409, 'Esta empresa não está suspensa');
  await db.update(schema.accounts).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.accounts.id, a.id));
  await audit(req, a.id, a.name, 'reactivate', { reason: a.suspendedReason });
  emitToAccount(a.id, 'account:reactivated', {});
  res.json({ ok: true });
}));

/** Dias de cortesia: libera (ou estende) a assinatura sem cobrança, sem renovar sozinha no fim. */
platformRouter.post('/accounts/:id/courtesy', asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  const body = z.object({
    days: z.coerce.number().int().min(1, 'Mínimo 1 dia').max(90, 'Máximo 90 dias por vez'),
    instances: z.coerce.number().int().min(1).max(50).optional(),
    note: z.string().trim().max(200).optional().default(''),
  }).parse(req.body ?? {});
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, a.id)).limit(1);
  if (!sub) throw new AppError(409, 'Esta empresa não tem registro de assinatura');
  if (sub.house) throw new AppError(409, 'Conta da casa já tem tudo liberado');
  if (sub.status === 'active' && sub.gatewaySubscriptionId && !sub.cancelAtPeriodEnd) {
    throw new AppError(409, 'Esta empresa tem uma assinatura paga que renova sozinha. Para dar desconto, ajuste a cobrança no painel da Asaas ou da Paddle.', { code: 'paid_renewing' });
  }
  const now = new Date();
  const activeNow = sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  const from = activeNow ? sub.currentPeriodEnd! : now;
  const until = new Date(from.getTime() + body.days * 86_400_000);
  const instances = Math.max(body.instances ?? 0, sub.instances || 0, 1);
  await patchSub(a.id, {
    status: 'active', currentPeriodEnd: until, cancelAtPeriodEnd: true, instances, pendingInstances: null,
    startedAt: sub.startedAt ?? now, canceledAt: null,
  });
  await audit(req, a.id, a.name, 'courtesy', { days: body.days, instances, until: until.toISOString(), note: body.note || undefined });
  res.json({ ok: true, until, instances });
}));

/** Créditos de IA: soma (ou tira, para corrigir) tokens no saldo da empresa, sem cobrança. */
platformRouter.post('/accounts/:id/ai-credits', asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  const body = z.object({
    tokens: z.coerce.number().int().min(1, 'Mínimo 1 token').max(100_000_000, 'Máximo 100 milhões de tokens por vez'),
    mode: z.enum(['add', 'remove']).optional().default('add'),
    note: z.string().trim().max(200).optional().default(''),
  }).parse(req.body ?? {});
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, a.id)).limit(1);
  if (sub?.house) throw new AppError(409, 'Conta da casa já tem tokens de IA sem limite');
  const before = sub?.aiTokensBalance ?? 0;
  if (body.mode === 'add' && before + body.tokens > 2_000_000_000) throw new AppError(422, 'O saldo passaria do limite de 2 bilhões de tokens');
  const balance = body.mode === 'add' ? await creditTokens(a.id, body.tokens) : await removeTokens(a.id, body.tokens);
  await audit(req, a.id, a.name, body.mode === 'add' ? 'ai_credits' : 'ai_credits_remove', {
    tokens: body.mode === 'add' ? body.tokens : before - balance, before, balance, note: body.note || undefined,
  });
  res.json({ ok: true, balance, before });
}));

/* ------------------------------------------------------------------ registro */

platformRouter.get('/audit', asyncHandler(async (_req, res) => {
  const log = await db.select().from(schema.platformAudit).orderBy(sql`${schema.platformAudit.createdAt} desc`).limit(100);
  res.json({ audit: log });
}));

/* ------------------------------------------------------------------ notificações no celular (teste) */

/** Estado das notificações e os aparelhos inscritos (busca por pessoa, e-mail ou empresa). */
platformRouter.get('/push', asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const devices = rows<Record<string, unknown>>(await db.execute(sql`select ps.id, ps.device, ps.prefs, ps.created_at as "createdAt", ps.last_sent_at as "lastSentAt",
      ps.endpoint, u.id as "userId", u.name as "userName", u.email as "userEmail", a.id as "accountId", a.name as "accountName",
      (m.push_sale_template is not null) as "customTemplate"
    from push_subscriptions ps join users u on u.id = ps.user_id join accounts a on a.id = ps.account_id
    left join memberships m on m.user_id = ps.user_id and m.account_id = ps.account_id
    where ${q ? sql`(u.name ilike ${like} or u.email ilike ${like} or a.name ilike ${like})` : sql`true`}
    order by ps.created_at desc limit 100`));
  const [t] = rows<{ total: number; users: number; accounts: number; sent24: number }>(await db.execute(sql`select count(*)::int as total, count(distinct user_id)::int as users,
    count(distinct account_id)::int as accounts, count(*) filter (where last_sent_at > now() - interval '24 hours')::int as sent24 from push_subscriptions`));
  const host = (e: unknown) => { try { return new URL(String(e)).host; } catch { return ''; } };
  res.json({
    configured: pushConfigured(), publicKey: config.push.publicKey ? `${config.push.publicKey.slice(0, 12)}…` : null, subject: config.push.subject || null,
    totals: t, devices: devices.map(({ endpoint, ...d }) => ({ ...d, service: /apple/.test(host(endpoint)) ? 'Apple (iPhone/Safari)' : /google|fcm/.test(host(endpoint)) ? 'Google (Chrome/Android)' : /mozilla/.test(host(endpoint)) ? 'Mozilla (Firefox)' : /windows|wns/.test(host(endpoint)) ? 'Microsoft (Edge)' : host(endpoint) })),
  });
}));

const pushTarget = z.object({ target: z.enum(['device', 'user', 'account']), id: z.string().regex(UUID) });

async function targetSubs(t: z.infer<typeof pushTarget>) {
  const col = t.target === 'device' ? schema.pushSubscriptions.id : t.target === 'user' ? schema.pushSubscriptions.userId : schema.pushSubscriptions.accountId;
  return db.select().from(schema.pushSubscriptions).where(eq(col, t.id));
}
async function targetName(t: z.infer<typeof pushTarget>, subs: { accountId: string }[]) {
  const accId = t.target === 'account' ? t.id : subs[0]?.accountId;
  const [a] = accId ? await db.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, accId)).limit(1) : [];
  return a ?? { id: null, name: '—' };
}

/** Notificação livre (título e texto) para um aparelho, todos os aparelhos de uma pessoa ou de uma empresa. */
platformRouter.post('/push/test', asyncHandler(async (req, res) => {
  if (!pushConfigured()) throw new AppError(503, 'Defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no servidor.');
  const d = pushTarget.extend({ title: z.string().trim().min(1).max(120), body: z.string().max(300).default(''), url: z.string().max(300).regex(/^\//).default('/') }).parse(req.body);
  const subs = await targetSubs(d);
  if (!subs.length) throw new AppError(404, 'Nenhum aparelho inscrito nesse destino.');
  const r = await deliverDetailed(subs, { title: d.title, body: d.body, url: d.url, tag: `platform-test-${Date.now()}` });
  const a = await targetName(d, subs);
  await audit(req, a.id, a.name, 'push_test', { target: d.target, devices: subs.length, sent: r.sent, failed: r.failed.length, removed: r.removed, title: d.title });
  res.json({ devices: subs.length, ...r });
}));

/** Simula uma venda aprovada numa empresa: cada pessoa recebe no formato dela, sem criar venda. */
platformRouter.post('/push/simulate-sale', asyncHandler(async (req, res) => {
  if (!pushConfigured()) throw new AppError(503, 'Defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no servidor.');
  const d = z.object({ accountId: z.string().regex(UUID), amount: z.number().min(0).max(1e7).default(47), product: z.string().trim().max(120).default('Ebook Novena'), customer: z.string().trim().max(120).default('Maria Lúcia') }).parse(req.body);
  const [a] = await db.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, d.accountId)).limit(1);
  if (!a) throw new AppError(404, 'Empresa não encontrada');
  const vars = { ...SAMPLE_VARS(a.name), valor: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(d.amount), produto: d.product, cliente: d.customer };
  const r = await pushSaleToAccount(a.id, vars, `platform-sale-${Date.now()}`);
  if (!r.devices) throw new AppError(404, 'Ninguém nesta empresa ativou as notificações de vendas.');
  await audit(req, a.id, a.name, 'push_sale_test', { devices: r.devices, sent: r.sent, failed: r.failed.length, removed: r.removed });
  res.json(r);
}));
