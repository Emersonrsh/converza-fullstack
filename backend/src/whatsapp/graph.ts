import { config } from '../config';
import { WhatsAppError, friendlyWaError } from './cloud-api';

/**
 * Chamadas de gestão da conta na Graph API da Meta (fora o envio de mensagens):
 * Embedded Signup, inscrição dos webhooks, registro do número, saúde, perfil e coexistência.
 * Usa GRAPH_API_BASE (permite simular a Meta nos testes).
 */

const graphUrl = (path: string, params?: Record<string, string>) =>
  `${config.whatsapp.graphBase}/${config.whatsapp.graphVersion}/${path.replace(/^\/+/, '')}${params ? `?${new URLSearchParams(params).toString()}` : ''}`;

async function call<T>(path: string, opts: { token?: string; method?: string; body?: unknown; params?: Record<string, string> } = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(graphUrl(path, opts.params), {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new WhatsAppError(`Sem conexão com a Meta (${(err as Error).message}). Tente de novo.`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw friendlyWaError(data, resp.status);
  return data as T;
}

/** Troca o `code` do Embedded Signup por um token de acesso do negócio. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const data = await call<{ access_token?: string }>('oauth/access_token', {
    params: { client_id: config.whatsapp.appId, client_secret: config.whatsapp.appSecret, code },
  });
  if (!data.access_token) throw new WhatsAppError('A Meta não devolveu o token da conexão. Tente conectar de novo.');
  return data.access_token;
}

/** Inscreve o app do operador nos webhooks do WABA (sem isso, as mensagens não chegam). */
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
  await call(`${wabaId}/subscribed_apps`, { token, method: 'POST' });
}

/** Apps inscritos nos webhooks do WABA. */
export async function wabaSubscriptions(wabaId: string, token: string): Promise<{ id: string; name: string | null }[]> {
  const r = await call<{ data?: { whatsapp_business_api_data?: { id?: string; name?: string } }[] }>(`${wabaId}/subscribed_apps`, { token });
  return (r.data ?? []).map((x) => ({ id: String(x.whatsapp_business_api_data?.id ?? ''), name: x.whatsapp_business_api_data?.name ?? null }));
}

/** Registra o número na Cloud API com o PIN de verificação em duas etapas. */
export async function registerPhone(phoneNumberId: string, token: string, pin: string): Promise<void> {
  await call(`${phoneNumberId}/register`, { token, method: 'POST', body: { messaging_product: 'whatsapp', pin } });
}

export interface PhoneHealth {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
  name_status?: string;
  code_verification_status?: string;
  platform_type?: string;
  throughput?: { level?: string };
  status?: string;
  is_on_biz_app?: boolean;
}

const FULL_FIELDS = 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status,code_verification_status,platform_type,throughput,status,is_on_biz_app';
const BASIC_FIELDS = 'id,display_phone_number,verified_name,quality_rating';

/** Dados e saúde do número. Se a Meta recusar algum campo (versão/conta), tenta com o básico. */
export async function getPhoneHealth(phoneNumberId: string, token: string): Promise<PhoneHealth> {
  try {
    return await call<PhoneHealth>(phoneNumberId, { token, params: { fields: FULL_FIELDS } });
  } catch (err) {
    if (err instanceof WhatsAppError && err.code === 100 && /field/i.test(err.message)) {
      return call<PhoneHealth>(phoneNumberId, { token, params: { fields: BASIC_FIELDS } });
    }
    throw err;
  }
}

export interface PhoneInfo { display_phone_number?: string; verified_name?: string; id?: string }
export const getPhoneInfo = (phoneNumberId: string, token: string): Promise<PhoneInfo> =>
  call<PhoneInfo>(phoneNumberId, { token, params: { fields: 'id,display_phone_number,verified_name' } });

/** Números do WABA (a coexistência devolve só o WABA; o número vem daqui). */
export async function wabaPhoneNumbers(wabaId: string, token: string): Promise<PhoneHealth[]> {
  const r = await call<{ data?: PhoneHealth[] }>(`${wabaId}/phone_numbers`, { token, params: { fields: 'id,display_phone_number,verified_name,quality_rating' } });
  return r.data ?? [];
}

export interface BusinessProfile {
  about?: string; address?: string; description?: string; email?: string; websites?: string[];
  vertical?: string; profile_picture_url?: string;
}
const PROFILE_FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';

export async function getBusinessProfile(phoneNumberId: string, token: string): Promise<BusinessProfile> {
  const r = await call<{ data?: BusinessProfile[] }>(`${phoneNumberId}/whatsapp_business_profile`, { token, params: { fields: PROFILE_FIELDS } });
  return r.data?.[0] ?? {};
}

export async function updateBusinessProfile(phoneNumberId: string, token: string, p: Omit<BusinessProfile, 'profile_picture_url'>): Promise<void> {
  await call(`${phoneNumberId}/whatsapp_business_profile`, { token, method: 'POST', body: { messaging_product: 'whatsapp', ...p } });
}

/**
 * Coexistência: pede à Meta os contatos e o histórico do WhatsApp Business do celular
 * (cada um só pode ser pedido uma vez por conexão, em até 24h). Devolve o request_id.
 */
export async function requestSmbSync(phoneNumberId: string, token: string, syncType: 'smb_app_state_sync' | 'history'): Promise<string | null> {
  const r = await call<{ request_id?: string }>(`${phoneNumberId}/smb_app_data`, { token, method: 'POST', body: { messaging_product: 'whatsapp', sync_type: syncType } });
  return r.request_id ?? null;
}

/** De qual app da Meta é esse token (usa as credenciais do operador). null se não der para saber. */
export async function tokenAppId(token: string): Promise<string | null> {
  if (!config.whatsapp.appId || !config.whatsapp.appSecret) return null;
  try {
    const r = await call<{ data?: { app_id?: string | number } }>('debug_token', {
      params: { input_token: token, access_token: `${config.whatsapp.appId}|${config.whatsapp.appSecret}` },
    });
    return r.data?.app_id != null ? String(r.data.app_id) : null;
  } catch {
    return null;
  }
}
