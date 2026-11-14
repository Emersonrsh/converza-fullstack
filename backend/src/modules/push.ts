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

async function deliver(subs: Sub[], msg: PushMessage) {
  if (!subs.length || !pushConfigured()) return 0;
  const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '/', tag: msg.tag });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 24 * 3600, urgency: 'high' });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.id); // aparelho desinstalou ou revogou: sai da lista
      else console.error('[push] envio:', code ?? '', (err as Error).message);
    }
  }));
  if (gone.length) await db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.id, gone));
  if (sent) await db.update(schema.pushSubscriptions).set({ lastSentAt: new Date() })
    .where(inArray(schema.pushSubscriptions.id, subs.filter((s) => !gone.includes(s.id)).map((s) => s.id)));
  return sent;
}

/** Envia para os aparelhos dos membros da empresa que querem esse tipo de aviso. */
export async function pushToAccount(accountId: string, kind: 'sales', msg: PushMessage) {
  if (!pushConfigured()) return 0;
  const subs = await db.select({ s: schema.pushSubscriptions }).from(schema.pushSubscriptions)
    .innerJoin(schema.memberships, and(eq(schema.memberships.userId, schema.pushSubscriptions.userId), eq(schema.memberships.accountId, schema.pushSubscriptions.accountId)))
    .where(and(eq(schema.pushSubscriptions.accountId, accountId), sql`coalesce((${schema.pushSubscriptions.prefs}->>${kind})::boolean, true)`));
  return deliver(subs.map((x) => x.s), msg);
}

const money = (v: number, cur: string) => {
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cur }).format(v); } catch { return `${cur} ${v.toFixed(2)}`; }
};

/** "Venda aprovada" — uma vez por venda, mesmo que o checkout reenvie o pedido. */
export async function notifySaleApproved(saleId: string) {
  if (!pushConfigured()) return;
  try {
    const [s] = await db.update(schema.sales).set({ pushNotifiedAt: new Date() })
      .where(and(eq(schema.sales.id, saleId), eq(schema.sales.status, 'approved'), isNull(schema.sales.pushNotifiedAt))).returning();
    if (!s) return;
    const [acc] = await db.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, s.accountId)).limit(1);
    const [p] = s.productId ? await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, s.productId)).limit(1) : [];
    const product = p?.name ?? s.productName;
    // quem tem mais de uma empresa vê de qual veio
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from memberships m join push_subscriptions ps on ps.user_id = m.user_id
      where ps.account_id = ${s.accountId} and m.account_id <> ${s.accountId}`)).rows as { n: number }[];
    const extra = Number(n) > 0 && acc ? { account: acc.name } : null;
    const body = [product, s.customerName].filter(Boolean).join(' · ') || 'Nova venda no Converza';
    await pushToAccount(s.accountId, 'sales', {
      title: `💰 Venda aprovada · ${money(Number(s.amount), s.currency)}`,
      body: extra?.account ? `${body}\n${extra.account}` : body,
      url: '/', tag: `sale-${s.id}`,
    });
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
