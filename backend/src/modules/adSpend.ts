import { Router } from 'express';
import { z } from 'zod';
import { and, between, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';

/**
 * Investimento em anúncios por dia: lançado à mão ou puxado das contas de anúncios da Meta
 * escolhidas em Facebook › Perfis e contas (origin = 'meta', atualizado a cada hora).
 */
export const adSpendRouter = Router();

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

adSpendRouter.get('/', asyncHandler(async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  const where = isDate(from) && isDate(to)
    ? and(eq(schema.adSpend.accountId, req.accountId!), between(schema.adSpend.date, from, to))
    : eq(schema.adSpend.accountId, req.accountId!);
  const list = await db.select().from(schema.adSpend).where(where).orderBy(desc(schema.adSpend.date), desc(schema.adSpend.createdAt)).limit(500);
  res.json({ entries: list.map((e) => ({ ...e, amount: Number(e.amount) })) });
}));

adSpendRouter.post('/', asyncHandler(async (req, res) => {
  const d = z.object({
    date: z.string().refine(isDate, 'Data inválida'),
    amount: z.number().positive().max(100_000_000),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    campaignName: z.string().trim().max(160).optional().nullable(),
  }).parse(req.body);
  const [row] = await db.insert(schema.adSpend).values({
    accountId: req.accountId!, date: d.date, amount: d.amount.toFixed(2), currency: (d.currency ?? 'BRL').toUpperCase(),
    campaignName: d.campaignName || null, platform: 'meta', origin: 'manual',
  }).returning();
  emitToAccount(req.accountId!, 'sale:changed', { adSpend: row.id });
  res.status(201).json({ entry: { ...row, amount: Number(row.amount) } });
}));

adSpendRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Lançamento não encontrado');
  const [cur] = await db.select({ origin: schema.adSpend.origin }).from(schema.adSpend)
    .where(and(eq(schema.adSpend.id, req.params.id), eq(schema.adSpend.accountId, req.accountId!))).limit(1);
  if (cur?.origin === 'meta') {
    throw new AppError(409, 'Esse gasto vem da conta de anúncios da Meta e se atualiza sozinho. Para tirar do Dashboard, desligue a conta em Facebook › Perfis e contas.');
  }
  const [row] = await db.delete(schema.adSpend)
    .where(and(eq(schema.adSpend.id, req.params.id), eq(schema.adSpend.accountId, req.accountId!)))
    .returning({ id: schema.adSpend.id });
  if (!row) throw new AppError(404, 'Lançamento não encontrado');
  emitToAccount(req.accountId!, 'sale:changed', { adSpend: row.id });
  res.status(204).end();
}));
