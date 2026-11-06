import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';

export const flowsRouter = Router();

flowsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.flows)
    .where(eq(schema.flows.accountId, req.accountId!)).orderBy(desc(schema.flows.createdAt));
  const counts = await db.select({ flowId: schema.flowRuns.flowId, runs: sql<number>`count(*)` })
    .from(schema.flowRuns).where(eq(schema.flowRuns.accountId, req.accountId!))
    .groupBy(schema.flowRuns.flowId);
  const byFlow = new Map(counts.map((c) => [c.flowId, Number(c.runs)]));
  res.json({ flows: rows.map((f) => ({ ...f, runs: byFlow.get(f.id) ?? 0 })) });
}));

flowsRouter.get('/:id', asyncHandler(async (req, res) => {
  const [row] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, req.params.id), eq(schema.flows.accountId, req.accountId!))).limit(1);
  if (!row) throw new AppError(404, 'Fluxo não encontrado');
  res.json({ flow: row });
}));

const upsert = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  trigger: z.record(z.any()).optional(),
  graph: z.object({ nodes: z.array(z.any()), edges: z.array(z.any()) }).optional(),
});

flowsRouter.post('/', asyncHandler(async (req, res) => {
  const data = upsert.parse(req.body);
  const [row] = await db.insert(schema.flows).values({
    accountId: req.accountId!, name: data.name ?? 'Novo fluxo',
    trigger: data.trigger ?? { type: 'inbound_message' }, graph: data.graph ?? { nodes: [], edges: [] },
  }).returning();
  res.status(201).json({ flow: row });
}));

flowsRouter.put('/:id', asyncHandler(async (req, res) => {
  const data = upsert.parse(req.body);
  const [row] = await db.update(schema.flows).set({
    ...(data.name ? { name: data.name } : {}),
    ...(data.status ? { status: data.status } : {}),
    ...(data.trigger ? { trigger: data.trigger } : {}),
    ...(data.graph ? { graph: data.graph } : {}),
  }).where(and(eq(schema.flows.id, req.params.id), eq(schema.flows.accountId, req.accountId!))).returning();
  if (!row) throw new AppError(404, 'Fluxo não encontrado');
  res.json({ flow: row });
}));

flowsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const [row] = await db.delete(schema.flows)
    .where(and(eq(schema.flows.id, req.params.id), eq(schema.flows.accountId, req.accountId!)))
    .returning({ id: schema.flows.id });
  if (!row) throw new AppError(404, 'Fluxo não encontrado');
  res.status(204).end();
}));
