import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { redis } from '../redis';
import { emitToAccount } from '../realtime/io';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import {
  debugUserToken, exchangeAdsCode, extendUserToken, fetchAdAccounts, fetchEntities, fetchInsights, fetchMe, MetaApiError,
  type InsightRow, type Level, type RemoteAdAccount, type RemoteEntity,
} from '../meta/graphAds';
import { accountStatusLabel, buildRows, dailySeries, totalsByCurrency, type Attribution, type EntityIn } from '../meta/insights';
import { addDays, dropAdAccountSpend, markProfileProblem, syncAdAccountSpend, todayIn } from '../meta/adsSync';
import { PERIODS, periodDates, validTz, type Period } from './dashboard';

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
    tokenExpiresAt: p.tokenExpiresAt, createdAt: p.createdAt, updatedAt: p.updatedAt,
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

  const selected = await db.select({ a: schema.metaAdAccounts, profileName: schema.metaProfiles.name, profileStatus: schema.metaProfiles.status, token: schema.metaProfiles.accessToken })
    .from(schema.metaAdAccounts)
    .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.selected, true)))
    .orderBy(asc(schema.metaAdAccounts.name));
  const accounts = selected.map((s) => ({ id: s.a.id, actId: s.a.actId, name: s.a.name, currency: s.a.currency, profileName: s.profileName, profileStatus: s.profileStatus, lastSyncAt: s.a.lastSyncAt }));
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
  res.json({
    level, period, from: d0, to: d1, days, accounts,
    rows: rows.slice(0, 500), total: rows.length,
    totals: totalsByCurrency(rows), daily: dailySeries(daily, days),
    errors, updatedAt: new Date(oldest).toISOString(), unmatched,
  });
}));
