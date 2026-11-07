/**
 * Equipe: membros (função e setor), convites pendentes (reenviar/cancelar) e convidar quem já tem cadastro.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emailConfigured } from '../email/mailer';
import { emitToAccount } from '../realtime/io';
import {
  ROLE_LABEL, inviteExpiry, inviteStatus, newToken, normEmail, sendTeamInviteEmail, teamInviteLink,
} from './invites';

export const teamRouter = Router();

const manager = (req: Request) => req.role === 'owner' || req.role === 'admin';
function managerOnly(req: Request) {
  if (!manager(req)) throw new AppError(403, 'Só o dono e os administradores mexem na equipe.');
}

async function ownDepartment(accountId: string, id: string | null | undefined) {
  if (!id) return null;
  if (!isUuid(id)) throw new AppError(422, 'Setor inválido');
  const [d] = await db.select({ id: schema.departments.id }).from(schema.departments)
    .where(and(eq(schema.departments.id, id), eq(schema.departments.accountId, accountId))).limit(1);
  if (!d) throw new AppError(422, 'Setor não encontrado');
  return d.id;
}

teamRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [members, invites, departments] = await Promise.all([
    db.select({
      membershipId: schema.memberships.id, role: schema.memberships.role, userId: schema.users.id, name: schema.users.name,
      email: schema.users.email, departmentId: schema.memberships.departmentId, departmentName: schema.departments.name,
      departmentColor: schema.departments.color, createdAt: schema.memberships.createdAt,
    }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.memberships.departmentId))
      .where(eq(schema.memberships.accountId, accountId))
      .orderBy(asc(schema.memberships.createdAt)),
    manager(req)
      ? db.select({
        id: schema.teamInvites.id, email: schema.teamInvites.email, role: schema.teamInvites.role, departmentId: schema.teamInvites.departmentId,
        status: schema.teamInvites.status, expiresAt: schema.teamInvites.expiresAt, lastSentAt: schema.teamInvites.lastSentAt,
        createdAt: schema.teamInvites.createdAt, token: schema.teamInvites.token, invitedByName: schema.users.name,
      }).from(schema.teamInvites)
        .leftJoin(schema.users, eq(schema.users.id, schema.teamInvites.invitedBy))
        .where(and(eq(schema.teamInvites.accountId, accountId), eq(schema.teamInvites.status, 'pending')))
        .orderBy(desc(schema.teamInvites.createdAt))
      : [],
    db.select({ id: schema.departments.id, name: schema.departments.name, color: schema.departments.color }).from(schema.departments)
      .where(eq(schema.departments.accountId, accountId)).orderBy(asc(schema.departments.name)),
  ]);
  res.json({
    members: members.map((m) => ({ ...m, roleLabel: ROLE_LABEL[m.role], isMe: m.userId === req.user!.id })),
    invites: invites.map(({ token, ...i }) => ({ ...i, status: inviteStatus(i), roleLabel: ROLE_LABEL[i.role], link: teamInviteLink(token) })),
    departments,
    canManage: manager(req),
    emailConfigured: emailConfigured(),
  });
}));

const inviteSchema = z.object({
  email: z.string().trim().email('E-mail inválido'),
  role: z.enum(['admin', 'agent']).default('agent'),
  departmentId: z.string().uuid().nullable().optional(),
});

/** Convida quem já tem cadastro (o convite precisa ser aceito por ele). */
teamRouter.post('/invites', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = inviteSchema.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const email = normEmail(p.data.email);
  // só o dono pode convidar outro administrador
  if (p.data.role === 'admin' && req.role !== 'owner' && !req.support) throw new AppError(403, 'Só o dono convida administradores.');
  const departmentId = await ownDepartment(accountId, p.data.departmentId);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (!user) {
    throw new AppError(404, 'Esse e-mail ainda não tem cadastro no Converza. Mande um convite em “Convites para Plataforma” — depois de criar a conta, convide para a equipe.', { code: 'not_registered' });
  }
  const [member] = await db.select({ id: schema.memberships.id }).from(schema.memberships)
    .where(and(eq(schema.memberships.userId, user.id), eq(schema.memberships.accountId, accountId))).limit(1);
  if (member) throw new AppError(409, 'Essa pessoa já faz parte da equipe.', { code: 'already_member' });

  // já havia convite pendente: atualiza e manda de novo
  const [pending] = await db.select().from(schema.teamInvites)
    .where(and(eq(schema.teamInvites.accountId, accountId), sql`lower(${schema.teamInvites.email}) = ${email}`, eq(schema.teamInvites.status, 'pending'))).limit(1);
  const now = new Date();
  const [inv] = pending
    ? await db.update(schema.teamInvites).set({ role: p.data.role, departmentId, invitedBy: req.support ? pending.invitedBy : req.user!.id, expiresAt: inviteExpiry(), lastSentAt: now })
      .where(eq(schema.teamInvites.id, pending.id)).returning()
    : await db.insert(schema.teamInvites).values({
      accountId, email, role: p.data.role, departmentId, invitedBy: req.support ? null : req.user!.id, token: newToken(), expiresAt: inviteExpiry(), lastSentAt: now,
    }).returning();
  const mail = await sendTeamInviteEmail(inv);
  emitToAccount(accountId, 'team:changed', {});
  res.status(201).json({ invite: { id: inv.id, email: inv.email }, emailSent: mail.sent, emailError: mail.error ?? null, link: teamInviteLink(inv.token) });
}));

teamRouter.post('/invites/:id/resend', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Convite não encontrado');
  const [inv] = await db.update(schema.teamInvites).set({ expiresAt: inviteExpiry(), lastSentAt: new Date() })
    .where(and(eq(schema.teamInvites.id, req.params.id), eq(schema.teamInvites.accountId, req.accountId!), eq(schema.teamInvites.status, 'pending'))).returning();
  if (!inv) throw new AppError(404, 'Convite não encontrado');
  const mail = await sendTeamInviteEmail(inv);
  res.json({ emailSent: mail.sent, emailError: mail.error ?? null, link: teamInviteLink(inv.token) });
}));

teamRouter.delete('/invites/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Convite não encontrado');
  await db.update(schema.teamInvites).set({ status: 'canceled', respondedAt: new Date() })
    .where(and(eq(schema.teamInvites.id, req.params.id), eq(schema.teamInvites.accountId, req.accountId!), eq(schema.teamInvites.status, 'pending')));
  emitToAccount(req.accountId!, 'team:changed', {});
  res.status(204).end();
}));

/** Função e setor de um membro. */
teamRouter.patch('/:membershipId', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  if (!isUuid(req.params.membershipId)) throw new AppError(404, 'Membro não encontrado');
  const p = z.object({ role: z.enum(['admin', 'agent']).optional(), departmentId: z.string().uuid().nullable().optional() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, 'Dados inválidos');
  const [m] = await db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, req.params.membershipId), eq(schema.memberships.accountId, accountId))).limit(1);
  if (!m) throw new AppError(404, 'Membro não encontrado');
  const patch: Partial<typeof schema.memberships.$inferInsert> = {};
  if (p.data.role && p.data.role !== m.role) {
    if (m.role === 'owner') throw new AppError(409, 'A função do proprietário não muda.');
    if (req.role !== 'owner' && !req.support) throw new AppError(403, 'Só o dono muda a função de alguém.');
    patch.role = p.data.role;
  }
  if (p.data.departmentId !== undefined) patch.departmentId = await ownDepartment(accountId, p.data.departmentId);
  if (!Object.keys(patch).length) return res.json({ membership: m });
  const [row] = await db.update(schema.memberships).set(patch).where(eq(schema.memberships.id, m.id)).returning();
  emitToAccount(accountId, 'team:changed', {});
  res.json({ membership: row });
}));

teamRouter.delete('/:membershipId', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.membershipId)) throw new AppError(404, 'Membro não encontrado');
  const [m] = await db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.id, req.params.membershipId), eq(schema.memberships.accountId, req.accountId!))).limit(1);
  if (!m) throw new AppError(404, 'Membro não encontrado');
  if (m.role === 'owner') throw new AppError(409, 'O proprietário não pode ser removido.');
  if (m.userId === req.user!.id) throw new AppError(409, 'Para sair, use “Sair da Empresa” em Configurações › Empresa.');
  if (m.role === 'admin' && req.role !== 'owner' && !req.support) throw new AppError(403, 'Só o dono remove administradores.');
  await db.delete(schema.memberships).where(and(eq(schema.memberships.id, m.id), ne(schema.memberships.role, 'owner')));
  // conversas que estavam com a pessoa voltam para a fila
  await db.update(schema.conversations).set({ assignedUserId: null })
    .where(and(eq(schema.conversations.accountId, req.accountId!), eq(schema.conversations.assignedUserId, m.userId), ne(schema.conversations.status, 'resolved')));
  emitToAccount(req.accountId!, 'team:changed', {});
  res.status(204).end();
}));
