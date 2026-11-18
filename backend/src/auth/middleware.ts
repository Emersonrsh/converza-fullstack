import type { Request, Response, NextFunction } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { verifyToken } from './jwt';
import { AppError } from '../utils/http';
import { recordAccessLater } from './accessLog';

export const isPlatformAdmin = (email: string | undefined | null) => !!email && config.platformAdmins.includes(email.toLowerCase());
// os acessos dados pelo e-mail (dono da plataforma, suporte, conta da casa) só valem com o e-mail confirmado: authRequired já barra quem não confirmou

export const isSupportEmail = (email: string | undefined | null) => !!email && config.supportEmails.includes(email.toLowerCase());

/** Acesso de suporte valendo agora para esta conta (registra o último uso, no máximo 1 vez por minuto). */
async function supportGrant(email: string, accountId: string) {
  if (!isSupportEmail(email)) return false;
  const now = new Date();
  const [grant] = await db.select().from(schema.supportAccess).where(and(
    eq(schema.supportAccess.accountId, accountId), isNull(schema.supportAccess.revokedAt), gt(schema.supportAccess.expiresAt, now),
  )).limit(1);
  if (!grant) return false;
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() > 60_000 || grant.lastUsedBy !== email.toLowerCase()) {
    await db.update(schema.supportAccess).set({ lastUsedAt: now, lastUsedBy: email.toLowerCase() }).where(eq(schema.supportAccess.id, grant.id));
  }
  return true;
}

/** Ações que o suporte não faz mesmo com acesso (pagar, excluir a empresa, liberar acesso, chaves de API…). */
export function notSupport(req: Request, what = 'Esta ação') {
  if (req.support) throw new AppError(403, `${what} só pode ser feita por alguém da própria empresa (o suporte não faz).`, { code: 'support_blocked' });
}

/** Última troca de senha de cada usuário (guardada por 30 s para não consultar o banco a cada pedido). */
const pwCache = new Map<string, { at: number; changed: number | null }>();
export function forgetPasswordCache(userId: string) { pwCache.delete(userId); }
async function passwordChangedAt(userId: string): Promise<number | null | undefined> {
  const hit = pwCache.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.changed;
  const [u] = await db.select({ p: schema.users.passwordChangedAt }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return undefined;
  const changed = u.p ? u.p.getTime() : null;
  pwCache.set(userId, { at: Date.now(), changed });
  if (pwCache.size > 5000) pwCache.delete(pwCache.keys().next().value as string);
  return changed;
}

/** Confere o token: válido, de um usuário que existe e emitido depois da última troca de senha. */
export async function sessionFrom(token: string): Promise<{ id: string; email: string; verified: boolean } | null> {
  let payload: ReturnType<typeof verifyToken>;
  try { payload = verifyToken(token); } catch { return null; }
  const changed = await passwordChangedAt(payload.userId);
  if (changed === undefined) return null;
  if (changed && (payload.iat ?? 0) < Math.floor(changed / 1000)) return null;
  return { id: payload.userId, email: payload.email, verified: payload.ev !== false };
}

function bearer(req: Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Token ausente');
  return header.slice(7);
}

/** Exige login (mesmo sem o e-mail confirmado): só as rotas de sessão e de confirmação usam este. */
export function authAllowUnverified(req: Request, _res: Response, next: NextFunction) {
  (async () => {
    const user = await sessionFrom(bearer(req));
    if (!user) throw new AppError(401, 'Token inválido ou expirado');
    req.user = user;
    recordAccessLater(req, req.user, 'session');
  })().then(() => next(), next);
}

/** Exige um Bearer token válido de uma conta com o e-mail confirmado e popula req.user. */
export function authRequired(req: Request, res: Response, next: NextFunction) {
  authAllowUnverified(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user!.verified) return next(new AppError(403, 'Confirme o seu e-mail para usar o Converza. Enviamos um link para a sua caixa de entrada.', { code: 'email_not_verified' }));
    next();
  });
}

/**
 * Exige que o usuário pertença à conta indicada no header x-account-id.
 * Popula req.accountId e req.role. Garante o isolamento entre contas (tenants).
 */
export function requireAccount(...roles: Array<'owner' | 'admin' | 'agent'>) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Express 4 não pega erro de função async: sem o catch, um 403 aqui derrubava o servidor inteiro
  return (req: Request, _res: Response, next: NextFunction) => {
    (async () => {
      if (!req.user) throw new AppError(401, 'Não autenticado');
      const accountId = req.header('x-account-id');
      if (!accountId) throw new AppError(400, 'Header x-account-id ausente');
      if (!UUID.test(accountId)) throw new AppError(400, 'Header x-account-id inválido');

      const [membership] = await db
        .select()
        .from(schema.memberships)
        .where(and(eq(schema.memberships.userId, req.user.id), eq(schema.memberships.accountId, accountId)))
        .limit(1);

      let role = membership?.role ?? null;
      if (!membership) {
        // suporte do Converza: só com acesso temporário liberado pela empresa (e enquanto ele vale)
        if (await supportGrant(req.user.email, accountId)) {
          role = 'admin';
          req.support = true;
        } else {
          throw new AppError(403, 'Sem acesso a esta conta', { code: 'no_account_access' });
        }
      }
      // empresa suspensa pelo dono da plataforma: ninguém entra (o dono da plataforma continua vendo)
      const [acc] = await db.select({ at: schema.accounts.suspendedAt, why: schema.accounts.suspendedReason })
        .from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
      if (acc?.at && !isPlatformAdmin(req.user.email)) {
        throw new AppError(403, `Esta empresa está suspensa${acc.why ? `: ${acc.why}` : ''}. Fale com o suporte do Converza.`, { code: 'account_suspended', reason: acc.why ?? null });
      }
      if (roles.length && !roles.includes(role!)) {
        throw new AppError(403, 'Permissão insuficiente');
      }
      req.accountId = accountId;
      req.role = role!;
    })().then(() => next(), next);
  };
}

/** Só os donos da plataforma (PLATFORM_ADMIN_EMAILS). Responde 404 para os outros (nem mostra que existe). */
export function platformAdminRequired(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !isPlatformAdmin(req.user.email)) throw new AppError(404, 'Não encontrado');
  next();
}
