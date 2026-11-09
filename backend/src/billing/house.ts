/**
 * Conta da casa: as empresas cujo dono está em HOUSE_EMAILS funcionam como assinatura ativa com HOUSE_INSTANCES
 * instâncias, sem cobrança e sem descontar tokens de IA (o operador paga a IA direto ao provedor).
 * O vencimento acompanha o mês do calendário (é o ciclo da cota de disparos) e é renovado a cada sincronização.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { config } from '../config';
import { emitToAccount } from '../realtime/io';

/** Primeiro dia do próximo mês (UTC): vencimento "de mentira" da conta da casa. */
export function housePeriod(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 3));
}

let running: Promise<{ added: number; removed: number }> | null = null;

/** Marca/desmarca as contas da casa conforme HOUSE_EMAILS. Seguro para chamar várias vezes. */
export function syncHouseAccounts(): Promise<{ added: number; removed: number }> {
  running ??= run().finally(() => { running = null; });
  return running;
}

async function run() {
  const emails = config.house.emails;
  const period = housePeriod();
  const n = config.house.instances;
  const owners = emails.length
    ? (await db.execute(sql`
        select distinct m.account_id from memberships m join users u on u.id = m.user_id
        where m.role = 'owner' and lower(u.email) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`)).rows.map((r) => String((r as { account_id: string }).account_id))
    : [];

  let added = 0;
  for (const accountId of owners) {
    const r = await db.execute(sql`
      insert into subscriptions (account_id, status, instances, current_period_end, house, started_at, cancel_at_period_end, pending_instances, updated_at)
      values (${accountId}, 'active', ${n}, ${period}, true, now(), false, null, now())
      on conflict (account_id) do update set
        status = 'active', instances = ${n}, current_period_end = ${period}, house = true, cancel_at_period_end = false,
        pending_instances = null, started_at = coalesce(subscriptions.started_at, now()), updated_at = now()
      where not subscriptions.house or subscriptions.status <> 'active' or subscriptions.instances <> ${n}
        or subscriptions.current_period_end is distinct from ${period}
      returning account_id`);
    if (r.rows.length) { added++; emitToAccount(accountId, 'billing:changed', {}); }
  }

  // saiu da lista: volta a precisar de assinatura
  const removed = await db.execute(sql`
    update subscriptions set house = false, status = 'canceled', instances = 0, current_period_end = now(), updated_at = now()
    where house ${owners.length ? sql`and account_id not in (${sql.join(owners.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
    returning account_id`);
  for (const row of removed.rows as { account_id: string }[]) emitToAccount(row.account_id, 'billing:changed', {});
  if (added || removed.rows.length) console.log(`[conta da casa] ${added} marcada(s), ${removed.rows.length} desmarcada(s)`);
  return { added, removed: removed.rows.length };
}
