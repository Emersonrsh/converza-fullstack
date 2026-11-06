import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { tokensForPlan } from './plans';

export interface TokenState { plan: string | null; status: string; allowance: number; balance: number; }

/** Recarrega a franquia quando o ciclo mensal vira (assinatura ativa). */
export async function ensureRecharged(accountId: string): Promise<void> {
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  if (!sub || sub.status !== 'active' || !sub.currentPeriodEnd) return;
  if (sub.currentPeriodEnd.getTime() > Date.now()) return;

  const allowance = tokensForPlan(sub.plan);
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  await db.update(schema.subscriptions)
    .set({ aiTokensAllowance: allowance, aiTokensBalance: allowance, currentPeriodEnd: next })
    .where(eq(schema.subscriptions.id, sub.id));
}

/** Define franquia e saldo ao (re)assinar um plano, e inicia o ciclo. */
export async function grantPlan(accountId: string, plan: string): Promise<void> {
  const allowance = tokensForPlan(plan);
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  await db.update(schema.subscriptions)
    .set({ aiTokensAllowance: allowance, aiTokensBalance: allowance, currentPeriodEnd: next })
    .where(eq(schema.subscriptions.accountId, accountId));
}

export async function getTokenState(accountId: string): Promise<TokenState> {
  await ensureRecharged(accountId);
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return {
    plan: sub?.plan ?? null,
    status: sub?.status ?? 'inactive',
    allowance: sub?.aiTokensAllowance ?? 0,
    balance: sub?.status === 'active' ? (sub?.aiTokensBalance ?? 0) : 0,
  };
}

export async function hasTokens(accountId: string): Promise<boolean> {
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return !!sub && sub.status === 'active' && sub.aiTokensBalance > 0;
}

/** Debita tokens consumidos, nunca abaixo de zero. Retorna o saldo novo. */
export async function debit(accountId: string, amount: number): Promise<number> {
  if (amount <= 0) { return (await getTokenState(accountId)).balance; }
  const [row] = await db.update(schema.subscriptions)
    .set({ aiTokensBalance: sql`greatest(0, ${schema.subscriptions.aiTokensBalance} - ${Math.ceil(amount)})` })
    .where(eq(schema.subscriptions.accountId, accountId))
    .returning({ balance: schema.subscriptions.aiTokensBalance });
  return row?.balance ?? 0;
}
