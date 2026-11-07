/** Convites para a plataforma: chamar alguém para criar uma conta no Converza (vira indicação da empresa). */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emailConfigured } from '../email/mailer';
import { emitToAccount } from '../realtime/io';
import { inviteExpiry, inviteStatus, newToken, normEmail, platformInviteLink, sendPlatformInviteEmail } from './invites';

export const platformInvitesRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores convidam pessoas para a plataforma.');
}

platformInvitesRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const q = z.object({ status: z.enum(['all', 'pending', 'accepted', 'declined', 'expired', 'canceled']).default('all'), q: z.string().max(80).optional() })
    .safeParse(req.query);
  const f = q.success ? q.data : { status: 'all' as const, q: undefined };
  const like = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const rows = await db.select({
    id: schema.platformInvites.id, email: schema.platformInvites.email, status: schema.platformInvites.status, token: schema.platformInvites.token,
    expiresAt: schema.platformInvites.expiresAt, lastSentAt: schema.platformInvites.lastSentAt, respondedAt: schema.platformInvites.respondedAt,
    createdAt: schema.platformInvites.createdAt, invitedByName: schema.users.name, accountName: schema.accounts.name,
  }).from(schema.platformInvites)
    .leftJoin(schema.users, eq(schema.users.id, schema.platformInvites.invitedBy))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.platformInvites.accountId))
    .where(and(eq(schema.platformInvites.accountId, accountId),
      ...(like ? [or(ilike(schema.platformInvites.email, like), ilike(schema.users.name, like), ilike(schema.accounts.name, like))!] : [])))
    .orderBy(desc(schema.platformInvites.createdAt)).limit(300);
  const list = rows.map(({ token, ...r }) => ({ ...r, status: inviteStatus(r), link: platformInviteLink(token) })).filter((i) => i.status !== 'canceled' || f.status === 'canceled');
  const stats = { total: list.filter((i) => i.status !== 'canceled').length, pending: 0, accepted: 0, declined: 0, expired: 0 };
  for (const i of list) if (i.status in stats) (stats as Record<string, number>)[i.status]++;
  res.json({
    invites: f.status === 'all' ? list : list.filter((i) => i.status === f.status),
    stats, canEdit: req.role !== 'agent', emailConfigured: emailConfigured(),
  });
}));

platformInvitesRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = z.object({ email: z.string().trim().email('E-mail inválido') }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'E-mail inválido');
  const email = normEmail(p.data.email);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (user) {
    throw new AppError(409, 'Essa pessoa já tem conta no Converza. Para trazer para a sua equipe, use Equipe › Convidar membro.', { code: 'already_registered' });
  }
  const now = new Date();
  const [pending] = await db.select().from(schema.platformInvites)
    .where(and(eq(schema.platformInvites.accountId, accountId), eq(schema.platformInvites.email, email), eq(schema.platformInvites.status, 'pending'))).limit(1);
  const [inv] = pending
    ? await db.update(schema.platformInvites).set({ expiresAt: inviteExpiry(), lastSentAt: now }).where(eq(schema.platformInvites.id, pending.id)).returning()
    : await db.insert(schema.platformInvites).values({
      accountId, email, invitedBy: req.support ? null : req.user!.id, token: newToken(), expiresAt: inviteExpiry(), lastSentAt: now,
    }).returning();
  const mail = await sendPlatformInviteEmail(inv);
  emitToAccount(accountId, 'invites:changed', {});
  res.status(201).json({ invite: { id: inv.id, email: inv.email }, emailSent: mail.sent, emailError: mail.error ?? null, link: platformInviteLink(inv.token) });
}));

platformInvitesRouter.post('/:id/resend', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Convite não encontrado');
  const [inv] = await db.update(schema.platformInvites).set({ expiresAt: inviteExpiry(), lastSentAt: new Date() })
    .where(and(eq(schema.platformInvites.id, req.params.id), eq(schema.platformInvites.accountId, req.accountId!), eq(schema.platformInvites.status, 'pending'))).returning();
  if (!inv) throw new AppError(404, 'Convite não encontrado (ou já respondido)');
  const mail = await sendPlatformInviteEmail(inv);
  emitToAccount(req.accountId!, 'invites:changed', {});
  res.json({ emailSent: mail.sent, emailError: mail.error ?? null, link: platformInviteLink(inv.token) });
}));

platformInvitesRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Convite não encontrado');
  await db.update(schema.platformInvites).set({ status: 'canceled', respondedAt: new Date() })
    .where(and(eq(schema.platformInvites.id, req.params.id), eq(schema.platformInvites.accountId, req.accountId!), eq(schema.platformInvites.status, 'pending')));
  emitToAccount(req.accountId!, 'invites:changed', {});
  res.status(204).end();
}));
