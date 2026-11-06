import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { verifyToken } from './jwt';
import { AppError } from '../utils/http';

/** Exige um Bearer token válido e popula req.user. */
export function authRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Token ausente');
  try {
    const payload = verifyToken(header.slice(7));
    req.user = { id: payload.userId, email: payload.email };
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
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError(401, 'Não autenticado');
    const accountId = req.header('x-account-id');
    if (!accountId) throw new AppError(400, 'Header x-account-id ausente');

    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.userId, req.user.id), eq(schema.memberships.accountId, accountId)))
      .limit(1);

    if (!membership) throw new AppError(403, 'Sem acesso a esta conta');
    if (roles.length && !roles.includes(membership.role)) {
      throw new AppError(403, 'Permissão insuficiente');
    }
    req.accountId = accountId;
    req.role = membership.role;
    next();
  };
}
