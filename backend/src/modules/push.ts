/**
 * Notificações no celular (Web Push): cada usuário ativa nos aparelhos dele (Converza instalada na tela de
 * início do iPhone, ou no Chrome do Android/computador) e recebe "Venda aprovada" na hora, com o app fechado.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import webpush from 'web-push';
import { config } from '../config';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';

export const pushRouter = Router();

let ready: boolean | null = null;
export function pushConfigured() {
  if (ready !== null) return ready;
  const { publicKey, privateKey } = config.push;
  if (!publicKey || !privateKey) return (ready = false);
  try {
    const subject = config.push.subject || (config.appOrigin.startsWith('https://') ? config.appOrigin : 'https://converza.app');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    ready = true;
  } catch (err) {
    console.error('[push] chaves VAPID inválidas:', (err as Error).message);
    ready = false;
  }
  return ready;
}

export interface PushMessage { title: string; body: string; url?: string; tag?: string }
type Sub = typeof schema.pushSubscriptions.$inferSelect;

export async function deliver(subs: Sub[], msg: PushMessage) {
  return (await deliverDetailed(subs, msg)).sent;
}
export async function deliverDetailed(subs: Sub[], msg: PushMessage): Promise<{ sent: number; failed: { id: string; error: string }[]; removed: number }> {
  if (!subs.length || !pushConfigured()) return { sent: 0, failed: [], removed: 0 };
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '/', tag: msg.tag });
  let sent = 0;
  const gone: string[] = [];
  const failed: { id: string; error: string }[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600, urgency: 'high' });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.id); // aparelho desinstalou ou revogou: sai da lista
      else { console.error('[push] envio:', code ?? '', (err as Error).message); failed.push({ id: s.id, error: `${code ?? ''} ${(err as Error).message}`.trim().slice(0, 200) }); }
    }
  }));
  if (gone.length) await db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, gone));
  if (sent) await db.update(schema.pushSubscriptions).set({ lastSentAt: new Date() })
    .where(inArray(schema.pushSubscriptions.id, subs.filter((s) => !gone.includes(s.id)).map((s) => s.id)));
  return { sent, failed, removed: gone.length };
}

/* ------------------------------------------------------------- mensagem de venda */

export const SALE_TEMPLATE_DEFAULT = { title: '💰 Venda aprovada · {valor}', body: '{produto} · {cliente}' };
export const SALE_VARS: [string, string][] = [
  ['valor', 'Valor da venda'], ['produto', 'Produto'], ['cliente', 'Nome do cliente'], ['telefone', 'Telefone do cliente'],
  ['origem', 'Anúncio ou orgânico'], ['conexao', 'Número de WhatsApp'], ['empresa', 'Nome da empresa'],
  ['vendas_hoje', 'Vendas aprovadas hoje'], ['faturamento_hoje', 'Faturamento de hoje'],
];

/** Troca {variavel} pelos valores e limpa separadores que sobraram de variáveis vazias. */
export function renderTemplate(tpl: string, vars: Record<string, string>, max: number) {
  let out = tpl.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m));
  out = out.split('\n').map((line) => line
    .replace(/(\s*[·|•\-–]\s*){2,}/g, ' · ')
    .replace(/^\s*[·|•\-–]\s*/, '').replace(/\s*[·|•\-–]\s*$/, '')
    .replace(/\s{2,}/g, ' ').trim()).filter((l) => l).join('\n');
  return out.slice(0, max);
}
export function saleMessage(tpl: { title: string; body: string } | null | undefined, vars: Record<string, string>) {
  const t = tpl?.title?.trim() || tpl?.body?.trim() ? tpl! : SALE_TEMPLATE_DEFAULT;
  return { title: renderTemplate(t.title || SALE_TEMPLATE_DEFAULT.title, vars, 120) || 'Venda aprovada', body: renderTemplate(t.body ?? '', vars, 300) };
}

/** Aparelhos da empresa que querem o aviso, com o modelo de mensagem de cada pessoa. */
async function subsWithTemplates(accountId: string, kind: 'sales') {
  return db.select({ s: schema.pushSubscriptions, tpl: schema.memberships.pushSaleTemplate }).from(schema.pushSubscriptions)
    .innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.pushSubscriptions.userId), eq(schema.memberships.accountId, schema.pushSubscriptions.accountId)))
    .where(and(eq(schema.pushSubscriptions.accountId, accountId), sql`coalesce((${schema.pushSubscriptions.prefs}->>${kind})::boolean, true)`));
}

/** Envia a venda: cada pessoa recebe no formato que escolheu. */
export async function pushSaleToAccount(accountId: string, vars: Record<string, string>, tag: string, onlySubs?: string[]) {
  const list = (await subsWithTemplates(accountId, 'sales')).filter((x) => !onlySubs || onlySubs.includes(x.s.id));
  const groups = new Map<string, { tpl: { title: string; body: string } | null; subs: Sub[] }>();
  for (const x of list) {
    const k = x.s.userId;
    const g = groups.get(k) ?? { tpl: x.tpl ?? null, subs: [] };
    g.subs.push(x.s); groups.set(k, g);
  }
  const out = { sent: 0, failed: [] as { id: string; error: string }[], removed: 0, devices: list.length };
  for (const g of groups.values()) {
    const m = saleMessage(g.tpl, vars);
    const r = await deliverDetailed(g.subs, { ...m, url: '/', tag });
    out.sent += r.sent; out.failed.push(...r.failed); out.removed += r.removed;
  }
  return out;
}

const money = (v: number, cur: string) => {
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cur }).format(v); } catch { return `${cur} ${v.toFixed(2)}`; }
};
const fmtPhone = (p: string | null) => {
  const d = String(p ?? '').replace(/\D/g, '');
  if (!d) return '';
  const br = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  return br.length >= 10 ? `(${br.slice(0, 2)}) ${br.slice(2, br.length - 4)}-${br.slice(-4)}` : `+${d}`;
};

/** Variáveis de uma venda (as mesmas da prévia na tela). */
async function saleVars(s: typeof schema.sales.$inferSelect) {
  const [acc] = await db.select({ name: schema.accounts.name, tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, s.accountId)).limit(1);
  const [p] = s.productId ? await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, s.productId)).limit(1) : [];
  const [c] = s.connectionId ? await db.select({ name: schema.connections.name }).from(schema.connections).where(eq(schema.connections.id, s.connectionId)).limit(1) : [];
  const tz = acc?.tz || 'America/Sao_Paulo';
  const [t] = (await db.execute(sql`select count(*)::int as n, coalesce(sum(amount), 0)::float as v from sales
    where account_id = ${s.accountId} and status = 'approved' and currency = ${s.currency}
      and created_at >= (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`)).rows as { n: number; v: number }[];
  return {
    valor: money(Number(s.amount), s.currency), produto: p?.name ?? s.productName ?? '',
    // sem nome, o contato fica com o telefone como nome: não repete o número
    cliente: /^\+?[\d\s().-]{7,}$/.test(s.customerName ?? '') ? '' : (s.customerName ?? ''),
    telefone: fmtPhone(s.customerPhone), origem: s.sourceId ? 'Anúncio' : 'Orgânico', conexao: c?.name ?? '', empresa: acc?.name ?? '',
    vendas_hoje: String(Number(t?.n ?? 0)), faturamento_hoje: money(Number(t?.v ?? 0), s.currency),
  };
}

/** Exemplo para prévias e simulações. */
export const SAMPLE_VARS = (empresa = 'Sua empresa') => ({
  valor: 'R$ 47,00', produto: 'Ebook Novena', cliente: 'Maria Lúcia', telefone: '(11) 98888-7777', origem: 'Anúncio',
  conexao: 'Número principal', empresa, vendas_hoje: '12', faturamento_hoje: 'R$ 564,00',
});

/** "Venda aprovada" — uma vez por venda, mesmo que o checkout reenvie o pedido. */
export async function notifySaleApproved(saleId: string) {
  if (!pushConfigured()) return;
  try {
    const [s] = await db.update(schema.sales).set({ pushNotifiedAt: new Date() })
      .where(and(eq(schema.sales.id, saleId), eq(schema.sales.status, 'approved'), isNull(schema.sales.pushNotifiedAt))).returning();
    if (!s) return;
    await pushSaleToAccount(s.accountId, await saleVars(s), `sale-${s.id}`);
  } catch (err) {
    console.error('[push] venda aprovada:', (err as Error).message);
  }
}

/* ------------------------------------------------------------------- API */

const subSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(300), auth: z.string().min(8).max(100) }),
});

pushRouter.get('/', asyncHandler(async (req, res) => {
  const mine = await db.select({ id: schema.pushSubscriptions.id, endpoint: schema.pushSubscriptions.endpoint, device: schema.pushSubscriptions.device,
    prefs: schema.pushSubscriptions.prefs, createdAt: schema.pushSubscriptions.createdAt, lastSentAt: schema.pushSubscriptions.lastSentAt })
    .from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.userId, req.user!.id), eq(schema.pushSubscriptions.accountId, req.accountId!)));
  res.json({ configured: pushConfigured(), publicKey: pushConfigured() ? config.push.publicKey : null, devices: mine });
}));

/** Mensagem de venda desta pessoa nesta empresa (null = padrão). */
pushRouter.get('/template', asyncHandler(async (req, res) => {
  const [m] = await db.select({ tpl: schema.memberships.pushSaleTemplate, account: schema.accounts.name }).from(schema.memberships)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.memberships.accountId))
    .where(and(eq(schema.memberships.userId, req.user!.id), eq(schema.memberships.accountId, req.accountId!))).limit(1);
  res.json({ template: m?.tpl ?? null, default: SALE_TEMPLATE_DEFAULT, vars: SALE_VARS, sample: SAMPLE_VARS(m?.account ?? undefined) });
}));

pushRouter.put('/template', asyncHandler(async (req, res) => {
  const d = z.object({ title: z.string().trim().max(120), body: z.string().max(300) }).nullable().parse(req.body?.template ?? null);
  const tpl = d && (d.title || d.body.trim()) ? { title: d.title || SALE_TEMPLATE_DEFAULT.title, body: d.body.trim() } : null;
  await db.update(schema.memberships).set({ pushSaleTemplate: tpl })
    .where(and(eq(schema.memberships.userId, req.user!.id), eq(schema.memberships.accountId, req.accountId!)));
  res.json({ template: tpl });
}));

/** Prévia real: manda a mensagem de venda (com dados de exemplo) para os meus aparelhos. */
pushRouter.post('/template/test', asyncHandler(async (req, res) => {
  const mine = await db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.userId, req.user!.id), eq(schema.pushSubscriptions.accountId, req.accountId!)));
  if (!mine.length) throw new AppError(400, 'Ative as notificações em pelo menos um aparelho para testar.');
  const [acc] = await db.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, req.accountId!)).limit(1);
  const r = await pushSaleToAccount(req.accountId!, SAMPLE_VARS(acc?.name), 'sale-preview', mine.map((x) => x.id));
  if (!r.sent) throw new AppError(502, 'Nenhum aparelho recebeu. Ative as notificações de novo neste aparelho.');
  res.json(r);
}));

pushRouter.post('/subscribe', asyncHandler(async (req, res) => {
  if (!pushConfigured()) throw new AppError(503, 'As notificações ainda não foram configuradas no servidor (chaves VAPID).');
  const d = z.object({ subscription: subSchema, device: z.string().trim().max(120).optional(), sales: z.boolean().default(true) }).parse(req.body);
  const [row] = await db.insert(schema.pushSubscriptions).values({
    userId: req.user!.id, accountId: req.accountId!, endpoint: d.subscription.endpoint,
    p256dh: d.subscription.keys.p256dh, auth: d.subscription.keys.auth, device: d.device ?? null, prefs: { sales: d.sales },
  }).onConflictDoUpdate({
    target: [schema.pushSubscriptions.accountId, schema.pushSubscriptions.endpoint],
    set: { userId: req.user!.id, p256dh: d.subscription.keys.p256dh, auth: d.subscription.keys.auth, device: d.device ?? null },
  }).returning({ id: schema.pushSubscriptions.id });
  res.json({ id: row.id });
}));

async function ownDevice(userId: string, accountId: string, id: string) {
  const [d] = await db.select().from(schema.pushSubscriptions)
    .where(and(eq(schema.pushSubscriptions.id, id), eq(schema.pushSubscriptions.userId, userId), eq(schema.pushSubscriptions.accountId, accountId))).limit(1);
  if (!d) throw new AppError(404, 'Aparelho não encontrado');
  return d;
}

pushRouter.patch('/:id', asyncHandler(async (req, res) => {
  await ownDevice(req.user!.id, req.accountId!, req.params.id);
  const d = z.object({ sales: z.boolean() }).parse(req.body);
  await db.update(schema.pushSubscriptions).set({ prefs: { sales: d.sales } }).where(eq(schema.pushSubscriptions.id, req.params.id));
  res.json({ ok: true });
}));

pushRouter.delete('/:id', asyncHandler(async (req, res) => {
  await ownDevice(req.user!.id, req.accountId!, req.params.id);
  await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, req.params.id));
  res.json({ ok: true });
}));

/** Notificação de teste para um aparelho meu. */
pushRouter.post('/:id/test', asyncHandler(async (req, res) => {
  const d = await ownDevice(req.user!.id, req.accountId!, req.params.id);
  const sent = await deliver([d], { title: '🔔 Notificações ligadas', body: 'É assim que as vendas aprovadas vão chegar neste aparelho.', url: '/', tag: 'push-test' });
  if (!sent) throw new AppError(502, 'O aparelho não recebeu. Ative as notificações de novo neste aparelho.');
  res.json({ ok: true });
}));
