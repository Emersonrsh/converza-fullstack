/**
 * Regras automáticas dos anúncios: "pausar anúncio com CPA acima de R$ X depois de R$ Y gastos",
 * "aumentar o orçamento em 20% se o ROAS passar de 2 nos últimos 3 dias"...
 *
 * Cada regra olha os números de uma conta de anúncios (Meta + vendas do Converza, os mesmos do Gerenciador)
 * numa janela de tempo e, para cada campanha/conjunto/anúncio em que TODAS as condições valem, aplica a ação.
 * Roda a cada 30 minutos; depois de agir num objeto, espera o "intervalo" da regra antes de agir nele de novo.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import type { AdRuleAction, AdRuleCondition } from '../db/schema';
import { redis } from '../redis';
import { emitToAccount } from '../realtime/io';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { validTz } from '../modules/dashboard';
import { loadManagerRows } from '../modules/meta';
import { addDays, todayIn } from './adsSync';
import { minorUnits, setObjectBudget, setObjectStatus } from './adsWrite';
import { MetaApiError, type Level } from './graphAds';
import type { ManagerRow } from './insights';

/* ------------------------------------------------------------------ métricas */

const INF = Number.POSITIVE_INFINITY;
/** Custo por algo: sem nenhum resultado e com gasto, conta como infinito (a regra "CPA acima de X" pega quem gastou e não vendeu). */
const costPer = (spend: number, count: number) => (count > 0 ? spend / count : spend > 0 ? INF : 0);

export const METRICS: Record<string, { label: string; money?: boolean; pct?: boolean; x?: boolean; get: (r: ManagerRow) => number }> = {
  spend: { label: 'Valor gasto', money: true, get: (r) => r.metrics.spend },
  cpa: { label: 'Custo por venda (CPA)', money: true, get: (r) => costPer(r.metrics.spend, r.converza.sales) },
  sales: { label: 'Vendas (Converza)', get: (r) => r.converza.sales },
  revenue: { label: 'Faturamento (Converza)', money: true, get: (r) => r.converza.revenue },
  roas: { label: 'ROAS (Converza)', x: true, get: (r) => r.converza.roas },
  profit: { label: 'Lucro líquido', money: true, get: (r) => r.converza.profit },
  margin: { label: 'Margem líquida', pct: true, get: (r) => r.converza.margin },
  conversations: { label: 'Conversas iniciadas', get: (r) => r.metrics.conversations },
  costPerConversation: { label: 'Custo por conversa', money: true, get: (r) => costPer(r.metrics.spend, r.metrics.conversations) },
  leads: { label: 'Leads (Converza)', get: (r) => r.converza.leads },
  costPerLead: { label: 'Custo por lead (Converza)', money: true, get: (r) => costPer(r.metrics.spend, r.converza.leads) },
  cpc: { label: 'CPC (link)', money: true, get: (r) => costPer(r.metrics.spend, r.metrics.linkClicks) },
  ctr: { label: 'CTR (link)', pct: true, get: (r) => r.derived.ctr },
  cpm: { label: 'CPM', money: true, get: (r) => r.derived.cpm },
  frequency: { label: 'Frequência', get: (r) => r.derived.frequency },
  impressions: { label: 'Impressões', get: (r) => r.metrics.impressions },
};
export const WINDOWS: Record<string, { label: string; days: number; offset: number }> = {
  today: { label: 'Hoje', days: 1, offset: 0 },
  yesterday: { label: 'Ontem', days: 1, offset: 1 },
  '3d': { label: 'Últimos 3 dias (com hoje)', days: 3, offset: 0 },
  '7d': { label: 'Últimos 7 dias (com hoje)', days: 7, offset: 0 },
  '14d': { label: 'Últimos 14 dias (com hoje)', days: 14, offset: 0 },
  '30d': { label: 'Últimos 30 dias (com hoje)', days: 30, offset: 0 },
};
const LEVELS = ['campaign', 'adset', 'ad'] as const;
const LEVEL_NAME: Record<string, string> = { campaign: 'campanha', adset: 'conjunto', ad: 'anúncio' };

export function windowDates(win: string, today: string) {
  const w = WINDOWS[win] ?? WINDOWS.today;
  const d1 = addDays(today, -w.offset);
  return { d0: addDays(d1, -(w.days - 1)), d1 };
}

export function conditionsHold(r: ManagerRow, conds: AdRuleCondition[]) {
  const values: Record<string, number> = {};
  for (const c of conds) {
    const def = METRICS[c.metric];
    if (!def) return { ok: false, values };
    const v = def.get(r);
    values[c.metric] = Number.isFinite(v) ? Math.round(v * 100) / 100 : -1; // -1 = sem resultado (custo infinito)
    if (!(c.op === 'gt' ? v > c.value : v < c.value)) return { ok: false, values };
  }
  return { ok: conds.length > 0, values };
}

/** Quem a regra pode tocar: pausar/orçamento só em quem está ligado; ativar só em quem está pausado. */
export function eligible(r: ManagerRow, action: AdRuleAction['type']) {
  if (!r.configured) return false; // excluído na Meta
  if (action === 'activate') return r.configured === 'PAUSED';
  return r.configured === 'ACTIVE' && r.status.key === 'active';
}

/** Novo orçamento (na moeda) depois de subir/descer pct%, respeitando o limite. null = já está no limite. */
export function nextBudget(amount: number, a: AdRuleAction): number | null {
  const pct = Math.max(1, Math.min(500, a.pct ?? 20));
  let v = a.type === 'budget_up' ? amount * (1 + pct / 100) : amount * (1 - pct / 100);
  if (a.limit && a.limit > 0) v = a.type === 'budget_up' ? Math.min(v, a.limit) : Math.max(v, a.limit);
  v = Math.round(v * 100) / 100;
  if (a.type === 'budget_up' ? v <= amount : v >= amount) return null;
  return v;
}

const fmtMoney = (v: number, cur: string) => {
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cur }).format(v); } catch { return `${cur} ${v.toFixed(2)}`; }
};
export function describeAction(a: AdRuleAction, cur: string) {
  switch (a.type) {
    case 'pause': return 'Pausar';
    case 'activate': return 'Ativar';
    case 'budget_up': return `Aumentar orçamento em ${a.pct ?? 20}%${a.limit ? ` (até ${fmtMoney(a.limit, cur)})` : ''}`;
    case 'budget_down': return `Diminuir orçamento em ${a.pct ?? 20}%${a.limit ? ` (no mínimo ${fmtMoney(a.limit, cur)})` : ''}`;
    default: return 'Só avisar';
  }
}

/* ---------------------------------------------------------------- execução */

type Rule = typeof schema.adRules.$inferSelect;
type RuleDraft = Pick<Rule, 'actId' | 'level' | 'campaignIds' | 'conditions' | 'window' | 'action' | 'cooldownHours'> & { id?: string; name: string; accountId: string };
export interface Match { id: string; name: string; level: string; campaignId: string | null; values: Record<string, number>; budget: ManagerRow['budget']; status: string; cooling: boolean; currency: string }

/** Avalia a regra agora (sem aplicar). */
export async function evaluateRule(rule: RuleDraft) {
  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, rule.accountId)).limit(1);
  const tz = validTz(acc?.tz);
  const { d0, d1 } = windowDates(rule.window, todayIn(tz));
  const m = await loadManagerRows({ accountId: rule.accountId, level: rule.level as Level, d0, d1, tz, onlyAct: rule.actId, ttl: 120 });
  const adAcc = m.accounts.find((a) => a.actId === rule.actId);
  if (!adAcc) throw new AppError(400, 'Essa conta de anúncios não está mais escolhida no painel (Facebook → Perfis e contas).');
  if (m.errors.length) throw new AppError(502, m.errors[0].message);
  const camps = new Set(rule.campaignIds ?? []);
  const since = new Date(Date.now() - Math.max(0, rule.cooldownHours) * 3600_000);
  const recent = rule.id ? await db.select({ objectId: schema.adRuleLogs.objectId }).from(schema.adRuleLogs)
    .where(and(eq(schema.adRuleLogs.ruleId, rule.id), eq(schema.adRuleLogs.status, 'applied'), gt(schema.adRuleLogs.createdAt, since))) : [];
  const cooling = new Set(recent.map((x) => x.objectId));
  const matches: Match[] = [];
  for (const r of m.rows) {
    if (camps.size && !camps.has(r.campaignId ?? '')) continue;
    if (!eligible(r, rule.action.type)) continue;
    const c = conditionsHold(r, rule.conditions);
    if (!c.ok) continue;
    matches.push({ id: r.id, name: r.name, level: r.level, campaignId: r.campaignId, values: c.values, budget: r.budget, status: r.status.label, cooling: cooling.has(r.id), currency: r.currency });
  }
  return { matches, checked: m.rows.filter((r) => !camps.size || camps.has(r.campaignId ?? '')).length, from: d0, to: d1, account: adAcc, token: m.tokens.get(rule.actId) ?? null };
}

async function log(rule: RuleDraft & { id: string }, x: Match, action: string, status: 'applied' | 'error' | 'skipped', detail: string) {
  await db.insert(schema.adRuleLogs).values({
    accountId: rule.accountId, ruleId: rule.id, ruleName: rule.name, objectId: x.id, objectName: x.name, level: x.level,
    action, status, detail: detail.slice(0, 500), values: x.values,
  });
}

/** Avalia e aplica a regra. Devolve quantos objetos foram alterados. */
export async function runRule(rule: Rule) {
  const lock = await redis.set(`ad-rule:${rule.id}`, '1', 'PX', 5 * 60_000, 'NX').catch(() => 'OK');
  if (!lock) return { applied: 0, matches: 0, skipped: true };
  let applied = 0; let matched = 0;
  try {
    const ev = await evaluateRule(rule);
    matched = ev.matches.length;
    if (ev.matches.length && rule.action.type !== 'notify' && !ev.account.canManage) {
      throw new AppError(403, 'O perfil do Facebook desta conta não tem permissão para gerenciar anúncios. Reconecte em Perfis e contas.');
    }
    for (const x of ev.matches) {
      if (x.cooling) continue;
      const what = describeAction(rule.action, x.currency);
      try {
        if (rule.action.type === 'pause' || rule.action.type === 'activate') {
          await setObjectStatus(x.id, rule.action.type === 'pause' ? 'PAUSED' : 'ACTIVE', ev.token!);
          await log(rule, x, what, 'applied', `${rule.action.type === 'pause' ? 'Pausou' : 'Ativou'} ${LEVEL_NAME[x.level]} “${x.name}”`);
        } else if (rule.action.type === 'budget_up' || rule.action.type === 'budget_down') {
          if (!x.budget) {
            await log(rule, x, what, 'skipped', `${LEVEL_NAME[x.level]} “${x.name}” não tem orçamento próprio (ele fica ${x.level === 'adset' ? 'na campanha' : 'nos conjuntos'})`);
            continue;
          }
          const nv = nextBudget(x.budget.amount, rule.action);
          if (nv === null) { await log(rule, x, what, 'skipped', `Orçamento de “${x.name}” já está no limite da regra`); continue; }
          await setObjectBudget(x.id, x.budget.kind, minorUnits(nv, x.currency), ev.token!);
          await log(rule, x, what, 'applied', `Orçamento ${x.budget.kind === 'daily' ? 'diário' : 'total'} de “${x.name}”: ${fmtMoney(x.budget.amount, x.currency)} → ${fmtMoney(nv, x.currency)}`);
        } else {
          await log(rule, x, what, 'applied', `${LEVEL_NAME[x.level][0].toUpperCase()}${LEVEL_NAME[x.level].slice(1)} “${x.name}” bateu as condições`);
        }
        applied++;
      } catch (err) {
        const msg = err instanceof MetaApiError ? err.message : (err as Error).message;
        await log(rule, x, what, 'error', `A Meta recusou: ${msg}`);
      }
    }
    await db.update(schema.adRules).set({ lastRunAt: new Date(), lastError: null }).where(eq(schema.adRules.id, rule.id));
  } catch (err) {
    await db.update(schema.adRules).set({ lastRunAt: new Date(), lastError: (err as Error).message.slice(0, 300) }).where(eq(schema.adRules.id, rule.id));
    throw err;
  } finally {
    await redis.del(`ad-rule:${rule.id}`).catch(() => undefined);
    emitToAccount(rule.accountId, 'meta:rules', { ruleId: rule.id });
  }
  return { applied, matches: matched, skipped: false };
}

const EVERY_MIN = 30;
/** A cada 5 minutos, roda as regras ligadas que não rodam há 30 minutos. */
export function startAdRules() {
  const sweep = async () => {
    const got = await redis.set('ad-rules-sweep', '1', 'PX', 4 * 60_000, 'NX').catch(() => 'OK');
    if (!got) return;
    try {
      const due = await db.select().from(schema.adRules)
        .where(and(eq(schema.adRules.enabled, true), or(isNull(schema.adRules.lastRunAt), lt(schema.adRules.lastRunAt, new Date(Date.now() - (EVERY_MIN - 1) * 60_000)))))
        .limit(200);
      for (const r of due) await runRule(r).catch((e) => console.error('[regras]', r.id, (e as Error).message));
    } catch (err) {
      console.error('[regras] rodada:', (err as Error).message);
    }
  };
  setTimeout(() => void sweep(), 30_000).unref();
  setInterval(() => void sweep(), 5 * 60_000).unref();
}

/* ------------------------------------------------------------------- API */

export const adRulesRouter = Router();
const manager = (role: string | undefined) => { if (role === 'agent') throw new AppError(403, 'Apenas donos e administradores mexem nas regras automáticas'); };

const condSchema = z.object({ metric: z.string().refine((k) => k in METRICS, 'Métrica inválida'), op: z.enum(['gt', 'lt']), value: z.number().min(0).max(1e9) });
const ruleSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a regra').max(120),
  enabled: z.boolean().default(true),
  actId: z.string().regex(/^act_\d{1,30}$/, 'Escolha a conta de anúncios'),
  level: z.enum(LEVELS),
  campaignIds: z.array(z.string().regex(/^\d{1,30}$/)).max(200).default([]),
  conditions: z.array(condSchema).min(1, 'Coloque pelo menos uma condição').max(8),
  window: z.string().refine((w) => w in WINDOWS, 'Janela inválida'),
  action: z.object({
    type: z.enum(['pause', 'activate', 'budget_up', 'budget_down', 'notify']),
    pct: z.number().min(1).max(500).optional(),
    limit: z.number().min(0).max(1e9).nullable().optional(),
  }),
  cooldownHours: z.number().int().min(0).max(24 * 30).default(24),
});
const cleanAction = (a: z.infer<typeof ruleSchema>['action']): AdRuleAction =>
  (a.type === 'budget_up' || a.type === 'budget_down' ? { type: a.type, pct: a.pct ?? 20, limit: a.limit ?? null } : { type: a.type });

adRulesRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [rules, logs] = await Promise.all([
    db.select().from(schema.adRules).where(eq(schema.adRules.accountId, accountId)).orderBy(desc(schema.adRules.createdAt)),
    db.select().from(schema.adRuleLogs).where(eq(schema.adRuleLogs.accountId, accountId)).orderBy(desc(schema.adRuleLogs.createdAt)).limit(100),
  ]);
  const last24 = new Date(Date.now() - 24 * 3600_000);
  const counts = (await db.execute(sql`select rule_id, count(*)::int as n from ad_rule_logs
    where account_id = ${accountId} and status = 'applied' and created_at > ${last24} group by 1`)).rows as { rule_id: string; n: number }[];
  const by = new Map(counts.map((c) => [c.rule_id, Number(c.n)]));
  res.json({
    rules: rules.map((r) => ({ ...r, applied24h: by.get(r.id) ?? 0 })),
    logs,
    metrics: Object.entries(METRICS).map(([id, m]) => ({ id, label: m.label, money: !!m.money, pct: !!m.pct, x: !!m.x })),
    windows: Object.entries(WINDOWS).map(([id, w]) => ({ id, label: w.label })),
    everyMinutes: EVERY_MIN,
  });
}));

adRulesRouter.post('/', asyncHandler(async (req, res) => {
  manager(req.role);
  const d = ruleSchema.parse(req.body);
  const [r] = await db.insert(schema.adRules).values({ ...d, action: cleanAction(d.action), accountId: req.accountId!, createdBy: req.user?.id ?? null }).returning();
  res.json({ rule: r });
}));

async function own(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Regra não encontrada');
  const [r] = await db.select().from(schema.adRules).where(and(eq(schema.adRules.id, id), eq(schema.adRules.accountId, accountId))).limit(1);
  if (!r) throw new AppError(404, 'Regra não encontrada');
  return r;
}

adRulesRouter.put('/:id', asyncHandler(async (req, res) => {
  manager(req.role);
  await own(req.accountId!, req.params.id);
  const d = ruleSchema.parse(req.body);
  const [r] = await db.update(schema.adRules).set({ ...d, action: cleanAction(d.action), updatedAt: new Date(), lastError: null })
    .where(eq(schema.adRules.id, req.params.id)).returning();
  res.json({ rule: r });
}));

adRulesRouter.patch('/:id', asyncHandler(async (req, res) => {
  manager(req.role);
  await own(req.accountId!, req.params.id);
  const d = z.object({ enabled: z.boolean() }).parse(req.body);
  const [r] = await db.update(schema.adRules).set({ enabled: d.enabled, updatedAt: new Date() }).where(eq(schema.adRules.id, req.params.id)).returning();
  res.json({ rule: r });
}));

adRulesRouter.delete('/:id', asyncHandler(async (req, res) => {
  manager(req.role);
  await own(req.accountId!, req.params.id);
  await db.delete(schema.adRules).where(eq(schema.adRules.id, req.params.id));
  res.json({ ok: true });
}));

/** Simula uma regra (nova ou editada) sem aplicar: quem bateria as condições agora. */
adRulesRouter.post('/simulate', asyncHandler(async (req, res) => {
  manager(req.role);
  const d = ruleSchema.parse(req.body);
  const id = typeof req.body.id === 'string' && isUuid(req.body.id) ? req.body.id : undefined;
  const ev = await evaluateRule({ ...d, id, action: cleanAction(d.action), accountId: req.accountId! });
  res.json({ matches: ev.matches.map((m) => ({ ...m, preview: previewOf(m, cleanAction(d.action)) })), checked: ev.checked, from: ev.from, to: ev.to });
}));

function previewOf(m: Match, a: AdRuleAction) {
  if (a.type === 'budget_up' || a.type === 'budget_down') {
    if (!m.budget) return 'sem orçamento próprio: não muda';
    const nv = nextBudget(m.budget.amount, a);
    return nv === null ? 'já está no limite' : `${fmtMoney(m.budget.amount, m.currency)} → ${fmtMoney(nv, m.currency)}`;
  }
  return describeAction(a, m.currency);
}

/** Roda a regra agora (aplica de verdade). */
adRulesRouter.post('/:id/run', asyncHandler(async (req, res) => {
  manager(req.role);
  const r = await own(req.accountId!, req.params.id);
  const out = await runRule(r);
  if (out.skipped) throw new AppError(409, 'Essa regra já está rodando. Tente de novo em instantes.');
  res.json(out);
}));
