/**
 * O que o cliente faz na tela de cobrança: assinar, mudar instâncias, cancelar e comprar tokens ou disparos.
 * Nada é liberado aqui — instâncias, tokens e disparos só entram quando o gateway confirma o pagamento.
 */
import { and, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { AppError } from '../utils/http';
import {
  DISPATCH_PACKS, MAX_INSTANCES, PER_INSTANCE, PRICING, TOKENS_MAX, TOKENS_MIN, TOKENS_STEP, monthlyPrice, tokensPrice,
} from '../modules/plans';
import * as gw from './gateways';
import {
  agentsInUse, connectionsInUse, createInvoice, describeInstances, dropOpen, ownerOf, patchSub, plural, setAsaasMonthly, subRow, upsertInvoiceByPayment,
  type SubRow,
} from './store';
import { addDaysDate, brDate, prorata, todayBR, validTaxId } from './rules';

export type Country = 'BR' | 'INTL';
export type Gateway = 'asaas' | 'paddle';
export interface Payer { taxId?: string | null; name?: string | null }
export interface CheckoutResult { url: string | null; invoiceId?: string; applied?: boolean; scheduled?: boolean; message?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function needAsaas() {
  if (!gw.asaasConfigured()) throw new AppError(400, 'A cobrança por Pix e cartão (Asaas) ainda não está configurada neste servidor.', { code: 'asaas_off' });
}
function needPaddle(subscriptions = false) {
  if (!(subscriptions ? gw.paddleSubscriptionsConfigured() : gw.paddleConfigured())) {
    throw new AppError(400, 'A cobrança internacional (Paddle) ainda não está configurada neste servidor.', { code: 'paddle_off' });
  }
}

/** Erros do gateway viram resposta da API com a mensagem dele (sem esconder o motivo). */
async function viaGateway<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof gw.GatewayError) throw new AppError(err.status === 400 ? 400 : err.status === 422 ? 422 : 502, err.message, { code: 'gateway_error' });
    throw err;
  }
}

/** Cliente na Asaas (CPF/CNPJ é obrigatório lá). Reaproveita o cadastro quando nada mudou. */
async function asaasCustomerFor(accountId: string, sub: SubRow, payer: Payer): Promise<string> {
  const given = payer.taxId ? validTaxId(payer.taxId) : null;
  if (payer.taxId && !given) throw new AppError(422, 'CPF ou CNPJ inválido. Confira os números.', { code: 'invalid_tax_id' });
  const taxId = given ?? sub.taxId;
  if (!taxId) throw new AppError(422, 'Informe o CPF ou CNPJ de quem paga: a Asaas exige para emitir a cobrança.', { code: 'need_tax_id' });
  const owner = await ownerOf(accountId);
  const name = (payer.name?.trim() || sub.billingName || owner?.name || owner?.account || 'Cliente Converza').slice(0, 120);
  if (sub.gatewayCustomerId && sub.taxId === taxId && sub.billingName === name) return sub.gatewayCustomerId;
  const input = { name, cpfCnpj: taxId, email: owner?.email ?? null, externalReference: accountId };
  const id = await viaGateway(async () => {
    try {
      return await gw.asaasCustomer({ ...input, id: sub.gatewayCustomerId });
    } catch (err) {
      // cadastro antigo apagado no painel da Asaas: cria outro
      if (sub.gatewayCustomerId && err instanceof gw.GatewayError && !err.retryable) return gw.asaasCustomer({ ...input, id: null });
      throw err;
    }
  });
  await patchSub(accountId, { gatewayCustomerId: id, taxId, billingName: name });
  return id;
}

/** A primeira cobrança de uma assinatura nova (a Asaas gera na hora, mas às vezes demora um instante). */
async function firstPayment(subscriptionId: string) {
  for (let i = 0; i < 4; i++) {
    const list = await gw.asaasSubscriptionPayments(subscriptionId);
    const open = list.filter((p) => !['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'REFUNDED'].includes(p.status));
    const p = (open.length ? open : list).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    if (p) return p;
    await sleep(500 * (i + 1));
  }
  return null;
}

/** Números conectados e agentes de IA que já existem precisam caber na quantidade escolhida. */
async function assertFits(accountId: string, n: number, verb: 'reduzir para' | 'assinar com') {
  const [conns, agents] = await Promise.all([connectionsInUse(accountId), agentsInUse(accountId)]);
  if (n < conns) {
    throw new AppError(409, `Você tem ${plural(conns, 'número conectado', 'números conectados')}. Desconecte ${conns - n} antes de ${verb} ${plural(n, 'instância', 'instâncias')}.`, { code: 'instances_in_use', inUse: conns });
  }
  const maxAgents = n * PER_INSTANCE.agents;
  if (agents > maxAgents) {
    throw new AppError(409, `Você tem ${plural(agents, 'agente de IA', 'agentes de IA')} e ${plural(n, 'instância', 'instâncias')} liberam ${maxAgents}. Apague ${agents - maxAgents} antes de ${verb} ${plural(n, 'instância', 'instâncias')}.`, { code: 'agents_in_use', agents });
  }
}

function instanceCount(n: unknown) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > MAX_INSTANCES) throw new AppError(422, `Escolha de 1 a ${MAX_INSTANCES} instâncias.`);
  return v;
}

/** Valor da instância em dólar: o preço do catálogo da Paddle (ou INSTANCE_PRICE_USD, se não der para ler). */
export async function instanceUSD() {
  const id = config.billing.paddle.priceInstance;
  const p = id && config.billing.paddle.apiKey ? await gw.paddlePrice(id) : null;
  return p?.amount ?? PRICING.instanceUSD;
}

/* ------------------------------------------------------------ assinatura */

/**
 * Assinar (ou assinar de novo). Sem assinatura ativa: a primeira mensalidade vence hoje. Com assinatura que não
 * renova (cancelada, mas ainda dentro do período): a nova começa no fim do período já pago.
 */
/** Conta da casa (HOUSE_EMAILS): tudo já está liberado, nada a pagar. */
async function assertNotHouse(accountId: string) {
  const sub = await subRow(accountId);
  if (sub.house) throw new AppError(409, 'Esta é uma conta da casa: tudo já está liberado, sem cobrança.', { code: 'house' });
}

export async function startSubscription(accountId: string, input: { instances: unknown; country: Country; method?: 'pix' | 'card' } & Payer): Promise<CheckoutResult> {
  await assertNotHouse(accountId);
  const n = instanceCount(input.instances);
  const sub = await subRow(accountId);
  const now = new Date();
  if (sub.status === 'active' && !sub.cancelAtPeriodEnd) {
    throw new AppError(409, 'Sua assinatura já está ativa. Para mudar a quantidade, use “Alterar instâncias”.', { code: 'already_active' });
  }
  const continuing = sub.status === 'active' && sub.cancelAtPeriodEnd && !!sub.currentPeriodEnd && sub.currentPeriodEnd > now;
  await assertFits(accountId, n, 'assinar com');

  if (input.country === 'INTL') {
    needPaddle(true);
    // cancelada pela Paddle e ainda no período: desfaz o cancelamento (sem cobrança nova agora)
    if (continuing && sub.gateway === 'paddle' && sub.gatewaySubscriptionId) {
      const id = sub.gatewaySubscriptionId;
      let s = await viaGateway(() => gw.paddleKeep(id));
      if (n !== sub.instances) s = await viaGateway(() => gw.paddleChangeQuantity(id, n));
      await patchSub(accountId, { cancelAtPeriodEnd: false, canceledAt: null, instances: gw.paddleQuantity(s) || n, pendingInstances: null });
      return { url: null, applied: true, message: 'Assinatura reativada. A renovação segue pela Paddle.' };
    }
    const tx = await viaGateway(() => gw.paddleTransaction([{ price_id: config.billing.paddle.priceInstance, quantity: n }], { account_id: accountId, kind: 'subscription' }));
    // checkouts anteriores que ficaram pela metade
    await dropOpen(accountId, ['subscription'], { gateway: 'paddle' });
    const inv = await createInvoice({
      accountId, gateway: 'paddle', gatewayPaymentId: tx.id, kind: 'subscription', description: describeInstances(n),
      amount: (n * (await instanceUSD())).toFixed(2), currency: 'USD', dueDate: todayBR(), invoiceUrl: tx.checkoutUrl, meta: { instances: n },
    });
    return { url: tx.checkoutUrl, invoiceId: inv.id };
  }

  needAsaas();
  const method = input.method === 'card' ? 'card' : 'pix';
  const customer = await asaasCustomerFor(accountId, sub, input);
  const due = continuing ? todayBR(sub.currentPeriodEnd!) : todayBR();
  const created = await viaGateway(() => gw.asaasCreateSubscription({
    customer, method, value: monthlyPrice(n, 'BRL'), nextDueDate: due, description: describeInstances(n), externalReference: accountId,
  }));
  const old = sub.gateway === 'asaas' && sub.gatewaySubscriptionId !== created.id ? sub.gatewaySubscriptionId : null;
  await patchSub(accountId, {
    gateway: 'asaas', gatewaySubscriptionId: created.id, paymentMethod: method, billingCountry: 'BR',
    // quantas instâncias a próxima mensalidade paga libera
    pendingInstances: n,
    ...(continuing ? { cancelAtPeriodEnd: false, canceledAt: null, pendingInstances: n !== sub.instances ? n : null } : {}),
  });
  // uma assinatura antiga ainda esperando o primeiro pagamento (ou atrasada) deixa de valer.
  // (se a antiga era da Paddle e ia acabar, ela acaba no fim do período, como já estava agendado)
  if (old) await gw.asaasDeleteSubscription(old).catch(() => {});
  await dropOpen(accountId, ['subscription', 'instances'], { keepSub: created.id });
  const pay = await viaGateway(() => firstPayment(created.id));
  if (!pay) return { url: null, message: 'A cobrança está sendo gerada pela Asaas. Ela aparece no histórico de faturas em instantes.' };
  const inv = await upsertInvoiceByPayment({
    accountId, gateway: 'asaas', gatewayPaymentId: pay.id, kind: 'subscription', description: describeInstances(n),
    amount: Number(pay.value).toFixed(2), currency: 'BRL', status: 'pending', method, dueDate: pay.dueDate,
    invoiceUrl: pay.invoiceUrl, meta: { instances: n, sub: created.id },
  });
  return {
    url: pay.invoiceUrl, invoiceId: inv.id,
    message: continuing ? `Assinatura reativada. A próxima mensalidade vence em ${brDate(pay.dueDate)}.` : undefined,
  };
}

/** Mais instâncias: paga só o proporcional até o próximo vencimento. Menos: vale na próxima renovação. */
export async function changeInstances(accountId: string, value: unknown): Promise<CheckoutResult & { instances?: number }> {
  await assertNotHouse(accountId);
  const n = instanceCount(value);
  const sub = await subRow(accountId);
  if (sub.status === 'past_due') throw new AppError(409, 'Pague a mensalidade em aberto antes de mudar as instâncias.', { code: 'past_due' });
  if (sub.status !== 'active') throw new AppError(409, 'Você ainda não tem assinatura ativa. Use “Assinar agora”.', { code: 'not_active' });
  if (sub.cancelAtPeriodEnd || !sub.gateway || !sub.gatewaySubscriptionId) {
    throw new AppError(409, 'Esta assinatura não renova. Assine de novo para escolher a quantidade de instâncias.', { code: 'not_renewing' });
  }
  if (n < sub.instances) await assertFits(accountId, n, 'reduzir para');
  const next = sub.pendingInstances ?? sub.instances;
  if (n === sub.instances && n === next) throw new AppError(422, 'Essa já é a quantidade contratada.', { code: 'same' });
  const subId = sub.gatewaySubscriptionId;

  if (sub.gateway === 'paddle') {
    needPaddle(true);
    // a Paddle cobra (ou credita) a diferença proporcional na hora, no cartão salvo
    const s = await viaGateway(() => gw.paddleChangeQuantity(subId, n));
    const q = gw.paddleQuantity(s) || n;
    await patchSub(accountId, { instances: q, pendingInstances: null });
    return { url: null, applied: true, instances: q, message: n > sub.instances ? 'Instâncias liberadas. A Paddle cobrou a diferença proporcional.' : 'Instâncias reduzidas. A diferença vira crédito na próxima fatura da Paddle.' };
  }

  needAsaas();
  // pedido anterior de instâncias que ainda não foi pago deixa de valer
  await dropOpen(accountId, ['instances']);
  if (n > sub.instances) {
    const extra = n - sub.instances;
    const amount = prorata(extra, PRICING.instanceBRL, sub.currentPeriodEnd);
    const until = sub.currentPeriodEnd ? brDate(sub.currentPeriodEnd) : '';
    const description = `+${plural(extra, 'instância', 'instâncias')} (proporcional${until ? ` até ${until}` : ''})`;
    const customer = sub.gatewayCustomerId;
    if (!customer) throw new AppError(409, 'Cadastro de cobrança não encontrado. Assine de novo.', { code: 'no_customer' });
    const pay = await viaGateway(() => gw.asaasCreatePayment({
      customer, method: null, value: amount, dueDate: addDaysDate(todayBR(), 1), description, externalReference: accountId,
    }));
    const inv = await upsertInvoiceByPayment({
      accountId, gateway: 'asaas', gatewayPaymentId: pay.id, kind: 'instances', description, amount: amount.toFixed(2), currency: 'BRL',
      status: 'pending', dueDate: pay.dueDate, invoiceUrl: pay.invoiceUrl, meta: { instances: n, from: sub.instances },
    });
    // uma redução agendada continua valendo até esta fatura ser paga (a mensalidade na Asaas segue a redução)
    return { url: pay.invoiceUrl, invoiceId: inv.id, instances: n };
  }
  // menos instâncias (ou desfazer uma redução agendada): a mensalidade nova vale a partir do próximo vencimento.
  // Primeiro na Asaas: se ela recusar, nada muda aqui.
  await viaGateway(() => setAsaasMonthly(sub, n));
  await patchSub(accountId, { pendingInstances: n === sub.instances ? null : n });
  return {
    url: null, scheduled: n !== sub.instances, instances: n,
    message: n === sub.instances ? 'Redução desfeita. A mensalidade continua a mesma.'
      : `A partir do próximo vencimento (${brDate(sub.currentPeriodEnd)}) você paga ${plural(n, 'instância', 'instâncias')}. Até lá, continua com ${sub.instances}.`,
  };
}

/** Já existe uma mensalidade paga para um mês que ainda não começou, com esta quantidade de instâncias? */
async function paidAheadWith(accountId: string, instances: number | null) {
  if (instances === null) return false;
  const [row] = await db.select({ meta: schema.invoices.meta }).from(schema.invoices)
    .where(and(eq(schema.invoices.accountId, accountId), eq(schema.invoices.kind, 'subscription'), eq(schema.invoices.status, 'paid'),
      gt(schema.invoices.periodStart, new Date()))).limit(1);
  return (row?.meta as { instances?: number } | undefined)?.instances === instances;
}

/** Apaga a assinatura na Asaas; se ela já não existe lá (apagada no painel), segue. */
async function asaasDrop(id: string) {
  await viaGateway(() => gw.asaasDeleteSubscription(id).catch((err) => {
    if (err instanceof gw.GatewayError && !err.retryable && err.status === 422) return null;
    throw err;
  }));
}

/** Cancelar: segue funcionando até o fim do período pago. Com a mensalidade atrasada, acaba na hora. */
export async function cancelSubscription(accountId: string): Promise<CheckoutResult> {
  await assertNotHouse(accountId);
  const sub = await subRow(accountId);
  const now = new Date();
  const subId = sub.gatewaySubscriptionId;
  if (sub.status === 'past_due') {
    if (subId && sub.gateway === 'asaas') await asaasDrop(subId);
    if (subId && sub.gateway === 'paddle') await viaGateway(() => gw.paddleCancel(subId, true));
    await dropOpen(accountId, ['subscription', 'instances']);
    await patchSub(accountId, { status: 'canceled', cancelAtPeriodEnd: false, canceledAt: now, pendingInstances: null });
    return { url: null, message: 'Assinatura cancelada.' };
  }
  if (sub.status !== 'active') throw new AppError(409, 'Não há assinatura ativa para cancelar.', { code: 'not_active' });
  if (sub.cancelAtPeriodEnd) throw new AppError(409, `A assinatura já não renova. Ela vale até ${brDate(sub.currentPeriodEnd)}.`, { code: 'not_renewing' });
  if (subId && sub.gateway === 'asaas') await asaasDrop(subId);
  if (subId && sub.gateway === 'paddle') await viaGateway(() => gw.paddleCancel(subId));
  await dropOpen(accountId, ['subscription', 'instances']);
  // a redução agendada deixa de existir (não há renovação)... a não ser que o mês novo já tenha sido pago
  // adiantado com menos instâncias: aí ela continua valendo quando esse mês começar
  const paidAhead = await paidAheadWith(accountId, sub.pendingInstances);
  await patchSub(accountId, { cancelAtPeriodEnd: true, canceledAt: now, ...(paidAhead ? {} : { pendingInstances: null }) });
  return { url: null, message: `Assinatura cancelada. Tudo continua funcionando até ${brDate(sub.currentPeriodEnd)}.` };
}

/* ------------------------------------------------------------ avulsos */

async function oneOff(accountId: string, gateway: Gateway, o: {
  kind: 'tokens' | 'dispatch'; description: string; amountBRL: number; amountUSD: number; meta: Record<string, unknown>;
} & Payer): Promise<CheckoutResult> {
  if (gateway === 'paddle') {
    needPaddle();
    const tx = await viaGateway(() => gw.paddleTransaction([gw.paddleOneOff(o.description, o.amountUSD)], { account_id: accountId, kind: o.kind }));
    const inv = await createInvoice({
      accountId, gateway: 'paddle', gatewayPaymentId: tx.id, kind: o.kind, description: o.description, amount: o.amountUSD.toFixed(2),
      currency: 'USD', dueDate: todayBR(), invoiceUrl: tx.checkoutUrl, meta: o.meta,
    });
    return { url: tx.checkoutUrl, invoiceId: inv.id };
  }
  needAsaas();
  const sub = await subRow(accountId);
  const customer = await asaasCustomerFor(accountId, sub, o);
  const pay = await viaGateway(() => gw.asaasCreatePayment({
    customer, method: null, value: o.amountBRL, dueDate: addDaysDate(todayBR(), 1), description: o.description, externalReference: accountId,
  }));
  const inv = await upsertInvoiceByPayment({
    accountId, gateway: 'asaas', gatewayPaymentId: pay.id, kind: o.kind, description: o.description, amount: o.amountBRL.toFixed(2),
    currency: 'BRL', status: 'pending', dueDate: pay.dueDate, invoiceUrl: pay.invoiceUrl, meta: o.meta,
  });
  return { url: pay.invoiceUrl, invoiceId: inv.id };
}

/** Tokens de IA: compra avulsa, para a conta inteira (não muda a mensalidade). */
export async function buyTokens(accountId: string, input: { tokens: unknown; gateway: Gateway } & Payer) {
  await assertNotHouse(accountId);
  const t = Number(input.tokens);
  if (!Number.isInteger(t) || t < TOKENS_MIN || t > TOKENS_MAX || t % TOKENS_STEP !== 0) {
    throw new AppError(422, `Escolha de ${plural(TOKENS_MIN, 'token', 'tokens')} a ${plural(TOKENS_MAX, 'token', 'tokens')}, de 1.000 em 1.000.`, { code: 'invalid_tokens' });
  }
  return oneOff(accountId, input.gateway, {
    kind: 'tokens', description: `${plural(t, 'token', 'tokens')} de IA`, amountBRL: tokensPrice(t, 'BRL'), amountUSD: tokensPrice(t, 'USD'),
    meta: { tokens: t }, taxId: input.taxId, name: input.name,
  });
}

/** Pacote de disparos extras (entra no saldo extra e não vence; só vale com a assinatura ativa). */
export async function buyDispatchPack(accountId: string, input: { packId: unknown; gateway: Gateway } & Payer) {
  await assertNotHouse(accountId);
  const pack = DISPATCH_PACKS.find((p) => p.id === input.packId);
  if (!pack) throw new AppError(422, 'Pacote inválido.');
  const sub = await subRow(accountId);
  if (sub.status !== 'active') throw new AppError(403, 'Os disparos extras só valem com a assinatura ativa. Assine primeiro.', { code: 'no_plan' });
  return oneOff(accountId, input.gateway, {
    kind: 'dispatch', description: `Pacote de ${plural(pack.quantity, 'disparo', 'disparos')} extras`,
    amountBRL: pack.price, amountUSD: pack.priceUSD, meta: { packId: pack.id, quantity: pack.quantity }, taxId: input.taxId, name: input.name,
  });
}
