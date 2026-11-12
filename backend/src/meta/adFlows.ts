/**
 * Campanha → fluxo: lead que chega por um anúncio de uma campanha ligada a um fluxo começa nesse fluxo.
 *
 * O WhatsApp só manda o ID do ANÚNCIO (referral.source_id). A campanha dele vem da Meta (uma vez por anúncio,
 * guardada em cache); os anúncios criados pelo Converza já ficam guardados na criação.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { graphAds } from './graphAds';

const key = (adId: string) => `adcamp:${adId}`;
const FOUND_TTL = 90 * 86400;
const MISS_TTL = 6 * 3600;
const redisLazy = async () => (await import('../redis')).redis;

export async function rememberAdCampaign(adId: string, campaignId: string) {
  const redis = await redisLazy();
  await redis.set(key(adId), campaignId, 'EX', FOUND_TTL).catch(() => undefined);
}

/** Campanha de um anúncio (cache → Meta, com os perfis do Facebook conectados na conta). */
export async function campaignOfAd(accountId: string, adId: string): Promise<string | null> {
  if (!/^\d{6,25}$/.test(adId)) return null;
  const redis = await redisLazy();
  const hit = await redis.get(key(adId)).catch(() => null);
  if (hit) return hit === '-' ? null : hit;
  const profiles = await db.select({ token: schema.metaProfiles.accessToken }).from(schema.metaProfiles)
    .where(and(eq(schema.metaProfiles.accountId, accountId), eq(schema.metaProfiles.status, 'connected')));
  for (const p of profiles) {
    try {
      const r = await graphAds<{ campaign_id?: string }>(adId, { token: p.token, params: { fields: 'campaign_id' }, timeoutMs: 10_000 });
      if (r.campaign_id) { await rememberAdCampaign(adId, String(r.campaign_id)); return String(r.campaign_id); }
    } catch { /* esse perfil não enxerga o anúncio */ }
  }
  await redis.set(key(adId), '-', 'EX', MISS_TTL).catch(() => undefined);
  return null;
}

/** Fluxo ligado à campanha do anúncio clicado (ou null). Só consulta a Meta se a conta tem alguma ligação. */
export async function flowForAdClick(accountId: string, adId: string): Promise<{ flowId: string; campaignId: string } | null> {
  const links = await db.select({ campaignId: schema.metaCampaignFlows.campaignId, flowId: schema.metaCampaignFlows.flowId })
    .from(schema.metaCampaignFlows).where(eq(schema.metaCampaignFlows.accountId, accountId));
  if (!links.length) return null;
  const camp = await campaignOfAd(accountId, adId);
  const hit = camp ? links.find((l) => l.campaignId === camp) : null;
  return hit ? { flowId: hit.flowId, campaignId: hit.campaignId } : null;
}

export async function linkCampaignFlow(accountId: string, actId: string, campaignId: string, flowId: string | null) {
  if (!flowId) {
    await db.delete(schema.metaCampaignFlows).where(and(eq(schema.metaCampaignFlows.accountId, accountId), eq(schema.metaCampaignFlows.campaignId, campaignId)));
    return;
  }
  await db.insert(schema.metaCampaignFlows).values({ accountId, actId, campaignId, flowId })
    .onConflictDoUpdate({ target: [schema.metaCampaignFlows.accountId, schema.metaCampaignFlows.campaignId], set: { flowId, actId, updatedAt: new Date() } });
}
