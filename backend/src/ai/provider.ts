import { config } from '../config';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { text: string; tokens: number; }

/** Chama um endpoint de chat OpenAI-compatível. */
export async function chatComplete(model: string, messages: ChatMsg[]): Promise<ChatResult> {
  if (!config.ai.apiKey) throw new Error('IA não configurada (OPENAI_API_KEY ausente)');
  const resp = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.5, max_tokens: 500 }),
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
