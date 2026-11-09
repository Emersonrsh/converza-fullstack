/**
 * Cobranças e assinaturas: resumo da conta, assinar/mudar/cancelar, compras avulsas e histórico de faturas.
 * As ações só abrem a cobrança no gateway; o que foi comprado entra quando o pagamento é confirmado.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, ilike, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { AppError, asyncHandler } from '../utils/http';
import { notSupport } from '../auth/middleware';
import { DISPATCH_PACKS, MAX_INSTANCES, PER_INSTANCE, PRICING, TOKENS_MAX, TOKENS_MIN, TOKENS_STEP } from './plans';
import { getTokenState } from './tokens';
import { asaasConfigured, paddleConfigured, paddleInvoicePdf, paddleSubscriptionsConfigured, GatewayError } from '../billing/gateways';
import { connectionsInUse, openInvoices, ownerOf, subRow, type InvRow } from '../billing/store';
import { buyDispatchPack, buyTokens, cancelSubscription, changeInstances, instanceUSD, startSubscription } from '../billing/checkout';
import { maskTaxId, statusInfo } from '../billing/rules';

export const billingRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores da conta mexem na cobrança.', { code: 'manager_only' });
}
/** Pagar e mudar a assinatura: só gente da própria empresa (o suporte com acesso temporário só olha). */
function payer(req: Request) {
  managerOnly(req);
  notSupport(req, 'Pagar ou mudar a assinatura');
}

function parse<S extends z.ZodTypeAny>(s: S, body: unknown): z.infer<S> {
  const r = s.safeParse(body);
  if (!r.success) throw new AppError(422, r.error.issues[0]?.message ?? 'Dados inválidos');
  return r.data;
}

/** Fatura para a tela (sem ids dos gateways). */
function publicInvoice(i: InvRow) {
  return {
    id: i.id, number: i.number, kind: i.kind, description: i.description, amount: Number(i.amount), currency: i.currency,
    status: i.status, method: i.method, gateway: i.gateway, dueDate: i.dueDate, paidAt: i.paidAt, createdAt: i.createdAt,
    refundedAt: i.refundedAt, refundAmount: i.refundAmount === null ? null : Number(i.refundAmount),
    periodStart: i.periodStart, periodEnd: i.periodEnd,
    // pagar (em aberto) ou ver o comprovante/fatura (paga)
    hasLink: i.gateway === 'paddle' ? !!i.paidAt : !!i.invoiceUrl,
  };
}

/** Checkout da Paddle que nunca foi concluído não é fatura: não aparece no histórico. */
const visible = (accountId: string) => and(
  eq(schema.invoices.accountId, accountId),
  sql`not (${schema.invoices.gateway} = 'paddle' and ${schema.invoices.paidAt} is null)`,
);

/* ------------------------------------------------------------ leitura */

billingRouter.get('/summary', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const canEdit = req.role !== 'agent';
  const [sub, owner, inUse, tokens, usd, [account]] = await Promise.all([
    subRow(accountId), ownerOf(accountId), connectionsInUse(accountId), getTokenState(accountId), instanceUSD(),
    db.select({ number: schema.accounts.number, name: schema.accounts.name, createdAt: schema.accounts.createdAt })
      .from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1),
  ]);
  const open = (await openInvoices(accountId, ['subscription', 'instances'])).filter((i) => i.gateway === 'asaas');
  const firstOpen = open.find((i) => i.kind === 'subscription');
  const info = statusInfo(sub, sub.status !== 'active' && !!firstOpen);
  const active = sub.status === 'active';
  const renewing = active && !sub.cancelAtPeriodEnd;
  const currency = sub.billingCountry === 'INTL' ? 'USD' : 'BRL';
  const unit = currency === 'USD' ? usd : PRICING.instanceBRL;
  const contracted = active ? sub.instances : 0;
  const nextCount = sub.pendingInstances ?? sub.instances;
  const recent = canEdit
    ? await db.select().from(schema.invoices).where(visible(accountId)).orderBy(desc(schema.invoices.createdAt)).limit(5)
    : [];
  // quando a quantidade agendada passa a valer: no fim do período atual ou, se a renovação já foi paga
  // adiantada com a quantidade nova, quando esse mês pago começar
  let pendingFrom = sub.currentPeriodEnd;
  if (sub.pendingInstances !== null && active) {
    const [early] = await db.select({ start: schema.invoices.periodStart, meta: schema.invoices.meta }).from(schema.invoices)
      .where(and(eq(schema.invoices.accountId, accountId), eq(schema.invoices.kind, 'subscription'), eq(schema.invoices.status, 'paid'),
        gte(schema.invoices.periodStart, new Date()))).orderBy(desc(schema.invoices.periodStart)).limit(1);
    if (early?.start && (early.meta as { instances?: number })?.instances === sub.pendingInstances) pendingFrom = early.start;
  }
  res.json({
    status: info,
    subscription: {
      status: sub.status, instances: contracted, inUse, free: Math.max(0, contracted - inUse),
      // quantas a próxima mensalidade paga libera (redução agendada ou primeira assinatura aguardando pagamento)
      pendingInstances: sub.pendingInstances, pendingFrom, nextInstances: renewing ? nextCount : null,
      monthly: renewing ? Math.round(nextCount * unit * 100) / 100 : 0,
      currentMonthly: active ? Math.round(contracted * unit * 100) / 100 : 0,
      currency, unitPrice: unit, startedAt: sub.startedAt, currentPeriodEnd: sub.currentPeriodEnd,
      nextDueDate: renewing ? sub.currentPeriodEnd : null,
      paymentMethod: sub.paymentMethod, billingCountry: sub.billingCountry, gateway: sub.gateway,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd, canceledAt: sub.canceledAt,
      renewing, canChange: renewing && !!sub.gatewaySubscriptionId,
      taxId: canEdit ? maskTaxId(sub.taxId) : null, billingName: canEdit ? sub.billingName : null, hasTaxId: !!sub.taxId,
    },
    openInvoices: canEdit ? open.map(publicInvoice) : [],
    tokens: { balance: tokens.balance, used: tokens.used, lastPurchaseAt: tokens.lastPurchaseAt },
    // conta da casa (HOUSE_EMAILS): sem cobrança e sem desconto de tokens
    house: !!sub.house,
    account: {
      number: account?.number ?? null, name: account?.name ?? '', createdAt: account?.createdAt ?? null,
      ownerName: owner?.name ?? null, ownerEmail: canEdit ? owner?.email ?? null : null,
    },
    invoices: recent.map(publicInvoice),
    gateways: { asaas: asaasConfigured(), paddle: paddleConfigured(), paddleSubscriptions: paddleSubscriptionsConfigured() },
    pricing: {
      instanceBRL: PRICING.instanceBRL, instanceUSD: usd, tokensPer1000BRL: PRICING.tokensPer1000BRL, tokensPer1000USD: PRICING.tokensPer1000USD,
      tokensMin: TOKENS_MIN, tokensMax: TOKENS_MAX, tokensStep: TOKENS_STEP, maxInstances: MAX_INSTANCES, perInstance: PER_INSTANCE,
    },
    dispatchPacks: DISPATCH_PACKS,
    supportUrl: config.billing.supportUrl || null,
    canEdit,
  });
}));

/** Situação da assinatura (avisos do Dashboard e das outras telas). */
billingRouter.get('/subscription', asyncHandler(async (req, res) => {
  const sub = await subRow(req.accountId!);
  res.json({
    subscription: {
      status: sub.status, instances: sub.status === 'active' ? sub.instances : 0, currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    },
  });
}));

/** Saldo de tokens de IA (topo da tela). */
billingRouter.get('/tokens', asyncHandler(async (req, res) => {
  res.json(await getTokenState(req.accountId!));
}));

const listQuery = z.object({
  status: z.enum(['all', 'paid', 'open', 'overdue', 'refunded', 'canceled']).default('all'),
  kind: z.enum(['all', 'subscription', 'instances', 'tokens', 'dispatch']).default('all'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

function periodFilter(from?: string, to?: string, col: typeof schema.invoices.createdAt | typeof schema.invoices.refundedAt = schema.invoices.createdAt): SQL[] {
  const out: SQL[] = [];
  if (from) out.push(gte(col, new Date(`${from}T00:00:00-03:00`)));
  if (to) out.push(lte(col, new Date(`${to}T23:59:59.999-03:00`)));
  return out;
}

function searchFilter(q?: string): SQL[] {
  const term = q?.trim().replace(/^#/, '');
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return [or(ilike(schema.invoices.description, like), sql`${schema.invoices.number}::text = ${term}`)!];
}

const PAGE = 20;

billingRouter.get('/invoices', asyncHandler(async (req, res) => {
  managerOnly(req);
  const q = parse(listQuery, req.query);
  const where: SQL[] = [visible(req.accountId!)!, ...periodFilter(q.from, q.to), ...searchFilter(q.q)];
  if (q.status === 'open') where.push(eq(schema.invoices.status, 'pending'));
  else if (q.status !== 'all') where.push(eq(schema.invoices.status, q.status));
  if (q.kind !== 'all') where.push(eq(schema.invoices.kind, q.kind));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(schema.invoices).where(and(...where)).orderBy(desc(schema.invoices.createdAt)).limit(PAGE).offset((q.page - 1) * PAGE),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(and(...where)),
  ]);
  res.json({ invoices: rows.map(publicInvoice), total: Number(n), page: q.page, pageSize: PAGE });
}));

billingRouter.get('/refunds', asyncHandler(async (req, res) => {
  managerOnly(req);
  const q = parse(listQuery, req.query);
  const where: SQL[] = [visible(req.accountId!)!, isNotNull(schema.invoices.refundedAt), ...periodFilter(q.from, q.to, schema.invoices.refundedAt), ...searchFilter(q.q)];
  if (q.kind !== 'all') where.push(eq(schema.invoices.kind, q.kind));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(schema.invoices).where(and(...where)).orderBy(desc(schema.invoices.refundedAt)).limit(PAGE).offset((q.page - 1) * PAGE),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.invoices).where(and(...where)),
  ]);
  res.json({ refunds: rows.map(publicInvoice), total: Number(n), page: q.page, pageSize: PAGE });
}));

/** Link para pagar a fatura (em aberto) ou ver o comprovante / PDF (paga). */
billingRouter.get('/invoices/:id/link', asyncHandler(async (req, res) => {
  managerOnly(req);
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(404, 'Fatura não encontrada');
  const [inv] = await db.select().from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.accountId, req.accountId!), ne(schema.invoices.status, 'canceled'))).limit(1);
  if (!inv) throw new AppError(404, 'Fatura não encontrada');
  if (inv.gateway === 'paddle') {
    if (!inv.paidAt || !inv.gatewayPaymentId) throw new AppError(404, 'Esta compra pela Paddle não foi concluída.');
    try {
      const url = await paddleInvoicePdf(inv.gatewayPaymentId);
      if (!url) throw new AppError(502, 'A Paddle não devolveu o PDF da fatura. Tente de novo em instantes.');
      return res.json({ url });
    } catch (err) {
      if (err instanceof GatewayError) throw new AppError(502, err.message);
      throw err;
    }
  }
  if (!inv.invoiceUrl) throw new AppError(404, 'A Asaas não informou o link desta fatura.');
  res.json({ url: inv.invoiceUrl });
}));

/* ------------------------------------------------------------ ações */

const payerFields = {
  taxId: z.string().max(20).optional().nullable(),
  name: z.string().max(120).optional().nullable(),
};

billingRouter.post('/subscribe', asyncHandler(async (req, res) => {
  payer(req);
  const b = parse(z.object({
    instances: z.number({ invalid_type_error: 'Escolha a quantidade de instâncias' }).int().min(1, 'Escolha pelo menos 1 instância').max(MAX_INSTANCES),
    country: z.enum(['BR', 'INTL'], { errorMap: () => ({ message: 'Escolha o país de cobrança' }) }),
    method: z.enum(['pix', 'card']).optional(),
    ...payerFields,
  }), req.body);
  res.json(await startSubscription(req.accountId!, b));
}));

billingRouter.post('/instances', asyncHandler(async (req, res) => {
  payer(req);
  const b = parse(z.object({ instances: z.number().int().min(1, 'Escolha pelo menos 1 instância').max(MAX_INSTANCES) }), req.body);
  res.json(await changeInstances(req.accountId!, b.instances));
}));

billingRouter.post('/cancel', asyncHandler(async (req, res) => {
  payer(req);
  res.json(await cancelSubscription(req.accountId!));
}));

billingRouter.post('/tokens', asyncHandler(async (req, res) => {
  payer(req);
  const b = parse(z.object({
    tokens: z.number({ invalid_type_error: 'Informe a quantidade de tokens' }).int(),
    gateway: z.enum(['asaas', 'paddle']),
    ...payerFields,
  }), req.body);
  res.json(await buyTokens(req.accountId!, b));
}));

billingRouter.post('/dispatch', asyncHandler(async (req, res) => {
  payer(req);
  const b = parse(z.object({ packId: z.string(), gateway: z.enum(['asaas', 'paddle']), ...payerFields }), req.body);
  res.json(await buyDispatchPack(req.accountId!, b));
}));
