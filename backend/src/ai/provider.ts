import { config } from '../config';

/** Parte de uma mensagem para modelos que entendem imagem, PDF e áudio (formato OpenAI). */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'mp3' | 'wav' } };
export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string | ChatPart[]; }
export interface ChatResult { text: string; tokens: number; }
export interface ChatOptions { maxTokens?: number; temperature?: number; }

/** Onde mandar o pedido: o servidor do Converza (créditos da conta) ou a chave do próprio cliente. */
export interface AiTarget { baseUrl: string; apiKey: string; }

/** Tamanho aproximado do pedido em caracteres (para estimar tokens quando o provedor não informa). */
export function contentChars(c: string | ChatPart[]): number {
  if (typeof c === 'string') return c.length;
  return c.reduce((a, p) => a + (p.type === 'text' ? p.text.length : 3000), 0);
}

const hasFile = (messages: ChatMsg[]) => messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file'));

/** Chama um endpoint de chat OpenAI-compatível. */
export async function chatCompleteWith(target: AiTarget, model: string, messages: ChatMsg[], opts: ChatOptions = {}): Promise<ChatResult> {
  // OpenAI direto não aceita o prefixo "openai/" usado no OpenRouter
  const m = target.baseUrl.includes('api.openai.com') ? model.replace(/^openai\//, '') : model;
  const body: Record<string, unknown> = {
    model: m,
    messages,
    temperature: opts.temperature ?? 0.5,
    max_tokens: opts.maxTokens ?? 500,
  };
  // PDFs no OpenRouter: leitura de texto gratuita (sem OCR pago)
  if (target.baseUrl.includes('openrouter.ai') && hasFile(messages)) body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];
  let resp: Response;
  try {
    resp = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': config.appOrigin,
        'X-Title': 'Converza',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(`Sem conexão com o provedor de IA (${(err as Error).message})`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const raw = data as { error?: { message?: string } | string };
    const msg = typeof raw?.error === 'string' ? raw.error : raw?.error?.message;
    if (resp.status === 401 || resp.status === 403) throw new Error(`O provedor de IA recusou a chave (${msg ?? `HTTP ${resp.status}`})`);
    throw new Error(msg ?? `IA HTTP ${resp.status}`);
  }
  const text = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '';
  const tokens = (data as { usage?: { total_tokens?: number } })?.usage?.total_tokens ?? 0;
  return { text, tokens };
}

/** Chama o provedor configurado no servidor (OpenRouter por padrão), pago com os tokens da conta. */
export async function chatComplete(model: string, messages: ChatMsg[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (!config.ai.apiKey) throw new Error('IA não configurada (OPENAI_API_KEY ausente)');
  return chatCompleteWith({ baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey }, model, messages, opts);
}

export const aiEnabled = () => Boolean(config.ai.apiKey);

/* ------------------------------------------------------------ chave própria (Bloco de IA) */

export type ByokProvider = 'openai' | 'gemini' | 'openrouter';

/** Endereço OpenAI-compatível de cada provedor (AI_BYOK_BASE troca todos, para testes). */
export function byokBaseUrl(p: ByokProvider): string {
  const override = (process.env.AI_BYOK_BASE ?? '').replace(/\/+$/, '');
  if (override) return override;
  if (p === 'openai') return 'https://api.openai.com/v1';
  if (p === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta/openai';
  return 'https://openrouter.ai/api/v1';
}

/** Modelos que a chave enxerga (lista do próprio provedor). */
export async function listModels(target: AiTarget): Promise<string[]> {
  let resp: Response;
  try {
    resp = await fetch(`${target.baseUrl}/models`, {
      headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Sem conexão com o provedor de IA (${(err as Error).message})`);
  }
  const data = await resp.json().catch(() => ({})) as { data?: Array<{ id?: string; name?: string }>; error?: { message?: string } };
  if (resp.status === 401 || resp.status === 403) throw new Error('O provedor recusou a chave. Confira se ela está certa e ativa.');
  if (!resp.ok) throw new Error(data?.error?.message ?? `O provedor respondeu HTTP ${resp.status}`);
  const ids = (data.data ?? []).map((m) => String(m.id ?? '').replace(/^models\//, '')).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 800);
}

/** Transcrição com a chave do cliente (OpenAI: Whisper). */
export async function transcribeWith(target: AiTarget, data: Buffer, mime: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([data], { type: mime }), filename);
  let resp: Response;
  try {
    resp = await fetch(`${target.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${target.apiKey}` }, body: form, signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(`Sem conexão com o provedor de IA (${(err as Error).message})`);
  }
  const j = await resp.json().catch(() => ({})) as { text?: string; error?: { message?: string } };
  if (!resp.ok) throw new Error(j?.error?.message ?? `Transcrição falhou (HTTP ${resp.status})`);
  return String(j.text ?? '');
}
