/** Variáveis globais da conta ({{g_nome}}) e as variáveis de data/hora, para os fluxos. */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { timeVars } from '../utils/hours';
import { emitToAccount } from '../realtime/io';

/** "Nome 01" → "g_nome_01" (minúsculas, números e _; o prefixo g_ entra sozinho). */
export function globalKey(raw: string): string {
  const base = String(raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^(g_+)+/, '').replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return base ? `g_${base}` : '';
}

/** Valor de número: aceita vírgula ou ponto. */
export const toNumber = (v: string) => {
  const n = Number(String(v ?? '').trim().replace(/\./g, (m, i, all) => (all.includes(',') ? '' : m)).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export async function globalsOf(accountId: string): Promise<Record<string, string>> {
  const rows = await db.select({ key: schema.globalVariables.key, value: schema.globalVariables.value })
    .from(schema.globalVariables).where(eq(schema.globalVariables.accountId, accountId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function flowExtras(accountId: string): Promise<Record<string, string>> {
  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  return { ...timeVars(acc?.tz || 'America/Sao_Paulo'), ...(await globalsOf(accountId)) };
}

/** O fluxo muda uma variável global. Número: somar/subtrair de forma atômica (vários contatos ao mesmo tempo). */
export async function setGlobalValue(accountId: string, key: string, op: 'set' | 'add' | 'subtract', value: string) {
  const k = globalKey(key);
  if (!k) return null;
  const [g] = await db.select().from(schema.globalVariables)
    .where(and(eq(schema.globalVariables.accountId, accountId), eq(schema.globalVariables.key, k))).limit(1);
  if (!g) { console.warn('[fluxo] variável global não existe:', k); return null; }
  if (g.type === 'number') {
    const n = toNumber(value);
    if (Number.isNaN(n)) { console.warn('[fluxo] valor não é número para', k, value); return null; }
    const delta = op === 'subtract' ? -n : n;
    const [row] = op === 'set'
      ? await db.update(schema.globalVariables).set({ value: String(n), updatedAt: new Date() }).where(eq(schema.globalVariables.id, g.id)).returning()
      : await db.update(schema.globalVariables).set({
        value: sql`(coalesce(nullif(${schema.globalVariables.value}, '')::numeric, 0) + ${delta})::text`, updatedAt: new Date(),
      }).where(eq(schema.globalVariables.id, g.id)).returning();
    emitToAccount(accountId, 'globals:changed', {});
    return row;
  }
  const next = op === 'set' ? value : g.value + value;
  const [row] = await db.update(schema.globalVariables).set({ value: next.slice(0, 2000), updatedAt: new Date() }).where(eq(schema.globalVariables.id, g.id)).returning();
  emitToAccount(accountId, 'globals:changed', {});
  return row;
}
