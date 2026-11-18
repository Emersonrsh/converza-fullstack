/**
 * Confirmação de e-mail e "Esqueci minha senha": links de uso único mandados por e-mail.
 * O banco guarda só o hash do link; ele vale uma vez e vence (confirmação em 48 h, senha em 1 h).
 */
import { createHash, randomBytes } from 'crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { emailConfigured, layout, plainText, sendMail, type MailResult } from '../email/mailer';

type Kind = 'verify' | 'reset';
const TTL_MS: Record<Kind, number> = { verify: 48 * 3600_000, reset: 3600_000 };
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const app = () => config.appOrigin.replace(/\/+$/, '');

/** Gera um link novo (os anteriores do mesmo tipo deixam de valer). */
export async function issueToken(userId: string, kind: Kind): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.transaction(async (tx) => {
    await tx.update(schema.userTokens).set({ usedAt: new Date() })
      .where(and(eq(schema.userTokens.userId, userId), eq(schema.userTokens.kind, kind), isNull(schema.userTokens.usedAt)));
    await tx.insert(schema.userTokens).values({ userId, kind, tokenHash: hash(token), expiresAt: new Date(Date.now() + TTL_MS[kind]) });
  });
  return token;
}

/** Usa o link: devolve o usuário se ele vale (e o marca como usado), ou null. */
export async function consumeToken(token: string, kind: Kind): Promise<string | null> {
  if (!/^[\w-]{30,100}$/.test(token)) return null;
  const [row] = await db.update(schema.userTokens).set({ usedAt: new Date() }).where(and(
    eq(schema.userTokens.tokenHash, hash(token)), eq(schema.userTokens.kind, kind),
    isNull(schema.userTokens.usedAt), gt(schema.userTokens.expiresAt, new Date()),
  )).returning({ userId: schema.userTokens.userId });
  return row?.userId ?? null;
}

export const verifyLink = (token: string) => `${app()}/confirmar-email?token=${token}`;
export const resetLink = (token: string) => `${app()}/redefinir-senha?token=${token}`;

/** Sem envio de e-mail configurado no servidor, não dá para exigir a confirmação (ninguém conseguiria entrar). */
// EMAIL_VERIFICATION=off: só nos testes automáticos (nunca em produção)
export const verificationRequired = () => emailConfigured()
  && (process.env.NODE_ENV === 'production' || process.env.EMAIL_VERIFICATION !== 'off');

export async function sendVerification(user: { id: string; name: string; email: string }): Promise<MailResult> {
  const token = await issueToken(user.id, 'verify');
  const title = 'Confirme o seu e-mail';
  const p = [`Olá, ${user.name.split(' ')[0]}! Falta só um passo para começar a usar o Converza.`, 'Clique no botão para confirmar que este e-mail é seu. O link vale por 48 horas.'];
  const button = { label: 'Confirmar meu e-mail', url: verifyLink(token) };
  const footer = 'Se você não criou uma conta no Converza, ignore este e-mail.';
  return sendMail({ to: user.email, subject: title, html: layout(title, p, button, footer), text: plainText(title, p, button) });
}

export async function sendPasswordReset(user: { id: string; name: string; email: string }): Promise<MailResult> {
  const token = await issueToken(user.id, 'reset');
  const title = 'Redefinir a sua senha';
  const p = [`Olá, ${user.name.split(' ')[0]}! Recebemos um pedido para trocar a senha da sua conta no Converza.`, 'Clique no botão para escolher uma senha nova. O link vale por 1 hora e só pode ser usado uma vez.'];
  const button = { label: 'Escolher senha nova', url: resetLink(token) };
  const footer = 'Se você não pediu para trocar a senha, ignore este e-mail: a sua senha continua a mesma.';
  return sendMail({ to: user.email, subject: title, html: layout(title, p, button, footer), text: plainText(title, p, button) });
}
