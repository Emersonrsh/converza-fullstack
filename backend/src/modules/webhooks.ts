import { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError } from '../utils/http';
import { triggerFlowsForInbound, onPaymentApproved } from '../flows/runner';

export const webhooksRouter = Router();

webhooksRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.webhooks)
    .where(eq(schema.webhooks.accountId, req.accountId!)).orderBy(desc(schema.webhooks.createdAt));
  const base = `${config.appOrigin.replace(/:\d+$/, '')}:${config.port}`;
  res.json({ webhooks: rows.map((w) => ({ ...w, url: `${base}/api/v1/hooks/${w.token}` })) });
}));

const createSchema = z.object({ name: z.string().min(1), events: z.array(z.string()).default([]) });

webhooksRouter.post('/', asyncHandler(async (req, res) => {
  const data = createSchema.parse(req.body);
  const token = randomBytes(9).toString('hex');
  const [row] = await db.insert(schema.webhooks)
    .values({ accountId: req.accountId!, name: data.name, events: data.events, token }).returning();
  res.status(201).json({ webhook: row });
}));

webhooksRouter.delete('/:id', asyncHandler(async (req, res) => {
  const [row] = await db.delete(schema.webhooks)
    .where(and(eq(schema.webhooks.id, req.params.id), eq(schema.webhooks.accountId, req.accountId!)))
    .returning({ id: schema.webhooks.id });
  if (!row) throw new AppError(404, 'Webhook não encontrado');
  res.status(204).end();
}));

/**
 * Receptor público de integrações externas (Hotmart, Kiwify, Cartpanda, etc.).
 * Mapeado em /api/v1/hooks/:token — sem auth, identificado pelo token.
 */
export const hooksInRouter = Router();

hooksInRouter.post('/:token', asyncHandler(async (req, res) => {
  const [wh] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.token, req.params.token)).limit(1);
  if (!wh) throw new AppError(404, 'Webhook inválido');
  await db.update(schema.webhooks).set({ hits: sql`${schema.webhooks.hits} + 1` }).where(eq(schema.webhooks.id, wh.id));

  const body = req.body ?? {};
  const customer = body.customer ?? body.buyer ?? {};
  const phone = String(customer.phone ?? customer.whatsapp ?? '').replace(/\D/g, '');
  const name = customer.name ?? 'Cliente';
  const amount = Number(body.amount ?? body.price ?? 0);
  const status = mapSaleStatus(String(body.status ?? body.event ?? ''));

  if (phone) {
    const [contact] = await db.insert(schema.contacts).values({
      accountId: wh.accountId, name, phone, waId: phone, lastContactAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.contacts.accountId, schema.contacts.phone], set: { lastContactAt: new Date() },
    }).returning();

    if (amount > 0) {
      await db.insert(schema.sales).values({
        accountId: wh.accountId, contactId: contact.id, amount: amount.toFixed(2), status,
      });
    }
    // venda aprovada → libera fluxos que aguardavam o pagamento deste contato
    if (status === 'approved') await onPaymentApproved(wh.accountId, contact.id);
    await triggerFlowsForInbound({
      accountId: wh.accountId,
      contactId: contact.id,
      text: String(body.event ?? body.status ?? 'webhook'),
      source: 'webhook',
      webhookId: wh.id,
      vars: {
        evento: String(body.event ?? body.status ?? ''),
        valor: amount > 0 ? amount.toFixed(2) : '',
        produto: String(body.product?.name ?? body.product_name ?? body.produto ?? ''),
        status_venda: status,
      },
    });
  }
  res.sendStatus(200);
}));

function mapSaleStatus(s: string): 'pending' | 'approved' | 'refused' | 'refunded' {
  const v = s.toLowerCase();
  if (v.includes('approv') || v.includes('aprov') || v.includes('paid') || v.includes('complete')) return 'approved';
  if (v.includes('refund') || v.includes('estorn') || v.includes('chargeback')) return 'refunded';
  if (v.includes('refus') || v.includes('recus') || v.includes('declin')) return 'refused';
  return 'pending';
}
