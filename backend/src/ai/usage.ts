import { config } from '../config';
import { AppError } from '../utils/http';
import { chatComplete, aiEnabled, type ChatMsg } from './provider';
import { ensureRecharged, hasTokens, debit } from '../modules/tokens';
import { emitToAccount } from '../realtime/io';

/**
 * Toda chamada de IA de uma conta passa por aqui: verifica se a IA está
 * configurada, aplica a trava de saldo, chama o modelo e debita os tokens usados.
 */
export async function aiCall(
  accountId: string,
  messages: ChatMsg[],
  opts: { model?: string; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
  await ensureRecharged(accountId);
  if (!(await hasTokens(accountId))) {
    throw new AppError(402, 'Sem saldo de tokens de IA — assine um plano ou faça upgrade.');
  }
  const r = await chatComplete(opts.model || config.ai.defaultModel, messages, {
    maxTokens: opts.maxTokens, temperature: opts.temperature,
  });
  const used = r.tokens || Math.ceil((messages.reduce((a, m) => a + m.content.length, 0) + r.text.length) / 4);
  const balance = await debit(accountId, used);
  emitToAccount(accountId, 'tokens:update', { balance });
  return r.text;
}
