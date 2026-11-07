/**
 * Gasto das contas de anúncios escolhidas → tabela ad_spend (o Dashboard usa no ROAS e no lucro).
 * Roda a cada hora (últimos 7 dias, porque a Meta ainda ajusta os números) e na hora em que uma conta
 * entra no dashboard (últimos 90 dias).
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { redis } from '../redis';
import { emitToAccount } from '../realtime/io';
import { fetchInsights, MetaApiError } from './graphAds';

export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export function todayIn(tz: string | null | undefined) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
}

/** Perfil com login vencido: avisa na tela e para de tentar até reconectar. */
export async function markProfileProblem(profileId: string, err: MetaApiError) {
  const [p] = await db.update(schema.metaProfiles).set({
    status: err.tokenExpired ? 'expired' : 'error', lastError: err.message, updatedAt: new Date(),
  }).where(eq(schema.metaProfiles.id, profileId)).returning({ accountId: schema.metaProfiles.accountId });
  if (p) emitToAccount(p.accountId, 'meta:changed', { profileId });
}

/** Sincroniza o gasto diário de uma conta de anúncios escolhida. Devolve o erro (texto) se a Meta recusar. */
export async function syncAdAccountSpend(adAccId: string, days = 7): Promise<string | null> {
  const lockKey = `meta-sync:${adAccId}`;
  const got = await redis.set(lockKey, '1', 'PX', 120_000, 'NX').catch(() => 'OK');
  if (!got) return null; // outra sincronização desta conta já está rodando
  try {
    const [row] = await db.select({ a: schema.metaAdAccounts, p: schema.metaProfiles }).from(schema.metaAdAccounts)
      .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
      .where(eq(schema.metaAdAccounts.id, adAccId)).limit(1);
    if (!row || !row.a.selected) return null;
    const until = todayIn(row.a.timezone);
    const since = addDays(until, -(Math.max(1, Math.min(days, 400)) - 1));
    let list;
    try {
      list = await fetchInsights(row.a.actId, row.p.accessToken, { level: 'account', since, until, daily: true });
    } catch (err) {
      const e = err instanceof MetaApiError ? err : new MetaApiError((err as Error).message);
      await db.update(schema.metaAdAccounts).set({ lastError: e.message, updatedAt: new Date() }).where(eq(schema.metaAdAccounts.id, adAccId));
      if (e.tokenExpired) await markProfileProblem(row.p.id, e);
      emitToAccount(row.a.accountId, 'meta:changed', { adAccountId: adAccId });
      return e.message;
    }
    const values = list
      .map((r) => ({ date: r.date_start ?? '', amount: Number(r.spend) || 0 }))
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.amount > 0)
      .map((r) => ({
        accountId: row.a.accountId, date: r.date, amount: r.amount.toFixed(2), currency: row.a.currency, platform: 'meta',
        campaignName: row.a.name, adAccountId: row.a.actId, origin: 'meta',
      }));
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from ad_spend where account_id = ${row.a.accountId} and origin = 'meta'
        and ad_account_id = ${row.a.actId} and date between ${since}::date and ${until}::date`);
      if (values.length) await tx.insert(schema.adSpend).values(values);
    });
    await db.update(schema.metaAdAccounts).set({ lastSyncAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(schema.metaAdAccounts.id, adAccId));
    emitToAccount(row.a.accountId, 'sale:changed', { adSpend: 'meta' });
    emitToAccount(row.a.accountId, 'meta:changed', { adAccountId: adAccId });
    return null;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

/** Tira do Dashboard o gasto que veio de uma conta de anúncios (ela saiu do painel ou o perfil foi removido). */
export async function dropAdAccountSpend(accountId: string, actId: string) {
  await db.execute(sql`delete from ad_spend where account_id = ${accountId} and origin = 'meta' and ad_account_id = ${actId}`);
  emitToAccount(accountId, 'sale:changed', { adSpend: 'meta' });
}

/** A cada hora: atualiza as contas escolhidas (90 dias na primeira vez) e limpa o histórico velho dos pixels. */
export function startMetaAdsSync() {
  const run = async () => {
    const got = await redis.set('meta-sync-sweep', '1', 'PX', 50 * 60_000, 'NX').catch(() => 'OK');
    if (!got) return;
    try {
      const due = await db.select({ id: schema.metaAdAccounts.id, last: schema.metaAdAccounts.lastSyncAt })
        .from(schema.metaAdAccounts)
        .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
        .where(and(eq(schema.metaAdAccounts.selected, true), eq(schema.metaProfiles.status, 'connected'),
          or(isNull(schema.metaAdAccounts.lastSyncAt), lt(schema.metaAdAccounts.lastSyncAt, new Date(Date.now() - 50 * 60_000)))))
        .limit(500);
      for (const a of due) await syncAdAccountSpend(a.id, a.last ? 7 : 90);
      await db.execute(sql`delete from pixel_events where created_at < now() - interval '90 days'`);
    } catch (err) {
      console.error('[meta] sincronização:', (err as Error).message);
    }
  };
  setTimeout(() => void run(), 20_000).unref();
  setInterval(() => void run(), 60 * 60_000).unref();
}
