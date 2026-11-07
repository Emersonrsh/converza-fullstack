/** Acesso de suporte: a empresa libera a equipe do Converza por um prazo e pode revogar quando quiser. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { notSupport } from '../auth/middleware';
import { layout, plainText, sendMail } from '../email/mailer';
import { emitToAccount } from '../realtime/io';

export const supportAccessRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores liberam o acesso do suporte.');
}

const view = (g: typeof schema.supportAccess.$inferSelect & { grantedByName?: string | null }) => {
  const now = Date.now();
  const status = g.revokedAt ? 'revoked' : g.expiresAt.getTime() <= now ? 'expired' : 'active';
  return {
    id: g.id, status, reason: g.reason, expiresAt: g.expiresAt, createdAt: g.createdAt, revokedAt: g.revokedAt,
    lastUsedAt: g.lastUsedAt, lastUsedBy: g.lastUsedBy, grantedByName: g.grantedByName ?? null,
  };
};

supportAccessRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select({ g: schema.supportAccess, grantedByName: schema.users.name }).from(schema.supportAccess)
    .leftJoin(schema.users, eq(schema.users.id, schema.supportAccess.grantedBy))
    .where(eq(schema.supportAccess.accountId, req.accountId!))
    .orderBy(desc(schema.supportAccess.createdAt)).limit(50);
  const list = rows.map((r) => view({ ...r.g, grantedByName: r.grantedByName }));
  res.json({
    active: list.filter((x) => x.status === 'active'),
    history: list.filter((x) => x.status !== 'active'),
    supportConfigured: config.supportEmails.length > 0,
    canEdit: req.role !== 'agent' && !req.support,
    isSupport: !!req.support,
  });
}));

supportAccessRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  notSupport(req, 'Liberar o acesso do suporte');
  if (!config.supportEmails.length) throw new AppError(400, 'A equipe de suporte ainda não foi definida neste servidor (SUPPORT_EMAILS).', { code: 'support_off' });
  const p = z.object({ hours: z.union([z.literal(24), z.literal(72), z.literal(168)]), reason: z.string().trim().max(300).optional() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, 'Escolha por quanto tempo liberar (24 horas, 3 dias ou 7 dias).');
  const now = new Date();
  // um acesso por vez: o novo prazo substitui o anterior
  await db.update(schema.supportAccess).set({ revokedAt: now, revokedBy: req.user!.id })
    .where(and(eq(schema.supportAccess.accountId, req.accountId!), isNull(schema.supportAccess.revokedAt), gt(schema.supportAccess.expiresAt, now)));
  const [g] = await db.insert(schema.supportAccess).values({
    accountId: req.accountId!, grantedBy: req.user!.id, reason: p.data.reason ?? '', expiresAt: new Date(now.getTime() + p.data.hours * 3600_000),
  }).returning();
  // avisa a equipe de suporte (se o e-mail estiver configurado)
  const [acc] = await db.select({ name: schema.accounts.name, number: schema.accounts.number }).from(schema.accounts).where(eq(schema.accounts.id, req.accountId!)).limit(1);
  const title = `${acc?.name ?? 'Uma empresa'} liberou acesso ao suporte`;
  const lines = [
    `A empresa <b>${acc?.name ?? ''}</b> (ID ${acc?.number ?? ''}) liberou acesso por ${p.data.hours === 168 ? '7 dias' : p.data.hours === 72 ? '3 dias' : '24 horas'}.`,
    ...(p.data.reason ? [`Motivo: ${p.data.reason.replace(/</g, '&lt;')}`] : []),
    'Entre no Converza com o seu e-mail de suporte: a empresa aparece na lista de contas enquanto o acesso valer.',
  ];
  const button = { label: 'Abrir o Converza', url: config.appOrigin };
  for (const to of config.supportEmails) void sendMail({ to, subject: title, html: layout(title, lines, button), text: plainText(title, lines, button) });
  emitToAccount(req.accountId!, 'support:changed', {});
  res.status(201).json({ access: view(g) });
}));

supportAccessRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Acesso não encontrado');
  const [g] = await db.update(schema.supportAccess).set({ revokedAt: new Date(), revokedBy: req.support ? null : req.user!.id })
    .where(and(eq(schema.supportAccess.id, req.params.id), eq(schema.supportAccess.accountId, req.accountId!), isNull(schema.supportAccess.revokedAt))).returning();
  if (!g) throw new AppError(404, 'Acesso não encontrado ou já encerrado');
  emitToAccount(req.accountId!, 'support:changed', {});
  res.status(204).end();
}));
