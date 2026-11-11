import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';

export const dashboardRouter = Router();

/* ------------------------------------------------------------------ período */

export const PERIODS = ['today', 'yesterday', '7d', '30d', 'month', 'last_month', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export interface Range {
  tz: string; period: Period; bucket: 'hour' | 'day'; days: number;
  d0: string; d1: string; prevD0: string; prevD1: string;
  start: Date; end: Date; prevStart: Date; prevEnd: Date;
}

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function validTz(tz: string | null | undefined): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz ?? '' }); return tz as string; } catch { return 'America/Sao_Paulo'; }
}
const todayIn = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Converte o período escolhido em datas/horários no fuso da conta, mais o período anterior equivalente. */
export function periodDates(period: Period, today: string, from?: unknown, to?: unknown) {
  let d0: string; let d1: string;
  switch (period) {
    case 'yesterday': d0 = d1 = addDays(today, -1); break;
    case '7d': d0 = addDays(today, -6); d1 = today; break;
    case '30d': d0 = addDays(today, -29); d1 = today; break;
    case 'month': d0 = `${today.slice(0, 8)}01`; d1 = today; break;
    case 'last_month': { const first = `${today.slice(0, 8)}01`; d1 = addDays(first, -1); d0 = `${d1.slice(0, 8)}01`; break; }
    case 'custom': {
      if (!isDate(from) || !isDate(to)) throw new AppError(400, 'Informe as datas do período (de/até)');
      [d0, d1] = from <= to ? [from, to] : [to, from];
      if (diffDays(d0, d1) > 366) throw new AppError(400, 'O período pode ter no máximo 1 ano');
      break;
    }
    default: d0 = d1 = today;
  }
  const days = diffDays(d0, d1) + 1;
  return { d0, d1, days, prevD0: addDays(d0, -days), prevD1: addDays(d1, -days) };
}

async function accountInfo(accountId: string) {
  const [acc] = await db.select({ tz: schema.accounts.timezone, settings: schema.accounts.settings, name: schema.accounts.name })
    .from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  if (!acc) throw new AppError(404, 'Conta não encontrada');
  return { tz: validTz(acc.tz), settings: (acc.settings ?? {}) as Record<string, any>, name: acc.name };
}

async function resolveRange(accountId: string, q: Request['query']): Promise<Range & { account: Awaited<ReturnType<typeof accountInfo>> }> {
  const account = await accountInfo(accountId);
  const tz = account.tz;
  const period = (PERIODS as readonly string[]).includes(String(q.period)) ? (q.period as Period) : 'today';
  const p = periodDates(period, todayIn(tz), q.from, q.to);
  const r = (await db.execute(sql`select
      (${p.d0}::date::timestamp at time zone ${tz}) as s,
      (${addDays(p.d1, 1)}::date::timestamp at time zone ${tz}) as e,
      (${p.prevD0}::date::timestamp at time zone ${tz}) as ps,
      (${addDays(p.prevD1, 1)}::date::timestamp at time zone ${tz}) as pe`)).rows[0] as Record<string, Date>;
  const now = Date.now();
  const end = new Date(Math.min(new Date(r.e).getTime(), now));
  const shift = p.days * 86400000;
  return {
    account, tz, period, ...p,
    bucket: p.days <= 2 ? 'hour' : 'day',
    start: new Date(r.s), end,
    prevStart: new Date(r.ps),
    // período anterior "até o mesmo ponto" (ex.: hoje até agora × ontem até a mesma hora)
    prevEnd: new Date(Math.min(new Date(r.pe).getTime(), end.getTime() - shift)),
  };
}

/* ------------------------------------------------------------------ filtros */

interface Filters { connectionId: string | null; productId: string | null; currency: string; }

function parseFilters(q: Request['query']): Filters {
  const c = String(q.connectionId ?? '');
  const p = String(q.productId ?? '');
  const cur = String(q.currency ?? 'BRL').toUpperCase();
  return { connectionId: isUuid(c) ? c : null, productId: isUuid(p) ? p : null, currency: /^[A-Z]{3}$/.test(cur) ? cur : 'BRL' };
}

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
const n = (v: unknown) => Number(v ?? 0) || 0;

function salesWhere(accountId: string, f: Filters, start: Date, end: Date): SQL {
  const parts: SQL[] = [
    sql`s.account_id = ${accountId}`, sql`s.created_at >= ${start}`, sql`s.created_at < ${end}`, sql`s.currency = ${f.currency}`,
  ];
  if (f.connectionId) parts.push(sql`s.connection_id = ${f.connectionId}`);
  if (f.productId) parts.push(sql`s.product_id = ${f.productId}`);
  return sql.join(parts, sql` and `);
}

function leadsWhere(accountId: string, f: Filters, start: Date, end: Date): SQL {
  const parts: SQL[] = [sql`c.account_id = ${accountId}`, sql`c.created_at >= ${start}`, sql`c.created_at < ${end}`];
  if (f.connectionId) parts.push(sql`c.first_connection_id = ${f.connectionId}`);
  return sql.join(parts, sql` and `);
}

export interface ProfitSettings { gatewayFeePercent: number; taxPercent: number; }
export function profitSettings(settings: Record<string, any>): ProfitSettings {
  const d = settings?.dashboard ?? {};
  const pct = (v: unknown) => Math.min(100, Math.max(0, Number(v) || 0));
  return { gatewayFeePercent: pct(d.gatewayFeePercent), taxPercent: pct(d.taxPercent) };
}

/** Fórmulas dos indicadores (também usadas nos testes). */
export function computeKpis(raw: { revenue: number; sales: number; cost: number; leads: number; adSpend: number }, ps: ProfitSettings) {
  const fees = raw.revenue * (ps.gatewayFeePercent + ps.taxPercent) / 100;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    leads: raw.leads,
    revenue: r2(raw.revenue),
    sales: raw.sales,
    adSpend: r2(raw.adSpend),
    roas: raw.adSpend > 0 ? r2(raw.revenue / raw.adSpend) : 0,
    conversion: raw.leads > 0 ? r2((raw.sales / raw.leads) * 100) : 0,
    ticket: raw.sales > 0 ? r2(raw.revenue / raw.sales) : 0,
    cost: r2(raw.cost),
    fees: r2(fees),
    profit: r2(raw.revenue - raw.cost - fees - raw.adSpend),
  };
}

async function salesKpis(accountId: string, f: Filters, start: Date, end: Date, d0: string, d1: string, ps: ProfitSettings) {
  const [a] = await rows(sql`select
      coalesce(sum(s.amount) filter (where s.status = 'approved'), 0) as revenue,
      count(*) filter (where s.status = 'approved') as sales,
      coalesce(sum(s.cost) filter (where s.status = 'approved'), 0) as cost
    from sales s where ${salesWhere(accountId, f, start, end)}`);
  const [l] = await rows(sql`select count(*) as n from contacts c where ${leadsWhere(accountId, f, start, end)}`);
  const [ad] = await rows(sql`select coalesce(sum(amount), 0) as spend from ad_spend
    where account_id = ${accountId} and date between ${d0}::date and ${d1}::date and currency = ${f.currency}`);
  return computeKpis({ revenue: n(a?.revenue), sales: n(a?.sales), cost: n(a?.cost), leads: n(l?.n), adSpend: n(ad?.spend) }, ps);
}

/** Lista de "baldes" do gráfico temporal (horas do dia ou dias). */
export function buckets(d0: string, d1: string, bucket: 'hour' | 'day') {
  const out: { key: string; label: string }[] = [];
  for (let d = d0; d <= d1; d = addDays(d, 1)) {
    const dm = `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    if (bucket === 'day') out.push({ key: d, label: dm });
    else for (let h = 0; h < 24; h++) { const hh = String(h).padStart(2, '0'); out.push({ key: `${d} ${hh}`, label: `${dm}, ${hh}h` }); }
  }
  return out;
}

/* --------------------------------------------------------------- vendas */

dashboardRouter.get('/sales', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const r = await resolveRange(accountId, req.query);
  const f = parseFilters(req.query);
  const ps = profitSettings(r.account.settings);
  const w = salesWhere(accountId, f, r.start, r.end);
  const fmt = r.bucket === 'hour' ? 'YYYY-MM-DD HH24' : 'YYYY-MM-DD';

  const [current, previous, series, byHour, byConnection, byState, byProduct, totals, currencies] = await Promise.all([
    salesKpis(accountId, f, r.start, r.end, r.d0, r.d1, ps),
    salesKpis(accountId, f, r.prevStart, r.prevEnd, r.prevD0, r.prevD1, ps),
    rows(sql`select to_char(date_trunc(${r.bucket}, s.created_at at time zone ${r.tz}), ${fmt}) as k,
        coalesce(sum(s.amount), 0) as revenue, count(*) as count
      from sales s where ${w} and s.status = 'approved' group by 1`),
    rows(sql`select extract(hour from s.created_at at time zone ${r.tz})::int as h,
        coalesce(sum(s.amount), 0) as revenue, count(*) as count
      from sales s where ${w} and s.status = 'approved' group by 1`),
    rows(sql`select s.connection_id as id, coalesce(cn.name, 'Sem conexão') as name, cn.display_phone as phone,
        count(*) as count, coalesce(sum(s.amount), 0) as revenue
      from sales s left join connections cn on cn.id = s.connection_id
      where ${w} and s.status = 'approved' group by 1, 2, 3 order by revenue desc`),
    rows(sql`select coalesce(s.state, '') as state, count(*) as count, coalesce(sum(s.amount), 0) as revenue
      from sales s where ${w} and s.status = 'approved' group by 1 order by count desc, revenue desc`),
    rows(sql`select coalesce(s.product_id::text, 'nome:' || coalesce(s.product_name, '')) as id,
        coalesce(p.name, s.product_name, 'Sem produto') as name, count(*) as count, coalesce(sum(s.amount), 0) as revenue
      from sales s left join products p on p.id = s.product_id
      where ${w} and s.status = 'approved' group by 1, 2 order by revenue desc`),
    rows(sql`select count(*) as leads from contacts where account_id = ${accountId}`),
    rows(sql`select distinct currency from sales where account_id = ${accountId}`),
  ]);

  // contas de anúncios do painel: período com hoje → busca o gasto na Meta agora (sem esperar a rodada de hora em hora)
  const adAccs = await db.select({
    id: schema.metaAdAccounts.id, name: schema.metaAdAccounts.name, currency: schema.metaAdAccounts.currency,
    lastSyncAt: schema.metaAdAccounts.lastSyncAt, lastError: schema.metaAdAccounts.lastError, profileStatus: schema.metaProfiles.status,
  }).from(schema.metaAdAccounts)
    .innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, accountId), eq(schema.metaAdAccounts.selected, true)));
  if (r.d1 >= todayIn(r.tz)) {
    for (const a of adAccs) {
      if (a.profileStatus !== 'connected') continue;
      if (a.lastSyncAt && Date.now() - a.lastSyncAt.getTime() < 10 * 60_000 && !a.lastError) continue;
      void import('../meta/adsSync').then((m) => m.syncAdAccountSpend(a.id, 3)).catch(() => undefined); // termina e avisa a tela (sale:changed)
    }
  }

  const byKey = new Map(series.map((x) => [String(x.k), x]));
  const hours = new Map(byHour.map((x) => [n(x.h), x]));
  res.json({
    range: {
      period: r.period, from: r.d0, to: r.d1, days: r.days, bucket: r.bucket, tz: r.tz,
      previous: { from: r.prevD0, to: r.prevD1 },
    },
    header: { accountName: r.account.name, totalLeads: n(totals[0]?.leads) },
    kpis: current,
    previous,
    profitSettings: ps,
    series: {
      period: buckets(r.d0, r.d1, r.bucket).map((b) => ({ ...b, revenue: n(byKey.get(b.key)?.revenue), count: n(byKey.get(b.key)?.count) })),
      byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, revenue: n(hours.get(h)?.revenue), count: n(hours.get(h)?.count) })),
    },
    byConnection: byConnection.map((x) => ({ id: x.id, name: x.name, phone: x.phone, count: n(x.count), revenue: n(x.revenue) })),
    byState: byState.map((x) => ({ state: x.state || null, count: n(x.count), revenue: n(x.revenue) })),
    byProduct: byProduct.map((x) => ({ id: String(x.id), name: x.name, count: n(x.count), revenue: n(x.revenue) })),
    currencies: [...new Set(['BRL', ...currencies.map((c) => String(c.currency))])],
    adAccounts: adAccs.map((a) => ({
      name: a.name, currency: a.currency, lastSyncAt: a.lastSyncAt,
      error: a.profileStatus !== 'connected' ? 'O login do perfil do Facebook venceu. Reconecte em Facebook → Perfis e contas.' : a.lastError,
    })),
  });
}));

/* -------------------------------------------------------- histórico de vendas */

const STATUSES = ['pending', 'approved', 'refused', 'refunded'] as const;

function listQuery(accountId: string, r: Range, f: Filters, status: string | null) {
  const where = sql.join([
    salesWhere(accountId, f, r.start, r.end),
    ...(status ? [sql`s.status = ${status}`] : []),
  ], sql` and `);
  return {
    where,
    select: sql`select s.id, to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "createdAt", s.status, s.amount, s.currency, s.external_id as "externalId",
        s.source_id as "sourceId", s.state, s.origin, s.notes, s.invoice_number as "invoiceNumber", s.invoice_url as "invoiceUrl",
        to_char(s.invoice_issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "invoiceIssuedAt", s.product_id as "productId", s.contact_id as "contactId", s.connection_id as "connectionId",
        coalesce(p.name, s.product_name) as "productName", coalesce(ct.name, s.customer_name) as "customerName",
        coalesce(s.customer_phone, ct.phone) as "customerPhone", cn.name as "connectionName", cn.display_phone as "connectionPhone",
        to_char(s.created_at at time zone ${r.tz}, 'DD/MM/YYYY HH24:MI') as "dateLabel"
      from sales s
      left join products p on p.id = s.product_id
      left join contacts ct on ct.id = s.contact_id
      left join connections cn on cn.id = s.connection_id
      where ${where}`,
  };
}

dashboardRouter.get('/sales/list', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const r = await resolveRange(accountId, req.query);
  const f = parseFilters(req.query);
  const status = (STATUSES as readonly string[]).includes(String(req.query.status)) ? String(req.query.status) : null;
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(100, Math.max(5, Math.floor(Number(req.query.pageSize) || 20)));
  const q = listQuery(accountId, r, f, status);
  const [list, [{ total }]] = await Promise.all([
    rows(sql`${q.select} order by s.created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`),
    rows<{ total: string }>(sql`select count(*) as total from sales s where ${q.where}`),
  ]);
  res.json({ rows: list.map((x) => ({ ...x, amount: n(x.amount) })), total: n(total), page, pageSize });
}));

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], data: unknown[][]) =>
  '﻿' + [header, ...data].map((r) => r.map(csvCell).join(';')).join('\r\n');

const STATUS_PT: Record<string, string> = { pending: 'Pendente', approved: 'Aprovada', refused: 'Recusada', refunded: 'Reembolsada' };

dashboardRouter.get('/sales/export.csv', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const r = await resolveRange(accountId, req.query);
  const f = parseFilters(req.query);
  const status = (STATUSES as readonly string[]).includes(String(req.query.status)) ? String(req.query.status) : null;
  const q = listQuery(accountId, r, f, status);
  const list = await rows(sql`${q.select} order by s.created_at desc limit 50000`);
  const csv = toCsv(
    ['Data', 'Instância', 'Nº da instância', 'Nº do lead', 'Cliente', 'Produto', 'ID', 'Valor', 'Moeda', 'Status', 'Source ID', 'Estado', 'Nota fiscal', 'Origem'],
    list.map((x) => [
      x.dateLabel, x.connectionName ?? '', x.connectionPhone ?? '', x.customerPhone ?? '', x.customerName ?? '', x.productName ?? '',
      x.externalId ?? x.id, n(x.amount).toFixed(2).replace('.', ','), x.currency, STATUS_PT[x.status] ?? x.status,
      x.sourceId ?? '', x.state ?? '', x.invoiceNumber ?? '', x.origin,
    ]),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vendas_${r.d0}_a_${r.d1}.csv"`);
  res.send(csv);
}));

/* --------------------------------------------------------------- atendimento */

function convWhere(accountId: string, f: Filters, start: Date, end: Date): SQL {
  const parts: SQL[] = [sql`v.account_id = ${accountId}`, sql`v.created_at >= ${start}`, sql`v.created_at < ${end}`];
  if (f.connectionId) parts.push(sql`v.connection_id = ${f.connectionId}`);
  return sql.join(parts, sql` and `);
}
function msgWhere(accountId: string, f: Filters, start: Date, end: Date): SQL {
  const parts: SQL[] = [sql`m.account_id = ${accountId}`, sql`m.created_at >= ${start}`, sql`m.created_at < ${end}`];
  if (f.connectionId) parts.push(sql`v.connection_id = ${f.connectionId}`);
  return sql.join(parts, sql` and `);
}

async function attendanceKpis(accountId: string, f: Filters, start: Date, end: Date) {
  const [c] = await rows(sql`select count(*) as n from conversations v where ${convWhere(accountId, f, start, end)}`);
  const [l] = await rows(sql`select count(*) as n from contacts c where ${leadsWhere(accountId, f, start, end)}`);
  const [m] = await rows(sql`select
      count(*) filter (where m.direction = 'in') as inbound,
      count(*) filter (where m.direction = 'out') as outbound,
      count(*) filter (where m.direction = 'out' and m.sender_user_id is null) as auto,
      count(*) filter (where m.direction = 'out' and m.sender_user_id is not null) as human
    from messages m join conversations v on v.id = m.conversation_id where ${msgWhere(accountId, f, start, end)}`);
  const [fr] = await rows(sql`select avg(extract(epoch from (fo.created_at - fi.created_at))) as secs,
      avg(extract(epoch from (fh.created_at - fi.created_at))) as human_secs
    from conversations v
    join lateral (select created_at from messages where conversation_id = v.id and direction = 'in' order by created_at limit 1) fi on true
    left join lateral (select created_at from messages where conversation_id = v.id and direction = 'out' and created_at >= fi.created_at order by created_at limit 1) fo on true
    left join lateral (select created_at from messages where conversation_id = v.id and direction = 'out' and sender_user_id is not null and created_at >= fi.created_at order by created_at limit 1) fh on true
    where ${convWhere(accountId, f, start, end)}`);
  const [fl] = await rows(sql`select count(*) as n from flow_runs
    where account_id = ${accountId} and status = 'done' and finished_at >= ${start} and finished_at < ${end}`);
  return {
    conversations: n(c?.n), leads: n(l?.n), inbound: n(m?.inbound), outbound: n(m?.outbound),
    outboundAuto: n(m?.auto), outboundHuman: n(m?.human),
    firstResponseSec: fr?.secs == null ? null : Math.round(n(fr.secs)),
    firstHumanResponseSec: fr?.human_secs == null ? null : Math.round(n(fr.human_secs)),
    flowsDone: n(fl?.n),
  };
}

dashboardRouter.get('/attendance', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const r = await resolveRange(accountId, req.query);
  const f = parseFilters(req.query);
  const fmt = r.bucket === 'hour' ? 'YYYY-MM-DD HH24' : 'YYYY-MM-DD';
  const mw = msgWhere(accountId, f, r.start, r.end);
  const queueParts: SQL[] = [sql`v.account_id = ${accountId}`, sql`v.bot_paused = true`, sql`v.status <> 'resolved'`];
  if (f.connectionId) queueParts.push(sql`v.connection_id = ${f.connectionId}`);
  const funnelParts: SQL[] = [sql`c.account_id = ${accountId}`];
  if (f.connectionId) funnelParts.push(sql`c.first_connection_id = ${f.connectionId}`);

  const [current, previous, series, byHour, byConnection, byAgent, funnel, topFlows, [queue], [sources]] = await Promise.all([
    attendanceKpis(accountId, f, r.start, r.end),
    attendanceKpis(accountId, f, r.prevStart, r.prevEnd),
    rows(sql`select to_char(date_trunc(${r.bucket}, m.created_at at time zone ${r.tz}), ${fmt}) as k,
        count(*) filter (where m.direction = 'in') as inbound, count(*) filter (where m.direction = 'out') as outbound
      from messages m join conversations v on v.id = m.conversation_id where ${mw} group by 1`),
    rows(sql`select extract(hour from m.created_at at time zone ${r.tz})::int as h, count(*) as count
      from messages m join conversations v on v.id = m.conversation_id where ${mw} and m.direction = 'in' group by 1`),
    rows(sql`select v.connection_id as id, coalesce(cn.name, 'Sem conexão') as name, cn.display_phone as phone,
        count(distinct v.id) as conversations, count(*) as messages
      from messages m join conversations v on v.id = m.conversation_id left join connections cn on cn.id = v.connection_id
      where ${mw} group by 1, 2, 3 order by messages desc`),
    rows(sql`select m.sender_user_id as id, coalesce(u.name, 'Usuário removido') as name, count(*) as messages,
        count(distinct m.conversation_id) as conversations
      from messages m join conversations v on v.id = m.conversation_id left join users u on u.id = m.sender_user_id
      where ${mw} and m.direction = 'out' and m.sender_user_id is not null group by 1, 2 order by messages desc limit 10`),
    rows(sql`select c.stage, count(*) as count from contacts c where ${sql.join(funnelParts, sql` and `)} group by 1`),
    rows(sql`select f.id, f.name, count(*) as started, count(*) filter (where fr.status = 'done') as done
      from flow_runs fr join flows f on f.id = fr.flow_id
      where fr.account_id = ${accountId} and fr.started_at >= ${r.start} and fr.started_at < ${r.end}
      group by 1, 2 order by started desc limit 8`),
    rows(sql`select count(*) as n from conversations v where ${sql.join(queueParts, sql` and `)}`),
    rows(sql`select count(*) filter (where c.source_id is not null) as ads, count(*) filter (where c.source_id is null) as organic
      from contacts c where ${leadsWhere(accountId, f, r.start, r.end)}`),
  ]);

  const byKey = new Map(series.map((x) => [String(x.k), x]));
  const hours = new Map(byHour.map((x) => [n(x.h), x]));
  const stages = new Map(funnel.map((x) => [String(x.stage), n(x.count)]));
  res.json({
    range: { period: r.period, from: r.d0, to: r.d1, days: r.days, bucket: r.bucket, tz: r.tz, previous: { from: r.prevD0, to: r.prevD1 } },
    kpis: { ...current, humanQueue: n(queue?.n) },
    previous,
    series: {
      period: buckets(r.d0, r.d1, r.bucket).map((b) => ({ ...b, inbound: n(byKey.get(b.key)?.inbound), outbound: n(byKey.get(b.key)?.outbound) })),
      byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: n(hours.get(h)?.count) })),
    },
    byConnection: byConnection.map((x) => ({ id: x.id, name: x.name, phone: x.phone, conversations: n(x.conversations), messages: n(x.messages) })),
    byAgent: byAgent.map((x) => ({ id: x.id, name: x.name, messages: n(x.messages), conversations: n(x.conversations) })),
    funnel: ['new', 'in_service', 'negotiating', 'won', 'lost'].map((s) => ({ stage: s, count: stages.get(s) ?? 0 })),
    topFlows: topFlows.map((x) => ({ id: x.id, name: x.name, started: n(x.started), done: n(x.done) })),
    leadSources: { ads: n(sources?.ads), organic: n(sources?.organic) },
  });
}));

/* ------------------------------------------------------------------ ajustes */

dashboardRouter.get('/settings', asyncHandler(async (req, res) => {
  const acc = await accountInfo(req.accountId!);
  res.json({ settings: profitSettings(acc.settings) });
}));

dashboardRouter.put('/settings', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores alteram os ajustes');
  const data = z.object({
    gatewayFeePercent: z.number().min(0).max(100),
    taxPercent: z.number().min(0).max(100),
  }).parse(req.body);
  await db.update(schema.accounts)
    .set({ settings: sql`jsonb_set(coalesce(${schema.accounts.settings}, '{}'::jsonb), '{dashboard}', ${JSON.stringify(data)}::jsonb)` })
    .where(eq(schema.accounts.id, req.accountId!));
  res.json({ settings: data });
}));

/* --------------------------------------------------------- trilha de conquistas */

export const LEVELS = [
  { key: 'primeira', label: 'Primeira venda', target: 0, minSales: 1 },
  { key: 'decolando', label: 'Decolando', target: 10_000 },
  { key: 'ritmo', label: 'Em ritmo', target: 50_000 },
  { key: 'seis', label: 'Seis dígitos', target: 100_000 },
  { key: 'meio', label: 'Meio milhão', target: 500_000 },
  { key: 'milhao', label: 'Milhão', target: 1_000_000 },
  { key: 'escala', label: 'Escala', target: 5_000_000 },
  { key: 'lenda', label: 'Lenda', target: 10_000_000 },
];

dashboardRouter.get('/achievements', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [[sale], [conn], [flow], [agent], [hook], [prod], [team]] = await Promise.all([
    rows(sql`select coalesce(sum(amount), 0) as revenue, count(*) as sales from sales where account_id = ${accountId} and status = 'approved' and currency = 'BRL'`),
    rows(sql`select count(*) as n from connections where account_id = ${accountId} and status = 'connected'`),
    rows(sql`select count(*) as n from flows where account_id = ${accountId} and status = 'active' and archived_at is null`),
    rows(sql`select count(*) as n from agents where account_id = ${accountId} and enabled = true`),
    rows(sql`select count(*) as n from webhooks where account_id = ${accountId}`),
    rows(sql`select count(*) as n from products where account_id = ${accountId} and checkout_url is not null`),
    rows(sql`select count(*) as n from memberships where account_id = ${accountId}`),
  ]);
  const revenue = n(sale?.revenue);
  const salesCount = n(sale?.sales);
  const levels = LEVELS.map((l) => ({ ...l, reached: l.minSales ? salesCount >= l.minSales : revenue >= l.target }));
  const next = levels.find((l) => !l.reached) ?? null;
  const prev = [...levels].reverse().find((l) => l.reached);
  const base = prev?.target ?? 0;
  res.json({
    revenue, sales: salesCount,
    level: prev ? { key: prev.key, label: prev.label } : null,
    next: next ? { key: next.key, label: next.label, target: next.target,
      progress: next.minSales ? 0 : Math.min(100, Math.round(((revenue - base) / Math.max(1, next.target - base)) * 100)) } : null,
    levels: levels.map(({ minSales: _m, ...l }) => l),
    steps: [
      { key: 'whatsapp', label: 'Conectar um número de WhatsApp', done: n(conn?.n) > 0, route: '/connections' },
      { key: 'flow', label: 'Ativar um fluxo de atendimento', done: n(flow?.n) > 0, route: '/flows' },
      { key: 'agent', label: 'Ligar um agente de IA', done: n(agent?.n) > 0, route: '/agents' },
      { key: 'product', label: 'Cadastrar um produto com link de pagamento', done: n(prod?.n) > 0, route: '/settings?aba=produtos' },
      { key: 'webhook', label: 'Receber vendas por webhook', done: n(hook?.n) > 0, route: '/webhooks' },
      { key: 'sale', label: 'Registrar a primeira venda', done: salesCount > 0, route: '/' },
      { key: 'team', label: 'Convidar alguém da equipe', done: n(team?.n) > 1, route: '/settings?aba=equipe' },
    ],
  });
}));
