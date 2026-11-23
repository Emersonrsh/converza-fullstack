/**
 * InfinitePay — Checkout Integrado (cartão de crédito em até 12x e Pix).
 *
 * - Cada conta informa a sua InfiniteTag (handle) e, se quiser, a chave de API.
 * - O bloco Pagamento do fluxo (ou o teste) gera um link com o valor certo; a venda nasce "aguardando".
 * - Quando o cliente paga, a InfinitePay chama o nosso webhook. Como o aviso não tem assinatura,
 *   o pagamento é sempre confirmado na consulta oficial (/payment_check) antes de valer.
 * - Confirmado: a venda vira "aprovada" (o Pixel recebe a compra e o celular recebe o aviso)
 *   e o fluxo que esperava o pagamento segue pela saída "pago".
 */
import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { recordSale } from './salesStore';
import { onPaymentApproved } from '../flows/runner';

const API = (process.env.INFINITEPAY_API_URL || 'https://api.checkout.infinitepay.io').replace(/\/+$/, '');
const PREFIX = 'ip:';

export interface InfinitePaySettings { handle: string; apiKey: string; pix: boolean }

export const infinitepayRouter = Router();
/** sem login: é a InfinitePay que chama */
export const infinitepayHookRouter = Router();

const cleanHandle = (v: unknown) => String(v ?? '').trim().replace(/^\$/, '').replace(/\s+/g, '');

export async function getInfinitePay(accountId: string): Promise<InfinitePaySettings | null> {
  const [a] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const s = ((a?.settings ?? {}) as Record<string, any>).infinitepay as Partial<InfinitePaySettings> | undefined;
  const handle = cleanHandle(s?.handle);
  return handle ? { handle, apiKey: String(s?.apiKey ?? ''), pix: s?.pix !== false } : null;
}

function apiBase(req?: Request) {
  if (config.publicApiUrl) return config.publicApiUrl;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${config.port}`;
}
const hookUrl = (accountId: string, req?: Request) => `${apiBase(req)}/api/v1/pay-hooks/infinitepay/${accountId}`;

async function call<T>(path: string, body: unknown, apiKey?: string): Promise<{ status: number; data: T | null; text: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(`${API}${path}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: T | null = null;
    try { data = JSON.parse(text) as T; } catch { data = null; }
    return { status: r.status, data, text };
  } finally { clearTimeout(timer); }
}

/** O endereço do checkout na resposta (a documentação não fixa o nome do campo). */
export function linkFromResponse(d: any): string | null {
  const cands = [d?.url, d?.link, d?.checkout_url, d?.payment_url, d?.data?.url, d?.data?.link];
  const u = cands.find((x) => typeof x === 'string' && /^https:\/\//i.test(x));
  return u ?? null;
}

/** Telefone no formato que a InfinitePay pede (+55DDDNUMERO). */
export function phoneE164(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return `+${d.length <= 11 ? `55${d}` : d}`;
}

export interface LinkInput {
  accountId: string;
  contactId: string | null;
  amount: number;
  description: string;
  productId?: string | null;
  productName?: string | null;
  customer?: { name?: string | null; phone?: string | null; email?: string | null };
  connectionId?: string | null;
  req?: Request;
}

/** Gera o link de pagamento e deixa a venda registrada como "aguardando". */
export async function createInfinitePayLink(input: LinkInput): Promise<{ url: string; orderNsu: string; saleId: string }> {
  const cfg = await getInfinitePay(input.accountId);
  if (!cfg) throw new AppError(422, 'Configure a InfinitePay em Configurações › Produtos (InfiniteTag).');
  const cents = Math.round(Number(input.amount) * 100);
  if (!Number.isFinite(cents) || cents < 100) throw new AppError(422, 'O valor do pagamento precisa ser de pelo menos R$ 1,00.');
  const orderNsu = randomUUID().replace(/-/g, '').slice(0, 20);
  const description = (input.description || input.productName || 'Pedido').trim().slice(0, 120);
  const phone = phoneE164(input.customer?.phone);
  const customer = {
    ...(input.customer?.name?.trim() ? { name: input.customer.name.trim().slice(0, 80) } : {}),
    ...(input.customer?.email?.trim() ? { email: input.customer.email.trim() } : {}),
    ...(phone ? { phone_number: phone } : {}),
  };
  const body: Record<string, unknown> = {
    ...(cfg.apiKey ? {} : { handle: cfg.handle }),
    items: [{ quantity: 1, price: cents, description }],
    order_nsu: orderNsu,
    webhook_url: hookUrl(input.accountId, input.req),
    ...(Object.keys(customer).length ? { customer } : {}),
    ...(cfg.apiKey && !cfg.pix ? { options: { payment_methods_enabled: ['credit_card'] } } : {}),
  };
  let r;
  try { r = await call<any>('/links', body, cfg.apiKey || undefined); }
  catch { throw new AppError(502, 'A InfinitePay não respondeu. Tente de novo em instantes.'); }
  const url = r.status < 300 ? linkFromResponse(r.data) : null;
  if (!url) {
    const msg = String(r.data?.message ?? r.data?.error ?? '').slice(0, 200);
    if (/handle/i.test(msg)) throw new AppError(422, 'A InfinitePay não reconheceu a InfiniteTag. Confira em Configurações › Produtos.');
    throw new AppError(502, `A InfinitePay recusou o link${msg ? `: ${msg}` : ''}.`);
  }
  const sale = await recordSale({
    accountId: input.accountId, contactId: input.contactId, amount: cents / 100, status: 'pending',
    productId: input.productId ?? null, productName: input.productName ?? description,
    externalId: `${PREFIX}${orderNsu}`, origin: 'flow', connectionId: input.connectionId ?? null,
    notes: 'Checkout InfinitePay', customerName: input.customer?.name ?? null, customerPhone: input.customer?.phone ?? null,
  });
  wakeInfinitePaySweep();
  return { url, orderNsu, saleId: sale.id };
}

/** Confirma na InfinitePay se o pedido foi mesmo pago. */
export async function checkPayment(cfg: InfinitePaySettings, q: { orderNsu: string; transactionNsu?: string; slug?: string }) {
  const r = await call<{ success?: boolean; paid?: boolean; amount?: number; paid_amount?: number; installments?: number; capture_method?: string }>('/payment_check', {
    handle: cfg.handle, order_nsu: q.orderNsu,
    ...(q.transactionNsu ? { transaction_nsu: q.transactionNsu } : {}),
    ...(q.slug ? { slug: q.slug } : {}),
  }, cfg.apiKey || undefined);
  if (r.status >= 500) throw new Error(`payment_check HTTP ${r.status}`);
  return r.data ?? {};
}

const METHOD: Record<string, string> = { credit_card: 'cartão de crédito', pix: 'Pix', debit_card: 'cartão de débito' };

/* ============================================================ confirmação */

export type ConfirmResult = 'paid' | 'unpaid' | 'already' | 'unknown_order' | 'not_configured';
interface Hint { transactionNsu?: string; slug?: string; receiptUrl?: string; installments?: number; captureMethod?: string }

/**
 * Confere um pedido na InfinitePay e, se estiver pago, aprova a venda (Pixel, aviso no celular)
 * e retoma o fluxo que esperava o pagamento. Usado pelo webhook, pela verificação periódica
 * e pela última conferência antes do "Não pago". Lança erro só se a InfinitePay não responder.
 */
export async function confirmInfinitePayOrder(accountId: string, orderNsu: string, hint: Hint = {}): Promise<ConfirmResult> {
  const cfg = await getInfinitePay(accountId);
  if (!cfg) return 'not_configured';
  const [sale] = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.accountId, accountId), eq(schema.sales.externalId, `${PREFIX}${orderNsu}`))).limit(1);
  if (!sale) return 'unknown_order';
  if (sale.status === 'approved') return 'already';
  const check = await checkPayment(cfg, { orderNsu, transactionNsu: hint.transactionNsu, slug: hint.slug });
  if (!check.success || !check.paid) return 'unpaid';

  const raw = String(check.capture_method ?? hint.captureMethod ?? '');
  const method = METHOD[raw] ?? raw;
  const parcelas = Number(check.installments ?? hint.installments ?? 1);
  const row = await recordSale({
    accountId, contactId: sale.contactId, amount: Number(sale.amount), status: 'approved',
    productId: sale.productId, productName: sale.productName, externalId: sale.externalId, origin: 'flow',
    connectionId: sale.connectionId,
  });
  // a venda já existia (aguardando): grava como foi paga e o comprovante
  const notes = `InfinitePay · ${method || 'pago'}${parcelas > 1 ? ` em ${parcelas}x` : ''}${hint.transactionNsu ? ` · NSU ${hint.transactionNsu.slice(0, 40)}` : ''}${hint.receiptUrl ? ` · comprovante: ${hint.receiptUrl.slice(0, 300)}` : ''}`;
  await db.update(schema.sales).set({ notes }).where(eq(schema.sales.id, row.id));
  if (row.contactId) await onPaymentApproved(accountId, row.contactId).catch((err) => console.error('[infinitepay] fluxo não retomou:', (err as Error).message));
  return 'paid';
}

/** Última conferência: os pedidos pendentes do contato (usada antes de o fluxo ir para "Não pago"). */
export async function checkPendingForContact(accountId: string, contactId: string): Promise<boolean> {
  const rows = await db.select({ externalId: schema.sales.externalId }).from(schema.sales).where(and(
    eq(schema.sales.accountId, accountId), eq(schema.sales.contactId, contactId), eq(schema.sales.status, 'pending'),
    sql`${schema.sales.externalId} like ${`${PREFIX}%`}`, sql`${schema.sales.createdAt} >= now() - interval '48 hours'`,
  ));
  let paid = false;
  for (const r of rows) {
    try { if ((await confirmInfinitePayOrder(accountId, String(r.externalId).slice(PREFIX.length))) === 'paid') paid = true; }
    catch (err) { console.error('[infinitepay] última conferência falhou:', (err as Error).message); }
  }
  return paid;
}

/* ============================================================ verificação periódica */

const lastCheck = new Map<string, number>();
/** de quanto em quanto tempo conferir, pela idade do pedido */
export function checkEveryMs(ageMs: number): number {
  if (ageMs < 30 * 60_000) return 60_000;        // primeira meia hora: a cada minuto
  if (ageMs < 3 * 3600_000) return 5 * 60_000;   // até 3 horas: a cada 5 minutos
  return 30 * 60_000;                             // até 48 horas: a cada 30 minutos
}

/** Confere os pedidos pendentes na InfinitePay, mesmo que o aviso dela nunca chegue. */
/** Sem cobrança pendente: a próxima consulta ao banco espera 5 minutos (uma cobrança nova acorda na hora). */
let idleUntil = 0;
export function wakeInfinitePaySweep() { idleUntil = 0; }

export async function sweepInfinitePay(now = Date.now()): Promise<number> {
  if (now < idleUntil) return 0;
  const rows = await db.select({ id: schema.sales.id, accountId: schema.sales.accountId, externalId: schema.sales.externalId, createdAt: schema.sales.createdAt })
    .from(schema.sales).where(and(
      eq(schema.sales.status, 'pending'), sql`${schema.sales.externalId} like ${`${PREFIX}%`}`,
      sql`${schema.sales.createdAt} >= now() - interval '48 hours'`,
    )).orderBy(sql`${schema.sales.createdAt} desc`).limit(200);
  idleUntil = rows.length ? 0 : now + 5 * 60_000;
  const alive = new Set(rows.map((r) => r.id));
  for (const id of lastCheck.keys()) if (!alive.has(id)) lastCheck.delete(id);
  let approved = 0;
  let calls = 0;
  for (const r of rows) {
    if (calls >= 60) break; // no máximo 60 consultas por rodada
    const age = now - new Date(r.createdAt).getTime();
    if (age < 45_000) continue; // o cliente acabou de receber o link
    if (now - (lastCheck.get(r.id) ?? 0) < checkEveryMs(age)) continue;
    lastCheck.set(r.id, now);
    calls++;
    try {
      if ((await confirmInfinitePayOrder(r.accountId, String(r.externalId).slice(PREFIX.length))) === 'paid') approved++;
    } catch (err) { console.error('[infinitepay] verificação:', (err as Error).message); }
  }
  return approved;
}

export function startInfinitePaySweep() {
  const tick = () => sweepInfinitePay().then((n) => { if (n) console.log(`[infinitepay] ${n} pagamento(s) confirmado(s) pela verificação`); })
    .catch((err) => console.error('[infinitepay] verificação:', (err as Error).message));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 60_000).unref();
}

/* ============================================================ webhook */

infinitepayHookRouter.post('/:accountId', asyncHandler(async (req, res) => {
  const accountId = req.params.accountId;
  if (!isUuid(accountId)) { res.status(200).json({ ok: true }); return; }
  const b = (req.body ?? {}) as Record<string, any>;
  const orderNsu = String(b.order_nsu ?? '').trim();
  if (!orderNsu) { res.status(200).json({ ok: true, ignored: 'sem order_nsu' }); return; }
  let r: ConfirmResult;
  try {
    r = await confirmInfinitePayOrder(accountId, orderNsu, {
      transactionNsu: b.transaction_nsu ? String(b.transaction_nsu) : undefined,
      slug: b.invoice_slug ? String(b.invoice_slug) : undefined,
      receiptUrl: b.receipt_url ? String(b.receipt_url) : undefined,
      installments: b.installments ? Number(b.installments) : undefined,
      captureMethod: b.capture_method ? String(b.capture_method) : undefined,
    });
  } catch (err) {
    // InfinitePay fora: responde erro para ela tentar de novo (e a verificação periódica também confere)
    console.error('[infinitepay] não deu para confirmar o pagamento:', (err as Error).message);
    res.status(400).json({ ok: false });
    return;
  }
  if (r === 'not_configured') { res.status(200).json({ ok: true, ignored: 'InfinitePay não configurada' }); return; }
  if (r === 'unknown_order') { res.status(200).json({ ok: true, ignored: 'pedido desconhecido' }); return; }
  if (r === 'already') { res.status(200).json({ ok: true, already: true }); return; }
  res.status(200).json({ ok: true, paid: r === 'paid' });
}));

/* ============================================================ configuração */

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só administradores e gestores mexem nas configurações de pagamento');
}

infinitepayRouter.get('/', asyncHandler(async (req, res) => {
  const cfg = await getInfinitePay(req.accountId!);
  const [st] = (await db.execute(sql`select count(*)::int as n, count(*) filter (where status = 'approved')::int as paid
    from sales where account_id = ${req.accountId!} and external_id like ${`${PREFIX}%`} and created_at >= now() - interval '30 days'`)).rows as { n: number; paid: number }[];
  res.json({
    configured: !!cfg, handle: cfg?.handle ?? '', hasApiKey: !!cfg?.apiKey, pix: cfg?.pix ?? true,
    webhookUrl: hookUrl(req.accountId!, req), last30: { links: Number(st?.n ?? 0), paid: Number(st?.paid ?? 0) },
  });
}));

const settingsSchema = z.object({
  handle: z.string().trim().max(60, 'InfiniteTag muito longa'),
  apiKey: z.string().trim().max(200).optional(),
  clearApiKey: z.boolean().optional(),
  pix: z.boolean().optional(),
});

infinitepayRouter.put('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = settingsSchema.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const handle = cleanHandle(p.data.handle);
  if (handle && !/^[a-z0-9_.-]{2,60}$/i.test(handle)) throw new AppError(422, 'InfiniteTag inválida: use só letras, números, ponto, hífen ou _ (sem o $).');
  const cur = await getInfinitePay(req.accountId!);
  const apiKey = p.data.clearApiKey ? '' : (p.data.apiKey || cur?.apiKey || '');
  const value = handle ? { handle, apiKey, pix: p.data.pix ?? cur?.pix ?? true } : null;
  await db.execute(sql`update accounts set settings = case when ${value === null}
      then coalesce(settings, '{}'::jsonb) - 'infinitepay'
      else coalesce(settings, '{}'::jsonb) || jsonb_build_object('infinitepay', ${JSON.stringify(value)}::jsonb) end
    where id = ${req.accountId!}`);
  const cfg = await getInfinitePay(req.accountId!);
  res.json({ configured: !!cfg, handle: cfg?.handle ?? '', hasApiKey: !!cfg?.apiKey, pix: cfg?.pix ?? true });
}));

/** Gera um link de R$ 1,00 só para conferir a InfiniteTag (não cria venda). */
infinitepayRouter.post('/test', asyncHandler(async (req, res) => {
  managerOnly(req);
  const cfg = await getInfinitePay(req.accountId!);
  if (!cfg) throw new AppError(422, 'Salve a InfiniteTag primeiro.');
  let r;
  try {
    r = await call<any>('/links', { ...(cfg.apiKey ? {} : { handle: cfg.handle }), items: [{ quantity: 1, price: 100, description: 'Teste Converza' }], order_nsu: `teste${Date.now()}` }, cfg.apiKey || undefined);
  } catch { throw new AppError(502, 'A InfinitePay não respondeu. Tente de novo em instantes.'); }
  const url = r.status < 300 ? linkFromResponse(r.data) : null;
  if (!url) throw new AppError(422, `A InfinitePay recusou: ${String(r.data?.message ?? `HTTP ${r.status}`).slice(0, 200)}`);
  res.json({ ok: true, url });
}));

/** Gera um link avulso (ex.: no Chats ao vivo) para um contato. */
infinitepayRouter.post('/links', asyncHandler(async (req, res) => {
  const d = z.object({
    contactId: z.string().uuid().nullable().optional(),
    amount: z.number().positive().max(1_000_000),
    description: z.string().trim().max(120).optional(),
    productId: z.string().uuid().nullable().optional(),
  }).safeParse(req.body);
  if (!d.success) throw new AppError(422, d.error.issues[0]?.message ?? 'Dados inválidos');
  let contact: { id: string; name: string | null; phone: string } | undefined;
  if (d.data.contactId) {
    [contact] = await db.select({ id: schema.contacts.id, name: schema.contacts.name, phone: schema.contacts.phone }).from(schema.contacts)
      .where(and(eq(schema.contacts.id, d.data.contactId), eq(schema.contacts.accountId, req.accountId!))).limit(1);
    if (!contact) throw new AppError(404, 'Contato não encontrado');
  }
  let productName: string | null = null;
  if (d.data.productId) {
    const [p] = await db.select({ name: schema.products.name }).from(schema.products)
      .where(and(eq(schema.products.id, d.data.productId), eq(schema.products.accountId, req.accountId!))).limit(1);
    productName = p?.name ?? null;
  }
  const r = await createInfinitePayLink({
    accountId: req.accountId!, contactId: contact?.id ?? null, amount: d.data.amount,
    description: d.data.description || productName || 'Pedido', productId: d.data.productId ?? null, productName,
    customer: { name: contact?.name, phone: contact?.phone }, req,
  });
  res.status(201).json(r);
}));
