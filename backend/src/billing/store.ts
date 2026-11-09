/**
 * Faturas e assinatura no banco: o que cada pagamento libera (uma vez só, mesmo com aviso repetido),
 * o que um reembolso desfaz, atraso e fim do período.
 */
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { creditTokens, removeTokens } from '../modules/tokens';
import { creditExtraDispatches } from '../modules/dispatchQuota';
import { monthlyPrice } from '../modules/plans';
import {
  GatewayError, asaasCreateSubscription, asaasDeletePayment, asaasDeleteSubscription, asaasUpdateSubscription, paddleCancel,
} from './gateways';
import { periodEndFromDue, todayBR } from './rules';

export type SubRow = typeof schema.subscriptions.$inferSelect;
export type InvRow = typeof schema.invoices.$inferSelect;
type InvInsert = typeof schema.invoices.$inferInsert;
export interface InvoiceMeta {
  instances?: number; from?: number; tokens?: number; packId?: string; quantity?: number;
  /** assinatura da Asaas a que a mensalidade pertence */
  sub?: string;
  /** reembolsos parciais já contados (Paddle) */
  refunds?: string[];
}
export interface PaidInfo { paidAt?: Date | null; method?: string | null; periodStart?: Date | null; periodEnd?: Date | null; gatewaySubscriptionId?: string | null }

export const GRACE_DAYS = 3;
export const OPEN = ['pending', 'overdue'];

export const plural = (n: number, one: string, many: string) => `${new Intl.NumberFormat('pt-BR').format(n)} ${n === 1 ? one : many}`;
export const describeInstances = (n: number) => `Assinatura Converza — ${plural(n, 'instância', 'instâncias')}`;

export async function subRow(accountId: string): Promise<SubRow> {
  await db.insert(schema.subscriptions).values({ accountId }).onConflictDoNothing();
  const [s] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return s;
}

export async function patchSub(accountId: string, patch: Partial<typeof schema.subscriptions.$inferInsert>): Promise<SubRow> {
  const [s] = await db.update(schema.subscriptions).set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.subscriptions.accountId, accountId)).returning();
  if (patch.status) await db.update(schema.accounts).set({ subscriptionStatus: patch.status }).where(eq(schema.accounts.id, accountId));
  emitToAccount(accountId, 'billing:changed', {});
  return s;
}

export async function createInvoice(v: InvInsert): Promise<InvRow> {
  const [row] = await db.insert(schema.invoices).values(v).returning();
  emitToAccount(v.accountId, 'billing:changed', { invoiceId: row.id });
  return row;
}

export async function invoiceByPayment(gateway: string, paymentId: string): Promise<InvRow | null> {
  const [row] = await db.select().from(schema.invoices)
    .where(and(eq(schema.invoices.gateway, gateway), eq(schema.invoices.gatewayPaymentId, paymentId))).limit(1);
  return row ?? null;
}

/**
 * Fatura de uma cobrança do gateway. Se o aviso do gateway chegou antes e já criou a fatura, completa os dados
 * dela (enquanto não foi paga) em vez de criar outra.
 */
export async function upsertInvoiceByPayment(v: InvInsert & { gatewayPaymentId: string }): Promise<InvRow> {
  const [created] = await db.insert(schema.invoices).values(v).onConflictDoNothing().returning();
  let row = created ?? await invoiceByPayment(v.gateway, v.gatewayPaymentId);
  if (!created && row && !row.applied) {
    const { status: _s, applied: _a, accountId: _acc, ...rest } = v;
    [row] = await db.update(schema.invoices).set({ ...rest, meta: { ...(row.meta as InvoiceMeta), ...(v.meta as InvoiceMeta ?? {}) }, updatedAt: new Date() })
      .where(eq(schema.invoices.id, row.id)).returning();
  }
  emitToAccount(v.accountId, 'billing:changed', { invoiceId: row?.id });
  return row!;
}

export async function updateInvoice(id: string, patch: Partial<InvInsert>) {
  const [row] = await db.update(schema.invoices).set({ ...patch, updatedAt: new Date() }).where(eq(schema.invoices.id, id)).returning();
  if (row) emitToAccount(row.accountId, 'billing:changed', { invoiceId: row.id });
  return row;
}

export async function subByGatewayId(gateway: string, id: string): Promise<SubRow | null> {
  const [row] = await db.select().from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.gateway, gateway), eq(schema.subscriptions.gatewaySubscriptionId, id))).limit(1);
  return row ?? null;
}

/** Dono da conta (nome e e-mail vão para o cadastro de cobrança e aparecem em "Informações da conta"). */
export async function ownerOf(accountId: string) {
  const [row] = await db.select({ account: schema.accounts.name, name: schema.users.name, email: schema.users.email })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.memberships.accountId))
    .where(and(eq(schema.memberships.accountId, accountId), eq(schema.memberships.role, 'owner'))).limit(1);
  return row ?? null;
}

export async function connectionsInUse(accountId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.connections).where(eq(schema.connections.accountId, accountId));
  return Number(n);
}

export async function agentsInUse(accountId: string) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.agents).where(eq(schema.agents.accountId, accountId));
  return Number(n);
}

/** Faturas em aberto de certos tipos (a mais recente primeiro). */
export async function openInvoices(accountId: string, kinds: string[]): Promise<InvRow[]> {
  return db.select().from(schema.invoices)
    .where(and(eq(schema.invoices.accountId, accountId), inArray(schema.invoices.kind, kinds), inArray(schema.invoices.status, OPEN)))
    .orderBy(desc(schema.invoices.createdAt));
}

/**
 * Tira do caminho cobranças em aberto que deixaram de valer (o cliente mudou de ideia antes de pagar).
 * `keepSub`: mensalidades desta assinatura da Asaas continuam (são da assinatura nova).
 */
export async function dropOpen(accountId: string, kinds: string[], opts: { keepSub?: string; gateway?: string } = {}) {
  for (const r of await openInvoices(accountId, kinds)) {
    const meta = (r.meta ?? {}) as InvoiceMeta;
    if (opts.keepSub && meta.sub === opts.keepSub) continue;
    if (opts.gateway && r.gateway !== opts.gateway) continue;
    // avulsa da Asaas: apaga lá também, para o link antigo não poder mais ser pago
    if (r.gateway === 'asaas' && r.gatewayPaymentId && r.kind !== 'subscription') await asaasDeletePayment(r.gatewayPaymentId).catch(() => {});
    await markInvoiceCanceled(r);
  }
}

/**
 * Nova mensalidade na Asaas (mais ou menos instâncias). Se a Asaas não aceitar mudar o valor da assinatura,
 * cria outra a partir do próximo vencimento e só depois apaga a antiga — nunca cobra duas vezes o mesmo mês.
 */
export async function setAsaasMonthly(sub: SubRow, instances: number) {
  if (sub.gateway !== 'asaas' || !sub.gatewaySubscriptionId) return;
  const value = monthlyPrice(instances, 'BRL');
  try {
    await asaasUpdateSubscription(sub.gatewaySubscriptionId, { value, description: describeInstances(instances) });
    // a Asaas também muda as mensalidades que já estavam geradas (updatePendingPayments): aqui igual
    for (const r of await openInvoices(sub.accountId, ['subscription'])) {
      if (r.gateway !== 'asaas' || r.applied) continue;
      await updateInvoice(r.id, { amount: value.toFixed(2), description: describeInstances(instances), meta: { ...(r.meta as InvoiceMeta), instances } });
    }
  } catch (err) {
    if (!sub.gatewayCustomerId || (err instanceof GatewayError && err.retryable)) throw err;
    const next = sub.currentPeriodEnd ? todayBR(sub.currentPeriodEnd) : todayBR();
    // a nova primeiro: o aviso de "assinatura apagada" da antiga não pode parecer um cancelamento
    const created = await asaasCreateSubscription({
      customer: sub.gatewayCustomerId, method: sub.paymentMethod ?? 'pix', value, nextDueDate: next,
      description: describeInstances(instances), externalReference: sub.accountId,
    });
    await patchSub(sub.accountId, { gatewaySubscriptionId: created.id });
    await asaasDeleteSubscription(sub.gatewaySubscriptionId).catch(() => {});
    await dropOpen(sub.accountId, ['subscription'], { keepSub: created.id, gateway: 'asaas' });
  }
}

/**
 * Pagamento confirmado: marca a fatura e aplica o que ela libera — uma vez só. Vale mesmo para uma fatura
 * que tínhamos dado como cancelada: se o gateway diz que foi paga, o cliente pagou.
 */
export async function markInvoicePaid(inv: InvRow, info: PaidInfo = {}): Promise<InvRow | null> {
  const now = new Date();
  const [claimed] = await db.update(schema.invoices).set({
    status: 'paid', paidAt: info.paidAt ?? now, method: info.method ?? inv.method, applied: true, updatedAt: now,
  }).where(and(eq(schema.invoices.id, inv.id), eq(schema.invoices.applied, false), ne(schema.invoices.status, 'refunded'))).returning();
  if (!claimed) return null;
  await applyInvoice(claimed, info);
  emitToAccount(inv.accountId, 'billing:changed', { invoiceId: inv.id, paid: true });
  return claimed;
}

async function applyInvoice(inv: InvRow, info: PaidInfo) {
  const meta = (inv.meta ?? {}) as InvoiceMeta;
  const sub = await subRow(inv.accountId);
  if (inv.kind === 'subscription') {
    const due = inv.dueDate ?? todayBR();
    const start = info.periodStart ?? new Date(`${due}T00:00:00-03:00`);
    let end = info.periodEnd ?? periodEndFromDue(due);
    // pagar adiantado nunca encurta o período que já estava pago
    if (sub.status === 'active' && sub.currentPeriodEnd && sub.currentPeriodEnd > end) end = sub.currentPeriodEnd;
    let instances = Math.max(1, sub.pendingInstances ?? meta.instances ?? sub.instances);
    // renovação paga antes do vencimento: uma redução só vale quando o mês novo começar (o atual já foi pago cheio)
    let keepPending: number | null = null;
    if (sub.status === 'active' && start.getTime() > Date.now() + 60_000 && instances < sub.instances) {
      keepPending = instances;
      instances = sub.instances;
    }
    // trocou de gateway (ex.: tentou Pix e acabou pagando pela Paddle): a assinatura antiga não pode cobrar de novo
    if (sub.gateway && sub.gateway !== inv.gateway && sub.gatewaySubscriptionId) {
      if (sub.gateway === 'asaas') await asaasDeleteSubscription(sub.gatewaySubscriptionId).catch(() => {});
      if (sub.gateway === 'paddle') await paddleCancel(sub.gatewaySubscriptionId, true).catch(() => {});
    }
    await db.update(schema.invoices).set({ periodStart: start, periodEnd: end }).where(eq(schema.invoices.id, inv.id));
    await patchSub(inv.accountId, {
      status: 'active', instances, pendingInstances: keepPending, currentPeriodEnd: end, startedAt: sub.startedAt ?? new Date(),
      paymentMethod: info.method ?? sub.paymentMethod, gateway: inv.gateway, billingCountry: inv.gateway === 'paddle' ? 'INTL' : 'BR',
      cancelAtPeriodEnd: false, canceledAt: null,
      ...(info.gatewaySubscriptionId ? { gatewaySubscriptionId: info.gatewaySubscriptionId } : meta.sub ? { gatewaySubscriptionId: meta.sub } : {}),
    });
  } else if (inv.kind === 'instances') {
    const target = Math.max(sub.instances, meta.instances ?? sub.instances);
    const updated = await patchSub(inv.accountId, { instances: target, pendingInstances: null });
    // os próximos meses passam a ser cobrados pelo total novo
    await setAsaasMonthly(updated, target).catch((err) => console.error('[cobrança] mensalidade nova na Asaas:', (err as Error).message));
  } else if (inv.kind === 'tokens') {
    if (meta.tokens) await creditTokens(inv.accountId, meta.tokens);
  } else if (inv.kind === 'dispatch') {
    if (meta.quantity) await creditExtraDispatches(inv.accountId, meta.quantity);
    // import tardio: o executor dos disparos abre a fila (Redis) ao ser carregado
    const { resumeQuotaPaused } = await import('../modules/dispatchRunner');
    await resumeQuotaPaused(inv.accountId);
  }
}

/** Reembolso total: marca a fatura e desfaz o que ela tinha liberado (o que ainda sobra). */
export async function markInvoiceRefunded(inv: InvRow, info: { amount?: number | null; at?: Date | null } = {}): Promise<InvRow | null> {
  const now = new Date();
  const [row] = await db.update(schema.invoices).set({
    status: 'refunded', refundedAt: info.at ?? now, refundAmount: (info.amount || Number(inv.amount)).toFixed(2), updatedAt: now,
  }).where(and(eq(schema.invoices.id, inv.id), ne(schema.invoices.status, 'refunded'))).returning();
  if (!row) return null;
  if (inv.applied) {
    const meta = (inv.meta ?? {}) as InvoiceMeta;
    const sub = await subRow(inv.accountId);
    if (inv.kind === 'tokens') await removeTokens(inv.accountId, meta.tokens ?? 0);
    else if (inv.kind === 'dispatch') {
      await db.execute(sql`update subscriptions set dispatch_extra = greatest(0, dispatch_extra - ${meta.quantity ?? 0}) where account_id = ${inv.accountId}`);
    } else if (inv.kind === 'instances' && meta.from !== undefined) {
      const back = Math.max(1, meta.from);
      const updated = await patchSub(inv.accountId, { instances: back, pendingInstances: null });
      await setAsaasMonthly(updated, back).catch((err) => console.error('[cobrança] mensalidade após reembolso:', (err as Error).message));
    } else if (inv.kind === 'subscription' && sub.status === 'active' && inv.periodEnd && inv.periodEnd > now) {
      // devolveu o mês em curso: a assinatura acaba agora
      if (sub.gateway === 'asaas' && sub.gatewaySubscriptionId) await asaasDeleteSubscription(sub.gatewaySubscriptionId).catch(() => {});
      if (sub.gateway === 'paddle' && sub.gatewaySubscriptionId) await paddleCancel(sub.gatewaySubscriptionId, true).catch(() => {});
      await patchSub(inv.accountId, { status: 'canceled', currentPeriodEnd: now, cancelAtPeriodEnd: false, canceledAt: now, pendingInstances: null });
    }
  }
  emitToAccount(inv.accountId, 'billing:changed', { invoiceId: inv.id, refunded: true });
  return row;
}

/**
 * Reembolso parcial: só registra (fica no histórico de reembolsos); o que a fatura liberou continua.
 * `total` = soma de tudo o que já foi devolvido dela; `add` = mais um reembolso (com id, para não contar duas vezes).
 */
export async function recordPartialRefund(inv: InvRow, r: { total?: number; add?: { id: string; amount: number } }, at = new Date()) {
  const meta = (inv.meta ?? {}) as InvoiceMeta;
  let total = r.total;
  let refunds = meta.refunds ?? [];
  if (r.add) {
    if (refunds.includes(r.add.id)) return inv;
    refunds = [...refunds, r.add.id];
    total = Number(inv.refundAmount ?? 0) + r.add.amount;
  }
  if (!total || total <= 0) return inv;
  return updateInvoice(inv.id, { refundAmount: Math.min(total, Number(inv.amount)).toFixed(2), refundedAt: at, meta: { ...meta, refunds } });
}

/**
 * Venceu sem pagar. A assinatura em si só fica "pagamento pendente" 3 dias depois do fim do período
 * (a verificação de hora em hora cuida disso) — a mesma tolerância para Pix, cartão e Paddle.
 */
export async function markInvoiceOverdue(inv: InvRow) {
  await db.update(schema.invoices).set({ status: 'overdue', updatedAt: new Date() })
    .where(and(eq(schema.invoices.id, inv.id), eq(schema.invoices.status, 'pending')));
  emitToAccount(inv.accountId, 'billing:changed', { invoiceId: inv.id });
}

export async function markInvoiceCanceled(inv: InvRow) {
  await db.update(schema.invoices).set({ status: 'canceled', updatedAt: new Date() })
    .where(and(eq(schema.invoices.id, inv.id), inArray(schema.invoices.status, OPEN)));
  emitToAccount(inv.accountId, 'billing:changed', { invoiceId: inv.id });
}

/** A cada hora: fim do período de quem cancelou e mensalidade não paga 3 dias depois do vencimento. */
export async function billingSweep(now = new Date()) {
  const ending = await db.select({ accountId: schema.subscriptions.accountId }).from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.status, 'active'), eq(schema.subscriptions.house, false), eq(schema.subscriptions.cancelAtPeriodEnd, true), lt(schema.subscriptions.currentPeriodEnd, now)));
  for (const s of ending) await patchSub(s.accountId, { status: 'canceled', pendingInstances: null });
  const late = await db.select({ accountId: schema.subscriptions.accountId }).from(schema.subscriptions)
    .where(and(eq(schema.subscriptions.status, 'active'), eq(schema.subscriptions.house, false), eq(schema.subscriptions.cancelAtPeriodEnd, false),
      lt(schema.subscriptions.currentPeriodEnd, new Date(now.getTime() - GRACE_DAYS * 86_400_000))));
  for (const s of late) await patchSub(s.accountId, { status: 'past_due' });
  // redução agendada + renovação paga adiantada: vale quando o mês que ela pagou começa
  const reduced = await db.execute(sql`
    update subscriptions s set instances = s.pending_instances, pending_instances = null, updated_at = now()
    from invoices i
    where i.account_id = s.account_id and i.kind = 'subscription' and i.status = 'paid' and i.applied
      and s.status = 'active' and s.pending_instances is not null and s.pending_instances < s.instances
      and i.period_start <= ${now} and i.period_end > ${now} and i.paid_at < i.period_start
      and (i.meta->>'instances')::int = s.pending_instances
    returning s.account_id`);
  for (const r of reduced.rows as { account_id: string }[]) emitToAccount(r.account_id, 'billing:changed', {});
  return { canceled: ending.length, pastDue: late.length, reduced: reduced.rows.length };
}

/** Avisos dos gateways que falharam (ou ficaram pela metade) nos últimos 3 dias: tentar de novo. */
export async function failedEvents(now = new Date()) {
  return db.select().from(schema.billingEvents).where(and(
    lt(schema.billingEvents.createdAt, new Date(now.getTime() - 60_000)),
    sql`${schema.billingEvents.createdAt} > ${new Date(now.getTime() - 3 * 86_400_000)}`,
    or(sql`${schema.billingEvents.error} is not null`, isNull(schema.billingEvents.processedAt)),
  )).limit(200);
}
