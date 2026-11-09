import type { Request, Response, NextFunction } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { verifyToken } from './jwt';
import { AppError } from '../utils/http';
import { recordAccessLater } from './accessLog';

export const isPlatformAdmin = (email: string | undefined | null) => !!email && config.platformAdmins.includes(email.toLowerCase());

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

/** Exige um Bearer token válido e popula req.user. */
export function authRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Token ausente');
  try {
    const payload = verifyToken(header.slice(7));
    req.user = { id: payload.userId, email: payload.email };
    recordAccessLater(req, req.user, 'session');
    next();
  } catch {
    throw new AppError(401, 'Token inválido ou expirado');
  }
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
