import { Router } from 'express';
import { z } from 'zod';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';

export const teamRouter = Router();

teamRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select({
    membershipId: schema.memberships.id,
    role: schema.memberships.role,
    userId: schema.users.id,
    name: schema.users.name,
    email: schema.users.email,
  }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.accountId, req.accountId!));
  res.json({ members: rows });
}));

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['admin', 'agent']).default('agent') });

// Adiciona um usuário já cadastrado à conta. (Convite por e-mail a quem não tem
// conta ainda é um próximo passo — exigiria envio de e-mail.)
teamRouter.post('/invite', asyncHandler(async (req, res) => {
  if (req.role !== 'owner' && req.role !== 'admin') throw new AppError(403, 'Apenas owner/admin podem convidar');
  const { email, role } = inviteSchema.parse(req.body);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) throw new AppError(404, 'Esse e-mail ainda não tem cadastro no Converza');
  const [row] = await db.insert(schema.memberships)
    .values({ userId: user.id, accountId: req.accountId!, role })
    .onConflictDoUpdate({ target: [schema.memberships.userId, schema.memberships.accountId], set: { role } })
    .returning();
  res.status(201).json({ membership: row });
}));

teamRouter.patch('/:membershipId', asyncHandler(async (req, res) => {
  if (req.role !== 'owner' && req.role !== 'admin') throw new AppError(403, 'Permissão insuficiente');
  const role = z.enum(['admin', 'agent']).parse(req.body.role);
  const [row] = await db.update(schema.memberships).set({ role })
    .where(and(eq(schema.memberships.id, req.params.membershipId), eq(schema.memberships.accountId, req.accountId!),
      ne(schema.memberships.role, 'owner'))).returning();
  if (!row) throw new AppError(404, 'Membro não encontrado');
  res.json({ membership: row });
}));

teamRouter.delete('/:membershipId', asyncHandler(async (req, res) => {
  if (req.role !== 'owner' && req.role !== 'admin') throw new AppError(403, 'Permissão insuficiente');
  const [row] = await db.delete(schema.memberships)
    .where(and(eq(schema.memberships.id, req.params.membershipId), eq(schema.memberships.accountId, req.accountId!),
      ne(schema.memberships.role, 'owner'))).returning({ id: schema.memberships.id });
  if (!row) throw new AppError(404, 'Membro não encontrado ou é o dono');
  res.status(204).end();
}));
