/**
 * XPag — cobranças em moedas da América Latina (pesos mexicanos por SPEI ou OXXO, Pix, Nequi/Bre-B, USDT e USDC).
 *
 * - Cada conta informa o Client ID e o Client Secret da própria conta XPag (Integrações › API no painel da XPag).
 * - O bloco "Pagamento XPag" do fluxo cria a cobrança (POST /cashin) com o valor certo; a venda nasce "aguardando"
 *   na moeda da cobrança e o cliente recebe as instruções (CLABE, ficha OXXO, link, Pix copia e cola ou endereço).
 * - Quando o cliente paga, a XPag chama o nosso webhook assinado (HMAC-SHA256 do corpo com o Client Secret).
 *   Sem assinatura válida, o aviso é ignorado. Uma verificação periódica consulta as cobranças pendentes
 *   (GET /consult-transaction) caso o aviso não chegue.
 * - Confirmado: a venda vira "aprovada" (Pixel, aviso no celular) e o fluxo que esperava segue por "Pago".
 */
import { Router, type Request } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { recordSale } from './salesStore';
import { onPaymentApproved } from '../flows/runner';
import { checkEveryMs } from './infinitepay';

const API = (process.env.XPAG_API_URL || 'https://api.xpag.global').replace(/\/+$/, '');
const PREFIX = 'xp:';

/** Moedas que o Converza cobra pela XPag e os trilhos de cada uma (o primeiro é o padrão). */
export const XPAG_CURRENCIES: Record<string, { label: string; methods: { id: string; label: string }[] }> = {
  MXN: { label: 'Peso mexicano (MXN)', methods: [{ id: 'SPEI', label: 'SPEI (transferência)' }, { id: 'OXXO', label: 'OXXO (dinheiro na loja)' }] },
  COP: { label: 'Peso colombiano (COP)', methods: [{ id: 'NEQUI_QR', label: 'Nequi (QR)' }, { id: 'NEQUI_PUSH', label: 'Nequi (aviso no app)' }, { id: 'BREB', label: 'Bre-B' }] },
  BRL: { label: 'Real (BRL)', methods: [{ id: 'PIX', label: 'Pix' }] },
  USDT: { label: 'USDT (rede TRON)', methods: [] },
  USDC: { label: 'USDC (rede Solana)', methods: [] },
};
export const isXpagCurrency = (c: unknown): c is string => typeof c === 'string' && c in XPAG_CURRENCIES;

export interface XpagSettings { clientId: string; clientSecret: string; currency: string }

export const xpagRouter = Router();
/** sem login: é a XPag que chama */
export const xpagHookRouter = Router();

export async function getXpag(accountId: string): Promise<XpagSettings | null> {
  const [a] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const s = ((a?.settings ?? {}) as Record<string, any>).xpag as Partial<XpagSettings> | undefined;
  const clientId = String(s?.clientId ?? '').trim();
  const clientSecret = String(s?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, currency: isXpagCurrency(s?.currency) ? s!.currency! : 'MXN' };
}

function apiBase(req?: Request) {
  if (config.publicApiUrl) return config.publicApiUrl;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${config.port}`;
}
const hookUrl = (accountId: string, req?: Request) => `${apiBase(req)}/api/v1/pay-hooks/xpag/${accountId}`;

async function call<T>(cfg: XpagSettings, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${API}${path}`, {
      method, signal: ctrl.signal,
      headers: { Accept: 'application/json', 'X-Client-Id': cfg.clientId, 'X-Client-Secret': cfg.clientSecret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let data: T | null = null;
    try { data = JSON.parse(text) as T; } catch { data = null; }
    return { status: r.status, data };
  } finally { clearTimeout(timer); }
}

const ERRORS: Record<string, string> = {
  invalid_credentials: 'A XPag não reconheceu o Client ID e o Client Secret.',
  missing_credentials: 'Faltam o Client ID e o Client Secret da XPag.',
  key_inactive: 'A chave de API está desativada no painel da XPag.',
  permission_denied: 'A chave de API da XPag não tem permissão de cobrança.',
  currency_not_enabled: 'Esta moeda não está liberada na sua conta XPag.',
  currency_not_supported: 'A XPag não aceita esta moeda.',
  kyc_required: 'A XPag pede a verificação de documentos da sua conta antes de cobrar.',
  amount_below_min: 'O valor está abaixo do mínimo da XPag para esta moeda.',
  amount_above_limit: 'O valor está acima do limite da XPag para esta moeda.',
  invalid_amount: 'Valor inválido para a XPag.',
  phone_required: 'Este método exige o telefone do cliente.',
  crypto_disabled: 'Cobrança em cripto não está liberada na sua conta XPag.',
  too_many_pending: 'Há cobranças pendentes demais na XPag. Tente de novo mais tarde.',
  provider_unavailable: 'A XPag está instável no momento. Tente de novo em instantes.',
  rate_limited: 'Muitas cobranças seguidas na XPag. Tente de novo em instantes.',
  maintenance: 'A XPag está em manutenção. Tente de novo mais tarde.',
};
const errorText = (d: any, status: number) => {
  const code = String(d?.error_code ?? '');
  return ERRORS[code] ?? `A XPag recusou a cobrança${d?.error ? `: ${String(d.error).slice(0, 160)}` : ` (HTTP ${status})`}.`;
};

/** USDT e USDC entram no dashboard como dólar (a moeda da venda tem 3 letras). */
export const saleCurrency = (c: string) => (c === 'USDT' || c === 'USDC' ? 'USD' : c);

export function formatAmount(n: number, currency: string): string {
  if (currency === 'USDT' || currency === 'USDC') return `${n} ${currency}`;
  try { return n.toLocaleString(currency === 'BRL' ? 'pt-BR' : 'es-MX', { style: 'currency', currency, currencyDisplay: 'code' }).replace(/ /g, ' '); }
  catch { return `${n.toFixed(2)} ${currency}`; }
}

const firstLink = (...xs: unknown[]) => xs.find((x) => typeof x === 'string' && /^https:\/\//i.test(x)) as string | undefined;

/**
 * Monta o que o cliente recebe a partir da resposta da XPag: um link (quando há página de pagamento)
 * e um texto com as instruções. Em espanhol fora do Brasil, porque quem paga está lá.
 */
export function chargeInstructions(currency: string, method: string, d: any): { link: string; text: string; amount: number | null } {
  const pd = d?.payee_data ?? {};
  const amount = Number.isFinite(Number(d?.amount)) ? Number(d.amount) : null;
  const link = firstLink(d?.checkout_url, d?.payment_url, d?.url, pd?.redirectUrl, method === 'OXXO' ? d?.code : undefined) ?? '';
  const lines: string[] = [];
  if (currency === 'BRL') {
    const copy = d?.copyPaste ?? d?.copy_paste ?? d?.code;
    if (copy) lines.push('Pix copia e cola:', String(copy));
  } else if (currency === 'MXN' && method === 'OXXO') {
    if (link) lines.push(`Paga en cualquier tienda OXXO con esta ficha: ${link}`);
    const ref = pd?.reference ?? d?.reference;
    if (ref) lines.push(`Referencia OXXO: ${ref}`);
    if (amount != null) lines.push(`Monto exacto: ${formatAmount(amount, 'MXN')}`);
  } else if (currency === 'MXN') {
    if (d?.clabe) lines.push(`CLABE: ${d.clabe}`);
    if (d?.bank_name) lines.push(`Banco: ${d.bank_name}`);
    if (d?.beneficiary) lines.push(`Beneficiario: ${d.beneficiary}`);
    if (d?.reference) lines.push(`Referencia: ${d.reference}`);
    if (amount != null) lines.push(`Monto: ${formatAmount(amount, 'MXN')}`);
  } else if (currency === 'COP') {
    if (link) lines.push(`Paga aquí: ${link}`);
    if (d?.breb_key) lines.push(`Llave Bre-B: ${d.breb_key}`);
    if (method === 'NEQUI_PUSH') lines.push('Te enviamos una notificación en la app Nequi para aprobar el pago.');
  } else if (currency === 'USDT' || currency === 'USDC') {
    const net = String(d?.network ?? (currency === 'USDT' ? 'TRON' : 'SOLANA'));
    lines.push(`Red: ${net === 'TRON' ? 'TRON (TRC20)' : net}`);
    if (d?.deposit_address) lines.push(`Dirección: ${d.deposit_address}`);
    if (amount != null) lines.push(`Monto exacto: ${amount} ${currency}`);
    lines.push('Envía exactamente este monto y por esta red.');
  }
  if (!lines.length && link) lines.push(link);
  return { link, text: lines.join('\n'), amount };
}

export interface XpagChargeInput {
  accountId: string;
  contactId: string | null;
  amount: number;
  currency: string;
  method?: string | null;
  description: string;
  productId?: string | null;
  productName?: string | null;
  customer?: { name?: string | null; phone?: string | null; email?: string | null };
  connectionId?: string | null;
  req?: Request;
}

/** Cria a cobrança na XPag e deixa a venda registrada como "aguardando". */
export async function createXpagCharge(input: XpagChargeInput): Promise<{ link: string; instructions: string; externalId: string; saleId: string; amount: number; currency: string }> {
  const cfg = await getXpag(input.accountId);
  if (!cfg) throw new AppError(422, 'Configure a XPag em Configurações › Produtos (Client ID e Client Secret).');
  const currency = String(input.currency || cfg.currency).toUpperCase();
  if (!isXpagCurrency(currency)) throw new AppError(422, `Moeda não suportada pela XPag no Converza: ${currency}.`);
  const methods = XPAG_CURRENCIES[currency].methods;
  const method = methods.find((m) => m.id === input.method)?.id ?? methods[0]?.id ?? '';
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(422, 'O valor do pagamento precisa ser maior que zero.');
  if (method === 'OXXO' && (amount < 10 || amount > 10_000)) throw new AppError(422, 'No OXXO, o valor precisa ficar entre 10 e 10.000 MXN.');
  const description = (input.description || input.productName || 'Pedido').trim().slice(0, 120);
  const externalId = randomUUID().replace(/-/g, '');
  const phone = String(input.customer?.phone ?? '').replace(/\D/g, '');
  const name = input.customer?.name?.trim().slice(0, 80);
  const email = input.customer?.email?.trim();
  const body: Record<string, unknown> = {
    currency, amount, external_id: externalId, webhook_url: hookUrl(input.accountId, input.req), description,
    ...(method && methods.length > 1 ? { method } : {}),
    ...(name ? { name } : {}),
    ...(method === 'OXXO' && (name || email) ? { payerData: { ...(name ? { name } : {}), ...(email ? { email } : {}) } } : {}),
    // Nequi pede o celular colombiano (10 dígitos começando com 3)
    ...(currency === 'COP' && /^(57)?3\d{9}$/.test(phone) ? { phone: phone.slice(-10) } : {}),
  };
  if (method === 'NEQUI_PUSH' && !body.phone) throw new AppError(422, 'O aviso no app Nequi exige um celular colombiano (+57 3…) no contato.');
  let r;
  try { r = await call<any>(cfg, 'POST', '/cashin', body); }
  catch { throw new AppError(502, 'A XPag não respondeu. Tente de novo em instantes.'); }
  if (r.status >= 300 || !r.data || r.data.ok === false) throw new AppError(r.status === 401 || r.status === 403 ? 422 : 502, errorText(r.data, r.status));
  const ins = chargeInstructions(currency, method, r.data);
  if (!ins.text && !ins.link) throw new AppError(502, 'A XPag criou a cobrança, mas não mandou as instruções de pagamento.');
  // USDT/USDC: o valor a pagar tem casas extras que identificam o pedido
  const charged = (currency === 'USDT' || currency === 'USDC') && ins.amount ? ins.amount : amount;
  const sale = await recordSale({
    accountId: input.accountId, contactId: input.contactId, amount: charged, currency: saleCurrency(currency), status: 'pending',
    productId: input.productId ?? null, productName: input.productName ?? description,
    externalId: `${PREFIX}${externalId}`, origin: 'flow', connectionId: input.connectionId ?? null,
    notes: `XPag · ${currency}${method ? ` · ${method}` : ''}`, customerName: input.customer?.name ?? null, customerPhone: input.customer?.phone ?? null,
  });
  wakeXpagSweep();
  return { link: ins.link, instructions: ins.text, externalId, saleId: sale.id, amount: charged, currency };
}

/* ============================================================ confirmação */

export type XpagConfirm = 'paid' | 'unpaid' | 'already' | 'unknown_order' | 'not_configured' | 'amount_mismatch';

/** Aprova a venda de uma cobrança confirmada e retoma o fluxo que esperava o pagamento. */
async function approve(accountId: string, externalId: string, info: { amount?: unknown; method?: unknown; e2e?: unknown }): Promise<XpagConfirm> {
  const [sale] = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.accountId, accountId), eq(schema.sales.externalId, `${PREFIX}${externalId}`))).limit(1);
  if (!sale) return 'unknown_order';
  if (sale.status === 'approved') return 'already';
  const paid = Number(info.amount);
  if (Number.isFinite(paid) && paid > 0 && paid + 0.01 < Number(sale.amount)) {
    console.warn(`[xpag] pagamento menor que a cobrança (${paid} < ${sale.amount}) na venda ${sale.id}`);
    return 'amount_mismatch';
  }
  const row = await recordSale({
    accountId, contactId: sale.contactId, amount: Number(sale.amount), currency: sale.currency, status: 'approved',
    productId: sale.productId, productName: sale.productName, externalId: sale.externalId, origin: 'flow', connectionId: sale.connectionId,
  });
  const notes = `${sale.notes ?? 'XPag'} · pago${info.e2e ? ` · e2e ${String(info.e2e).slice(0, 60)}` : ''}`;
  await db.update(schema.sales).set({ notes }).where(eq(schema.sales.id, row.id));
  if (row.contactId) await onPaymentApproved(accountId, row.contactId).catch((err) => console.error('[xpag] fluxo não retomou:', (err as Error).message));
  return 'paid';
}

/** Consulta a cobrança na XPag e aprova se estiver confirmada. Lança erro só se a XPag não responder. */
export async function confirmXpagCharge(accountId: string, externalId: string): Promise<XpagConfirm> {
  const cfg = await getXpag(accountId);
  if (!cfg) return 'not_configured';
  const r = await call<any>(cfg, 'GET', `/consult-transaction?external_id=${encodeURIComponent(externalId)}`);
  if (r.status >= 500 || r.status === 429) throw new Error(`consult-transaction HTTP ${r.status}`);
  const d = r.data ?? {};
  const list: any[] = Array.isArray(d.payments) ? d.payments : [d];
  const ok = list.find((p) => p?.status === 'confirmed');
  if (!ok) return 'unpaid';
  return approve(accountId, externalId, { amount: ok.amount, method: ok.method, e2e: ok.e2e });
}

/** Última conferência: as cobranças pendentes do contato (antes de o fluxo ir para "Não pago"). */
export async function checkXpagPendingForContact(accountId: string, contactId: string): Promise<boolean> {
  const rows = await db.select({ externalId: schema.sales.externalId }).from(schema.sales).where(and(
    eq(schema.sales.accountId, accountId), eq(schema.sales.contactId, contactId), eq(schema.sales.status, 'pending'),
    sql`${schema.sales.externalId} like ${`${PREFIX}%`}`, sql`${schema.sales.createdAt} >= now() - interval '14 days'`,
  ));
  let paid = false;
  for (const r of rows) {
    try { if ((await confirmXpagCharge(accountId, String(r.externalId).slice(PREFIX.length))) === 'paid') paid = true; }
    catch (err) { console.error('[xpag] última conferência falhou:', (err as Error).message); }
  }
  return paid;
}

/* ============================================================ verificação periódica */

const lastCheck = new Map<string, number>();

/** Confere as cobranças pendentes na XPag, mesmo que o aviso nunca chegue (OXXO vale 12 dias). */
/** Sem cobrança pendente: a próxima consulta ao banco espera 5 minutos (uma cobrança nova acorda na hora). */
let idleUntil = 0;
export function wakeXpagSweep() { idleUntil = 0; }

export async function sweepXpag(now = Date.now()): Promise<number> {
  if (now < idleUntil) return 0;
  const rows = await db.select({ id: schema.sales.id, accountId: schema.sales.accountId, externalId: schema.sales.externalId, createdAt: schema.sales.createdAt })
    .from(schema.sales).where(and(
      eq(schema.sales.status, 'pending'), sql`${schema.sales.externalId} like ${`${PREFIX}%`}`,
      sql`${schema.sales.createdAt} >= now() - interval '13 days'`,
    )).orderBy(sql`${schema.sales.createdAt} desc`).limit(200);
  idleUntil = rows.length ? 0 : now + 5 * 60_000;
  const alive = new Set(rows.map((r) => r.id));
  for (const id of lastCheck.keys()) if (!alive.has(id)) lastCheck.delete(id);
  let approved = 0;
  let calls = 0;
  for (const r of rows) {
    if (calls >= 60) break;
    const age = now - new Date(r.createdAt).getTime();
    if (age < 45_000) continue;
    const every = age > 48 * 3600_000 ? 3 * 3600_000 : checkEveryMs(age);
    if (now - (lastCheck.get(r.id) ?? 0) < every) continue;
    lastCheck.set(r.id, now);
    calls++;
    try { if ((await confirmXpagCharge(r.accountId, String(r.externalId).slice(PREFIX.length))) === 'paid') approved++; }
    catch (err) { console.error('[xpag] verificação:', (err as Error).message); }
  }
  return approved;
}

export function startXpagSweep() {
  const tick = () => sweepXpag().then((n) => { if (n) console.log(`[xpag] ${n} pagamento(s) confirmado(s) pela verificação`); })
    .catch((err) => console.error('[xpag] verificação:', (err as Error).message));
  setTimeout(tick, 40_000).unref();
  setInterval(tick, 60_000).unref();
}

/* ============================================================ webhook */

/** Confere a assinatura do aviso: HMAC-SHA256 do corpo cru com o Client Secret, em hexadecimal. */
export function signatureOk(raw: Buffer | undefined, header: unknown, secret: string): boolean {
  const got = String(header ?? '').trim().toLowerCase();
  if (!raw || !/^[0-9a-f]{64}$/.test(got)) return false;
  const want = createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

xpagHookRouter.post('/:accountId', asyncHandler(async (req, res) => {
  const accountId = req.params.accountId;
  if (!isUuid(accountId)) { res.status(200).json({ ok: true }); return; }
  const cfg = await getXpag(accountId);
  if (!cfg) { res.status(200).json({ ok: true, ignored: 'XPag não configurada' }); return; }
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signatureOk(raw, req.get('x-webhook-signature'), cfg.clientSecret)) {
    console.warn(`[xpag] aviso com assinatura inválida para a conta ${accountId}`);
    res.status(401).json({ ok: false });
    return;
  }
  const b = (req.body ?? {}) as Record<string, any>;
  const externalId = String(b.external_id ?? '').trim();
  if (b.type !== 'cashin' || b.status !== 'confirmed' || !externalId) { res.status(200).json({ ok: true, ignored: b.status ?? 'sem status' }); return; }
  const r = await approve(accountId, externalId, { amount: b.amount, method: b.method, e2e: b.e2e });
  res.status(200).json({ ok: true, result: r });
}));

/* ============================================================ configuração */

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só administradores e gestores mexem nas configurações de pagamento');
}

const view = (cfg: XpagSettings | null) => ({
  configured: !!cfg, clientId: cfg?.clientId ?? '', hasSecret: !!cfg?.clientSecret, currency: cfg?.currency ?? 'MXN',
  currencies: Object.entries(XPAG_CURRENCIES).map(([id, c]) => ({ id, label: c.label, methods: c.methods })),
});

xpagRouter.get('/', asyncHandler(async (req, res) => {
  const cfg = await getXpag(req.accountId!);
  const [st] = (await db.execute(sql`select count(*)::int as n, count(*) filter (where status = 'approved')::int as paid
    from sales where account_id = ${req.accountId!} and external_id like ${`${PREFIX}%`} and created_at >= now() - interval '30 days'`)).rows as { n: number; paid: number }[];
  res.json({ ...view(cfg), last30: { charges: Number(st?.n ?? 0), paid: Number(st?.paid ?? 0) } });
}));

const settingsSchema = z.object({
  clientId: z.string().trim().max(200),
  clientSecret: z.string().trim().max(400).optional(),
  currency: z.string().trim().toUpperCase().optional(),
  disconnect: z.boolean().optional(),
});

xpagRouter.put('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = settingsSchema.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const cur = await getXpag(req.accountId!);
  let value: XpagSettings | null = null;
  if (!p.data.disconnect) {
    const clientId = p.data.clientId;
    const clientSecret = p.data.clientSecret || cur?.clientSecret || '';
    if (!clientId || !clientSecret) throw new AppError(422, 'Informe o Client ID e o Client Secret da XPag.');
    const currency = isXpagCurrency(p.data.currency) ? p.data.currency : (cur?.currency ?? 'MXN');
    value = { clientId, clientSecret, currency };
    // confere a chave antes de salvar (a consulta de saldo é a mais barata)
    let r;
    try { r = await call<any>(value, 'GET', '/balance'); } catch { throw new AppError(502, 'A XPag não respondeu. Tente de novo em instantes.'); }
    if (r.status === 401 || r.status === 403) throw new AppError(422, errorText(r.data, r.status));
  }
  await db.execute(sql`update accounts set settings = case when ${value === null}
      then coalesce(settings, '{}'::jsonb) - 'xpag'
      else coalesce(settings, '{}'::jsonb) || jsonb_build_object('xpag', ${JSON.stringify(value)}::jsonb) end
    where id = ${req.accountId!}`);
  res.json(view(await getXpag(req.accountId!)));
}));

/** Testa a chave: consulta o saldo (não cria cobrança). */
xpagRouter.post('/test', asyncHandler(async (req, res) => {
  managerOnly(req);
  const cfg = await getXpag(req.accountId!);
  if (!cfg) throw new AppError(422, 'Salve o Client ID e o Client Secret primeiro.');
  let r;
  try { r = await call<any>(cfg, 'GET', '/balance'); } catch { throw new AppError(502, 'A XPag não respondeu. Tente de novo em instantes.'); }
  if (r.status >= 300 || r.data?.ok === false) throw new AppError(422, errorText(r.data, r.status));
  const balances = (r.data?.balances ?? {}) as Record<string, any>;
  const list = Object.entries(balances).map(([currency, b]) => ({ currency, available: Number(b?.available ?? b ?? 0) }));
  res.json({ ok: true, balances: list, sandbox: !!r.data?.sandbox });
}));
