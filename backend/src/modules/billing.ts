import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler } from '../utils/http';
import { PLANS } from './plans';
import { getTokenState, grantPlan } from './tokens';

export const billingRouter = Router();
export { PLANS };

billingRouter.get('/plans', (_req, res) => res.json({ plans: PLANS }));

billingRouter.get('/subscription', asyncHandler(async (req, res) => {
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, req.accountId!)).limit(1);
  res.json({ subscription: sub ?? null });
}));

/** Saldo de tokens de IA — persistido, recarregado no ciclo e debitado no uso. */
billingRouter.get('/tokens', asyncHandler(async (req, res) => {
  res.json(await getTokenState(req.accountId!));
}));

/**
 * Ativa um plano. Pagamento real (Stripe/Pix) entra atrás desta rota: a
 * ativação viria do webhook de pagamento aprovado. Ao ativar, concede a
 * franquia de tokens do plano.
 */
billingRouter.post('/subscribe', asyncHandler(async (req, res) => {
  const { plan } = z.object({ plan: z.enum(['starter', 'growth', 'scale']) }).parse(req.body);
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const [sub] = await db.insert(schema.subscriptions)
    .values({ accountId: req.accountId!, plan, status: 'active', currentPeriodEnd: periodEnd })
    .onConflictDoUpdate({
      target: schema.subscriptions.accountId,
      set: { plan, status: 'active', currentPeriodEnd: periodEnd },
    }).returning();
  await db.update(schema.accounts).set({ subscriptionStatus: 'active' })
    .where(eq(schema.accounts.id, req.accountId!));
  await grantPlan(req.accountId!, plan);

  res.json({ subscription: sub });
}));
