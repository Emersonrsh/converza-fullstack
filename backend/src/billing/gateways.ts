/**
 * Clientes da Asaas (Pix, cartão e boleto no Brasil) e da Paddle (internacional).
 * O cliente paga na página segura de cada um: os dados do cartão nunca passam pelo Converza.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

export class GatewayError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status = 502, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export const asaasConfigured = () => Boolean(config.billing.asaas.apiKey);
export const paddleConfigured = () => Boolean(config.billing.paddle.apiKey && config.billing.paddle.clientToken);
export const paddleSubscriptionsConfigured = () => paddleConfigured() && Boolean(config.billing.paddle.priceInstance);

/* ------------------------------------------------------------------ Asaas */

export interface AsaasPayment {
  id: string; status: string; value: number; dueDate: string; invoiceUrl: string | null; billingType: string;
  subscription?: string | null; externalReference?: string | null; paymentDate?: string | null; confirmedDate?: string | null;
  refunds?: { value?: number; status?: string }[] | null;
}

async function asaas<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', body?: unknown): Promise<T> {
  if (!asaasConfigured()) throw new GatewayError('A cobrança pela Asaas não está configurada no servidor (ASAAS_API_KEY).', 400);
  let resp: Response;
  try {
    resp = await fetch(`${config.billing.asaas.apiBase}/${path.replace(/^\/+/, '')}`, {
      method,
      headers: {
        access_token: config.billing.asaas.apiKey,
        'Content-Type': 'application/json',
        // a Asaas exige um User-Agent nas chamadas
        'User-Agent': 'Converza/1.0',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    throw new GatewayError(`Sem conexão com a Asaas (${(err as Error).message}). Tente de novo.`, 502, true);
  }
  const data = await resp.json().catch(() => ({})) as { errors?: { code?: string; description?: string }[] };
  if (!resp.ok) {
    const msg = data.errors?.map((e) => e.description).filter(Boolean).join(' ') || `HTTP ${resp.status}`;
    if (resp.status === 401) throw new GatewayError('A Asaas recusou a chave da API (ASAAS_API_KEY). Confira a chave e o ambiente (sandbox ou produção).', 502);
    throw new GatewayError(`A Asaas recusou: ${msg}`, resp.status >= 500 ? 502 : 422, resp.status >= 500);
  }
  return data as T;
}

export const asaasBillingType = (m: string | null | undefined) => (m === 'pix' ? 'PIX' : m === 'card' ? 'CREDIT_CARD' : m === 'boleto' ? 'BOLETO' : 'UNDEFINED');
export const methodFromAsaas = (b: string | null | undefined) =>
  (b === 'PIX' ? 'pix' : b === 'CREDIT_CARD' || b === 'DEBIT_CARD' ? 'card' : b === 'BOLETO' ? 'boleto' : null);

export async function asaasCustomer(input: { id?: string | null; name: string; cpfCnpj: string; email: string | null; externalReference: string }): Promise<string> {
  const body = { name: input.name, cpfCnpj: input.cpfCnpj, ...(input.email ? { email: input.email } : {}), externalReference: input.externalReference };
  if (input.id) {
    const r = await asaas<{ id: string }>(`customers/${input.id}`, 'PUT', body);
    return r.id ?? input.id;
  }
  const r = await asaas<{ id: string }>('customers', 'POST', body);
  return r.id;
}

export async function asaasCreateSubscription(input: { customer: string; method: string; value: number; nextDueDate: string; description: string; externalReference: string }) {
  return asaas<{ id: string; status: string }>('subscriptions', 'POST', {
    customer: input.customer, billingType: asaasBillingType(input.method), value: input.value, nextDueDate: input.nextDueDate,
    cycle: 'MONTHLY', description: input.description, externalReference: input.externalReference,
  });
}

export async function asaasSubscriptionPayments(id: string): Promise<AsaasPayment[]> {
  const r = await asaas<{ data?: AsaasPayment[] }>(`subscriptions/${id}/payments`);
  return r.data ?? [];
}

/** Troca a mensalidade (vale para as próximas cobranças e as pendentes). */
export async function asaasUpdateSubscription(id: string, input: { value: number; description: string }) {
  return asaas<{ id: string }>(`subscriptions/${id}`, 'PUT', { value: input.value, description: input.description, updatePendingPayments: true });
}

export async function asaasDeleteSubscription(id: string) {
  return asaas<{ deleted?: boolean }>(`subscriptions/${id}`, 'DELETE');
}

export async function asaasCreatePayment(input: { customer: string; method: string | null; value: number; dueDate: string; description: string; externalReference: string }) {
  return asaas<AsaasPayment>('payments', 'POST', {
    customer: input.customer, billingType: asaasBillingType(input.method), value: input.value, dueDate: input.dueDate,
    description: input.description, externalReference: input.externalReference,
  });
}

/** Apaga uma cobrança ainda não paga (ex.: o cliente trocou a quantidade antes de pagar). */
export async function asaasDeletePayment(id: string) {
  return asaas<{ deleted?: boolean }>(`payments/${id}`, 'DELETE');
}

export async function asaasPayment(id: string) {
  return asaas<AsaasPayment>(`payments/${id}`);
}

/** O token do webhook confere (comparação em tempo constante)? */
export function asaasTokenOk(received: string | undefined) {
  const expected = config.billing.asaas.webhookToken;
  if (!expected || !received) return false;
  const a = Buffer.from(received); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ Paddle */

async function paddle<T>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown): Promise<T> {
  if (!config.billing.paddle.apiKey) throw new GatewayError('A cobrança internacional (Paddle) não está configurada no servidor (PADDLE_API_KEY).', 400);
  let resp: Response;
  try {
    resp = await fetch(`${config.billing.paddle.apiBase}/${path.replace(/^\/+/, '')}`, {
      method,
      headers: { Authorization: `Bearer ${config.billing.paddle.apiKey}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    throw new GatewayError(`Sem conexão com a Paddle (${(err as Error).message}). Tente de novo.`, 502, true);
  }
  const data = await resp.json().catch(() => ({})) as { data?: T; error?: { detail?: string; code?: string } };
  if (!resp.ok) {
    const msg = data.error?.detail || data.error?.code || `HTTP ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) throw new GatewayError(`A Paddle recusou a chave da API (PADDLE_API_KEY): ${msg}`, 502);
    throw new GatewayError(`A Paddle recusou: ${msg}`, resp.status >= 500 ? 502 : 422, resp.status >= 500);
  }
  return data.data as T;
}

export interface PaddleItem { price_id?: string; quantity: number; price?: Record<string, unknown> }

/** Cria a transação e devolve a página de pagamento (link padrão + ?_ptxn=). */
export async function paddleTransaction(items: PaddleItem[], customData: Record<string, string>) {
  const t = await paddle<{ id: string; status: string; checkout?: { url?: string | null } }>('transactions', 'POST', {
    items, custom_data: customData, collection_mode: 'automatic',
  });
  if (!t.checkout?.url) throw new GatewayError('A Paddle não devolveu o link de pagamento. Confira o “Default payment link” em Checkout settings.', 502);
  return { id: t.id, checkoutUrl: t.checkout.url };
}

/** Item avulso (tokens, disparos): preço definido na hora, em dólar. */
export function paddleOneOff(name: string, amountUSD: number): PaddleItem {
  return {
    quantity: 1,
    price: {
      description: name, name,
      unit_price: { amount: String(Math.round(amountUSD * 100)), currency_code: 'USD' },
      product: { name, tax_category: 'standard' },
    },
  };
}

export interface PaddleSubscription {
  id: string; status: string; customer_id?: string;
  items?: { quantity: number; price?: { id?: string } }[];
  current_billing_period?: { starts_at: string; ends_at: string } | null;
  scheduled_change?: { action: string; effective_at: string } | null;
  canceled_at?: string | null; started_at?: string | null;
  custom_data?: Record<string, string> | null;
}

export async function paddleSubscription(id: string) {
  return paddle<PaddleSubscription>(`subscriptions/${id}`);
}

/** Quantidade de instâncias de uma assinatura da Paddle (soma dos itens). */
export const paddleQuantity = (s: Pick<PaddleSubscription, 'items'>) =>
  Math.max(0, (s.items ?? []).reduce((n, it) => n + (Number(it.quantity) || 0), 0));

/** Muda a quantidade de instâncias (a Paddle cobra ou credita a diferença proporcional na hora). */
export async function paddleChangeQuantity(id: string, quantity: number) {
  const s = await paddleSubscription(id);
  const priceId = s.items?.[0]?.price?.id ?? config.billing.paddle.priceInstance;
  return paddle<PaddleSubscription>(`subscriptions/${id}`, 'PATCH', {
    items: [{ price_id: priceId, quantity }], proration_billing_mode: 'prorated_immediately', on_payment_failure: 'prevent_change',
  });
}

/** Cancela no fim do período pago (ou na hora, quando a mensalidade já está atrasada). */
export async function paddleCancel(id: string, now = false) {
  return paddle<PaddleSubscription>(`subscriptions/${id}/cancel`, 'POST', { effective_from: now ? 'immediately' : 'next_billing_period' });
}

/** Desfaz um cancelamento agendado (reativar antes do fim do período). */
export async function paddleKeep(id: string) {
  return paddle<PaddleSubscription>(`subscriptions/${id}`, 'PATCH', { scheduled_change: null });
}

/** PDF da fatura de uma transação paga (link temporário gerado pela Paddle). */
export async function paddleInvoicePdf(txnId: string): Promise<string | null> {
  const r = await paddle<{ url?: string }>(`transactions/${txnId}/invoice`);
  return r?.url ?? null;
}

/** Preço do catálogo (o valor da instância em dólar vem da própria Paddle). */
const priceCache = new Map<string, { at: number; amount: number; currency: string }>();
export async function paddlePrice(id: string): Promise<{ amount: number; currency: string } | null> {
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  try {
    const p = await paddle<{ unit_price?: { amount?: string; currency_code?: string } }>(`prices/${id}`);
    const amount = Number(p.unit_price?.amount) / 100;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const v = { at: Date.now(), amount, currency: p.unit_price?.currency_code ?? 'USD' };
    priceCache.set(id, v);
    return v;
  } catch {
    return null;
  }
}

/** Assinatura do aviso da Paddle: HMAC-SHA256 de "ts:corpo" com o segredo do destino. */
export function paddleSignatureOk(rawBody: Buffer | undefined, header: string | undefined, secret = config.billing.paddle.webhookSecret, now = Date.now(), toleranceSec = 300) {
  if (!secret || !rawBody || !header) return false;
  const parts = header.split(';').map((p) => p.split('='));
  const ts = parts.find(([k]) => k === 'ts')?.[1];
  const sigs = parts.filter(([k]) => k === 'h1').map(([, v]) => v);
  if (!ts || !sigs.length || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody.toString('utf8')}`).digest('hex');
  return sigs.some((s) => {
    const a = Buffer.from(s); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
