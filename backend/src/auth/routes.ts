import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { signToken } from './jwt';
import { authRequired, isPlatformAdmin } from './middleware';
import { accountsFor } from './accounts';
import { asyncHandler, AppError } from '../utils/http';
import { acceptPlatformInviteOnSignup } from '../modules/invites';
import { config } from '../config';
import { syncHouseAccounts } from '../billing/house';
import { TERMS_VERSION } from '../modules/legal';
import { recordAccessLater } from './accessLog';

export const authRouter = Router();

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'empresa';
}

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().trim().email(),
  password: z.string().min(8),
  companyName: z.string().min(2).optional(),
  // código de indicação do programa de parceiros (?ref= no link)
  ref: z.string().trim().max(20).optional().nullable(),
  // convite para a plataforma (?convite= no link do e-mail)
  inviteToken: z.string().trim().max(80).optional().nullable(),
  // aceite dos Termos de Uso e da Política de Privacidade (obrigatório: fica registrado com a data e a versão)
  acceptTerms: z.boolean().optional(),
});

export function slugifyName(s: string) { return slugify(s); }

authRouter.post('/register', asyncHandler(async (req, res) => {
  const { name, password, companyName, ref, inviteToken, acceptTerms } = registerSchema.parse(req.body);
  const email = registerSchema.shape.email.parse(req.body.email).trim().toLowerCase();
  if (acceptTerms !== true) throw new AppError(422, 'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.', { field: 'acceptTerms' });

  const [existing] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (existing) throw new AppError(409, 'E-mail já cadastrado');

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(schema.users).values({
      name, email, passwordHash, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION,
    }).returning();
    const baseSlug = slugify(companyName ?? name);
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const code = String(ref ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [referrer] = code
      ? await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.referralCode, code)).limit(1)
      : [];
    // convite para a plataforma: quem convidou vira a indicação (se não veio outro código)
    const invitedBy = await acceptPlatformInviteOnSignup(tx, email, inviteToken ?? null);
    const [account] = await tx.insert(schema.accounts).values({
      name: companyName ?? `Empresa de ${name}`, slug, referredBy: referrer?.id ?? invitedBy ?? null,
    }).returning();
    await tx.insert(schema.memberships).values({ userId: user.id, accountId: account.id, role: 'owner' });
    await tx.insert(schema.subscriptions).values({ accountId: account.id, status: 'inactive' });
    await tx.update(schema.platformInvites).set({ acceptedUserId: user.id })
      .where(eq(schema.platformInvites.email, email));
    return { user, account };
  });

  // dono que está em HOUSE_EMAILS: a empresa nova já nasce como conta da casa
  if (config.house.emails.includes(email)) await syncHouseAccounts().catch((err) => console.error('[conta da casa]', (err as Error).message));

  const token = signToken({ userId: result.user.id, email: result.user.email });
  recordAccessLater(req, result.user, 'register');
  res.status(201).json({
    token,
    user: { id: result.user.id, name: result.user.name, email: result.user.email, platformAdmin: isPlatformAdmin(result.user.email) },
    accounts: [{ id: result.account.id, name: result.account.name, slug: result.account.slug, role: 'owner' }],
  });
}));

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string() });

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { password } = loginSchema.parse(req.body);
  const email = loginSchema.shape.email.parse(req.body.email).trim().toLowerCase();
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (!user) throw new AppError(401, 'Credenciais inválidas');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new AppError(401, 'Credenciais inválidas');

  const token = signToken({ userId: user.id, email: user.email });
  recordAccessLater(req, user, 'login');
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, platformAdmin: isPlatformAdmin(user.email) }, accounts: await accountsFor(user.id, user.email) });
}));

authRouter.get('/me', authRequired, asyncHandler(async (req, res) => {
  const [user] = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
  if (!user) throw new AppError(404, 'Usuário não encontrado');
  res.json({ user: { ...user, platformAdmin: isPlatformAdmin(user.email) }, accounts: await accountsFor(user.id, user.email) });
}));
