import { and, eq, gt, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { isSupportEmail } from './middleware';

export interface AccountItem { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'agent'; support?: boolean; supportUntil?: Date }

/** Empresas do usuário (e, para a equipe de suporte, as que liberaram acesso temporário). */
export async function accountsFor(userId: string, email: string): Promise<AccountItem[]> {
  const rows = await db.select({
    id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug, role: schema.memberships.role,
  }).from(schema.memberships)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.memberships.accountId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(schema.memberships.createdAt);
  const list: AccountItem[] = rows;
  if (isSupportEmail(email)) {
    const grants = await db.select({ id: schema.accounts.id, name: schema.accounts.name, slug: schema.accounts.slug, until: schema.supportAccess.expiresAt })
      .from(schema.supportAccess)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.supportAccess.accountId))
      .where(and(isNull(schema.supportAccess.revokedAt), gt(schema.supportAccess.expiresAt, new Date())));
    for (const g of grants) {
      if (!list.some((a) => a.id === g.id)) list.push({ id: g.id, name: g.name, slug: g.slug, role: 'admin', support: true, supportUntil: g.until });
    }
  }
  return list;
}
