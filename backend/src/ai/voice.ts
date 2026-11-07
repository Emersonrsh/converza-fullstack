import { config } from '../config';
import { AppError } from '../utils/http';
import { hasTokens } from '../modules/tokens';
import { chargeUsage, type UsageCtx } from './usage';

/**
 * Voz pela ElevenLabs (chave do operador): clonar uma voz a partir de amostras (IVC),
 * transformar texto em fala e transcrever áudios (Scribe). Tudo o que gasta é cobrado
 * do saldo de tokens de IA da conta.
 */

export class VoiceError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export const VOICE_OFF = 'A voz não está configurada no servidor (falta a ELEVENLABS_API_KEY).';
export const voiceEnabled = () => Boolean(config.voice.apiKey);

export interface AudioFile { data: Buffer; mime: string; filename: string }

/** Mensagem clara a partir do erro da ElevenLabs ({ detail: { status, message } } ou { detail: "..." }). */
export function friendlyVoiceError(raw: unknown, status: number): string {
  const r = (raw ?? {}) as { detail?: unknown; message?: unknown };
  const d = r.detail as any;
  const obj = d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  const code = String(obj?.status ?? obj?.code ?? '');
  const msg = typeof d === 'string' ? d
    : obj ? String(obj.message ?? '')
      : Array.isArray(d) ? d.map((x: any) => x?.msg).filter(Boolean).join('; ') : String(r.message ?? '');
  const all = `${code} ${msg}`;
  if (status === 401 || /invalid_api_key/i.test(all)) return 'A chave da ElevenLabs foi recusada (confira a ELEVENLABS_API_KEY).';
  if (/quota_exceeded|insufficient|credits/i.test(all)) return 'A conta da ElevenLabs está sem créditos.';
  if (/voice_limit_reached|voice limit/i.test(all)) return 'A conta da ElevenLabs chegou ao limite de vozes clonadas. Exclua uma voz antiga.';
  if (/can_not_use_instant_voice_cloning|instant voice cloning|subscription/i.test(all)) return 'O plano da ElevenLabs não permite clonar voz (precisa do plano Starter ou acima).';
  if (status === 404 || /voice_not_found/i.test(all)) return 'Essa voz não existe mais na ElevenLabs.';
  if (status === 422 || status === 400) return `O serviço de voz recusou o pedido${msg ? `: ${msg.slice(0, 200)}` : ''}.`;
  return msg ? `Serviço de voz: ${msg.slice(0, 200)}` : `O serviço de voz respondeu com erro (HTTP ${status}).`;
}

async function call(path: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
  if (!voiceEnabled()) throw new VoiceError(VOICE_OFF, 503);
  let resp: Response;
  try {
    resp = await fetch(`${config.voice.baseUrl}${path}`, {
      ...init,
      headers: { 'xi-api-key': config.voice.apiKey, ...((init.headers as Record<string, string>) ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new VoiceError(`Sem conexão com o serviço de voz (${(err as Error).message}).`);
  }
  if (!resp.ok) {
    const raw = await resp.json().catch(() => ({}));
    throw new VoiceError(friendlyVoiceError(raw, resp.status), resp.status === 404 ? 404 : 502);
  }
  return resp;
}

/** Cria a voz clonada a partir de 1 a 3 amostras. Devolve o voice_id da ElevenLabs. */
export async function cloneVoice(name: string, language: string, files: AudioFile[]): Promise<string> {
  const form = new FormData();
  form.append('name', name);
  form.append('description', `Converza (${language})`);
  form.append('labels', JSON.stringify({ language }));
  for (const f of files) form.append('files', new Blob([f.data], { type: f.mime }), f.filename);
  const r = await call('/v1/voices/add', { method: 'POST', body: form }, 180_000);
  const j = (await r.json().catch(() => ({}))) as { voice_id?: string };
  if (!j.voice_id) throw new VoiceError('O serviço de voz não devolveu o código da voz criada.');
  return j.voice_id;
}

/** Apaga a voz na ElevenLabs (se já não existir, tudo bem). */
export async function deleteVoice(providerVoiceId: string): Promise<void> {
  try {
    await call(`/v1/voices/${encodeURIComponent(providerVoiceId)}`, { method: 'DELETE' }, 20_000);
  } catch (err) {
    if (!(err instanceof VoiceError) || err.status !== 404) throw err;
  }
}

/** Texto → fala (MP3). Sem voz escolhida, usa a voz padrão da plataforma. */
export async function speak(text: string, providerVoiceId?: string | null): Promise<Buffer> {
  const id = providerVoiceId || config.voice.defaultVoiceId;
  const r = await call(`/v1/text-to-speech/${encodeURIComponent(id)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: config.voice.ttsModel, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
  }, 90_000);
  const audio = Buffer.from(await r.arrayBuffer());
  if (!audio.length) throw new VoiceError('O serviço de voz devolveu um áudio vazio.');
  return audio;
}

/** Fala → texto. `seconds` é a duração do áudio (para a cobrança). */
export async function transcribe(file: AudioFile, language?: string | null): Promise<{ text: string; seconds: number }> {
  const form = new FormData();
  form.append('model_id', config.voice.sttModel);
  form.append('file', new Blob([file.data], { type: file.mime }), file.filename);
  if (language) form.append('language_code', language);
  const r = await call('/v1/speech-to-text', { method: 'POST', body: form }, 120_000);
  const j = (await r.json().catch(() => ({}))) as { text?: string; audio_duration_secs?: number; words?: { end?: number }[] };
  const seconds = Number(j.audio_duration_secs) || Number(j.words?.[j.words.length - 1]?.end) || 0;
  return { text: String(j.text ?? '').trim(), seconds };
}

/* ------------------------------------------------------------ cobrança */

export const ttsTokens = (text: string) => Math.ceil(text.length * config.voice.tokensPerChar);
export const sttTokens = (seconds: number) => Math.ceil((Math.max(1, seconds) / 60) * config.voice.tokensPerMinute);

/** Confere se dá para usar a voz agora (chave configurada e saldo de tokens). */
export async function requireVoiceBudget(accountId: string): Promise<void> {
  if (!voiceEnabled()) throw new AppError(503, VOICE_OFF);
  if (!(await hasTokens(accountId))) throw new AppError(402, 'Sem saldo de tokens de IA — compre tokens em Cobranças e assinaturas.');
}

/** Cobra a voz do saldo de tokens e anota em "Uso da IA". */
export async function chargeTokens(accountId: string, tokens: number, ctx?: UsageCtx): Promise<void> {
  await chargeUsage(accountId, tokens, ctx);
}

/** Converte erros do serviço de voz em erro HTTP para as rotas. */
export function asHttp(err: unknown): never {
  if (err instanceof VoiceError) throw new AppError(err.status === 503 ? 503 : 502, err.message);
  throw err;
}
