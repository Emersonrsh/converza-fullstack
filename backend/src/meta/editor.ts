/**
 * Editor de campanhas (igual ao da Meta): lê uma campanha inteira (campanha → conjuntos → anúncios → criativos),
 * publica a árvore criando ou mudando o que mudou, duplica, exclui e faz as buscas que o editor usa
 * (pixels, públicos, idiomas, direcionamento detalhado, Instagram, formulários, apps, biblioteca de mídia,
 * tamanho estimado do público).
 *
 * A tela monta os campos no formato da Marketing API; aqui cada nível só aceita os campos da lista (o resto é
 * ignorado) e os valores em dinheiro vêm na moeda da conta (50 = R$ 50,00) e viram centavos.
 */
import { config } from '../config';
import { graphAds, graphAdsAll, metaError, MetaApiError } from './graphAds';
import { minorUnits, StepError } from './adsWrite';
import { ZERO_DECIMAL } from './insights';

export type EditLevel = 'campaign' | 'adset' | 'ad' | 'creative';

export const ALLOWED: Record<EditLevel, string[]> = {
  campaign: ['name', 'objective', 'status', 'buying_type', 'special_ad_categories', 'special_ad_category_country', 'daily_budget',
    'lifetime_budget', 'bid_strategy', 'spend_cap', 'start_time', 'stop_time', 'is_adset_budget_sharing_enabled', 'pacing_type'],
  adset: ['name', 'status', 'optimization_goal', 'billing_event', 'bid_strategy', 'bid_amount', 'bid_constraints', 'daily_budget',
    'lifetime_budget', 'daily_min_spend_target', 'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap', 'start_time',
    'end_time', 'destination_type', 'promoted_object', 'targeting', 'attribution_spec', 'pacing_type', 'frequency_control_specs',
    'is_dynamic_creative', 'dsa_beneficiary', 'dsa_payor', 'multi_optimization_goal_weight'],
  ad: ['name', 'status', 'tracking_specs', 'conversion_domain'],
  creative: ['name', 'object_story_spec', 'asset_feed_spec', 'url_tags', 'degrees_of_freedom_spec', 'contextual_multi_ads', 'object_story_id', 'source_instagram_media_id',
    'instagram_user_id', 'object_id', 'call_to_action'],
};

export const MONEY: Record<EditLevel, string[]> = {
  campaign: ['daily_budget', 'lifetime_budget', 'spend_cap'],
  adset: ['daily_budget', 'lifetime_budget', 'bid_amount', 'daily_min_spend_target', 'daily_spend_cap', 'lifetime_min_spend_target', 'lifetime_spend_cap'],
  ad: [], creative: [],
};

/** Valor que a Meta documenta para tirar o limite de gastos da campanha (ela recusa 0). */
export const NO_SPEND_CAP = 922337203685478;

/**
 * Só os campos permitidos do nível, com dinheiro em centavos.
 * Dinheiro vazio (`null`/''): ao criar, não vai (a Meta recusa 0 e o padrão já é "sem limite");
 * ao editar, tira o valor: `spend_cap` com o valor de remoção da Meta, os demais com 0.
 */
export function cleanFields(level: EditLevel, fields: Record<string, unknown> | undefined, currency: string, mode: 'create' | 'update' = 'update'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ALLOWED[level]) {
    if (!fields || !(k in fields) || fields[k] === undefined) continue;
    const v = fields[k];
    if (MONEY[level].includes(k)) {
      const empty = v === null || v === '' || Number(v) <= 0;
      if (!empty) out[k] = minorUnits(Number(v), currency);
      else if (mode === 'update') out[k] = k === 'spend_cap' ? NO_SPEND_CAP : 0;
    } else out[k] = v;
  }
  return out;
}

/** Valores da Meta → tela (centavos voltam a reais). */
export function readFields(level: EditLevel, obj: Record<string, unknown>, currency: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const div = ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
  for (const k of ALLOWED[level]) {
    if (!(k in obj)) continue;
    const v = obj[k];
    // sem limite na Meta volta como 0 ou como o valor de remoção: os dois viram vazio na tela
    out[k] = MONEY[level].includes(k) ? (Number(v) > 0 && Number(v) < NO_SPEND_CAP ? Number(v) / div : null) : v;
  }
  return out;
}

const F = {
  campaign: ALLOWED.campaign.filter((k) => !['is_adset_budget_sharing_enabled', 'pacing_type'].includes(k)).concat(['id', 'effective_status', 'is_adset_budget_sharing_enabled']).join(','),
  adset: ALLOWED.adset.filter((k) => !['dsa_beneficiary', 'dsa_payor', 'multi_optimization_goal_weight', 'is_dynamic_creative'].includes(k)).concat(['id', 'campaign_id', 'effective_status']).join(','),
  ad: 'id,name,status,effective_status,adset_id,campaign_id,tracking_specs,conversion_domain,creative{id,name,object_story_spec,asset_feed_spec,url_tags,thumbnail_url,image_url,effective_object_story_id,object_story_id,source_instagram_media_id,instagram_user_id,call_to_action,contextual_multi_ads}',
};

export interface TreeAd { id: string; fields: Record<string, unknown>; creative: Record<string, unknown> | null; creativeId: string | null; thumbnail: string | null }
export interface TreeAdset { id: string; fields: Record<string, unknown>; ads: TreeAd[] }
export interface Tree { campaign: { id: string; fields: Record<string, unknown> }; adsets: TreeAdset[] }

/** Lê a campanha inteira para o editor. */
export async function readTree(campaignId: string, token: string, currency: string): Promise<Tree> {
  const c = await graphAds<Record<string, unknown>>(campaignId, { token, params: { fields: F.campaign } });
  const sets = await graphAdsAll<Record<string, unknown>>(`${campaignId}/adsets`, token, { fields: F.adset }, 200);
  const ads = await graphAdsAll<Record<string, unknown>>(`${campaignId}/ads`, token, { fields: F.ad }, 500);
  const alive = (x: Record<string, unknown>) => !['DELETED', 'ARCHIVED'].includes(String(x.effective_status ?? x.status ?? ''));
  return {
    campaign: { id: String(c.id), fields: readFields('campaign', c, currency) },
    adsets: sets.filter(alive).map((s) => ({
      id: String(s.id), fields: readFields('adset', s, currency),
      ads: ads.filter(alive).filter((a) => String(a.adset_id) === String(s.id)).map((a) => {
        const cr = (a.creative ?? null) as Record<string, unknown> | null;
        return {
          id: String(a.id), fields: readFields('ad', a, currency),
          creative: cr ? readFields('creative', cr, currency) : null,
          creativeId: cr?.id ? String(cr.id) : null,
          thumbnail: (cr?.thumbnail_url as string) ?? (cr?.image_url as string) ?? null,
        };
      }),
    })),
  };
}

/* ------------------------------------------------------------------ publicar */

export interface PubAd { key: string; id?: string | null; fields?: Record<string, unknown>; creative?: Record<string, unknown> | null; creativeId?: string | null }
export interface PubAdset { key: string; id?: string | null; fields?: Record<string, unknown>; ads: PubAd[] }
export interface PubTree {
  campaign: { id?: string | null; fields?: Record<string, unknown> };
  adsets: PubAdset[];
  /** conjuntos e anúncios que saíram do editor (são excluídos na Meta) */
  remove?: string[];
}
export interface PubResult { campaignId: string; ids: Record<string, string>; created: string[]; updated: string[]; removed: string[]; adCampaign: [string, string][] }

/**
 * Publica a árvore: cria o que não tem id, muda só os campos enviados do que já existe e exclui o que saiu.
 * Se uma etapa falhar, apaga o que esta publicação criou (as mudanças já salvas ficam) e diz em qual parou.
 */
export async function publishTree(actId: string, t: PubTree, token: string, currency: string): Promise<PubResult> {
  const res: PubResult = { campaignId: '', ids: {}, created: [], updated: [], removed: [], adCampaign: [] };
  const createdObjs: string[] = []; // na ordem: campanha, conjuntos, criativos, anúncios
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (err) {
      const e = err instanceof MetaApiError ? err : new MetaApiError((err as Error).message);
      // desfaz o que esta publicação criou (do mais novo ao mais antigo)
      for (const id of [...createdObjs].reverse()) await graphAds(id, { token, method: 'DELETE' }).catch(() => undefined);
      const se = new StepError(label, e) as StepError & { saved?: string[] };
      se.saved = res.updated;
      throw se;
    }
  };

  const cf = cleanFields('campaign', t.campaign.fields, currency, t.campaign.id ? 'update' : 'create');
  if (t.campaign.id) {
    res.campaignId = t.campaign.id;
    if (Object.keys(cf).length) {
      await step('Campanha', () => graphAds(t.campaign.id!, { token, method: 'POST', body: cf }));
      res.updated.push(t.campaign.id);
    }
  } else {
    if (!cf.special_ad_categories) cf.special_ad_categories = [];
    if (!cf.status) cf.status = 'PAUSED';
    if (!cf.buying_type) cf.buying_type = 'AUCTION';
    const c = await step('Campanha', () => graphAds<{ id: string }>(`${actId}/campaigns`, { token, method: 'POST', body: cf }));
    res.campaignId = String(c.id); createdObjs.push(res.campaignId);
  }
  res.ids.campaign = res.campaignId;

  for (const [i, s] of t.adsets.entries()) {
    const sf = cleanFields('adset', s.fields, currency, s.id ? 'update' : 'create');
    const sName = String(s.fields?.name ?? `Conjunto ${i + 1}`);
    let setId = s.id ?? '';
    if (setId) {
      if (Object.keys(sf).length) {
        await step(`Conjunto “${sName}”`, () => graphAds(setId, { token, method: 'POST', body: sf }));
        res.updated.push(setId);
      }
    } else {
      if (!sf.status) sf.status = 'ACTIVE';
      const made = await step(`Conjunto “${sName}”`, () => graphAds<{ id: string }>(`${actId}/adsets`, { token, method: 'POST', body: { ...sf, campaign_id: res.campaignId } }));
      setId = String(made.id); createdObjs.push(setId);
    }
    res.ids[s.key] = setId;

    for (const [j, a] of s.ads.entries()) {
      const af = cleanFields('ad', a.fields, currency);
      const aName = String(a.fields?.name ?? `Anúncio ${j + 1}`);
      if (a.creative) {
        const crf = cleanFields('creative', a.creative, currency);
        if (!crf.name) crf.name = `${aName} — Criativo`;
        const cr = await step(`Anúncio “${aName}” (criativo)`, () => graphAds<{ id: string }>(`${actId}/adcreatives`, { token, method: 'POST', body: crf }));
        createdObjs.push(String(cr.id));
        af.creative = { creative_id: String(cr.id) };
      }
      // anúncio novo copiado de outro no editor: usa o mesmo criativo já publicado
      if (!af.creative && !a.id && a.creativeId) af.creative = { creative_id: a.creativeId };
      let adId = a.id ?? '';
      if (adId) {
        if (Object.keys(af).length) {
          await step(`Anúncio “${aName}”`, () => graphAds(adId, { token, method: 'POST', body: af }));
          res.updated.push(adId);
        }
      } else {
        if (!af.creative) await step(`Anúncio “${aName}”`, async () => { throw new MetaApiError('Falta o criativo (mídia e textos) do anúncio.', 422); });
        if (!af.status) af.status = 'ACTIVE';
        const made = await step(`Anúncio “${aName}”`, () => graphAds<{ id: string }>(`${actId}/ads`, { token, method: 'POST', body: { ...af, adset_id: setId } }));
        adId = String(made.id); createdObjs.push(adId);
      }
      res.ids[a.key] = adId;
      res.adCampaign.push([adId, res.campaignId]);
    }
  }

  for (const id of t.remove ?? []) {
    await step('Excluir', () => graphAds(id, { token, method: 'DELETE' }));
    res.removed.push(id);
  }
  res.created = createdObjs;
  return res;
}

/** Duplica campanha, conjunto ou anúncio (a cópia sai pausada). */
export async function copyObject(id: string, level: 'campaign' | 'adset' | 'ad', token: string, deep: boolean): Promise<string> {
  const body: Record<string, unknown> = { status_option: 'PAUSED', rename_options: { rename_strategy: 'DEEP_RENAME', rename_suffix: ' - Cópia' } };
  if (level !== 'ad') body.deep_copy = deep;
  const r = await graphAds<Record<string, unknown>>(`${id}/copies`, { token, method: 'POST', body });
  const got = r.copied_campaign_id ?? r.copied_adset_id ?? r.copied_ad_id ?? (r.ad_object_ids as { copied_id?: string }[] | undefined)?.[0]?.copied_id;
  if (!got) throw new MetaApiError('A Meta não devolveu a cópia.', 502);
  return String(got);
}

/* ------------------------------------------------------------------ buscas do editor */

type Any = Record<string, unknown>;
const list = (r: { data?: Any[] }) => r.data ?? [];

export async function lookup(what: string, actId: string, token: string, q: string, pageId: string | null): Promise<Any[]> {
  switch (what) {
    case 'pixels':
      return list(await graphAds(`${actId}/adspixels`, { token, params: { fields: 'id,name,last_fired_time,is_unavailable', limit: 100 } }))
        .map((p) => {
          const last = p.last_fired_time ? Date.parse(String(p.last_fired_time)) : 0;
          return { id: String(p.id), name: p.name ?? p.id, lastFired: p.last_fired_time ?? null, active: !p.is_unavailable && last > Date.now() - 7 * 86400_000 };
        });
    case 'custom-conversions':
      return list(await graphAds(`${actId}/customconversions`, { token, params: { fields: 'id,name,custom_event_type,pixel{id},is_archived', limit: 200 } }))
        .filter((c) => !c.is_archived)
        .map((c) => ({ id: String(c.id), name: c.name, event: c.custom_event_type ?? 'OTHER', pixelId: (c.pixel as Any | undefined)?.id ? String((c.pixel as Any).id) : null }));
    case 'page-posts': {
      if (!pageId) return [];
      // publicações da Página pedem o token da Página (vem do token da pessoa)
      const pg = await graphAds<Any>(pageId, { token, params: { fields: 'access_token' } }).catch(() => ({} as Any));
      const pt = typeof pg.access_token === 'string' ? pg.access_token : token;
      return list(await graphAds(`${pageId}/posts`, { token: pt, params: { fields: 'id,message,full_picture,created_time,permalink_url', limit: 30 } }))
        .map((x) => ({ id: String(x.id), text: x.message ?? '', picture: x.full_picture ?? null, at: x.created_time ?? null, url: x.permalink_url ?? null }));
    }
    case 'ig-media': {
      if (!q || !/^\d{5,30}$/.test(q)) return [];
      return list(await graphAds(`${q}/media`, { token, params: { fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink', limit: 30 } }))
        .map((x) => ({ id: String(x.id), text: x.caption ?? '', picture: x.thumbnail_url ?? x.media_url ?? null, type: x.media_type ?? null, at: x.timestamp ?? null, url: x.permalink ?? null }));
    }
    case 'video-thumbs': {
      if (!q || !/^\d{5,30}$/.test(q)) return [];
      return list(await graphAds(`${q}/thumbnails`, { token, params: { fields: 'id,uri,is_preferred,width,height' } }))
        .map((t) => ({ id: String(t.id ?? t.uri), uri: t.uri, preferred: !!t.is_preferred }));
    }
    case 'custom-audiences':
      return list(await graphAds(`${actId}/customaudiences`, { token, params: { fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound', limit: 200 } }))
        .map((a) => ({ id: String(a.id), name: a.name, subtype: a.subtype ?? null, size: a.approximate_count_upper_bound ?? a.approximate_count_lower_bound ?? null }));
    case 'saved-audiences':
      return list(await graphAds(`${actId}/saved_audiences`, { token, params: { fields: 'id,name,targeting', limit: 100 } }))
        .map((a) => ({ id: String(a.id), name: a.name, targeting: a.targeting ?? null }));
    case 'locales': {
      if (q.length < 2) return [];
      return list(await graphAds('search', { token, params: { type: 'adlocale', q, limit: 15, locale: 'pt_BR' } }))
        .map((l) => ({ key: Number(l.key), name: l.name }));
    }
    case 'detailed': {
      if (q.length < 2) return [];
      return list(await graphAds(`${actId}/targetingsearch`, { token, params: { q, limit: 25, locale: 'pt_BR' } }))
        .map((x) => ({
          id: String(x.id), name: x.name, type: x.type ?? 'interests', path: Array.isArray(x.path) ? (x.path as string[]).join(' › ') : null,
          size: x.audience_size_upper_bound ?? x.audience_size_lower_bound ?? null,
        }));
    }
    case 'geo': {
      if (q.length < 2) return [];
      const r = await graphAds<{ data?: Any[] }>('search', {
        token, params: { type: 'adgeolocation', location_types: JSON.stringify(['country', 'region', 'city', 'zip', 'geo_market', 'neighborhood']), q, limit: 15, locale: 'pt_BR' },
      });
      return list(r).map((x) => ({
        key: String(x.key), type: String(x.type), countryCode: x.country_code ?? null,
        name: x.type === 'country' ? x.name : [x.name, x.type === 'city' || x.type === 'neighborhood' ? x.region : null, x.country_name].filter(Boolean).join(', '),
      }));
    }
    case 'instagram': {
      if (!pageId) return [];
      const p = await graphAds<Any>(pageId, { token, params: { fields: 'instagram_business_account{id,username,profile_picture_url}' } }).catch(() => ({} as Any));
      const ig = p.instagram_business_account as Any | undefined;
      const out = ig?.id ? [{ id: String(ig.id), username: ig.username ?? null, picture: ig.profile_picture_url ?? null }] : [];
      const more = await graphAds<{ data?: Any[] }>(`${actId}/instagram_accounts`, { token, params: { fields: 'id,username,profile_pic', limit: 50 } }).catch(() => ({ data: [] }));
      for (const a of list(more)) if (!out.some((o) => o.id === String(a.id))) out.push({ id: String(a.id), username: a.username ?? null, picture: a.profile_pic ?? null });
      return out;
    }
    case 'lead-forms': {
      if (!pageId) return [];
      return list(await graphAds(`${pageId}/leadgen_forms`, { token, params: { fields: 'id,name,status', limit: 100 } }))
        .filter((f) => f.status !== 'ARCHIVED').map((f) => ({ id: String(f.id), name: f.name, status: f.status ?? null }));
    }
    case 'apps':
      return list(await graphAds(`${actId}/advertisable_applications`, { token, params: { fields: 'id,name,object_store_urls,logo_url', limit: 50 } }))
        .map((a) => ({ id: String(a.id), name: a.name, stores: a.object_store_urls ?? {}, logo: a.logo_url ?? null }));
    case 'images':
      return list(await graphAds(`${actId}/adimages`, { token, params: { fields: 'hash,name,url,width,height,created_time', limit: 60 } }))
        .map((i) => ({ hash: String(i.hash), name: i.name ?? null, url: i.url ?? null, width: i.width ?? null, height: i.height ?? null }));
    case 'videos':
      return list(await graphAds(`${actId}/advideos`, { token, params: { fields: 'id,title,picture,length,created_time', limit: 60 } }))
        .map((v) => ({ id: String(v.id), title: v.title ?? null, picture: v.picture ?? null, length: v.length ?? null }));
    default:
      throw new MetaApiError('Busca desconhecida', 404);
  }
}

/** Tamanho estimado do público (o mesmo número do painel da direita na Meta). */
export async function deliveryEstimate(actId: string, token: string, targeting: unknown, goal: string, promoted: unknown) {
  const r = await graphAds<{ data?: { estimate_mau_lower_bound?: number; estimate_mau_upper_bound?: number; estimate_ready?: boolean }[] }>(`${actId}/delivery_estimate`, {
    token, params: { targeting_spec: JSON.stringify(targeting ?? {}), optimization_goal: goal || 'REACH', ...(promoted ? { promoted_object: JSON.stringify(promoted) } : {}) },
  });
  const d = r.data?.[0] ?? {};
  return { lower: d.estimate_mau_lower_bound ?? null, upper: d.estimate_mau_upper_bound ?? null, ready: d.estimate_ready !== false };
}

/* ------------------------------------------------------------------ vídeo */

const videoBase = () => {
  const b = config.whatsapp.graphBase.replace('://graph.facebook.com', '://graph-video.facebook.com');
  return `${b}/${config.meta.adsApiVersion}`;
};

/** Sobe um vídeo para a biblioteca da conta (envio único, até 200 MB). */
export async function uploadAdVideo(actId: string, name: string, bytes: Buffer, mime: string, token: string): Promise<string> {
  const form = new FormData();
  form.set('title', name.slice(0, 120));
  form.set('source', new Blob([new Uint8Array(bytes)], { type: mime || 'video/mp4' }), name);
  let resp: Response;
  try {
    resp = await fetch(`${videoBase()}/${actId}/advideos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(300_000) });
  } catch (err) {
    throw new MetaApiError(`Sem conexão com a Meta (${(err as Error).message}). Tente de novo.`, 502);
  }
  const data = (await resp.json().catch(() => ({}))) as { id?: string; error?: unknown };
  if (!resp.ok || data.error) throw metaError(data, resp.status);
  if (!data.id) throw new MetaApiError('A Meta não devolveu o vídeo enviado.', 502);
  return String(data.id);
}

/** Situação do vídeo (a Meta processa antes de poder usar) e a capa sugerida. */
export async function videoState(videoId: string, token: string) {
  const v = await graphAds<Any>(videoId, { token, params: { fields: 'status,picture,length,thumbnails{uri,is_preferred}' } });
  const st = (v.status as Any | undefined)?.video_status ?? 'ready';
  const thumbs = ((v.thumbnails as { data?: Any[] } | undefined)?.data ?? []);
  const best = thumbs.find((t) => t.is_preferred) ?? thumbs[0];
  return { status: String(st), ready: String(st) === 'ready', thumbnail: (best?.uri as string) ?? (v.picture as string) ?? null, length: v.length ?? null };
}


/* ------------------------------------------------------------------ prévia real, corte de vídeo e legendas */

export const PREVIEW_FORMATS = ['MOBILE_FEED_STANDARD', 'DESKTOP_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY', 'INSTAGRAM_REELS',
  'FACEBOOK_STORY_MOBILE', 'FACEBOOK_REELS_MOBILE', 'MARKETPLACE_MOBILE', 'INSTAGRAM_EXPLORE_CONTEXTUAL', 'RIGHT_COLUMN_STANDARD'] as const;

/** Prévia gerada pela própria Meta (o mesmo desenho do Gerenciador) para cada posicionamento. */
export async function previews(actId: string, token: string, creative: Record<string, unknown>, formats: string[]) {
  const out: { format: string; html: string | null; error: string | null }[] = [];
  for (const f of formats) {
    try {
      const r = await graphAds<{ data?: { body?: string }[] }>(`${actId}/generatepreviews`, { token, params: { creative: JSON.stringify(creative), ad_format: f, locale: 'pt_BR' } });
      out.push({ format: f, html: r.data?.[0]?.body ?? null, error: null });
    } catch (err) { out.push({ format: f, html: null, error: (err as Error).message }); }
  }
  return out;
}

/** Corta um trecho do vídeo (ffmpeg, sem recomprimir) e devolve o arquivo novo. */
export async function trimVideo(input: Buffer, start: number, end: number): Promise<Buffer> {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'cz-trim-'));
  const src = path.join(dir, 'in.mp4'); const dst = path.join(dir, 'out.mp4');
  try {
    await writeFile(src, input);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-y', '-ss', String(start), '-to', String(end), '-i', src, '-c', 'copy', '-movflags', '+faststart', dst], { stdio: ['ignore', 'ignore', 'pipe'] });
      let errTxt = '';
      p.stderr.on('data', (d) => { errTxt = (errTxt + String(d)).slice(-600); });
      const t = setTimeout(() => p.kill('SIGKILL'), 180_000);
      p.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); reject(new MetaApiError(e.code === 'ENOENT' ? 'O servidor não tem o ffmpeg para cortar o vídeo.' : e.message, 500)); });
      p.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(); else reject(new MetaApiError(`Não deu para cortar o vídeo (${errTxt.split('\n').filter(Boolean).pop() ?? code}).`, 422)); });
    });
    return await readFile(dst);
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** Baixa um vídeo da biblioteca da conta (para cortar). */
export async function downloadAdVideo(videoId: string, token: string): Promise<Buffer> {
  const v = await graphAds<{ source?: string }>(videoId, { token, params: { fields: 'source' } });
  if (!v.source) throw new MetaApiError('A Meta não liberou o arquivo deste vídeo para baixar. Envie o vídeo de novo para cortar.', 422);
  const r = await fetch(v.source, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new MetaApiError('Não deu para baixar o vídeo da Meta.', 502);
  return Buffer.from(await r.arrayBuffer());
}

/** Legendas (arquivo .srt) no vídeo. */
export async function uploadCaptions(videoId: string, srt: string, locale: string, token: string) {
  const form = new FormData();
  form.set('captions_file', new Blob([srt], { type: 'application/x-subrip' }), `legendas.${locale}.srt`);
  form.set('default_locale', locale);
  const resp = await fetch(`${videoBase()}/${videoId}/captions`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(60_000) })
    .catch((err) => { throw new MetaApiError(`Sem conexão com a Meta (${(err as Error).message}).`, 502); });
  const data = (await resp.json().catch(() => ({}))) as { success?: boolean; error?: unknown };
  if (!resp.ok || data.error) throw metaError(data, resp.status);
  return { ok: true };
}
