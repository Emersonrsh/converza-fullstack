import { config } from '../config';

const V = config.whatsapp.graphVersion;
const BASE = `https://graph.facebook.com/${V}`;

async function graph<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data as { error?: { message?: string } })?.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Troca o `code` do Embedded Signup por um token de acesso do negócio. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: config.whatsapp.appId,
    client_secret: config.whatsapp.appSecret,
    code,
  });
  const data = await graph<{ access_token: string }>(`${BASE}/oauth/access_token?${params.toString()}`);
  return data.access_token;
}

/** Inscreve o app do operador nos webhooks do WABA do cliente. */
export async function subscribeAppToWaba(wabaId: string, token: string): Promise<void> {
  await graph(`${BASE}/${wabaId}/subscribed_apps`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
}

/** Registra o número no Cloud API (necessário após o signup). Pode já estar
 * registrado — nesse caso o chamador ignora o erro. */
export async function registerPhone(phoneNumberId: string, token: string, pin = '000000'): Promise<void> {
  await graph(`${BASE}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  });
}

export interface PhoneInfo { display_phone_number?: string; verified_name?: string; id?: string; }

/** Lê os dados do número (nome verificado, telefone exibido). */
export async function getPhoneInfo(phoneNumberId: string, token: string): Promise<PhoneInfo> {
  const params = new URLSearchParams({ fields: 'display_phone_number,verified_name', access_token: token });
  return graph<PhoneInfo>(`${BASE}/${phoneNumberId}?${params.toString()}`);
}
