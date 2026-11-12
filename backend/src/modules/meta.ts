import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { redis } from '../redis';
import { emitToAccount } from '../realtime/io';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import {
  BREAKDOWNS, debugUserToken, exchangeAdsCode, extendUserToken, graphAds, fetchAdAccounts, fetchBreakdown, fetchEntities, fetchInsights, fetchMe, MetaApiError,
  type InsightRow, type Level, type RemoteAdAccount, type RemoteEntity,
} from '../meta/graphAds';
import { accountStatusLabel, addMetrics, breakdownKey, buildRows, dailySeries, derive, metricsOf, totalsByCurrency, zero, type Attribution, type EntityIn, type Metrics } from '../meta/insights';
import { addDays, dropAdAccountSpend, markProfileProblem, syncAdAccountSpend, todayIn } from '../meta/adsSync';
import { PERIODS, periodDates, validTz, type Period } from './dashboard';
import {
  adsManagerUrl, createCtwaCampaign, listAdPages, minorUnits, searchGeo, searchInterests, setObjectBudget, setObjectStatus,
  StepError, uploadAdImage, type CampaignSpec,
} from '../meta/adsWrite';
import { linkCampaignFlow, rememberAdCampaign } from '../meta/adFlows';
import { copyObject, deliveryEstimate, lookup, publishTree, readTree, uploadAdVideo, videoState, type PubTree } from '../meta/editor';

/**
 * Facebook: perfis da Meta (um login por perfil), contas de anúncios que entram no painel e o
 * Gerenciador (campanhas, conjuntos e anúncios com os leads e vendas do Converza).
 */
export const metaRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores mexem na integração com a Meta');
}

const loginConfig = () => ({
  configured: Boolean(config.whatsapp.appId && config.whatsapp.appSecret),
  appId: config.whatsapp.appId,
  configId: config.meta.adsLoginConfigId || null,
  graphVersion: config.meta.adsApiVersion,
});

type ProfileRow = typeof schema.metaProfiles.$inferSelect;
type AdAccRow = typeof schema.metaAdAccounts.$inferSelect;

async function listProfiles(accountId: string) {
  const profiles = await db.select().from(schema.metaProfiles).where(eq(schema.metaProfiles.accountId, accountId)).orderBy(asc(schema.metaProfiles.createdAt));
  const accs = await db.select().from(schema.metaAdAccounts).where(eq(schema.metaAdAccounts.accountId, accountId)).orderBy(asc(schema.metaAdAccounts.name));
  const selectedBy = new Map<string, string>();
  for (const a of accs) if (a.selected) selectedBy.set(a.actId, a.profileId);
  const pname = new Map(profiles.map((p) => [p.id, p.name]));
  return profiles.map((p) => ({
    id: p.id, fbUserId: p.fbUserId, name: p.name, picture: p.pictureUrl, status: p.status, lastError: p.lastError,
    tokenExpiresAt: p.tokenExpiresAt, createdAt: p.createdAt, updatedAt: p.updatedAt, canManageAds: canManage(p.scopes),
    adAccounts: accs.filter((a) => a.profileId === p.id).map((a) => {
      const other = selectedBy.get(a.actId);
      return {
        id: a.id, actId: a.actId, name: a.name, currency: a.currency, timezone: a.timezone, business: a.businessName,
        status: accountStatusLabel(a.accountStatus), selected: a.selected, available: a.available,
        lastSyncAt: a.lastSyncAt, lastError: a.lastError,
        selectedElsewhere: !a.selected && other && other !== p.id ? pname.get(other) ?? 'outro perfil' : null,
      };
    }),
  }));
}

async function ownProfile(accountId: string, id: string): Promise<ProfileRow> {
  if (!isUuid(id)) throw new AppError(404, 'Perfil não encontrado');
  const [p] = await db.select().from(schema.metaProfiles).where(and(eq(schema.metaProfiles.id, id), eq(schema.metaProfiles.accountId, accountId))).limit(1);
  if (!p) throw new AppError(404, 'Perfil não encontrado');
  return p;
}

async function ownAdAccount(accountId: string, id: string): Promise<AdAccRow> {
  if (!isUuid(id)) throw new AppError(404, 'Conta de anúncios não encontrada');
  const [a] = await db.select().from(schema.metaAdAccounts).where(and(eq(schema.metaAdAccounts.id, id), eq(schema.metaAdAccounts.accountId, accountId))).limit(1);
  if (!a) throw new AppError(404, 'Conta de anúncios não encontrada');
  return a;
}

/** Grava as contas que o perfil enxerga; as que sumiram ficam marcadas como sem acesso. */
async function upsertAdAccounts(accountId: string, profileId: string, remote: RemoteAdAccount[]) {
  for (const a of remote) {
    await db.insert(schema.metaAdAccounts).values({
      accountId, profileId, actId: a.actId, name: a.name, currency: a.currency, timezone: a.timezone,
      accountStatus: a.status, businessName: a.business, available: true,
    }).onConflictDoUpdate({
      target: [schema.metaAdAccounts.profileId, schema.metaAdAccounts.actId],
      set: { name: a.name, currency: a.currency, timezone: a.timezone, accountStatus: a.status, businessName: a.business, available: true, updatedAt: new Date() },
    });
  }
  const ids = remote.map((a) => a.actId);
  await db.update(schema.metaAdAccounts).set({ available: false, updatedAt: new Date() })
    .where(and(eq(schema.metaAdAccounts.profileId, profileId), ids.length ? notInArray(schema.metaAdAccounts.actId, ids) : sql`true`));
}

/** O login do perfil autorizou criar e mudar anúncios? (sem a lista de permissões, deixa a Meta decidir) */
export function canManage(scopes: unknown): boolean {
  const list = Array.isArray(scopes) ? scopes.map(String) : [];
  return !list.length || list.includes('ads_management');
}

const metaFail = (err: unknown): never => {
  if (err instanceof MetaApiError) throw new AppError(err.status, err.message);
  throw err;
};

metaRouter.get('/overview', asyncHandler(async (req, res) => {
  const profiles = await listProfiles(req.accountId!);
  const selected = profiles.reduce((n, p) => n + p.adAccounts.filter((a) => a.selected).length, 0);
  res.json({ login: loginConfig(), profiles, selectedCount: selected, canEdit: req.role !== 'agent' });
}));

const connectSchema = z.object({
  code: z.string().trim().min(4).max(4000).optional(),
  accessToken: z.string().trim().min(20).max(4000).optional(),
}).refine((d) => d.code || d.accessToken, 'Faltou o login da Meta');

/** Conectar (ou reconectar) um perfil: troca o login por um token de ~60 dias e lista as contas de anúncios. */
metaRouter.post('/profiles', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  if (!loginConfig().configured) throw new AppError(400, 'O login da Meta não está configurado no servidor (META_APP_ID e META_APP_SECRET).');
  const d = connectSchema.parse(req.body);
  let token: string;
  let me: Awaited<ReturnType<typeof fetchMe>>;
  let remote: RemoteAdAccount[];
  let expiresAt: Date | null;
  let scopes: string[] = [];
  try {
    token = d.code ? await exchangeAdsCode(d.code) : d.accessToken!;
    const ext = await extendUserToken(token);
    token = ext.token;
    const info = await debugUserToken(token).catch(() => null);
    if (info?.appId && config.whatsapp.appId && info.appId !== config.whatsapp.appId) throw new AppError(422, 'Esse login é de outro app da Meta.');
    if (info && !info.valid) throw new AppError(422, 'A Meta recusou o login. Tente de novo.');
    scopes = info?.scopes ?? [];
    if (scopes.length && !scopes.some((s) => s === 'ads_read' || s === 'ads_management')) {
      throw new AppError(422, 'O perfil não autorizou a leitura dos anúncios (ads_read). Conecte de novo e permita o acesso às contas de anúncios.');
    }
    expiresAt = info?.expiresAt ?? (ext.expiresIn ? new Date(Date.now() + ext.expiresIn * 1000) : null);
    me = await fetchMe(token);
    remote = await fetchAdAccounts(token);
  } catch (err) { return metaFail(err); }

  const [profile] = await db.insert(schema.metaProfiles).values({
    accountId, fbUserId: me.id, name: me.name, pictureUrl: me.picture, accessToken: token, tokenExpiresAt: expiresAt,
    scopes, status: 'connected', lastError: null, createdBy: req.user!.id,
  }).onConflictDoUpdate({
    target: [schema.metaProfiles.accountId, schema.metaProfiles.fbUserId],
    set: { name: me.name, pictureUrl: me.picture, accessToken: token, tokenExpiresAt: expiresAt, scopes, status: 'connected', lastError: null, updatedAt: new Date() },
  }).returning({ id: schema.metaProfiles.id, inserted: sql<boolean>`(xmax = 0)` });
  await upsertAdAccounts(accountId, profile.id, remote);
  emitToAccount(accountId, 'meta:changed', { profileId: profile.id });
  const list = await listProfiles(accountId);
  res.status(profile.inserted ? 201 : 200).json({ profile: list.find((p) => p.id === profile.id), reconnected: !profile.inserted });
}));

/** Lê de novo as contas de anúncios do perfil (e confere se o login ainda vale). */
metaRouter.post('/profiles/:id/refresh', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = await ownProfile(accountId, req.params.id);
  try {
    const remote = await fetchAdAccounts(p.accessToken);
    await upsertAdAccounts(accountId, p.id, remote);
    const info = await debugUserToken(p.accessToken).catch(() => null);
    await db.update(schema.metaProfiles).set({
      status: 'connected', lastError: null, updatedAt: new Date(), ...(info?.expiresAt ? { tokenExpiresAt: info.expiresAt } : {}),
    }).where(eq(schema.metaProfiles.id, p.id));
  } catch (err) {
    if (err instanceof MetaApiError) { await markProfileProblem(p.id, err); throw new AppError(err.status, err.message); }
    throw err;
  }
  emitToAccount(accountId, 'meta:changed', { profileId: p.id });
  const list = await listProfiles(accountId);
  res.json({ profile: list.find((x) => x.id === p.id) });
}));

metaRouter.delete('/profiles/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = await ownProfile(accountId, req.params.id);
  const sel = await db.select({ actId: schema.metaAdAccounts.actId }).from(schema.metaAdAccounts)
    .where(and(eq(schema.metaAdAccounts.profileId, p.id), eq(schema.metaAdAccounts.selected, true)));
  await db.delete(schema.metaProfiles).where(eq(schema.metaProfiles.id, p.id));
  for (const a of sel) await dropAdAccountSpend(accountId, a.actId);
  emitToAccount(accountId, 'meta:changed', { profileId: p.id });
  res.json({ ok: true, removedFromDashboard: sel.length });
}));

/** Liga/desliga uma conta de anúncios no painel (Gerenciador + gasto do Dashboard). */
metaRouter.patch('/ad-accounts/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const a = await ownAdAccount(accountId, req.params.id);
  const d = z.object({ selected: z.boolean() }).parse(req.body);
  if (d.selected && !a.selected) {
    if (!a.available) throw new AppError(409, 'Este perfil não enxerga mais essa conta. Atualize as contas ou use outro perfil.');
    const [other] = await db.select({ name: schema.metaProfiles.name }).from(schema.metaAdAccounts)
      .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
      .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.actId, a.actId), eq(schema.metaAdAccounts.selected, true), ne(schema.metaAdAccounts.id, a.id)))
      .limit(1);
    if (other) throw new AppError(409, `Esta conta já entra no painel pelo perfil “${other.name}”.`);
  }
  const [row] = await db.update(schema.metaAdAccounts).set({ selected: d.selected, updatedAt: new Date(), ...(d.selected ? {} : { lastSyncAt: null }) })
    .where(eq(schema.metaAdAccounts.id, a.id)).returning();
  if (d.selected && !a.selected) void syncAdAccountSpend(a.id, 90).catch((err) => console.error('[meta] sincronizar conta:', (err as Error).message));
  if (!d.selected && a.selected) await dropAdAccountSpend(accountId, a.actId);
  emitToAccount(accountId, 'meta:changed', { adAccountId: a.id });
  res.json({ adAccount: { id: row.id, selected: row.selected } });
}));

/** Atualiza agora o gasto das contas escolhidas (o automático roda a cada hora). */
metaRouter.post('/sync', asyncHandler(async (req, res) => {
  managerOnly(req);
  const list = await db.select().from(schema.metaAdAccounts)
    .where(and(eq(schema.metaAdAccounts.accountId, req.accountId!), eq(schema.metaAdAccounts.selected, true)));
  const results = [];
  for (const a of list) results.push({ actId: a.actId, name: a.name, error: await syncAdAccountSpend(a.id, a.lastSyncAt ? 7 : 90) });
  res.json({ results });
}));

/* ------------------------------------------------------------------ Gerenciador */

async function cached<T>(key: string, ttlSec: number, fresh: boolean, fn: () => Promise<T>): Promise<{ v: T; at: number }> {
  if (!fresh) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as { v: T; at: number };
    } catch { /* sem cache */ }
  }
  const out = { v: await fn(), at: Date.now() };
  redis.set(key, JSON.stringify(out), 'EX', ttlSec).catch(() => {});
  return out;
}

const LEVELS = ['campaign', 'adset', 'ad'] as const;

metaRouter.get('/manager', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const q = req.query;
  const level: Level = (LEVELS as readonly string[]).includes(String(q.level)) ? (q.level as Level) : 'campaign';
  const period: Period = (PERIODS as readonly string[]).includes(String(q.period)) ? (q.period as Period) : '7d';
  const fresh = q.fresh === '1';
  const campaignId = typeof q.campaignId === 'string' && /^\d{1,30}$/.test(q.campaignId) ? q.campaignId : null;
  const adsetId = typeof q.adsetId === 'string' && /^\d{1,30}$/.test(q.adsetId) ? q.adsetId : null;
  const onlyAct = typeof q.actId === 'string' && /^act_\d{1,30}$/.test(q.actId) ? q.actId : null;

  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const tz = validTz(acc?.tz);
  const p = periodDates(period, todayIn(tz), q.from, q.to);
  const d0 = p.d0; const d1 = p.d1;
  const days: string[] = [];
  for (let d = d0; d <= d1 && days.length < 400; d = addDays(d, 1)) days.push(d);

  const selected = await db.select({ a: schema.metaAdAccounts, profileName: schema.metaProfiles.name, profileStatus: schema.metaProfiles.status, token: schema.metaProfiles.accessToken, scopes: schema.metaProfiles.scopes })
    .from(schema.metaAdAccounts)
    .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.selected, true)))
    .orderBy(asc(schema.metaAdAccounts.name));
  const accounts = selected.map((s) => ({
    id: s.a.id, actId: s.a.actId, name: s.a.name, currency: s.a.currency, timezone: s.a.timezone, profileName: s.profileName, profileStatus: s.profileStatus,
    lastSyncAt: s.a.lastSyncAt, canManage: s.profileStatus === 'connected' && canManage(s.scopes),
  }));
  const use = selected.filter((s) => !onlyAct || s.a.actId === onlyAct);
  if (!use.length) {
    res.json({ level, period, from: d0, to: d1, days, accounts, rows: [], total: 0, totals: {}, daily: {}, errors: [], updatedAt: null, unmatched: { leads: 0, sales: 0 } });
    return;
  }

  const errors: { actId: string; name: string; message: string; expired: boolean }[] = [];
  const entities: EntityIn[] = [];
  const insights: (InsightRow & { actId: string; accountName: string; currency: string })[] = [];
  const daily: (InsightRow & { currency: string })[] = [];
  const ads: RemoteEntity[] = [];
  let oldest = Date.now();

  await Promise.all(use.map(async (s) => {
    const a = s.a;
    if (s.profileStatus === 'expired') {
      errors.push({ actId: a.actId, name: a.name, message: `O login do perfil “${s.profileName}” venceu. Reconecte em Perfis e contas.`, expired: true });
      return;
    }
    const k = `meta:${accountId}:${a.profileId}:${a.actId}`;
    try {
      const [adList, ents, ins, day] = await Promise.all([
        cached(`${k}:ent:ad`, 600, fresh, () => fetchEntities(a.actId, s.token, 'ad')),
        level === 'ad' ? null : cached(`${k}:ent:${level}`, 600, fresh, () => fetchEntities(a.actId, s.token, level)),
        cached(`${k}:ins:${level}:${d0}:${d1}`, 300, fresh, () => fetchInsights(a.actId, s.token, { level, since: d0, until: d1 })),
        cached(`${k}:daily:${d0}:${d1}`, 300, fresh, () => fetchInsights(a.actId, s.token, { level: 'account', since: d0, until: d1, daily: true })),
      ]);
      oldest = Math.min(oldest, adList.at, ins.at, day.at, ents?.at ?? Date.now());
      ads.push(...adList.v);
      const mine = (ents ?? adList).v
        .filter((e) => !campaignId || (level === 'campaign' ? e.id === campaignId : e.campaign_id === campaignId))
        .filter((e) => !adsetId || (level === 'adset' ? e.id === adsetId : e.adset_id === adsetId));
      entities.push(...mine.map((e) => ({ ...e, actId: a.actId, accountName: a.name, currency: a.currency })));
      insights.push(...ins.v
        .filter((r) => !campaignId || r.campaign_id === campaignId)
        .filter((r) => !adsetId || level === 'campaign' || r.adset_id === adsetId)
        .map((r) => ({ ...r, actId: a.actId, accountName: a.name, currency: a.currency })));
      daily.push(...day.v.map((r) => ({ ...r, currency: a.currency })));
    } catch (err) {
      const e = err instanceof MetaApiError ? err : new MetaApiError((err as Error).message);
      if (e.tokenExpired) await markProfileProblem(a.profileId, e);
      errors.push({ actId: a.actId, name: a.name, message: e.message, expired: e.tokenExpired });
    }
  }));

  // leads e vendas do Converza que vieram de um anúncio (ID do anúncio no referral / na venda)
  const r = (await db.execute(sql`select (${d0}::date::timestamp at time zone ${tz}) as s, (${addDays(d1, 1)}::date::timestamp at time zone ${tz}) as e`)).rows[0] as { s: Date; e: Date };
  const leadRows = (await db.execute(sql`select source_id as ad, count(*)::int as n from contacts
    where account_id = ${accountId} and source_id is not null and created_at >= ${r.s} and created_at < ${r.e} group by 1`)).rows as { ad: string; n: number }[];
  const saleRows = (await db.execute(sql`select source_id as ad, currency, count(*)::int as n, coalesce(sum(amount), 0)::float as v from sales
    where account_id = ${accountId} and status = 'approved' and source_id is not null and created_at >= ${r.s} and created_at < ${r.e} group by 1, 2`)).rows as { ad: string; currency: string; n: number; v: number }[];
  const attrByAd = new Map<string, Attribution>();
  const get = (ad: string) => { const x = attrByAd.get(ad) ?? { leads: 0, sales: 0, revenue: {} }; attrByAd.set(ad, x); return x; };
  for (const l of leadRows) get(l.ad).leads += Number(l.n);
  for (const s of saleRows) { const x = get(s.ad); x.sales += Number(s.n); x.revenue[s.currency] = (x.revenue[s.currency] ?? 0) + Number(s.v); }
  const known = new Set(ads.map((a) => a.id));
  const unmatched = { leads: 0, sales: 0 };
  if (!campaignId && !adsetId && !onlyAct && !errors.length) {
    for (const [ad, x] of attrByAd) if (!known.has(ad)) { unmatched.leads += x.leads; unmatched.sales += x.sales; }
  }

  const rows = buildRows(level, entities, insights, ads, attrByAd);
  // campanha ligada a um fluxo (leads dos anúncios dela começam nele)
  const links = level === 'campaign' ? await db.select({ campaignId: schema.metaCampaignFlows.campaignId, flowId: schema.flows.id, flowName: schema.flows.name })
    .from(schema.metaCampaignFlows).innerJoin(schema.flows, eq(schema.flows.id, schema.metaCampaignFlows.flowId))
    .where(eq(schema.metaCampaignFlows.accountId, accountId)) : [];
  const flowBy = new Map(links.map((l) => [l.campaignId, { id: l.flowId, name: l.flowName }]));
  const rowsOut = rows.slice(0, 500).map((r) => (r.level === 'campaign' ? { ...r, flow: flowBy.get(r.id) ?? null } : r));
  res.json({
    level, period, from: d0, to: d1, days, accounts,
    rows: rowsOut, total: rows.length,
    totals: totalsByCurrency(rows), daily: dailySeries(daily, days),
    errors, updatedAt: new Date(oldest).toISOString(), unmatched,
  });
}));

/** Detalhamento das linhas da tabela (idade, gênero, posicionamento, dia…), como no Gerenciador da Meta. */
metaRouter.get('/manager/breakdown', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const q = req.query;
  const level: Level = (LEVELS as readonly string[]).includes(String(q.level)) ? (q.level as Level) : 'campaign';
  const period: Period = (PERIODS as readonly string[]).includes(String(q.period)) ? (q.period as Period) : '7d';
  const by = String(q.by ?? '');
  if (!BREAKDOWNS[by]) throw new AppError(400, 'Detalhamento desconhecido');
  const campaignId = typeof q.campaignId === 'string' && /^\d{1,30}$/.test(q.campaignId) ? q.campaignId : null;
  const adsetId = typeof q.adsetId === 'string' && /^\d{1,30}$/.test(q.adsetId) ? q.adsetId : null;
  const onlyAct = typeof q.actId === 'string' && /^act_\d{1,30}$/.test(q.actId) ? q.actId : null;
  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const p = periodDates(period, todayIn(validTz(acc?.tz)), q.from, q.to);
  const selected = await db.select({ a: schema.metaAdAccounts, token: schema.metaProfiles.accessToken, status: schema.metaProfiles.status })
    .from(schema.metaAdAccounts).innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.selected, true)));
  const out = new Map<string, { id: string; key: string; label: string; currency: string; metrics: Metrics }>();
  const errors: string[] = [];
  await Promise.all(selected.filter((x) => (!onlyAct || x.a.actId === onlyAct) && x.status !== 'expired').map(async (x) => {
    try {
      const list = await cached(`meta:${accountId}:${x.a.profileId}:${x.a.actId}:bd:${level}:${by}:${p.d0}:${p.d1}`, 300, q.fresh === '1',
        () => fetchBreakdown(x.a.actId, x.token, { level, since: p.d0, until: p.d1, by }));
      for (const r of list.v) {
        if (campaignId && r.campaign_id !== campaignId) continue;
        if (adsetId && level !== 'campaign' && r.adset_id !== adsetId) continue;
        const id = String((level === 'campaign' ? r.campaign_id : level === 'adset' ? r.adset_id : r.ad_id) ?? '');
        if (!id) continue;
        const k = breakdownKey(by, r);
        const key = `${id}|${k.key}`;
        const cur = out.get(key) ?? { id, key: k.key, label: k.label, currency: x.a.currency, metrics: zero() };
        cur.metrics = addMetrics(cur.metrics, metricsOf(r));
        out.set(key, cur);
      }
    } catch (err) { errors.push(`${x.a.name}: ${(err as Error).message}`); }
  }));
  const rows = [...out.values()].map((r) => ({ ...r, derived: derive(r.metrics) }))
    .sort((a, b) => (by === 'day' || by === 'week' || by === 'month' ? a.key.localeCompare(b.key) : b.metrics.spend - a.metrics.spend || a.label.localeCompare(b.label)));
  res.json({ by, rows, errors });
}));

/* ------------------------------------------------------------------ criar e mudar anúncios */

/** Conta de anúncios do painel que o perfil pode mudar (permissão ads_management). */
async function writable(req: Request, actId: unknown) {
  managerOnly(req);
  const act = String(actId ?? '');
  if (!/^act_\d{1,30}$/.test(act)) throw new AppError(400, 'Conta de anúncios inválida');
  const [row] = await db.select({ a: schema.metaAdAccounts, token: schema.metaProfiles.accessToken, scopes: schema.metaProfiles.scopes, status: schema.metaProfiles.status, profileName: schema.metaProfiles.name })
    .from(schema.metaAdAccounts).innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, req.accountId!), eq(schema.metaAdAccounts.actId, act), eq(schema.metaAdAccounts.selected, true)))
    .limit(1);
  if (!row) throw new AppError(404, 'Essa conta de anúncios não está no painel. Ligue a conta em Facebook → Perfis e contas.');
  if (row.status !== 'connected') throw new AppError(409, `O login do perfil “${row.profileName}” venceu. Reconecte em Facebook → Perfis e contas.`);
  if (!canManage(row.scopes)) {
    throw new AppError(403, `O perfil “${row.profileName}” só autorizou ler os anúncios. Em Facebook → Perfis e contas, clique em Reconectar e aceite a permissão de gerenciar anúncios (ads_management).`);
  }
  return { act, token: row.token, currency: row.a.currency, name: row.a.name, profileId: row.a.profileId };
}

/** Depois de mudar algo, o Gerenciador lê de novo da Meta (sem o cache de 5 a 10 minutos). */
async function dropManagerCache(accountId: string, profileId: string, actId: string) {
  try {
    const keys = await redis.keys(`meta:${accountId}:${profileId}:${actId}:*`);
    if (keys.length) await redis.del(...keys);
  } catch { /* sem cache */ }
}

const objectId = (id: string) => {
  if (!/^\d{6,30}$/.test(id)) throw new AppError(400, 'ID inválido');
  return id;
};

/** Pausar / ativar campanha, conjunto ou anúncio. */
metaRouter.post('/objects/:id/status', asyncHandler(async (req, res) => {
  const d = z.object({ actId: z.string(), status: z.enum(['ACTIVE', 'PAUSED']) }).parse(req.body);
  const w = await writable(req, d.actId);
  try { await setObjectStatus(objectId(req.params.id), d.status, w.token); } catch (err) { return metaFail(err); }
  await dropManagerCache(req.accountId!, w.profileId, w.act);
  emitToAccount(req.accountId!, 'meta:changed', { objectId: req.params.id });
  res.json({ ok: true, status: d.status });
}));

/** Mudar o orçamento (na moeda da conta, ex.: 50 = R$ 50,00). */
metaRouter.post('/objects/:id/budget', asyncHandler(async (req, res) => {
  const d = z.object({ actId: z.string(), kind: z.enum(['daily', 'lifetime']), amount: z.number().positive().max(10_000_000) }).parse(req.body);
  const w = await writable(req, d.actId);
  try { await setObjectBudget(objectId(req.params.id), d.kind, minorUnits(d.amount, w.currency), w.token); } catch (err) { return metaFail(err); }
  await dropManagerCache(req.accountId!, w.profileId, w.act);
  res.json({ ok: true });
}));

/** Páginas do Facebook que podem anunciar nesta conta. */
metaRouter.get('/ad-accounts/:actId/pages', asyncHandler(async (req, res) => {
  const w = await writable(req, req.params.actId);
  try { res.json({ pages: await listAdPages(w.act, w.token) }); } catch (err) { metaFail(err); }
}));

/** Busca de locais (país, estado, cidade) e de interesses para o público. */
metaRouter.get('/targeting/:kind', asyncHandler(async (req, res) => {
  const w = await writable(req, req.query.actId);
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q.length < 2) { res.json({ results: [] }); return; }
  try {
    if (req.params.kind === 'geo') res.json({ results: await searchGeo(q, w.token) });
    else if (req.params.kind === 'interests') res.json({ results: await searchInterests(q, w.token) });
    else throw new AppError(404, 'Busca desconhecida');
  } catch (err) { metaFail(err); }
}));

const geoSchema = z.object({ key: z.string().min(1).max(40), name: z.string().max(200), type: z.enum(['country', 'region', 'city']), countryCode: z.string().max(4).nullable().optional() });
const campaignSchema = z.object({
  actId: z.string(),
  name: z.string().trim().min(1, 'Dê um nome à campanha').max(200),
  status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
  budget: z.object({ kind: z.enum(['daily', 'lifetime']), amount: z.number().positive('Informe o orçamento').max(10_000_000) }),
  startTime: z.string().datetime({ offset: true }).nullable().optional(),
  endTime: z.string().datetime({ offset: true }).nullable().optional(),
  audience: z.object({
    mode: z.enum(['advantage', 'manual']),
    locations: z.array(geoSchema).max(50).default([]),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    genders: z.array(z.number().int()).max(2).default([]),
    interests: z.array(z.object({ id: z.string().max(40), name: z.string().max(200) })).max(50).default([]),
  }),
  pageId: z.string().regex(/^\d{5,30}$/, 'Escolha a Página do Facebook'),
  whatsappNumber: z.string().max(30).nullable().optional(),
  image: z.object({ name: z.string().max(120), data: z.string().min(100, 'Escolha a imagem do anúncio').max(16_000_000) }),
  ad: z.object({
    primaryText: z.string().trim().min(1, 'Escreva o texto principal').max(2000),
    headline: z.string().trim().min(1, 'Escreva o título').max(255),
    description: z.string().trim().max(255).nullable().optional(),
    greeting: z.string().trim().min(1, 'Escreva a saudação').max(300),
    prefill: z.string().trim().min(1, 'Escreva a mensagem que o cliente envia').max(300),
  }),
  flowId: z.string().uuid().nullable().optional(),
});

/** Cria uma campanha de "clique para o WhatsApp" inteira (sai pausada, a não ser que peçam ativa). */
metaRouter.post('/campaigns', asyncHandler(async (req, res) => {
  const d = campaignSchema.parse(req.body);
  const accountId = req.accountId!;
  const w = await writable(req, d.actId);
  if (d.budget.kind === 'lifetime' && !d.endTime) throw new AppError(400, 'Orçamento total precisa de data de término.', { field: 'endTime' });
  if (d.endTime && new Date(d.endTime).getTime() <= Math.max(Date.now(), d.startTime ? new Date(d.startTime).getTime() : 0) + 3600_000) {
    throw new AppError(400, 'O término precisa ser pelo menos 1 hora depois do início.', { field: 'endTime' });
  }
  if (d.flowId) {
    const [f] = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.id, d.flowId), eq(schema.flows.accountId, accountId))).limit(1);
    if (!f) throw new AppError(400, 'Fluxo não encontrado', { field: 'flowId' });
  }
  const imgName = /\.(jpe?g|png)$/i.test(d.image.name) ? d.image.name : `${d.image.name.replace(/\.[^.]*$/, '') || 'anuncio'}.jpg`;
  const b64 = d.image.data.replace(/^data:[^,]*,/, '');
  let hash: string;
  try { hash = (await uploadAdImage(w.act, imgName, b64, w.token)).hash; } catch (err) {
    if (err instanceof MetaApiError) throw new AppError(err.status, `Imagem: ${err.message}`, { step: 'Imagem' });
    throw err;
  }
  const spec: CampaignSpec = {
    actId: w.act, currency: w.currency, name: d.name, status: d.status, budget: d.budget,
    startTime: d.startTime ?? null, endTime: d.endTime ?? null,
    audience: { ...d.audience, locations: d.audience.locations.map((l) => ({ ...l, countryCode: l.countryCode ?? null })) },
    pageId: d.pageId, whatsappNumber: d.whatsappNumber ?? null,
    ad: { imageHash: hash, primaryText: d.ad.primaryText, headline: d.ad.headline, description: d.ad.description ?? null, greeting: d.ad.greeting, prefill: d.ad.prefill },
  };
  let created;
  try { created = await createCtwaCampaign(spec, w.token); } catch (err) {
    if (err instanceof StepError) throw new AppError(err.cause.status, `${err.step}: ${err.cause.message}`, { step: err.step });
    return metaFail(err);
  }
  await rememberAdCampaign(created.adId, created.campaignId);
  if (d.flowId) await linkCampaignFlow(accountId, w.act, created.campaignId, d.flowId);
  await dropManagerCache(accountId, w.profileId, w.act);
  emitToAccount(accountId, 'meta:changed', { campaignId: created.campaignId });
  res.status(201).json({ ...created, status: d.status, url: adsManagerUrl(w.act, created.campaignId) });
}));

/** Liga (ou desliga) uma campanha a um fluxo: leads dos anúncios dela começam nesse fluxo. */
metaRouter.put('/campaign-flows', asyncHandler(async (req, res) => {
  managerOnly(req);
  const d = z.object({ actId: z.string().regex(/^act_\d{1,30}$/), campaignId: z.string().regex(/^\d{6,30}$/), flowId: z.string().uuid().nullable() }).parse(req.body);
  const accountId = req.accountId!;
  const [acc] = await db.select({ id: schema.metaAdAccounts.id }).from(schema.metaAdAccounts)
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.actId, d.actId))).limit(1);
  if (!acc) throw new AppError(404, 'Conta de anúncios não encontrada');
  if (d.flowId) {
    const [f] = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.id, d.flowId), eq(schema.flows.accountId, accountId))).limit(1);
    if (!f) throw new AppError(400, 'Fluxo não encontrado');
  }
  await linkCampaignFlow(accountId, d.actId, d.campaignId, d.flowId);
  res.json({ ok: true });
}));


/* ------------------------------------------------------------------ editor (igual ao da Meta) */

/** Campanha inteira para editar: campanha, conjuntos, anúncios e criativos. */
metaRouter.get('/editor/campaigns/:id', asyncHandler(async (req, res) => {
  const w = await writable(req, req.query.actId);
  try {
    const tree = await readTree(objectId(req.params.id), w.token, w.currency);
    const [link] = await db.select({ flowId: schema.metaCampaignFlows.flowId }).from(schema.metaCampaignFlows)
      .where(and(eq(schema.metaCampaignFlows.accountId, req.accountId!), eq(schema.metaCampaignFlows.campaignId, tree.campaign.id))).limit(1);
    res.json({ ...tree, currency: w.currency, flowId: link?.flowId ?? null });
  } catch (err) { metaFail(err); }
}));

const anyObj = z.record(z.string(), z.unknown());
const pubSchema = z.object({
  actId: z.string(),
  flowId: z.string().uuid().nullable().optional(),
  tree: z.object({
    campaign: z.object({ id: z.string().regex(/^\d{6,30}$/).nullable().optional(), fields: anyObj.optional() }),
    adsets: z.array(z.object({
      key: z.string().max(60), id: z.string().regex(/^\d{6,30}$/).nullable().optional(), fields: anyObj.optional(),
      ads: z.array(z.object({ key: z.string().max(60), id: z.string().regex(/^\d{6,30}$/).nullable().optional(), fields: anyObj.optional(), creative: anyObj.nullable().optional(), creativeId: z.string().regex(/^\d{6,30}$/).nullable().optional() })).max(50),
    })).max(50),
    remove: z.array(z.string().regex(/^\d{6,30}$/)).max(100).optional(),
  }),
});

/** Publica o que foi criado ou mudado no editor. */
metaRouter.post('/editor/publish', asyncHandler(async (req, res) => {
  const d = pubSchema.parse(req.body);
  const accountId = req.accountId!;
  const w = await writable(req, d.actId);
  if (d.flowId) {
    const [f] = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.id, d.flowId), eq(schema.flows.accountId, accountId))).limit(1);
    if (!f) throw new AppError(400, 'Fluxo não encontrado', { field: 'flowId' });
  }
  let out;
  try { out = await publishTree(w.act, d.tree as PubTree, w.token, w.currency); } catch (err) {
    await dropManagerCache(accountId, w.profileId, w.act);
    if (err instanceof StepError) throw new AppError(err.cause.status, `${err.step}: ${err.cause.message}`, { step: err.step, saved: (err as StepError & { saved?: string[] }).saved ?? [] });
    return metaFail(err);
  }
  for (const [ad, camp] of out.adCampaign) await rememberAdCampaign(ad, camp);
  if (d.flowId !== undefined) await linkCampaignFlow(accountId, w.act, out.campaignId, d.flowId);
  await dropManagerCache(accountId, w.profileId, w.act);
  emitToAccount(accountId, 'meta:changed', { campaignId: out.campaignId });
  res.status(d.tree.campaign.id ? 200 : 201).json({ ...out, url: adsManagerUrl(w.act, out.campaignId) });
}));

/** Duplicar (sai pausada). */
metaRouter.post('/objects/:id/copy', asyncHandler(async (req, res) => {
  const d = z.object({ actId: z.string(), level: z.enum(['campaign', 'adset', 'ad']), deep: z.boolean().default(true) }).parse(req.body);
  const w = await writable(req, d.actId);
  let id: string;
  try { id = await copyObject(objectId(req.params.id), d.level, w.token, d.deep); } catch (err) { return metaFail(err); }
  await dropManagerCache(req.accountId!, w.profileId, w.act);
  res.status(201).json({ id });
}));

/** Excluir campanha, conjunto ou anúncio. */
metaRouter.delete('/objects/:id', asyncHandler(async (req, res) => {
  const w = await writable(req, req.query.actId);
  try { await graphAds(objectId(req.params.id), { token: w.token, method: 'DELETE' }); } catch (err) { return metaFail(err); }
  await db.delete(schema.metaCampaignFlows).where(and(eq(schema.metaCampaignFlows.accountId, req.accountId!), eq(schema.metaCampaignFlows.campaignId, req.params.id)));
  await dropManagerCache(req.accountId!, w.profileId, w.act);
  emitToAccount(req.accountId!, 'meta:changed', { objectId: req.params.id });
  res.json({ ok: true });
}));

/** Buscas do editor: pixels, públicos, idiomas, direcionamento, locais, Instagram, formulários, apps, mídia. */
metaRouter.get('/editor/lookup/:what', asyncHandler(async (req, res) => {
  const w = await writable(req, req.query.actId);
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const pageId = typeof req.query.pageId === 'string' && /^\d{5,30}$/.test(req.query.pageId) ? req.query.pageId : null;
  try {
    if (req.params.what === 'pages') { res.json({ results: await listAdPages(w.act, w.token) }); return; }
    res.json({ results: await lookup(req.params.what, w.act, w.token, q, pageId) });
  } catch (err) { metaFail(err); }
}));

/** Tamanho estimado do público. */
metaRouter.post('/editor/estimate', asyncHandler(async (req, res) => {
  const d = z.object({ actId: z.string(), targeting: anyObj, goal: z.string().max(60).optional(), promoted: anyObj.nullable().optional() }).parse(req.body);
  const w = await writable(req, d.actId);
  try { res.json(await deliveryEstimate(w.act, w.token, d.targeting, d.goal ?? 'REACH', d.promoted ?? null)); } catch (err) { metaFail(err); }
}));

/** Imagem para a biblioteca da conta. */
metaRouter.post('/editor/image', asyncHandler(async (req, res) => {
  const d = z.object({ actId: z.string(), name: z.string().max(120), data: z.string().min(100).max(16_000_000) }).parse(req.body);
  const w = await writable(req, d.actId);
  const name = /\.(jpe?g|png)$/i.test(d.name) ? d.name : `${d.name.replace(/\.[^.]*$/, '') || 'anuncio'}.jpg`;
  try { res.json(await uploadAdImage(w.act, name, d.data.replace(/^data:[^,]*,/, ''), w.token)); } catch (err) { metaFail(err); }
}));

/** Vídeo para a biblioteca da conta (o corpo é o arquivo). */
metaRouter.post('/editor/video', asyncHandler(async (req, res) => {
  const w = await writable(req, req.header('x-act-id'));
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length < 1000) throw new AppError(400, 'Escolha o arquivo de vídeo');
  const name = decodeURIComponent(String(req.header('x-file-name') ?? 'video.mp4')).slice(0, 120);
  try { res.status(201).json({ id: await uploadAdVideo(w.act, name, body, String(req.header('content-type') ?? 'video/mp4'), w.token) }); } catch (err) { metaFail(err); }
}));

metaRouter.get('/editor/video/:id', asyncHandler(async (req, res) => {
  const w = await writable(req, req.query.actId);
  try { res.json(await videoState(objectId(req.params.id), w.token)); } catch (err) { metaFail(err); }
}));
