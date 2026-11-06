const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

export function getToken() { return localStorage.getItem('token'); }
export function getAccountId() { return localStorage.getItem('accountId'); }
export function setToken(t: string | null) { t ? localStorage.setItem('token', t) : localStorage.removeItem('token'); }
export function setAccountId(a: string | null) { a ? localStorage.setItem('accountId', a) : localStorage.removeItem('accountId'); }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  const accountId = getAccountId();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (accountId) headers['x-account-id'] = accountId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `Erro ${res.status}`;
    if (res.status === 401) { setToken(null); setAccountId(null); }
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export const money = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const num = (n: number) => n.toLocaleString('pt-BR');
