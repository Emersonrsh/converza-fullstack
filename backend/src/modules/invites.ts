/**
 * Convites: para entrar na equipe de uma empresa (quem já tem cadastro) e para criar conta no Converza.
 * O e-mail leva o link; sem e-mail configurado, o app mostra o mesmo link para copiar.
 */
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { authRequired } from '../auth/middleware';
import { AppError, asyncHandler } from '../utils/http';
import { layout, plainText, sendMail, type MailResult } from '../email/mailer';
import { emitToAccount } from '../realtime/io';

export const INVITE_DAYS = 14;
export const ROLE_LABEL: Record<string, string> = { owner: 'Proprietário', admin: 'Administrador', agent: 'Membro' };

export const newToken = () => randomBytes(24).toString('base64url');
export const inviteExpiry = () => new Date(Date.now() + INVITE_DAYS * 86_400_000);
export const normEmail = (e: string) => e.trim().toLowerCase();
const app = () => config.appOrigin.replace(/\/+$/, '');

export const teamInviteLink = (token: string) => `${app()}/convite/${token}`;
export const platformInviteLink = (token: string) => `${app()}/?convite=${token}`;

/** Situação para a tela: pendente vencido aparece como expirado. */
export function inviteStatus(i: { status: string; expiresAt: Date }) {
  return i.status === 'pending' && i.expiresAt.getTime() < Date.now() ? 'expired' : i.status;
}

async function names(accountId: string, userId: string | null) {
  const [acc] = await db.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const [u] = userId ? await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId)).limit(1) : [];
  return { account: acc?.name ?? 'uma empresa', inviter: u?.name ?? 'Alguém' };
}

export async function sendTeamInviteEmail(inv: typeof schema.teamInvites.$inferSelect): Promise<MailResult> {
  const n = await names(inv.accountId, inv.invitedBy);
  const button = { label: 'Aceitar convite', url: teamInviteLink(inv.token) };
  const title = `${n.inviter} convidou você para ${n.account}`;
  const p = [
    `Você foi convidado(a) para a equipe de <b>${n.account}</b> no Converza, como <b>${ROLE_LABEL[inv.role] ?? inv.role}</b>.`,
    `Entre com este e-mail (${inv.email}) e aceite o convite. Ele vale por ${INVITE_DAYS} dias.`,
  ];
  return sendMail({ to: inv.email, subject: title, html: layout(title, p, button), text: plainText(title, p, button) });
}

export async function sendPlatformInviteEmail(inv: typeof schema.platformInvites.$inferSelect): Promise<MailResult> {
  const n = await names(inv.accountId, inv.invitedBy);
  const button = { label: 'Criar minha conta', url: platformInviteLink(inv.token) };
  const title = `${n.inviter} convidou você para o Converza`;
  const p = [
    `${n.inviter} (${n.account}) usa o Converza para vender e atender pelo WhatsApp e convidou você para conhecer.`,
    `Crie a sua conta pelo botão abaixo. O convite vale por ${INVITE_DAYS} dias.`,
  ];
  const footer = 'Se não quiser, é só ignorar este e-mail.';
  return sendMail({ to: inv.email, subject: title, html: layout(title, p, button, footer), text: plainText(title, p, button) });
}

/**
 * Cadastro novo: marca o convite para a plataforma como aceito (pelo link ou pelo mesmo e-mail) e devolve
 * a empresa que convidou (ela vira a indicação da conta nova).
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function acceptPlatformInviteOnSignup(tx: Tx | typeof db, email: string, token: string | null): Promise<string | null> {
  const now = new Date();
  let inv: typeof schema.platformInvites.$inferSelect | undefined;
  if (token) [inv] = await tx.select().from(schema.platformInvites).where(eq(schema.platformInvites.token, token)).limit(1);
  if (!inv || inv.status !== 'pending') {
    [inv] = await tx.select().from(schema.platformInvites)
      .where(and(eq(schema.platformInvites.email, email), eq(schema.platformInvites.status, 'pending'), gt(schema.platformInvites.expiresAt, now)))
      .orderBy(desc(schema.platformInvites.createdAt)).limit(1);
  }
  if (!inv || inv.status !== 'pending') return null;
  await tx.update(schema.platformInvites).set({ status: 'accepted', respondedAt: now }).where(eq(schema.platformInvites.id, inv.id));
  emitToAccount(inv.accountId, 'invites:changed', {});
  return inv.accountId;
}

/* ------------------------------------------------------------ rotas públicas do convite */

export const invitesRouter = Router();

async function byToken(token: string) {
  if (!/^[\w-]{20,80}$/.test(token)) return null;
  const [team] = await db.select().from(schema.teamInvites).where(eq(schema.teamInvites.token, token)).limit(1);
  if (team) return { kind: 'team' as const, team };
  const [platform] = await db.select().from(schema.platformInvites).where(eq(schema.platformInvites.token, token)).limit(1);
  if (platform) return { kind: 'platform' as const, platform };
  return null;
}

const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, c: string) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);

/** O que o link do convite mostra (sem login). */
invitesRouter.get('/:token', asyncHandler(async (req, res) => {
  const found = await byToken(String(req.params.token));
  if (!found) throw new AppError(404, 'Convite não encontrado. Peça um novo para quem convidou.');
  if (found.kind === 'team') {
    const i = found.team;
    const n = await names(i.accountId, i.invitedBy);
    return res.json({ kind: 'team', accountName: n.account, inviterName: n.inviter, role: i.role, roleLabel: ROLE_LABEL[i.role], email: maskEmail(i.email), status: inviteStatus(i) });
  }
  const i = found.platform;
  const n = await names(i.accountId, i.invitedBy);
  res.json({ kind: 'platform', accountName: n.account, inviterName: n.inviter, email: i.email, status: inviteStatus(i) });
}));

/** Aceitar o convite da equipe: precisa estar logado com o mesmo e-mail convidado. */
invitesRouter.post('/:token/accept', authRequired, asyncHandler(async (req, res) => {
  const found = await byToken(String(req.params.token));
  if (!found || found.kind !== 'team') throw new AppError(404, 'Convite não encontrado.');
  const inv = found.team;
  const status = inviteStatus(inv);
  if (status !== 'pending') {
    throw new AppError(409, status === 'expired' ? 'Este convite venceu. Peça um novo para quem convidou.' : status === 'accepted' ? 'Este convite já foi aceito.' : 'Este convite não vale mais.', { code: `invite_${status}` });
  }
  if (normEmail(req.user!.email) !== normEmail(inv.email)) {
    throw new AppError(403, `Este convite é para ${maskEmail(inv.email)}. Entre com esse e-mail para aceitar.`, { code: 'invite_other_email' });
  }
  const [existing] = await db.select().from(schema.memberships)
    .where(and(eq(schema.memberships.userId, req.user!.id), eq(schema.memberships.accountId, inv.accountId))).limit(1);
  if (!existing) {
    await db.insert(schema.memberships).values({ userId: req.user!.id, accountId: inv.accountId, role: inv.role === 'owner' ? 'admin' : inv.role, departmentId: inv.departmentId });
  }
  await db.update(schema.teamInvites).set({ status: 'accepted', respondedAt: new Date() }).where(eq(schema.teamInvites.id, inv.id));
  emitToAccount(inv.accountId, 'team:changed', {});
  const [acc] = await db.select({ id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug }).from(schema.accounts).where(eq(schema.accounts.id, inv.accountId)).limit(1);
  res.json({ account: { ...acc, role: existing?.role ?? inv.role } });
}));

/** Recusar: convite da equipe (logado, mesmo e-mail) ou para a plataforma (só o link). */
invitesRouter.post('/:token/decline', asyncHandler(async (req, res) => {
  const found = await byToken(String(req.params.token));
  if (!found) throw new AppError(404, 'Convite não encontrado.');
  const now = new Date();
  if (found.kind === 'team') {
    await db.update(schema.teamInvites).set({ status: 'declined', respondedAt: now })
      .where(and(eq(schema.teamInvites.id, found.team.id), eq(schema.teamInvites.status, 'pending')));
    emitToAccount(found.team.accountId, 'team:changed', {});
  } else {
    await db.update(schema.platformInvites).set({ status: 'declined', respondedAt: now })
      .where(and(eq(schema.platformInvites.id, found.platform.id), eq(schema.platformInvites.status, 'pending')));
    emitToAccount(found.platform.accountId, 'invites:changed', {});
  }
  res.json({ ok: true });
}));

/** Convites de equipe para o meu e-mail (aviso dentro do app). */
export async function myTeamInvites(email: string) {
  const rows = await db.select({
    token: schema.teamInvites.token, role: schema.teamInvites.role, accountName: schema.accounts.name, inviterName: schema.users.name,
    expiresAt: schema.teamInvites.expiresAt, createdAt: schema.teamInvites.createdAt,
  }).from(schema.teamInvites)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.teamInvites.accountId))
    .leftJoin(schema.users, eq(schema.users.id, schema.teamInvites.invitedBy))
    .where(and(sql`lower(${schema.teamInvites.email}) = ${normEmail(email)}`, eq(schema.teamInvites.status, 'pending'), gt(schema.teamInvites.expiresAt, new Date())))
    .orderBy(desc(schema.teamInvites.createdAt));
  return rows.map((r) => ({ ...r, roleLabel: ROLE_LABEL[r.role] }));
}
