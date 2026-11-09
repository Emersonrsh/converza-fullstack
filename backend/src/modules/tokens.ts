import { and, eq, gte, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';

/**
 * Tokens de IA: compra avulsa (não fazem parte da assinatura e não vencem). O saldo é da conta inteira;
 * para gastar, a assinatura precisa estar ativa (os agentes e os blocos de IA rodam nas instâncias).
 */
export interface TokenState { status: string; instances: number; balance: number; used: number; lastPurchaseAt: Date | null; house: boolean }

export async function getTokenState(accountId: string): Promise<TokenState> {
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return {
    status: sub?.status ?? 'inactive',
    instances: sub?.instances ?? 0,
    balance: sub?.aiTokensBalance ?? 0,
    used: sub?.aiTokensUsed ?? 0,
    lastPurchaseAt: sub?.lastTokenPurchaseAt ?? null,
    // conta da casa: a IA não desconta do saldo
    house: !!sub?.house,
  };
}

export async function hasTokens(accountId: string): Promise<boolean> {
  const [sub] = await db.select().from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return !!sub && sub.status === 'active' && (sub.house || sub.aiTokensBalance > 0);
}

/** Debita tokens consumidos, nunca abaixo de zero. Retorna o saldo novo. */
export async function debit(accountId: string, amount: number): Promise<number> {
  return (await debitDetailed(accountId, amount)).balance;
}

/** Igual ao debit, dizendo também quanto foi debitado de fato (o saldo pode acabar no meio). */
export async function debitDetailed(accountId: string, amount: number): Promise<{ balance: number; charged: number }> {
  if (amount <= 0) return { balance: (await getTokenState(accountId)).balance, charged: 0 };
  const n = Math.ceil(amount);
  const r = await db.execute(sql`
    with prev as (
      select account_id, ai_tokens_balance as b, house from subscriptions where account_id = ${accountId} for update
    )
    update subscriptions s
       set ai_tokens_used = s.ai_tokens_used + (case when prev.house then ${n}::int else least(${n}::int, prev.b) end),
           ai_tokens_balance = case when prev.house then prev.b else greatest(0, prev.b - ${n}::int) end
      from prev
     where s.account_id = prev.account_id
    returning s.ai_tokens_balance as balance, (case when prev.house then ${n}::int else least(${n}::int, prev.b) end) as charged`);
  const row = r.rows[0] as { balance: number; charged: number } | undefined;
  return { balance: Number(row?.balance ?? 0), charged: Number(row?.charged ?? 0) };
}

/**
 * Reserva tokens antes de um trabalho grande (ex.: traduzir um fluxo): só debita se houver saldo
 * para tudo, assim o trabalho não para no meio. O que sobrar volta com releaseReserved.
 */
export async function reserveTokens(accountId: string, amount: number): Promise<{ ok: true; balance: number } | { ok: false; reason: 'inactive' | 'balance'; balance: number }> {
  const n = Math.max(1, Math.ceil(amount));
  const [row] = await db.update(schema.subscriptions)
    .set({
      // conta da casa: não desconta (só conta o uso)
      aiTokensBalance: sql`case when ${schema.subscriptions.house} then ${schema.subscriptions.aiTokensBalance} else ${schema.subscriptions.aiTokensBalance} - ${n} end`,
      aiTokensUsed: sql`${schema.subscriptions.aiTokensUsed} + ${n}`,
    })
    .where(and(eq(schema.subscriptions.accountId, accountId), eq(schema.subscriptions.status, 'active'),
      or(eq(schema.subscriptions.house, true), gte(schema.subscriptions.aiTokensBalance, n))))
    .returning({ balance: schema.subscriptions.aiTokensBalance });
  if (row) {
    emitToAccount(accountId, 'tokens:update', { balance: row.balance });
    return { ok: true, balance: row.balance };
  }
  const st = await getTokenState(accountId);
  return { ok: false, reason: st.status === 'active' ? 'balance' : 'inactive', balance: st.balance };
}

/** Devolve a parte não usada de uma reserva. */
export async function releaseReserved(accountId: string, amount: number): Promise<number> {
  const n = Math.max(0, Math.floor(amount));
  if (!n) return (await getTokenState(accountId)).balance;
  const [row] = await db.update(schema.subscriptions)
    .set({
      aiTokensBalance: sql`case when ${schema.subscriptions.house} then ${schema.subscriptions.aiTokensBalance} else ${schema.subscriptions.aiTokensBalance} + ${n} end`,
      aiTokensUsed: sql`greatest(0, ${schema.subscriptions.aiTokensUsed} - ${n})`,
    })
    .where(eq(schema.subscriptions.accountId, accountId))
    .returning({ balance: schema.subscriptions.aiTokensBalance });
  emitToAccount(accountId, 'tokens:update', { balance: row?.balance ?? 0 });
  return row?.balance ?? 0;
}

/** Tokens comprados (pagamento confirmado) entram no saldo. */
export async function creditTokens(accountId: string, tokens: number): Promise<number> {
  if (!Number.isInteger(tokens) || tokens <= 0) throw new Error('Quantidade de tokens inválida');
  await db.insert(schema.subscriptions).values({ accountId }).onConflictDoNothing();
  const [row] = await db.update(schema.subscriptions)
    .set({ aiTokensBalance: sql`${schema.subscriptions.aiTokensBalance} + ${tokens}`, lastTokenPurchaseAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.subscriptions.accountId, accountId))
    .returning({ balance: schema.subscriptions.aiTokensBalance });
  emitToAccount(accountId, 'tokens:update', { balance: row?.balance ?? 0 });
  return row?.balance ?? 0;
}

/** Reembolso de uma compra de tokens: tira o que ainda sobra dela (nunca abaixo de zero). */
export async function removeTokens(accountId: string, tokens: number): Promise<number> {
  const [row] = await db.update(schema.subscriptions)
    .set({ aiTokensBalance: sql`greatest(0, ${schema.subscriptions.aiTokensBalance} - ${Math.max(0, tokens)})`, updatedAt: new Date() })
    .where(eq(schema.subscriptions.accountId, accountId))
    .returning({ balance: schema.subscriptions.aiTokensBalance });
  emitToAccount(accountId, 'tokens:update', { balance: row?.balance ?? 0 });
  return row?.balance ?? 0;
}
