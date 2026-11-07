/**
 * Cota dos disparos em massa: o plano inclui N contatos por ciclo da assinatura e o saldo extra
 * (pacotes comprados) entra depois da cota e não vence. Débito atômico: 1 por contato enviado.
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { dispatchQuotaFor } from './plans';
import { cycleOf } from '../utils/cycle';
export { cycleOf, addMonths } from '../utils/cycle';

export interface DispatchQuota {
  active: boolean; instances: number;
  cycleLimit: number; usedInCycle: number; extra: number;
  /** o que sobra da cota do ciclo + saldo extra */
  remaining: number;
  cycleStart: string; cycleEnd: string; cycleKey: string;
}

async function subOf(accountId: string) {
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  return sub ?? null;
}

export async function dispatchQuota(accountId: string): Promise<DispatchQuota> {
  const sub = await subOf(accountId);
  const active = sub?.status === 'active';
  // mensalidade vencida e ainda não paga (tolerância de 3 dias): segue no último ciclo pago, sem cota nova
  const end = sub?.currentPeriodEnd ?? null;
  const c = cycleOf(end, end && end.getTime() <= Date.now() ? new Date(end.getTime() - 1000) : new Date());
  const limit = dispatchQuotaFor(sub?.instances, active);
  const [u] = await db.select({ used: schema.dispatchUsage.used }).from(schema.dispatchUsage)
    .where(sql`${schema.dispatchUsage.accountId} = ${accountId} and ${schema.dispatchUsage.cycle} = ${c.key}`).limit(1);
  const used = u?.used ?? 0;
  const extra = sub?.dispatchExtra ?? 0;
  return {
    active, instances: sub?.instances ?? 0, cycleLimit: limit, usedInCycle: used, extra,
    // saldo extra só vale com assinatura ativa
    remaining: Math.max(0, limit - used) + (active ? extra : 0),
    cycleStart: c.start.toISOString(), cycleEnd: c.end.toISOString(), cycleKey: c.key,
  };
}

export type Charge = { from: 'quota' | 'extra'; cycle: string };

/** Debita 1 disparo: primeiro a cota do ciclo, depois o saldo extra. null = acabou. */
export async function chargeDispatch(accountId: string): Promise<Charge | null> {
  const q = await dispatchQuota(accountId);
  if (!q.active) return null;
  if (q.cycleLimit > 0) {
    const r = await db.execute(sql`
      insert into dispatch_usage (account_id, cycle, used) values (${accountId}, ${q.cycleKey}, 1)
      on conflict (account_id, cycle) do update set used = dispatch_usage.used + 1
      where dispatch_usage.used < ${q.cycleLimit}
      returning used`);
    if (r.rows.length) return { from: 'quota', cycle: q.cycleKey };
  }
  const x = await db.execute(sql`
    update subscriptions set dispatch_extra = dispatch_extra - 1
    where account_id = ${accountId} and dispatch_extra > 0 returning dispatch_extra`);
  return x.rows.length ? { from: 'extra', cycle: q.cycleKey } : null;
}

/** Devolve o débito quando nada foi enviado (falha antes de a Meta aceitar). */
export async function refundDispatch(accountId: string, c: Charge) {
  if (c.from === 'quota') {
    await db.execute(sql`update dispatch_usage set used = greatest(used - 1, 0) where account_id = ${accountId} and cycle = ${c.cycle}`);
  } else {
    await db.execute(sql`update subscriptions set dispatch_extra = dispatch_extra + 1 where account_id = ${accountId}`);
  }
}

/** Pacote pago (chamado pela cobrança quando o pagamento é confirmado). */
export async function creditExtraDispatches(accountId: string, quantity: number) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantidade inválida');
  const r = await db.execute(sql`
    update subscriptions set dispatch_extra = dispatch_extra + ${quantity} where account_id = ${accountId} returning dispatch_extra`);
  return Number((r.rows[0] as { dispatch_extra?: number } | undefined)?.dispatch_extra ?? 0);
}
