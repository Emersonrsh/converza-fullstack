/**
 * Avisos dos gateways (públicos, sem login): a Asaas se identifica pelo token do webhook e a Paddle pela
 * assinatura HMAC do corpo. Cada aviso é processado uma vez só; os que falham são tentados de novo.
 */
import { Router, type Request } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler } from '../utils/http';
import * as gw from './gateways';
import { syncHouseAccounts } from './house';
import {
  billingSweep, createInvoice, describeInstances, failedEvents, invoiceByPayment, markInvoiceCanceled, markInvoiceOverdue, markInvoicePaid,
  markInvoiceRefunded, patchSub, plural, recordPartialRefund, subByGatewayId, updateInvoice, upsertInvoiceByPayment, type InvoiceMeta,
} from './store';
import { todayBR } from './rules';

export const billingHooksRouter = Router();

/* ------------------------------------------------------------ fila de avisos */

/** Guarda o aviso. false = já foi processado (ou está sendo agora) — não processa de novo. */
async function claimEvent(id: string, gateway: string, type: string, payload: unknown): Promise<boolean> {
  const [fresh] = await db.insert(schema.billingEvents).values({ id, gateway, type, payload: payload as object })
    .onConflictDoNothing().returning({ id: schema.billingEvents.id });
  if (fresh) return true;
  // repetido: só processa de novo se a tentativa anterior falhou
  const [again] = await db.update(schema.billingEvents).set({ error: null })
    .where(sql`${schema.billingEvents.id} = ${id} and ${schema.billingEvents.error} is not null`).returning({ id: schema.billingEvents.id });
  return !!again;
}

async function finishEvent(id: string, err?: unknown) {
  await db.update(schema.billingEvents).set(err
    ? { error: (err as Error).message?.slice(0, 500) || String(err), processedAt: null }
    : { error: null, processedAt: new Date() }).where(eq(schema.billingEvents.id, id));
}

async function runEvent(id: string, gateway: string, payload: unknown) {
  try {
    if (gateway === 'asaas') await handleAsaas(payload as AsaasEvent);
    else await handlePaddle(payload as PaddleEvent);
    await finishEvent(id);
    return true;
  } catch (err) {
    console.error(`[cobrança] aviso ${id}:`, (err as Error).message);
    await finishEvent(id, err);
    return false;
  }
}

/** Processa e, se falhar (ex.: o aviso chegou antes da fatura ser gravada), tenta de novo em 20 s. */
async function processNow(id: string, gateway: string, payload: unknown) {
  if (!(await runEvent(id, gateway, payload))) {
    setTimeout(() => { reprocess(id).catch(() => {}); }, 20_000).unref();
  }
}

async function reprocess(id: string) {
  const [ev] = await db.select().from(schema.billingEvents).where(eq(schema.billingEvents.id, id)).limit(1);
  if (!ev || ev.processedAt) return;
  await runEvent(ev.id, ev.gateway, ev.payload);
}

/** De hora em hora: avisos que falharam nos últimos 3 dias. */
export async function retryFailedEvents() {
  let ok = 0;
  for (const ev of await failedEvents()) if (await runEvent(ev.id, ev.gateway, ev.payload)) ok++;
  return ok;
}

/** Fim de período, atraso e avisos que falharam: logo depois de subir e depois a cada hora. */
export function startBillingJobs() {
  const run = async () => {
    try {
      // conta da casa primeiro (HOUSE_EMAILS): renova o mês e libera as empresas novas do operador
      await syncHouseAccounts();
      await billingSweep();
      await retryFailedEvents();
    } catch (err) {
      console.error('[cobrança] verificação periódica:', (err as Error).message);
    }
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, 60 * 60_000).unref();
}

/* ------------------------------------------------------------ Asaas */

interface AsaasEvent {
  id?: string; event: string; dateCreated?: string;
  payment?: gw.AsaasPayment & { originalValue?: number | null; transactionReceiptUrl?: string | null };
  subscription?: { id: string; status?: string; deleted?: boolean };
}

/** "2026-11-07 14:03:11" (horário de Brasília) → Date */
const asaasTime = (s?: string | null) => {
  if (!s) return new Date();
  const d = new Date(/T/.test(s) ? s : `${s.replace(' ', 'T')}${s.length <= 10 ? 'T12:00:00' : ''}-03:00`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

const ASAAS_PAID = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
const ASAAS_REFUND = ['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'];

billingHooksRouter.post('/asaas', asyncHandler(async (req, res) => {
  if (!config.billing.asaas.webhookToken) return res.status(503).json({ error: 'ASAAS_WEBHOOK_TOKEN não configurado no servidor' });
  if (!gw.asaasTokenOk(req.get('asaas-access-token'))) return res.status(401).json({ error: 'Token do webhook inválido' });
  const body = req.body as AsaasEvent;
  if (!body?.event) return res.status(400).json({ error: 'Aviso sem evento' });
  const ref = body.payment?.id ?? body.subscription?.id ?? 'x';
  const id = `asaas:${body.id ?? `${body.event}:${ref}:${body.dateCreated ?? ''}`}`;
  if (await claimEvent(id, 'asaas', body.event, body)) await processNow(id, 'asaas', body);
  // a Asaas só precisa saber que recebemos; falhas são tentadas de novo por aqui
  res.json({ received: true });
}));

async function handleAsaas(body: AsaasEvent) {
  const ev = body.event;
  const p = body.payment;
  if (p?.id) {
    let inv = await invoiceByPayment('asaas', p.id);
    if (!inv && p.subscription && ev !== 'PAYMENT_DELETED') {
      // mensalidade nova gerada pela própria Asaas (renovação): vira fatura aqui
      const sub = await subByGatewayId('asaas', p.subscription);
      if (sub) {
        const n = (sub.pendingInstances ?? sub.instances) || 1;
        inv = await upsertInvoiceByPayment({
          accountId: sub.accountId, gateway: 'asaas', gatewayPaymentId: p.id, kind: 'subscription', description: describeInstances(n),
          amount: Number(p.value).toFixed(2), currency: 'BRL', status: 'pending', method: gw.methodFromAsaas(p.billingType),
          dueDate: p.dueDate, invoiceUrl: p.invoiceUrl, meta: { instances: n, sub: p.subscription },
        });
      }
    }
    if (!inv) {
      // cobrança que não é nossa (ex.: criada à mão no painel) ou que ainda não foi gravada
      if (ASAAS_PAID.includes(ev) || ASAAS_REFUND.includes(ev)) {
        if (p.externalReference || p.subscription) throw new Error(`Cobrança ${p.id} ainda não registrada aqui`);
      }
      return;
    }
    switch (ev) {
      case 'PAYMENT_CREATED':
      case 'PAYMENT_UPDATED':
        if (!inv.applied && ['pending', 'overdue'].includes(inv.status)) {
          let meta = inv.meta as InvoiceMeta;
          let description = inv.description;
          if (inv.kind === 'subscription') {
            // mensalidade: a quantidade é a que vale para o próximo mês (redução ou aumento já combinados)
            const sub = p.subscription ? await subByGatewayId('asaas', p.subscription) : null;
            if (sub) {
              const n = (sub.pendingInstances ?? sub.instances) || meta.instances || 1;
              meta = { ...meta, instances: n };
              description = describeInstances(n);
            }
          }
          await updateInvoice(inv.id, {
            amount: Number(p.value).toFixed(2), dueDate: p.dueDate, invoiceUrl: p.invoiceUrl ?? inv.invoiceUrl,
            method: gw.methodFromAsaas(p.billingType) ?? inv.method, meta, description,
          });
        }
        break;
      case 'PAYMENT_CONFIRMED':
      case 'PAYMENT_RECEIVED':
        await markInvoicePaid(inv, { paidAt: asaasTime(p.confirmedDate ?? p.paymentDate ?? body.dateCreated), method: gw.methodFromAsaas(p.billingType) });
        break;
      case 'PAYMENT_OVERDUE':
        await markInvoiceOverdue(inv);
        break;
      case 'PAYMENT_REFUNDED':
      case 'PAYMENT_CHARGEBACK_REQUESTED': {
        const refunded = (p.refunds ?? []).reduce((s, r) => s + (Number(r.value) || 0), 0);
        await markInvoiceRefunded(inv, { amount: refunded || Number(p.value), at: asaasTime(body.dateCreated) });
        break;
      }
      case 'PAYMENT_PARTIALLY_REFUNDED': {
        const refunded = (p.refunds ?? []).reduce((s, r) => s + (Number(r.value) || 0), 0);
        if (refunded > 0) await recordPartialRefund(inv, { total: refunded }, asaasTime(body.dateCreated));
        break;
      }
      case 'PAYMENT_DELETED':
        await markInvoiceCanceled(inv);
        break;
      case 'PAYMENT_RESTORED':
        if (inv.status === 'canceled') await updateInvoice(inv.id, { status: 'pending' });
        break;
      default:
        break;
    }
    return;
  }
  // assinatura apagada ou desativada no painel da Asaas: não renova mais (vale até o fim do período pago)
  if (body.subscription?.id && (ev === 'SUBSCRIPTION_DELETED' || ev === 'SUBSCRIPTION_INACTIVATED')) {
    const sub = await subByGatewayId('asaas', body.subscription.id);
    if (sub && sub.status === 'active' && !sub.cancelAtPeriodEnd) {
      await patchSub(sub.accountId, { cancelAtPeriodEnd: true, canceledAt: new Date(), pendingInstances: null });
    }
  }
}

/* ------------------------------------------------------------ Paddle */

interface PaddleTx {
  id: string; status: string; origin?: string; subscription_id?: string | null; currency_code?: string;
  custom_data?: Record<string, string> | null;
  items?: { quantity: number; price?: { id?: string } }[];
  details?: { totals?: { grand_total?: string; total?: string; subtotal?: string } };
  payments?: { status?: string; method_details?: { type?: string } }[];
  billing_period?: { starts_at: string; ends_at: string } | null;
}
interface PaddleAdjustment {
  id: string; action: string; status: string; type?: string; transaction_id: string; subscription_id?: string | null;
  totals?: { total?: string; currency_code?: string };
}
interface PaddleEvent { event_id: string; event_type: string; occurred_at?: string; data: Record<string, unknown> }

billingHooksRouter.post('/paddle', asyncHandler(async (req, res) => {
  if (!config.billing.paddle.webhookSecret) return res.status(503).json({ error: 'PADDLE_WEBHOOK_SECRET não configurado no servidor' });
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!gw.paddleSignatureOk(raw, req.get('paddle-signature'))) return res.status(401).json({ error: 'Assinatura inválida' });
  const body = req.body as PaddleEvent;
  if (!body?.event_id || !body.event_type) return res.status(400).json({ error: 'Aviso inválido' });
  const id = `paddle:${body.event_id}`;
  if (await claimEvent(id, 'paddle', body.event_type, body)) await processNow(id, 'paddle', body);
  res.json({ received: true });
}));

/** Dados da Paddle.js para a página de pagamento (o token do cliente é público por natureza). */
billingHooksRouter.get('/paddle-config', (_req, res) => {
  res.json({
    enabled: gw.paddleConfigured(),
    clientToken: gw.paddleConfigured() ? config.billing.paddle.clientToken : null,
    environment: config.billing.paddle.environment,
  });
});

const cents = (s?: string | null) => (Number(s) || 0) / 100;
const paddleMethod = (t: PaddleTx) => {
  const type = t.payments?.find((p) => p.status === 'captured')?.method_details?.type ?? t.payments?.[0]?.method_details?.type;
  return type ? (type === 'card' ? 'card' : type) : null;
};

async function handlePaddle(body: PaddleEvent) {
  const type = body.event_type;
  if (type === 'transaction.completed') return paddleTransactionDone(body.data as unknown as PaddleTx);
  if (type.startsWith('subscription.')) return syncPaddleSubscription(String(body.data.id));
  if (type === 'adjustment.created' || type === 'adjustment.updated') return paddleAdjustment(body.data as unknown as PaddleAdjustment);
}

async function paddleTransactionDone(t: PaddleTx) {
  const total = cents(t.details?.totals?.grand_total ?? t.details?.totals?.total);
  const currency = t.currency_code ?? 'USD';
  const method = paddleMethod(t);
  const qty = (t.items ?? []).reduce((n, it) => n + (Number(it.quantity) || 0), 0);
  let inv = await invoiceByPayment('paddle', t.id);
  if (!inv && t.subscription_id) {
    const sub = await subByGatewayId('paddle', t.subscription_id);
    if (!sub) throw new Error(`Assinatura da Paddle ${t.subscription_id} desconhecida`);
    if (t.origin === 'subscription_update') {
      // diferença proporcional de uma mudança de instâncias (a quantidade já foi aplicada na hora)
      if (total > 0) {
        await createInvoice({
          accountId: sub.accountId, gateway: 'paddle', gatewayPaymentId: t.id, kind: 'instances',
          description: `Ajuste proporcional — ${plural(qty || sub.instances, 'instância', 'instâncias')}`, amount: total.toFixed(2), currency,
          status: 'paid', method, dueDate: todayBR(), paidAt: new Date(), applied: true, meta: { instances: qty || sub.instances },
        });
      }
      return;
    }
    if (total <= 0) return;
    const n = qty || sub.instances || 1;
    inv = await createInvoice({
      accountId: sub.accountId, gateway: 'paddle', gatewayPaymentId: t.id, kind: 'subscription', description: describeInstances(n),
      amount: total.toFixed(2), currency, status: 'pending', method, dueDate: todayBR(), meta: { instances: n },
    });
  }
  if (!inv) throw new Error(`Transação da Paddle ${t.id} desconhecida`);
  // o valor cobrado de verdade (com impostos) é o da Paddle
  if (!inv.applied) {
    inv = (await updateInvoice(inv.id, { amount: total > 0 ? total.toFixed(2) : inv.amount, currency, invoiceUrl: null })) ?? inv;
    if (inv.kind === 'subscription' && qty) inv = (await updateInvoice(inv.id, { meta: { ...(inv.meta as InvoiceMeta), instances: qty } })) ?? inv;
  }
  await markInvoicePaid(inv, {
    method,
    periodStart: t.billing_period ? new Date(t.billing_period.starts_at) : null,
    periodEnd: t.billing_period ? new Date(t.billing_period.ends_at) : null,
    gatewaySubscriptionId: t.subscription_id ?? null,
  });
}

/** Estado atual da assinatura na Paddle (lido de lá: avisos podem chegar fora de ordem). */
async function syncPaddleSubscription(id: string) {
  const sub = await subByGatewayId('paddle', id);
  if (!sub) return; // ainda não ligada a uma conta: o aviso do pagamento faz isso
  const s = await gw.paddleSubscription(id);
  const qty = gw.paddleQuantity(s);
  const status = s.status === 'active' || s.status === 'trialing' ? 'active'
    : s.status === 'past_due' || s.status === 'paused' ? 'past_due'
      : s.status === 'canceled' ? 'canceled' : sub.status;
  const scheduledCancel = s.scheduled_change?.action === 'cancel';
  await patchSub(sub.accountId, {
    status,
    ...(qty ? { instances: qty } : {}),
    ...(status === 'active' && s.current_billing_period?.ends_at ? { currentPeriodEnd: new Date(s.current_billing_period.ends_at) } : {}),
    cancelAtPeriodEnd: status === 'active' && scheduledCancel,
    ...(scheduledCancel && !sub.canceledAt ? { canceledAt: new Date() } : {}),
    ...(status === 'canceled' ? { canceledAt: s.canceled_at ? new Date(s.canceled_at) : sub.canceledAt ?? new Date(), pendingInstances: null } : {}),
    ...(status === 'active' && !scheduledCancel ? { canceledAt: null } : {}),
  });
}

async function paddleAdjustment(a: PaddleAdjustment) {
  if (!['refund', 'chargeback'].includes(a.action) || a.status !== 'approved') return;
  const inv = await invoiceByPayment('paddle', a.transaction_id);
  if (!inv) throw new Error(`Transação ${a.transaction_id} do reembolso desconhecida`);
  const amount = cents(a.totals?.total);
  if (a.type === 'full' || a.action === 'chargeback' || amount >= Number(inv.amount) - 0.005) await markInvoiceRefunded(inv, { amount });
  else await recordPartialRefund(inv, { add: { id: a.id, amount } });
}
