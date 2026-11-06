import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { signToken } from './jwt';
import { authRequired } from './middleware';
import { asyncHandler, AppError } from '../utils/http';

export const authRouter = Router();

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'empresa';
}

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  companyName: z.string().min(2).optional(),
});

authRouter.post('/register', asyncHandler(async (req, res) => {
  const { name, email, password, companyName } = registerSchema.parse(req.body);

  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing) throw new AppError(409, 'E-mail já cadastrado');

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(schema.users).values({ name, email, passwordHash }).returning();
    const baseSlug = slugify(companyName ?? name);
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const [account] = await tx.insert(schema.accounts).values({
      name: companyName ?? `Empresa de ${name}`, slug,
    }).returning();
    await tx.insert(schema.memberships).values({ userId: user.id, accountId: account.id, role: 'owner' });
    await tx.insert(schema.subscriptions).values({ accountId: account.id, status: 'inactive' });
    return { user, account };
  });

  const token = signToken({ userId: result.user.id, email: result.user.email });
  res.status(201).json({
    token,
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
    accounts: [{ id: result.account.id, name: result.account.name, slug: result.account.slug, role: 'owner' }],
  });
}));

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) throw new AppError(401, 'Credenciais inválidas');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new AppError(401, 'Credenciais inválidas');

  const rows = await db.select({
    id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug, role: schema.memberships.role,
  }).from(schema.memberships)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.memberships.accountId))
    .where(eq(schema.memberships.userId, user.id));

  const token = signToken({ userId: user.id, email: user.email });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email }, accounts: rows });
}));

authRouter.get('/me', authRequired, asyncHandler(async (req, res) => {
  const [user] = await db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
  if (!user) throw new AppError(404, 'Usuário não encontrado');
  const accounts = await db.select({
    id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug, role: schema.memberships.role,
  }).from(schema.memberships)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.memberships.accountId))
    .where(eq(schema.memberships.userId, user.id));
  res.json({ user, accounts });
}));
