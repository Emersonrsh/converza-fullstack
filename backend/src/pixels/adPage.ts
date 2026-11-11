/**
 * Página do Facebook de um anúncio de clique para o WhatsApp.
 *
 * A API de Conversões para mensagens comerciais só atribui a venda ao anúncio com
 * action_source = business_messaging + ctwa_clid + a Página (page_id) quando a conexão não é uma WABA
 * (QR Code). O contato guarda o ID do anúncio que clicou (referral.source_id); daqui sai a Página dona dele,
 * lida com o perfil do Facebook conectado em "Perfis e contas" (ads_read).
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { graphAds } from '../meta/graphAds';
import { pageFromAd, type AdRead } from './engine';

const cacheKey = (adId: string) => `adpage:${adId}`;
const FOUND_TTL = 30 * 86400;
const MISS_TTL = 6 * 3600;

/** Página do anúncio (ou null). Tenta os perfis do Facebook da conta e o token do pixel; guarda em cache. */
export async function pageIdForAd(accountId: string, adId: string | null | undefined, extraTokens: (string | null | undefined)[] = []): Promise<string | null> {
  // só ID numérico de anúncio (no QR Code, sem o ID, o contato guarda o ctwa_clid no lugar)
  const ad = String(adId ?? '').trim();
  if (!/^\d{6,25}$/.test(ad)) return null;
  const { redis } = await import('../redis'); // só quando precisa (não segura conexão em quem só importa)
  const cached = await redis.get(cacheKey(ad)).catch(() => null);
  if (cached) return cached === '-' ? null : cached;

  const profiles = await db.select({ token: schema.metaProfiles.accessToken }).from(schema.metaProfiles)
    .where(and(eq(schema.metaProfiles.accountId, accountId), eq(schema.metaProfiles.status, 'connected')));
  const tokens = [...new Set([...profiles.map((p) => p.token), ...extraTokens].filter((t): t is string => !!t))];
  for (const token of tokens) {
    try {
      const a = await graphAds<AdRead>(`/${ad}`, { token, params: { fields: 'creative{effective_object_story_id,object_story_spec{page_id}}' }, timeoutMs: 10_000 });
      const page = pageFromAd(a);
      if (page) {
        await redis.set(cacheKey(ad), page, 'EX', FOUND_TTL).catch(() => undefined);
        return page;
      }
    } catch { /* esse perfil não enxerga o anúncio: tenta o próximo */ }
  }
  await redis.set(cacheKey(ad), '-', 'EX', MISS_TTL).catch(() => undefined);
  return null;
}
