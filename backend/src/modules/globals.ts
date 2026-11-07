/** Variáveis globais: valores da conta usados nos fluxos como {{g_nome}} (os fluxos também podem mudar). */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, ilike, ne, or } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';
import { globalKey, toNumber } from '../flows/globals';

export const globalsRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mexem nas variáveis globais.');
}

const fields = z.object({
  name: z.string().trim().min(1, 'Dê um nome à variável').max(42),
  description: z.string().trim().max(300).default(''),
  type: z.enum(['text', 'number']).default('text'),
  value: z.string().max(2000, 'Valor muito longo (até 2.000 letras)').default(''),
});

function checkValue(type: string, value: string) {
  if (type === 'number' && value.trim() !== '' && Number.isNaN(toNumber(value))) {
    throw new AppError(422, 'Para o tipo Número, o valor precisa ser um número (ex.: 10 ou 2,5).');
  }
  return type === 'number' && value.trim() !== '' ? String(toNumber(value)) : value;
}

globalsRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const like = q ? `%${q}%` : null;
  const rows = await db.select().from(schema.globalVariables).where(and(
    eq(schema.globalVariables.accountId, req.accountId!),
    ...(like ? [or(ilike(schema.globalVariables.key, like), ilike(schema.globalVariables.description, like))!] : []),
  )).orderBy(asc(schema.globalVariables.key));
  res.json({ variables: rows, canEdit: req.role !== 'agent' });
}));

globalsRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = fields.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const key = globalKey(p.data.name);
  if (!key) throw new AppError(422, 'Use letras, números e _ no nome (ex.: nome_01).');
  const value = checkValue(p.data.type, p.data.value);
  try {
    const [row] = await db.insert(schema.globalVariables).values({ accountId: req.accountId!, key, description: p.data.description, type: p.data.type, value }).returning();
    emitToAccount(req.accountId!, 'globals:changed', {});
    res.status(201).json({ variable: row });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, `Já existe a variável {{${key}}}.`);
    throw err;
  }
}));

globalsRouter.patch('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Variável não encontrada');
  const p = fields.partial().safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const [cur] = await db.select().from(schema.globalVariables)
    .where(and(eq(schema.globalVariables.id, req.params.id), eq(schema.globalVariables.accountId, req.accountId!))).limit(1);
  if (!cur) throw new AppError(404, 'Variável não encontrada');
  const type = p.data.type ?? cur.type;
  const patch: Partial<typeof schema.globalVariables.$inferInsert> = { updatedAt: new Date(), type };
  if (p.data.description !== undefined) patch.description = p.data.description;
  if (p.data.value !== undefined || p.data.type !== undefined) patch.value = checkValue(type, p.data.value ?? cur.value);
  if (p.data.name !== undefined) {
    const key = globalKey(p.data.name);
    if (!key) throw new AppError(422, 'Use letras, números e _ no nome.');
    const [dup] = await db.select({ id: schema.globalVariables.id }).from(schema.globalVariables)
      .where(and(eq(schema.globalVariables.accountId, req.accountId!), eq(schema.globalVariables.key, key), ne(schema.globalVariables.id, cur.id))).limit(1);
    if (dup) throw new AppError(409, `Já existe a variável {{${key}}}.`);
    patch.key = key;
  }
  const [row] = await db.update(schema.globalVariables).set(patch).where(eq(schema.globalVariables.id, cur.id)).returning();
  emitToAccount(req.accountId!, 'globals:changed', {});
  res.json({ variable: row, renamed: patch.key && patch.key !== cur.key ? { from: cur.key, to: patch.key } : null });
}));

globalsRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Variável não encontrada');
  await db.delete(schema.globalVariables).where(and(eq(schema.globalVariables.id, req.params.id), eq(schema.globalVariables.accountId, req.accountId!)));
  emitToAccount(req.accountId!, 'globals:changed', {});
  res.status(204).end();
}));
