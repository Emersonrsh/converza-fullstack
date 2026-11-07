import { config } from '../config';

/**
 * Chamadas da Marketing API e da API de Conversões da Meta (menu Facebook).
 * Usa o mesmo GRAPH_API_BASE do WhatsApp (os testes simulam a Meta) e a versão META_ADS_API_VERSION.
 */

export class MetaApiError extends Error {
  status: number;
  code?: number;
  subcode?: number;
  raw?: string;
  constructor(message: string, status = 502, code?: number, subcode?: number, raw?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.raw = raw;
  }
  /** login vencido, senha trocada ou acesso revogado */
  get tokenExpired() { return this.code === 190 || this.code === 102 || this.code === 463 || this.code === 467; }
  get rateLimited() { return [4, 17, 32, 613, 80000, 80003, 80004, 80014].includes(this.code ?? -1); }
}

const RATE = [4, 17, 32, 613, 80000, 80003, 80004, 80014];

export function metaError(data: unknown, status: number): MetaApiError {
  const e = ((data as { error?: Record<string, unknown> })?.error ?? {}) as Record<string, unknown>;
  const code = Number(e.code) || undefined;
  const sub = Number(e.error_subcode) || undefined;
  const raw = String(e.error_user_msg || e.message || `HTTP ${status}`).slice(0, 400);
  let msg = raw;
  if (code === 190 || code === 102) msg = 'O login da Meta venceu ou foi revogado. Reconecte o perfil.';
  else if (RATE.includes(code ?? -1)) msg = 'A Meta limitou as consultas desta conta por alguns minutos. Tente de novo daqui a pouco.';
  else if (code === 10 || code === 294 || (code !== undefined && code >= 200 && code < 300)) msg = `A Meta não deu permissão para isso: ${raw}`;
  else if (code === 100 && sub === 33) msg = 'A Meta não encontrou esse ID ou o token não tem acesso a ele.';
  return new MetaApiError(msg, status >= 500 ? 502 : 422, code, sub, raw);
}

const base = () => `${config.whatsapp.graphBase}/${config.meta.adsApiVersion}`;

type Params = Record<string, string | number | boolean | undefined | null>;

export async function graphAds<T>(path: string, opts: {
  token?: string; method?: 'GET' | 'POST' | 'DELETE'; params?: Params; body?: unknown; timeoutMs?: number;
} = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  const url = `${base()}/${path.replace(/^\/+/, '')}${q ? `?${q}` : ''}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
  } catch (err) {
    throw new MetaApiError(`Sem conexão com a Meta (${(err as Error).message}). Tente de novo.`, 502);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data as { error?: unknown })?.error) throw metaError(data, resp.status);
  return data as T;
}

/** Lê um edge inteiro (data + cursores) até `max` itens. */
export async function graphAdsAll<T>(path: string, token: string, params: Params = {}, max = 1000): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20 && out.length < max; page++) {
    const r = await graphAds<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, {
      token, params: { limit: 500, ...params, ...(after ? { after } : {}) },
    });
    out.push(...(r.data ?? []));
    after = r.paging?.next ? r.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return out.slice(0, max);
}

/* ------------------------------------------------------------------ login dos perfis */

/** Troca o code do login (Facebook Login for Business) por um token de usuário. */
export async function exchangeAdsCode(code: string): Promise<string> {
  const r = await graphAds<{ access_token?: string }>('oauth/access_token', {
    params: { client_id: config.whatsapp.appId, client_secret: config.whatsapp.appSecret, code },
  });
  if (!r.access_token) throw new MetaApiError('A Meta não devolveu o token do login. Tente de novo.', 502);
  return r.access_token;
}

/** Token de usuário de longa duração (~60 dias). Se a Meta não estender, segue com o que veio. */
export async function extendUserToken(token: string): Promise<{ token: string; expiresIn: number | null }> {
  try {
    const r = await graphAds<{ access_token?: string; expires_in?: number }>('oauth/access_token', {
      params: { grant_type: 'fb_exchange_token', client_id: config.whatsapp.appId, client_secret: config.whatsapp.appSecret, fb_exchange_token: token },
    });
    return { token: r.access_token || token, expiresIn: Number(r.expires_in) || null };
  } catch {
    return { token, expiresIn: null };
  }
}

export interface TokenInfo { appId: string | null; userId: string | null; valid: boolean; expiresAt: Date | null; scopes: string[] }

export async function debugUserToken(token: string): Promise<TokenInfo> {
  const r = await graphAds<{ data?: { app_id?: string; user_id?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] } }>('debug_token', {
    params: { input_token: token, access_token: `${config.whatsapp.appId}|${config.whatsapp.appSecret}` },
  });
  const d = r.data ?? {};
  return {
    appId: d.app_id ? String(d.app_id) : null, userId: d.user_id ? String(d.user_id) : null, valid: d.is_valid !== false,
    // expires_at 0 = não vence
    expiresAt: d.expires_at ? new Date(Number(d.expires_at) * 1000) : null,
    scopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
  };
}

export interface MetaMe { id: string; name: string; picture: string | null }
export async function fetchMe(token: string): Promise<MetaMe> {
  const r = await graphAds<{ id: string; name?: string; picture?: { data?: { url?: string } } }>('me', {
    token, params: { fields: 'id,name,picture.width(96).height(96){url}' },
  });
  return { id: String(r.id), name: r.name || 'Perfil da Meta', picture: r.picture?.data?.url ?? null };
}

export interface RemoteAdAccount { actId: string; name: string; currency: string; timezone: string | null; status: number | null; business: string | null }
export async function fetchAdAccounts(token: string): Promise<RemoteAdAccount[]> {
  const list = await graphAdsAll<{ id: string; account_id?: string; name?: string; currency?: string; timezone_name?: string; account_status?: number; business?: { name?: string } }>(
    'me/adaccounts', token, { fields: 'id,account_id,name,currency,timezone_name,account_status,business{id,name}', limit: 200 }, 2000);
  return list.map((a) => ({
    actId: a.id.startsWith('act_') ? a.id : `act_${a.account_id ?? a.id}`,
    name: a.name || a.id, currency: (a.currency || 'BRL').toUpperCase(), timezone: a.timezone_name ?? null,
    status: a.account_status ?? null, business: a.business?.name ?? null,
  }));
}

/* ------------------------------------------------------------------ anúncios */

export type Level = 'campaign' | 'adset' | 'ad';

export interface InsightRow {
  campaign_id?: string; campaign_name?: string; adset_id?: string; adset_name?: string; ad_id?: string; ad_name?: string;
  spend?: string; impressions?: string; reach?: string; clicks?: string; inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[];
  date_start?: string; date_stop?: string;
}

const LEVEL_FIELDS: Record<Level | 'account', string> = {
  account: '',
  campaign: 'campaign_id,campaign_name,',
  adset: 'campaign_id,adset_id,adset_name,',
  ad: 'campaign_id,adset_id,ad_id,ad_name,',
};
const METRIC_FIELDS = 'spend,impressions,reach,clicks,inline_link_clicks,actions,action_values';

export async function fetchInsights(actId: string, token: string, o: { level: Level | 'account'; since: string; until: string; daily?: boolean }) {
  return graphAdsAll<InsightRow>(`${actId}/insights`, token, {
    level: o.level,
    fields: `${LEVEL_FIELDS[o.level]}${METRIC_FIELDS}`,
    time_range: JSON.stringify({ since: o.since, until: o.until }),
    ...(o.daily ? { time_increment: 1 } : {}),
  }, 5000);
}

export interface RemoteEntity {
  id: string; name: string; status?: string; effective_status?: string; objective?: string;
  campaign_id?: string; adset_id?: string; daily_budget?: string; lifetime_budget?: string;
  optimization_goal?: string; creative?: { thumbnail_url?: string };
}

const ENTITY_FIELDS: Record<Level, string> = {
  campaign: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget',
  adset: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal',
  ad: 'id,name,campaign_id,adset_id,status,effective_status,creative{thumbnail_url}',
};
const EDGE: Record<Level, string> = { campaign: 'campaigns', adset: 'adsets', ad: 'ads' };

export async function fetchEntities(actId: string, token: string, level: Level) {
  const list = await graphAdsAll<RemoteEntity>(`${actId}/${EDGE[level]}`, token, { fields: ENTITY_FIELDS[level] }, 2000);
  return list.filter((e) => !['DELETED', 'ARCHIVED'].includes(String(e.effective_status ?? e.status ?? '')));
}

/* ------------------------------------------------------------------ pixels (API de Conversões) */

export async function fetchPixel(pixelId: string, token: string): Promise<{ id: string; name: string | null }> {
  const r = await graphAds<{ id: string; name?: string }>(pixelId, { token, params: { fields: 'id,name' } });
  return { id: String(r.id), name: r.name ?? null };
}

/** Conjunto de dados do WhatsApp Business (cria se ainda não existir). */
export async function wabaDataset(wabaId: string, token: string): Promise<string> {
  const got = await graphAds<{ data?: { id?: string }[]; id?: string }>(`${wabaId}/dataset`, { token }).catch(() => null);
  const existing = got?.data?.[0]?.id ?? got?.id;
  if (existing) return String(existing);
  const made = await graphAds<{ id?: string }>(`${wabaId}/dataset`, { token, method: 'POST' });
  if (!made.id) throw new MetaApiError('A Meta não devolveu o conjunto de dados do WhatsApp.', 502);
  return String(made.id);
}

export async function sendCapi(datasetId: string, token: string, body: Record<string, unknown>) {
  return graphAds<{ events_received?: number; messages?: string[]; fbtrace_id?: string }>(`${datasetId}/events`, { token, method: 'POST', body });
}
