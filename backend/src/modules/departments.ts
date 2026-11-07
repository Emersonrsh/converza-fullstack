/** Setores de atendimento: nome e cor. Membros e conversas apontam para o setor. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';

export const departmentsRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mexem nos setores.');
}

export const DEPARTMENT_COLORS = ['#3b82f6', '#0e9488', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

const body = z.object({
  name: z.string().trim().min(2, 'Dê um nome com pelo menos 2 letras').max(40, 'Nome muito longo (até 40 letras)'),
  color: z.string().trim().regex(/^#[0-9a-f]{6}$/i, 'Cor inválida').default('#3b82f6'),
});

departmentsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const rows = await db.execute(sql`
    select d.id, d.name, d.color, d.created_at as "createdAt",
      (select count(*)::int from memberships m where m.department_id = d.id) as members,
      (select count(*)::int from conversations v where v.department_id = d.id and v.status <> 'resolved' and v.assigned_user_id is null) as waiting
    from departments d where d.account_id = ${accountId} order by lower(d.name)`);
  res.json({ departments: rows.rows, canEdit: req.role !== 'agent' });
}));

async function nameTaken(accountId: string, name: string, exceptId?: string) {
  const [d] = await db.select({ id: schema.departments.id }).from(schema.departments).where(and(
    eq(schema.departments.accountId, accountId), sql`lower(${schema.departments.name}) = ${name.toLowerCase()}`,
    ...(exceptId ? [ne(schema.departments.id, exceptId)] : []),
  )).limit(1);
  return !!d;
}

departmentsRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = body.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  if (await nameTaken(req.accountId!, p.data.name)) throw new AppError(409, 'Já existe um setor com esse nome.');
  const [row] = await db.insert(schema.departments).values({ accountId: req.accountId!, ...p.data }).returning();
  emitToAccount(req.accountId!, 'departments:changed', {});
  res.status(201).json({ department: row });
}));

departmentsRouter.patch('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Setor não encontrado');
  const p = body.partial().safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  if (p.data.name && await nameTaken(req.accountId!, p.data.name, req.params.id)) throw new AppError(409, 'Já existe um setor com esse nome.');
  const [row] = await db.update(schema.departments).set(p.data)
    .where(and(eq(schema.departments.id, req.params.id), eq(schema.departments.accountId, req.accountId!))).returning();
  if (!row) throw new AppError(404, 'Setor não encontrado');
  emitToAccount(req.accountId!, 'departments:changed', {});
  res.json({ department: row });
}));

/** Excluir: os membros ficam sem setor e as conversas da fila do setor voltam para a fila geral. */
departmentsRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Setor não encontrado');
  const [row] = await db.delete(schema.departments)
    .where(and(eq(schema.departments.id, req.params.id), eq(schema.departments.accountId, req.accountId!))).returning({ id: schema.departments.id });
  if (!row) throw new AppError(404, 'Setor não encontrado');
  emitToAccount(req.accountId!, 'departments:changed', {});
  res.status(204).end();
}));

export async function departmentsOf(accountId: string) {
  return db.select({ id: schema.departments.id, name: schema.departments.name, color: schema.departments.color })
    .from(schema.departments).where(eq(schema.departments.accountId, accountId)).orderBy(asc(schema.departments.name));
}
