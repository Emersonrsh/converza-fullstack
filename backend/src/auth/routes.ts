import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { signToken } from './jwt';
import { authAllowUnverified, forgetPasswordCache, isPlatformAdmin } from './middleware';
import { accountsFor } from './accounts';
import { asyncHandler, AppError } from '../utils/http';
import { acceptPlatformInviteOnSignup } from '../modules/invites';
import { config } from '../config';
import { syncHouseAccounts } from '../billing/house';
import { TERMS_VERSION } from '../modules/legal';
import { recordAccessLater } from './accessLog';
import { consumeToken, sendPasswordReset, sendVerification, verificationRequired } from './emailFlows';
import { emailConfigured } from '../email/mailer';
import { assertUnderLimits, clearAttempts, clientIp, countAttempt, type Limit } from './throttle';

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

/** Dados do usuário que o app recebe (os acessos pelo e-mail só valem com ele confirmado). */
function userView(u: { id: string; name: string; email: string }, verified: boolean) {
  return { id: u.id, name: u.name, email: u.email, emailVerified: verified, platformAdmin: verified && isPlatformAdmin(u.email) };
}
const isVerified = (u: { emailVerifiedAt: Date | null }) => !!u.emailVerifiedAt || !verificationRequired();
const session = async (u: { id: string; name: string; email: string; emailVerifiedAt: Date | null }) => {
  const verified = isVerified(u);
  return {
    token: signToken({ userId: u.id, email: u.email, ev: verified }),
    user: userView(u, verified),
    accounts: verified ? await accountsFor(u.id, u.email) : [],
  };
};

/** Depois de confirmar o e-mail: convites para a plataforma feitos para ele e conta da casa. */
async function afterVerified(user: { id: string; email: string }) {
  const invitedBy = await acceptPlatformInviteOnSignup(db, user.email, null);
  await db.update(schema.platformInvites).set({ acceptedUserId: user.id })
    .where(and(eq(schema.platformInvites.email, user.email), isNull(schema.platformInvites.acceptedUserId)));
  if (invitedBy) {
    await db.execute(sql`update accounts set referred_by = ${invitedBy}
      where referred_by is null and id in (select account_id from memberships where user_id = ${user.id} and role = 'owner')`);
  }
  if (config.house.emails.includes(user.email.toLowerCase())) await syncHouseAccounts().catch((err) => console.error('[conta da casa]', (err as Error).message));
}

authRouter.post('/register', asyncHandler(async (req, res) => {
  const regLimits: Limit[] = [{ key: `register:ip:${clientIp(req)}`, max: 10, windowSec: 3600 }];
  await assertUnderLimits(regLimits, 'cadastro');
  await countAttempt(regLimits);
  const { name, password, companyName, ref, inviteToken, acceptTerms } = registerSchema.parse(req.body);
  const email = registerSchema.shape.email.parse(req.body.email).trim().toLowerCase();
  if (acceptTerms !== true) throw new AppError(422, 'Para criar a conta, aceite os Termos de Uso e a Política de Privacidade.', { field: 'acceptTerms' });

  const [existing] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (existing) throw new AppError(409, 'E-mail já cadastrado');

  // O convite NÃO prova a posse do e-mail: quem convidou recebe o mesmo link (para copiar e mandar),
  // então com ele qualquer um criaria a conta de outra pessoa já "confirmada". A confirmação é sempre
  // pelo link que chega na caixa de entrada; o convite só vale para a indicação.
  const verified = !verificationRequired();

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await db.transaction(async (tx) => {
    const [user] = await tx.insert(schema.users).values({
      name, email, passwordHash, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION, emailVerifiedAt: verified ? new Date() : null,
    }).returning();
    const baseSlug = slugify(companyName ?? name);
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
    const code = String(ref ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [referrer] = code
      ? await tx.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.referralCode, code)).limit(1)
      : [];
    // convite para a plataforma: quem convidou vira a indicação (se não veio outro código).
    // Pelo e-mail só com ele confirmado; sem confirmar, só pelo link.
    const invitedBy = await acceptPlatformInviteOnSignup(tx, email, inviteToken ?? null, { byEmail: verified });
    const [account] = await tx.insert(schema.accounts).values({
      name: companyName ?? `Empresa de ${name}`, slug, referredBy: referrer?.id ?? invitedBy ?? null,
    }).returning();
    await tx.insert(schema.memberships).values({ userId: user.id, accountId: account.id, role: 'owner' });
    await tx.insert(schema.subscriptions).values({ accountId: account.id, status: 'inactive' });
    if (verified) {
      await tx.update(schema.platformInvites).set({ acceptedUserId: user.id })
        .where(eq(schema.platformInvites.email, email));
    }
    return { user, account };
  });

  let verificationSent = false;
  if (verified) {
    // dono que está em HOUSE_EMAILS: a empresa nova já nasce como conta da casa
    if (config.house.emails.includes(email)) await syncHouseAccounts().catch((err) => console.error('[conta da casa]', (err as Error).message));
  } else {
    const r = await sendVerification(result.user);
    verificationSent = r.sent;
    if (!r.sent) console.error('[cadastro] e-mail de confirmação não saiu:', r.error);
  }

  recordAccessLater(req, result.user, 'register');
  res.status(201).json({
    token: signToken({ userId: result.user.id, email: result.user.email, ev: verified }),
    user: userView(result.user, verified),
    accounts: verified ? [{ id: result.account.id, name: result.account.name, slug: result.account.slug, role: 'owner' }] : [],
    verificationSent,
  });
}));

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string() });

// hash qualquer para conferir quando o e-mail não existe (o tempo de resposta não entrega quem tem cadastro)
const DUMMY_HASH = '$2a$10$b9V05isTrbY4/oWfVgziYOhsEVE3d2gARUB8zz8IuIae9XYvoZa.O';
const LOGIN_WINDOW = 15 * 60;
const loginLimits = (req: Request, email: string): Limit[] => [
  { key: `login:email:${email}`, max: 8, windowSec: LOGIN_WINDOW },
  { key: `login:ip:${clientIp(req)}`, max: 40, windowSec: LOGIN_WINDOW },
];

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { password } = loginSchema.parse(req.body);
  const email = loginSchema.shape.email.parse(req.body.email).trim().toLowerCase();
  const limits = loginLimits(req, email);
  await assertUnderLimits(limits, 'login');
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    await countAttempt(limits);
    throw new AppError(401, 'Credenciais inválidas');
  }
  await clearAttempts([limits[0].key]);
  recordAccessLater(req, user, 'login');
  res.json(await session(user));
}));

/** Token novo (o app chama ao abrir e de tempos em tempos): quem está usando não cai, e um token vazado vence logo. */
authRouter.post('/refresh', authAllowUnverified, asyncHandler(async (req, res) => {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
  if (!user) throw new AppError(401, 'Sessão inválida');
  const verified = isVerified(user);
  res.json({ token: signToken({ userId: user.id, email: user.email, ev: verified }), emailVerified: verified });
}));

authRouter.get('/me', authAllowUnverified, asyncHandler(async (req, res) => {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
  if (!user) throw new AppError(404, 'Usuário não encontrado');
  const s = await session(user);
  res.json({ user: s.user, accounts: s.accounts });
}));

/* ------------------------------------------------------------ confirmação de e-mail */

authRouter.post('/resend-verification', authAllowUnverified, asyncHandler(async (req, res) => {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, req.user!.id)).limit(1);
  if (!user) throw new AppError(401, 'Sessão inválida');
  if (isVerified(user)) return res.json({ ok: true, alreadyVerified: true });
  const limits: Limit[] = [{ key: `verify:user:${user.id}`, max: 3, windowSec: 15 * 60 }];
  await assertUnderLimits(limits, 'reenvio');
  await countAttempt(limits);
  const r = await sendVerification(user);
  if (!r.sent) throw new AppError(502, 'Não conseguimos mandar o e-mail agora. Tente de novo em alguns minutos.');
  res.json({ ok: true });
}));

authRouter.post('/verify-email', asyncHandler(async (req, res) => {
  const { token } = z.object({ token: z.string().trim().max(120) }).parse(req.body ?? {});
  const userId = await consumeToken(token, 'verify');
  if (!userId) throw new AppError(410, 'Este link de confirmação venceu ou já foi usado. Entre na sua conta e peça um novo.', { code: 'link_invalid' });
  const [user] = await db.update(schema.users).set({ emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())` })
    .where(eq(schema.users.id, userId)).returning();
  if (!user) throw new AppError(410, 'Conta não encontrada.');
  await afterVerified(user);
  recordAccessLater(req, user, 'login');
  res.json(await session(user));
}));

/* ------------------------------------------------------------ esqueci minha senha */

authRouter.post('/forgot-password', asyncHandler(async (req, res) => {
  const email = z.object({ email: z.string().trim().email() }).parse(req.body ?? {}).email.toLowerCase();
  if (!emailConfigured()) throw new AppError(503, 'O envio de e-mail não está configurado. Fale com o suporte do Converza.');
  const limits: Limit[] = [
    { key: `reset:email:${email}`, max: 3, windowSec: 3600 },
    { key: `reset:ip:${clientIp(req)}`, max: 20, windowSec: 3600 },
  ];
  await assertUnderLimits(limits, 'redefinição de senha');
  await countAttempt(limits);
  const [user] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`).limit(1);
  if (user) {
    const r = await sendPasswordReset(user);
    if (!r.sent) console.error('[senha] e-mail de redefinição não saiu:', r.error);
  }
  // mesma resposta com ou sem conta: não revela quem tem cadastro
  res.json({ ok: true });
}));

authRouter.post('/reset-password', asyncHandler(async (req, res) => {
  const d = z.object({ token: z.string().trim().max(120), password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres') }).parse(req.body ?? {});
  const userId = await consumeToken(d.token, 'reset');
  if (!userId) throw new AppError(410, 'Este link venceu ou já foi usado. Peça um novo em "Esqueci minha senha".', { code: 'link_invalid' });
  const passwordHash = await bcrypt.hash(d.password, 10);
  // trocar a senha derruba os logins antigos; abrir o link também prova o e-mail
  const [user] = await db.update(schema.users).set({
    passwordHash, passwordChangedAt: new Date(), emailVerifiedAt: sql`coalesce(${schema.users.emailVerifiedAt}, now())`,
  }).where(eq(schema.users.id, userId)).returning();
  if (!user) throw new AppError(410, 'Conta não encontrada.');
  forgetPasswordCache(user.id);
  await clearAttempts([`login:email:${user.email.toLowerCase()}`]);
  await afterVerified(user);
  recordAccessLater(req, user, 'login');
  // o token novo precisa nascer depois da troca (a conferência é por segundo)
  await new Promise((r) => setTimeout(r, 1000));
  res.json(await session(user));
}));
