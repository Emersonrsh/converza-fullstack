import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';

export const flowFoldersRouter = Router();

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida');

async function ownFolder(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Pasta não encontrada');
  const [f] = await db.select().from(schema.flowFolders)
    .where(and(eq(schema.flowFolders.id, id), eq(schema.flowFolders.accountId, accountId))).limit(1);
  if (!f) throw new AppError(404, 'Pasta não encontrada');
  return f;
}

flowFoldersRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const folders = await db.select().from(schema.flowFolders)
    .where(eq(schema.flowFolders.accountId, accountId)).orderBy(asc(schema.flowFolders.name));
  const counts = await db.select({ folderId: schema.flows.folderId, n: sql<number>`count(*)` })
    .from(schema.flows)
    .where(and(eq(schema.flows.accountId, accountId), isNull(schema.flows.archivedAt)))
    .groupBy(schema.flows.folderId);
  const byFolder = new Map(counts.map((c) => [c.folderId ?? 'none', Number(c.n)]));
  res.json({
    folders: folders.map((f) => ({ ...f, flowCount: byFolder.get(f.id) ?? 0 })),
    unfiledCount: byFolder.get('none') ?? 0,
  });
}));

flowFoldersRouter.post('/', asyncHandler(async (req, res) => {
  const data = z.object({ name: z.string().trim().min(1).max(60), color: color.optional() }).parse(req.body);
  const [row] = await db.insert(schema.flowFolders)
    .values({ accountId: req.accountId!, name: data.name, color: data.color ?? '#2f73e0' }).returning();
  res.status(201).json({ folder: { ...row, flowCount: 0 } });
}));

flowFoldersRouter.patch('/:id', asyncHandler(async (req, res) => {
  const folder = await ownFolder(req.accountId!, req.params.id);
  const data = z.object({ name: z.string().trim().min(1).max(60).optional(), color: color.optional() }).parse(req.body);
  const [row] = await db.update(schema.flowFolders).set(data).where(eq(schema.flowFolders.id, folder.id)).returning();
  res.json({ folder: row });
}));

/** Exclui a pasta; os fluxos dentro dela voltam para "Sem pasta". */
flowFoldersRouter.delete('/:id', asyncHandler(async (req, res) => {
  const folder = await ownFolder(req.accountId!, req.params.id);
  await db.delete(schema.flowFolders).where(eq(schema.flowFolders.id, folder.id));
  res.status(204).end();
}));
