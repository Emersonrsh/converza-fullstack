import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db, schema } from '../db';
import { AppError, isUuid } from '../utils/http';
import { chatComplete, aiEnabled, type ChatMsg } from './provider';
import { hasTokens, debitDetailed } from '../modules/tokens';
import { emitToAccount } from '../realtime/io';

/**
 * De onde veio o gasto de IA — vira uma linha em "Uso da IA" (Configurações), agrupada por conversa.
 * Quem gasta dentro de uma conversa (agente, bloco de IA do fluxo, voz, transcrição) passa o conversationId;
 * o resto (testes, gerador de fluxo, simulador, traduções) fica agrupado por ferramenta e por dia.
 */
export type UsageKind =
  | 'agent_reply' | 'agent_voice' | 'transcription' | 'flow_ai'
  | 'agent_test' | 'agent_create' | 'flow_generate' | 'flow_simulate' | 'flow_translate'
  | 'voice_preview' | 'dictation' | 'other';

export interface UsageCtx {
  kind: UsageKind;
  conversationId?: string | null;
  contactId?: string | null;
  agentId?: string | null;
  flowId?: string | null;
  /** texto curto para o detalhe (ex.: "Resposta da Sofia") */
  label?: string;
}

export const USAGE_KIND_LABEL: Record<UsageKind, string> = {
  agent_reply: 'Resposta do agente',
  agent_voice: 'Voz do agente',
  transcription: 'Transcrição de áudio',
  flow_ai: 'Bloco de IA do fluxo',
  agent_test: 'Teste do agente',
  agent_create: 'Criar agente com IA',
  flow_generate: 'Gerar fluxo com IA',
  flow_simulate: 'Simulador de fluxo',
  flow_translate: 'Tradução de fluxo',
  voice_preview: 'Prévia de voz',
  dictation: 'Ditado pelo microfone',
  other: 'Outros',
};

const tzCache = new Map<string, { tz: string; at: number }>();
async function accountTz(accountId: string): Promise<string> {
  const hit = tzCache.get(accountId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.tz;
  const [a] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const tz = a?.tz || 'America/Sao_Paulo';
  tzCache.set(accountId, { tz, at: Date.now() });
  return tz;
}

/** Data local (AAAA-MM-DD) no fuso da conta. */
export function localDay(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Chave que agrupa o uso: conversa (conv:<id>) ou ferramenta do dia (tool:<tipo>:<data>). */
export function sessionKeyOf(ctx: UsageCtx, day: string): string {
  return ctx.conversationId && isUuid(ctx.conversationId) ? `conv:${ctx.conversationId}` : `tool:${ctx.kind}:${day}`;
}

/** Anota um débito no histórico de uso. Nunca derruba quem chamou. */
export async function recordUsage(accountId: string, ctx: UsageCtx | undefined, tokens: number): Promise<void> {
  if (!tokens || tokens <= 0) return;
  const c: UsageCtx = ctx ?? { kind: 'other' };
  try {
    const day = localDay(new Date(), await accountTz(accountId));
    const uuidOr = (v?: string | null) => (v && isUuid(v) ? v : null);
    await db.insert(schema.aiUsage).values({
      accountId, kind: c.kind, sessionKey: sessionKeyOf(c, day),
      conversationId: uuidOr(c.conversationId), contactId: uuidOr(c.contactId),
      agentId: uuidOr(c.agentId), flowId: uuidOr(c.flowId),
      label: (c.label ?? '').slice(0, 200), tokens: Math.ceil(tokens),
    });
  } catch (err) {
    console.error('[ia] não deu para anotar o uso:', (err as Error).message);
  }
}

/** Debita (nunca abaixo de zero), avisa o painel e anota no histórico. Devolve quanto foi debitado. */
export async function chargeUsage(accountId: string, tokens: number, ctx?: UsageCtx): Promise<number> {
  if (tokens <= 0) return 0;
  const { balance, charged } = await debitDetailed(accountId, tokens);
  emitToAccount(accountId, 'tokens:update', { balance });
  await recordUsage(accountId, ctx, charged);
  return charged;
}

/**
 * Toda chamada de IA de uma conta passa por aqui: verifica se a IA está
 * configurada, aplica a trava de saldo, chama o modelo e debita os tokens usados.
 */
export async function aiCall(
  accountId: string,
  messages: ChatMsg[],
  opts: AiOpts = {},
): Promise<string> {
  return (await aiCallWithUsage(accountId, messages, opts)).text;
}

export interface AiOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** de onde veio o gasto (para "Uso da IA") */
  usage?: UsageCtx;
  /** já reservado antes (traduções): não confere saldo nem debita aqui — quem chamou acerta a conta */
  prepaid?: boolean;
}

/** Igual ao aiCall, devolvendo também quantos tokens foram usados. */
export async function aiCallWithUsage(
  accountId: string,
  messages: ChatMsg[],
  opts: AiOpts = {},
): Promise<{ text: string; tokens: number }> {
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
  if (!opts.prepaid && !(await hasTokens(accountId))) {
    throw new AppError(402, 'Sem saldo de tokens de IA — compre tokens em Cobranças e assinaturas.');
  }
  const r = await chatComplete(opts.model || config.ai.defaultModel, messages, {
    maxTokens: opts.maxTokens, temperature: opts.temperature,
  });
  const used = r.tokens || Math.ceil((messages.reduce((a, m) => a + m.content.length, 0) + r.text.length) / 4);
  if (!opts.prepaid) await chargeUsage(accountId, used, opts.usage);
  return { text: r.text, tokens: used };
}
