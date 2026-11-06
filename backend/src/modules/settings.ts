import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';

export const settingsRouter = Router();

/* ---- conta ---- */
settingsRouter.get('/account', asyncHandler(async (req, res) => {
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, req.accountId!)).limit(1);
  res.json({ account: row });
}));

settingsRouter.patch('/account', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(1).optional(), timezone: z.string().optional() }).parse(req.body);
  const [row] = await db.update(schema.accounts).set(data)
    .where(eq(schema.accounts.id, req.accountId!)).returning();
  res.json({ account: row });
}));

/* ---- etiquetas ---- */
settingsRouter.get('/tags', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.tags).where(eq(schema.tags.accountId, req.accountId!));
  res.json({ tags: rows });
}));

settingsRouter.post('/tags', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().min(1), color: z.string().optional() }).parse(req.body);
  const [row] = await db.insert(schema.tags)
    .values({ accountId: req.accountId!, name: data.name, color: data.color ?? '#0e9488' })
    .onConflictDoNothing().returning();
  res.status(201).json({ tag: row });
}));

settingsRouter.delete('/tags/:id', asyncHandler(async (req, res) => {
  await db.delete(schema.tags)
    .where(and(eq(schema.tags.id, req.params.id), eq(schema.tags.accountId, req.accountId!)));
  res.status(204).end();
}));

/* ---- produtos ---- */
settingsRouter.get('/products', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.products).where(eq(schema.products.accountId, req.accountId!));
  res.json({ products: rows });
}));

const checkoutUrl = z.string().trim().max(1000)
  .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'O link precisa começar com http:// ou https://')
  .optional();

settingsRouter.post('/products', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(1), price: z.number().nonnegative(), checkoutUrl }).parse(req.body);
  const [row] = await db.insert(schema.products)
    .values({ accountId: req.accountId!, name: data.name, price: data.price.toFixed(2), checkoutUrl: data.checkoutUrl || null })
    .returning();
  res.status(201).json({ product: row });
}));

settingsRouter.patch('/products/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Produto não encontrado');
  const data = z.object({
    name: z.string().trim().min(1).optional(), price: z.number().nonnegative().optional(), checkoutUrl,
  }).parse(req.body);
  const [row] = await db.update(schema.products).set({
    ...(data.name ? { name: data.name } : {}),
    ...(data.price !== undefined ? { price: data.price.toFixed(2) } : {}),
    ...(data.checkoutUrl !== undefined ? { checkoutUrl: data.checkoutUrl || null } : {}),
  }).where(and(eq(schema.products.id, req.params.id), eq(schema.products.accountId, req.accountId!))).returning();
  if (!row) throw new AppError(404, 'Produto não encontrado');
  res.json({ product: row });
}));

settingsRouter.delete('/products/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Produto não encontrado');
  const [row] = await db.delete(schema.products)
    .where(and(eq(schema.products.id, req.params.id), eq(schema.products.accountId, req.accountId!)))
    .returning({ id: schema.products.id });
  if (!row) throw new AppError(404, 'Produto não encontrado');
  res.status(204).end();
}));
