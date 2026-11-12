/**
 * Gerenciador de anúncios: o que o Converza muda na Meta (Marketing API).
 *
 * - pausar / ativar campanha, conjunto e anúncio; mudar o orçamento;
 * - criar uma campanha de "clique para o WhatsApp" inteira: imagem → campanha → conjunto → criativo → anúncio.
 *   Se uma etapa falhar, o que já foi criado é apagado (não fica campanha pela metade na conta).
 *
 * Formato (documentação da Meta, "Ads that Click to WhatsApp"): objetivo OUTCOME_ENGAGEMENT; conjunto com
 * destination_type WHATSAPP, optimization_goal CONVERSATIONS, billing_event IMPRESSIONS e promoted_object.page_id;
 * criativo com botão WHATSAPP_MESSAGE e a mensagem pronta em page_welcome_message (VISUAL_EDITOR / autofill_message).
 * Desde a v23 o público precisa dizer se usa o Advantage+ (targeting_automation.advantage_audience 0 ou 1) e, desde a
 * v24, a campanha sem orçamento próprio precisa de is_adset_budget_sharing_enabled.
 */
import { graphAds, MetaApiError } from './graphAds';
import { ZERO_DECIMAL } from './insights';

export const WA_LINK = 'https://api.whatsapp.com/send';

/** Valor da tela (R$ 50,00) → unidade da Meta (5000 centavos; moedas sem centavos vão inteiras). */
export function minorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? Math.round(amount) : Math.round(amount * 100);
}

export interface GeoPick { key: string; name: string; type: 'country' | 'region' | 'city'; countryCode?: string | null }
export interface Audience {
  mode: 'advantage' | 'manual';
  locations: GeoPick[];
  ageMin: number; ageMax: number;
  /** 1 = homens, 2 = mulheres; vazio = todos */
  genders: number[];
  interests: { id: string; name: string }[];
}

export interface CampaignSpec {
  actId: string; currency: string;
  name: string; status: 'ACTIVE' | 'PAUSED';
  budget: { kind: 'daily' | 'lifetime'; amount: number };
  startTime: string | null; endTime: string | null;
  audience: Audience;
  pageId: string; whatsappNumber: string | null;
  ad: { imageHash: string; primaryText: string; headline: string; description: string | null; greeting: string; prefill: string };
}

/** Público da Meta. Um país não entra junto com um estado/cidade dele (a Meta recusa locais sobrepostos). */
export function buildTargeting(a: Audience): Record<string, unknown> {
  const inner = new Set(a.locations.filter((l) => l.type !== 'country' && l.countryCode).map((l) => String(l.countryCode)));
  const countries = a.locations.filter((l) => l.type === 'country' && !inner.has(l.key)).map((l) => l.key);
  const regions = a.locations.filter((l) => l.type === 'region').map((l) => ({ key: l.key }));
  const cities = a.locations.filter((l) => l.type === 'city').map((l) => ({ key: l.key }));
  const geo: Record<string, unknown> = {};
  if (countries.length) geo.countries = countries;
  if (regions.length) geo.regions = regions;
  if (cities.length) geo.cities = cities;
  if (!countries.length && !regions.length && !cities.length) geo.countries = ['BR'];
  const t: Record<string, unknown> = { geo_locations: geo };
  if (a.mode === 'advantage') {
    // Advantage+: a Meta encontra o público; só o local (e a idade mínima, que é uma regra) ficam fixos
    t.targeting_automation = { advantage_audience: 1 };
    if (a.ageMin > 18) t.age_min = Math.min(25, a.ageMin);
    return t;
  }
  t.targeting_automation = { advantage_audience: 0 };
  t.age_min = Math.max(18, Math.min(65, a.ageMin));
  t.age_max = Math.max(Number(t.age_min), Math.min(65, a.ageMax));
  const g = [...new Set(a.genders.filter((x) => x === 1 || x === 2))];
  if (g.length === 1) t.genders = g;
  if (a.interests.length) t.flexible_spec = [{ interests: a.interests.map((i) => ({ id: i.id, name: i.name })) }];
  return t;
}

/** Mensagem de boas-vindas do anúncio: a saudação e o texto que já vem escrito para o cliente mandar. */
export function welcomeMessage(greeting: string, prefill: string): string {
  return JSON.stringify({
    type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text',
    text_format: { customer_action_type: 'autofill_message', message: { text: greeting, autofill_message: { content: prefill } } },
  });
}

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

export function campaignPayload(s: CampaignSpec) {
  return {
    name: s.name, objective: 'OUTCOME_ENGAGEMENT', status: s.status, buying_type: 'AUCTION',
    special_ad_categories: [], is_adset_budget_sharing_enabled: false,
  };
}

export function adsetPayload(s: CampaignSpec, campaignId: string) {
  const wa = digits(s.whatsappNumber);
  return {
    name: `${s.name} — Conjunto`, campaign_id: campaignId, status: 'ACTIVE',
    billing_event: 'IMPRESSIONS', optimization_goal: 'CONVERSATIONS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    destination_type: 'WHATSAPP',
    promoted_object: { page_id: s.pageId, ...(wa ? { whatsapp_phone_number: `+${wa}` } : {}) },
    [s.budget.kind === 'daily' ? 'daily_budget' : 'lifetime_budget']: minorUnits(s.budget.amount, s.currency),
    ...(s.startTime ? { start_time: s.startTime } : {}),
    ...(s.endTime ? { end_time: s.endTime } : {}),
    targeting: buildTargeting(s.audience),
  };
}

export function creativePayload(s: CampaignSpec) {
  return {
    name: `${s.name} — Criativo`,
    object_story_spec: {
      page_id: s.pageId,
      link_data: {
        image_hash: s.ad.imageHash, link: WA_LINK, message: s.ad.primaryText, name: s.ad.headline,
        ...(s.ad.description ? { description: s.ad.description } : {}),
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } },
        page_welcome_message: welcomeMessage(s.ad.greeting, s.ad.prefill),
      },
    },
  };
}

export const adPayload = (s: CampaignSpec, adsetId: string, creativeId: string) => ({
  name: `${s.name} — Anúncio`, adset_id: adsetId, creative: { creative_id: creativeId }, status: 'ACTIVE',
});

/* ------------------------------------------------------------------ chamadas */

/** Erro de uma etapa da criação (para a tela dizer onde parou). */
export class StepError extends Error {
  constructor(public step: string, public cause: MetaApiError) { super(`${step}: ${cause.message}`); }
}

export async function setObjectStatus(id: string, status: 'ACTIVE' | 'PAUSED', token: string) {
  await graphAds<{ success?: boolean }>(id, { token, method: 'POST', body: { status } });
}

export async function setObjectBudget(id: string, kind: 'daily' | 'lifetime', minor: number, token: string) {
  await graphAds<{ success?: boolean }>(id, { token, method: 'POST', body: { [kind === 'daily' ? 'daily_budget' : 'lifetime_budget']: minor } });
}

export interface PageOpt { id: string; name: string; picture: string | null }
/** Páginas que podem anunciar nesta conta (as "promote_pages"; sem elas, as Páginas do perfil). */
export async function listAdPages(actId: string, token: string): Promise<PageOpt[]> {
  type P = { id: string; name?: string; picture?: { data?: { url?: string } } };
  const map = (list: P[]) => list.map((p) => ({ id: String(p.id), name: p.name || p.id, picture: p.picture?.data?.url ?? null }));
  const promo = await graphAds<{ data?: P[] }>(`${actId}/promote_pages`, { token, params: { fields: 'id,name,picture{url}', limit: 100 } }).catch(() => null);
  if (promo?.data?.length) return map(promo.data);
  const mine = await graphAds<{ data?: P[] }>('me/accounts', { token, params: { fields: 'id,name,picture{url}', limit: 100 } });
  return map(mine.data ?? []);
}

export async function searchGeo(q: string, token: string): Promise<GeoPick[]> {
  const r = await graphAds<{ data?: { key: string; name: string; type: string; country_code?: string; country_name?: string; region?: string }[] }>('search', {
    token, params: { type: 'adgeolocation', location_types: JSON.stringify(['country', 'region', 'city']), q, limit: 12, locale: 'pt_BR' },
  });
  return (r.data ?? []).filter((x) => ['country', 'region', 'city'].includes(x.type)).map((x) => ({
    key: String(x.key), type: x.type as GeoPick['type'], countryCode: x.country_code ?? null,
    name: x.type === 'country' ? x.name : [x.name, x.type === 'city' ? x.region : null, x.country_name].filter(Boolean).join(', '),
  }));
}

export async function searchInterests(q: string, token: string) {
  const r = await graphAds<{ data?: { id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number; path?: string[] }[] }>('search', {
    token, params: { type: 'adinterest', q, limit: 12, locale: 'pt_BR' },
  });
  return (r.data ?? []).map((x) => ({
    id: String(x.id), name: x.name, size: x.audience_size_upper_bound ?? x.audience_size_lower_bound ?? null, path: (x.path ?? []).join(' › ') || null,
  }));
}

/** Sobe a imagem para a biblioteca da conta e devolve o hash (é ele que o criativo usa). */
export async function uploadAdImage(actId: string, name: string, base64: string, token: string): Promise<{ hash: string; url: string | null }> {
  const r = await graphAds<{ images?: Record<string, { hash?: string; url?: string }> }>(`${actId}/adimages`, {
    token, method: 'POST', body: { bytes: base64, name }, timeoutMs: 60_000,
  });
  const img = Object.values(r.images ?? {})[0];
  if (!img?.hash) throw new MetaApiError('A Meta não devolveu a imagem enviada. Tente outra imagem (JPG ou PNG).', 502);
  return { hash: img.hash, url: img.url ?? null };
}

export interface Created { campaignId: string; adsetId: string; creativeId: string; adId: string }

/** Cria a campanha inteira. Se algo falhar no meio, apaga o que já tinha criado. */
export async function createCtwaCampaign(s: CampaignSpec, token: string): Promise<Created> {
  const made: { campaignId?: string; creativeId?: string } = {};
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (err) {
      const e = err instanceof MetaApiError ? err : new MetaApiError((err as Error).message);
      // desfaz: apagar a campanha leva junto o conjunto e o anúncio
      if (made.campaignId) await graphAds(made.campaignId, { token, method: 'DELETE' }).catch(() => undefined);
      if (made.creativeId) await graphAds(made.creativeId, { token, method: 'DELETE' }).catch(() => undefined);
      throw new StepError(label, e);
    }
  };
  const c = await step('Campanha', () => graphAds<{ id: string }>(`${s.actId}/campaigns`, { token, method: 'POST', body: campaignPayload(s) }));
  made.campaignId = String(c.id);
  const set = await step('Conjunto de anúncios (público e orçamento)', () => graphAds<{ id: string }>(`${s.actId}/adsets`, { token, method: 'POST', body: adsetPayload(s, made.campaignId!) }));
  const cr = await step('Criativo (imagem, textos e mensagem)', () => graphAds<{ id: string }>(`${s.actId}/adcreatives`, { token, method: 'POST', body: creativePayload(s) }));
  made.creativeId = String(cr.id);
  const ad = await step('Anúncio', () => graphAds<{ id: string }>(`${s.actId}/ads`, { token, method: 'POST', body: adPayload(s, String(set.id), made.creativeId!) }));
  return { campaignId: made.campaignId, adsetId: String(set.id), creativeId: made.creativeId, adId: String(ad.id) };
}

/** Link do Gerenciador de Anúncios da Meta já na campanha. */
export const adsManagerUrl = (actId: string, campaignId: string) =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${actId.replace(/^act_/, '')}&selected_campaign_ids=${campaignId}`;
