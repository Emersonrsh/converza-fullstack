import { config } from '../config';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; tokens: number; }
export interface ChatOptions { maxTokens?: number; temperature?: number; }

/** Chama um endpoint de chat OpenAI-compatível (OpenRouter por padrão). */
export async function chatComplete(model: string, messages: ChatMsg[], opts: ChatOptions = {}): Promise<ChatResult> {
  if (!config.ai.apiKey) throw new Error('IA não configurada (OPENAI_API_KEY ausente)');
  // OpenAI direto não aceita o prefixo "openai/" usado no OpenRouter
  const m = config.ai.baseUrl.includes('api.openai.com') ? model.replace(/^openai\//, '') : model;
  const resp = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ai.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.appOrigin,
      'X-Title': 'Converza',
    },
    body: JSON.stringify({
      model: m,
      messages,
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 500,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data as { error?: { message?: string } })?.error?.message ?? `IA HTTP ${resp.status}`);
  }
  const text = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '';
  const tokens = (data as { usage?: { total_tokens?: number } })?.usage?.total_tokens ?? 0;
  return { text, tokens };
}

export const aiEnabled = () => Boolean(config.ai.apiKey);
