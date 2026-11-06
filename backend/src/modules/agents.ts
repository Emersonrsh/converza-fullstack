import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';

export const agentsRouter = Router();

agentsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.agents)
    .where(eq(schema.agents.accountId, req.accountId!)).orderBy(desc(schema.agents.createdAt));
  res.json({ agents: rows });
}));

const upsert = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  enabled: z.boolean().optional(),
  systemPrompt: z.string().optional(),
});

agentsRouter.post('/', asyncHandler(async (req, res) => {
  const data = upsert.parse(req.body);
  const [row] = await db.insert(schema.agents).values({
    accountId: req.accountId!, name: data.name ?? 'Novo agente',
    model: data.model ?? 'openai/gpt-4o-mini', systemPrompt: data.systemPrompt ?? '',
  }).returning();
  res.status(201).json({ agent: row });
}));

agentsRouter.put('/:id', asyncHandler(async (req, res) => {
  const data = upsert.parse(req.body);
  const [row] = await db.update(schema.agents).set({
    ...(data.name ? { name: data.name } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
  }).where(and(eq(schema.agents.id, req.params.id), eq(schema.agents.accountId, req.accountId!))).returning();
  if (!row) throw new AppError(404, 'Agente não encontrado');
  res.json({ agent: row });
}));

agentsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const [row] = await db.delete(schema.agents)
    .where(and(eq(schema.agents.id, req.params.id), eq(schema.agents.accountId, req.accountId!)))
    .returning({ id: schema.agents.id });
  if (!row) throw new AppError(404, 'Agente não encontrado');
  res.status(204).end();
}));
