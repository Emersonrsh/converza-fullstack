/**
 * Cache curto das chamadas à Meta (compartilhado pelo Gerenciador, pelo Dashboard e pelas regras) e
 * a lista de IDs de anúncios de cada conta de anúncios — usada para filtrar vendas e leads por conta.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { redis } from '../redis';
import { fetchEntities } from './graphAds';

export async function cached<T>(key: string, ttlSec: number, fresh: boolean, fn: () => Promise<T>): Promise<{ v: T; at: number }> {
  if (!fresh) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as { v: T; at: number };
    } catch { /* sem cache */ }
  }
  const out = { v: await fn(), at: Date.now() };
  redis.set(key, JSON.stringify(out), 'EX', ttlSec).catch(() => {});
  return out;
}

/** IDs dos anúncios das contas escolhidas (as que a Meta não responder ficam de fora). */
export async function adIdsOf(accountId: string, actIds: string[]): Promise<string[]> {
  if (!actIds.length) return [];
  const accs = await db.select({ actId: schema.metaAdAccounts.actId, profileId: schema.metaAdAccounts.profileId, token: schema.metaProfiles.accessToken, status: schema.metaProfiles.status })
    .from(schema.metaAdAccounts).innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.selected, true), inArray(schema.metaAdAccounts.actId, actIds)));
  const out: string[] = [];
  await Promise.all(accs.map(async (a) => {
    if (a.status === 'expired') return;
    try {
      const r = await cached(`meta:${accountId}:${a.profileId}:${a.actId}:ent:ad`, 600, false, () => fetchEntities(a.actId, a.token, 'ad'));
      out.push(...r.v.map((x) => x.id));
    } catch { /* conta sem resposta: sem anúncios no filtro */ }
  }));
  return out;
}

/** "act_1,act_2" da URL → lista válida (vazia = todas as contas). */
export function parseActIds(v: unknown): string[] {
  return [...new Set(String(v ?? '').split(',').map((s) => s.trim()).filter((s) => /^act_\d{1,30}$/.test(s)))].slice(0, 50);
}
