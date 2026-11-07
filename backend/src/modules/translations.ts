/**
 * Traduções de fluxo com IA. Antes de começar, a tradução reserva no saldo o que deve gastar
 * (assim não para no meio por falta de tokens); no fim, devolve o que sobrou ou cobra a diferença.
 * Cada tradução fica no histórico (Configurações → Traduções de fluxo).
 */
import { Router } from 'express';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';
import { normalizeGraph, triggerOf, type FlowGraph } from '../flows/types';
import { LANGUAGES, estimateTranslation, translateGraph } from '../flows/aiTools';
import { aiCallWithUsage, recordUsage } from '../ai/usage';
import { aiEnabled } from '../ai/provider';
import { debitDetailed, getTokenState, releaseReserved, reserveTokens } from './tokens';
import { uniqueFlowName } from './flowNames';
import { emitToAccount } from '../realtime/io';

export const TRANSLATE_LANGS = ['en', 'es', 'pt', 'fr', 'it', 'de'] as const;
export type TranslateLang = typeof TRANSLATE_LANGS[number];

export const LANGUAGE_LABEL: Record<TranslateLang, string> = {
  en: 'Inglês', es: 'Espanhol', pt: 'Português', fr: 'Francês', it: 'Italiano', de: 'Alemão',
};

type FlowRow = typeof schema.flows.$inferSelect;
type TranslationRow = typeof schema.flowTranslations.$inferSelect;

/** Uma tradução que ficou "em andamento" por mais que isso morreu junto com o servidor. */
const STALE_MINUTES = 20;

export async function translationEstimate(accountId: string, flow: FlowRow) {
  const est = estimateTranslation(normalizeGraph(flow.graph));
  const st = await getTokenState(accountId);
  return {
    texts: est.texts, tokens: est.tokens, balance: st.balance,
    active: st.status === 'active', enough: st.status === 'active' && st.balance >= est.tokens,
    aiEnabled: aiEnabled(),
  };
}

/** Acerta a reserva: devolve o que sobrou ou cobra o que passou. Devolve quanto foi cobrado no total. */
async function settle(accountId: string, reserved: number, used: number): Promise<{ charged: number; refunded: number }> {
  if (used <= reserved) {
    const refunded = reserved - used;
    if (refunded > 0) await releaseReserved(accountId, refunded);
    return { charged: used, refunded };
  }
  const extra = await debitDetailed(accountId, used - reserved);
  emitToAccount(accountId, 'tokens:update', { balance: extra.balance });
  return { charged: reserved + extra.charged, refunded: 0 };
}

export function publicTranslation(t: TranslationRow & { createdByName?: string | null; copyExists?: boolean; sourceExists?: boolean }) {
  return {
    id: t.id, status: t.status, language: t.language, languageLabel: LANGUAGE_LABEL[t.language as TranslateLang] ?? t.language,
    sourceFlowId: t.sourceExists === false ? null : t.sourceFlowId, sourceName: t.sourceName,
    copyFlowId: t.copyExists === false ? null : t.copyFlowId, copyName: t.copyName,
    reserved: t.reserved, used: t.used, refunded: t.refunded, charged: t.status === 'running' ? t.reserved : t.used,
    error: t.error, createdAt: t.createdAt, finishedAt: t.finishedAt, createdByName: t.createdByName ?? null,
  };
}

export async function translateFlow(accountId: string, userId: string | null, flow: FlowRow, language: TranslateLang) {
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
  const graph = normalizeGraph(flow.graph);
  const est = estimateTranslation(graph, LANGUAGES[language]);
  if (!est.texts) throw new AppError(422, 'Este fluxo não tem textos para traduzir.');

  const r = await reserveTokens(accountId, est.tokens);
  if (!r.ok) {
    throw new AppError(402, r.reason === 'inactive'
      ? 'A assinatura não está ativa — a IA só funciona com a assinatura em dia (Cobranças e assinaturas).'
      : `Para traduzir este fluxo são necessários cerca de ${est.tokens.toLocaleString('pt-BR')} tokens e o saldo é ${r.balance.toLocaleString('pt-BR')}. Compre tokens em Cobranças e assinaturas.`,
    { code: 'not_enough_tokens', needed: est.tokens, balance: r.balance });
  }

  const [tr] = await db.insert(schema.flowTranslations).values({
    accountId, sourceFlowId: flow.id, sourceName: flow.name, language, status: 'running', reserved: est.tokens, createdBy: userId,
  }).returning();
  emitToAccount(accountId, 'translations:changed', {});

  let used = 0;
  let translated: FlowGraph;
  try {
    translated = await translateGraph(graph, LANGUAGES[language], async (messages, maxTokens) => {
      const out = await aiCallWithUsage(accountId, messages, { maxTokens, temperature: 0.2, prepaid: true });
      used += out.tokens;
      await db.update(schema.flowTranslations).set({ used }).where(eq(schema.flowTranslations.id, tr.id));
      return out.text;
    });
  } catch (err) {
    const { charged, refunded } = await settle(accountId, est.tokens, used);
    await recordUsage(accountId, { kind: 'flow_translate', flowId: flow.id, label: `${flow.name} → ${LANGUAGE_LABEL[language]} (falhou)` }, charged);
    const msg = err instanceof AppError ? err.message : (err as Error).message;
    await db.update(schema.flowTranslations).set({ status: 'failed', used, refunded, error: msg.slice(0, 300), finishedAt: new Date() })
      .where(eq(schema.flowTranslations.id, tr.id));
    emitToAccount(accountId, 'translations:changed', {});
    if (err instanceof AppError) throw err;
    throw new AppError(502, msg);
  }

  const [copy] = await db.insert(schema.flows).values({
    accountId, folderId: flow.folderId,
    name: await uniqueFlowName(accountId, `${flow.name} (${language.toUpperCase()})`),
    status: 'draft', graph: translated, trigger: triggerOf(undefined, translated),
  }).returning();
  const { charged, refunded } = await settle(accountId, est.tokens, used);
  await recordUsage(accountId, { kind: 'flow_translate', flowId: flow.id, label: `${flow.name} → ${LANGUAGE_LABEL[language]}` }, charged);
  const [done] = await db.update(schema.flowTranslations)
    .set({ status: 'done', used, refunded, copyFlowId: copy.id, copyName: copy.name, finishedAt: new Date() })
    .where(eq(schema.flowTranslations.id, tr.id)).returning();
  emitToAccount(accountId, 'translations:changed', {});
  return { flow: copy, translation: publicTranslation(done) };
}

/** Traduções presas em "em andamento" (o servidor reiniciou no meio): viram falha e o saldo reservado volta. */
export async function sweepStaleTranslations(): Promise<number> {
  const stale = await db.select().from(schema.flowTranslations)
    .where(and(eq(schema.flowTranslations.status, 'running'), lt(schema.flowTranslations.createdAt, new Date(Date.now() - STALE_MINUTES * 60_000))));
  for (const t of stale) {
    // marca primeiro (só um processo acerta cada uma)
    const [claimed] = await db.update(schema.flowTranslations)
      .set({ status: 'failed', error: 'A tradução foi interrompida (o servidor reiniciou). O saldo reservado voltou.', finishedAt: new Date() })
      .where(and(eq(schema.flowTranslations.id, t.id), eq(schema.flowTranslations.status, 'running'))).returning();
    if (!claimed) continue;
    const { charged, refunded } = await settle(t.accountId, t.reserved, t.used);
    await db.update(schema.flowTranslations).set({ refunded }).where(eq(schema.flowTranslations.id, t.id));
    await recordUsage(t.accountId, { kind: 'flow_translate', flowId: t.sourceFlowId, label: `${t.sourceName} → ${LANGUAGE_LABEL[t.language as TranslateLang] ?? t.language} (interrompida)` }, charged);
    emitToAccount(t.accountId, 'translations:changed', {});
  }
  return stale.length;
}

export function startTranslationSweep() {
  const run = () => sweepStaleTranslations().catch((err) => console.error('[traduções] limpeza:', (err as Error).message));
  run();
  setInterval(run, 10 * 60_000).unref();
}

/* ------------------------------------------------------------ rotas */

export const translationsRouter = Router();

translationsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const rows = await db.select({
    t: schema.flowTranslations,
    createdByName: schema.users.name,
    sourceExists: sql<boolean>`exists (select 1 from flows f where f.id = ${schema.flowTranslations.sourceFlowId} and f.archived_at is null)`,
    copyExists: sql<boolean>`exists (select 1 from flows f where f.id = ${schema.flowTranslations.copyFlowId} and f.archived_at is null)`,
  }).from(schema.flowTranslations)
    .leftJoin(schema.users, eq(schema.users.id, schema.flowTranslations.createdBy))
    .where(eq(schema.flowTranslations.accountId, accountId))
    .orderBy(desc(schema.flowTranslations.createdAt)).limit(200);
  const list = rows.map((r) => publicTranslation({ ...r.t, createdByName: r.createdByName, sourceExists: r.sourceExists, copyExists: r.copyExists }));
  const st = await getTokenState(accountId);
  res.json({
    translations: list,
    stats: {
      total: list.length,
      done: list.filter((t) => t.status === 'done').length,
      failed: list.filter((t) => t.status === 'failed').length,
      running: list.filter((t) => t.status === 'running').length,
      tokens: list.reduce((a, t) => a + t.charged, 0),
    },
    balance: st.balance, active: st.status === 'active', aiEnabled: aiEnabled(),
    languages: TRANSLATE_LANGS.map((code) => ({ code, label: LANGUAGE_LABEL[code] })),
  });
}));
