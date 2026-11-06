import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';

export const contactsRouter = Router();

contactsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const q = (req.query.q as string | undefined)?.trim();
  const where = q
    ? and(eq(schema.contacts.accountId, accountId),
        or(ilike(schema.contacts.name, `%${q}%`), ilike(schema.contacts.phone, `%${q}%`)))
    : eq(schema.contacts.accountId, accountId);

  const rows = await db.select().from(schema.contacts).where(where)
    .orderBy(sql`${schema.contacts.lastContactAt} desc nulls last`).limit(200);
  res.json({ contacts: rows });
}));

const upsertSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  stage: z.enum(['new', 'in_service', 'negotiating', 'won', 'lost']).optional(),
  tags: z.array(z.string()).optional(),
  value: z.number().nonnegative().optional(),
});

contactsRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const data = upsertSchema.parse(req.body);
  const [row] = await db.insert(schema.contacts).values({
    accountId, name: data.name, phone: data.phone,
    stage: data.stage, tags: data.tags, value: data.value?.toFixed(2),
  }).onConflictDoUpdate({
    target: [schema.contacts.accountId, schema.contacts.phone],
    set: { name: data.name, ...(data.stage ? { stage: data.stage } : {}) },
  }).returning();
  res.status(201).json({ contact: row });
}));

contactsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const data = upsertSchema.partial().parse(req.body);
  const [row] = await db.update(schema.contacts).set({
    ...(data.name ? { name: data.name } : {}),
    ...(data.stage ? { stage: data.stage } : {}),
    ...(data.tags ? { tags: data.tags } : {}),
    ...(data.value !== undefined ? { value: data.value.toFixed(2) } : {}),
  }).where(and(eq(schema.contacts.id, req.params.id), eq(schema.contacts.accountId, accountId))).returning();
  if (!row) throw new AppError(404, 'Contato não encontrado');
  res.json({ contact: row });
}));
