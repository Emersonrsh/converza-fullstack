/**
 * Painel do dia: gasto × faturamento × lucro de hoje, por produto, para quem abre o Converza várias vezes ao dia.
 *
 * O gasto vem da Meta por campanha (hoje, no fuso da conta) e entra no produto da campanha:
 *  1. o produto escolhido para a campanha (meta_campaign_products);
 *  2. senão, o produto que a campanha mais vendeu nos últimos 30 dias (vendas com o ID do anúncio);
 *  3. senão, fica em "Gasto sem produto".
 * Faturamento, custo e taxas vêm de todas as vendas aprovadas de hoje (do anúncio ou não).
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { addDays, todayIn } from '../meta/adsSync';
import { validTz } from './dashboard';
import { loadManagerRows } from './meta';
import { adIdsOf, parseActIds } from '../meta/adIndex';

export const adsTodayRouter = Router();

const r2 = (x: number) => Math.round(x * 100) / 100;
const n = (v: unknown) => Number(v ?? 0) || 0;

export interface TodayLine {
  id: string; name: string; sales: number; revenue: number; cost: number; fees: number; spend: number; adSales: number;
  profit: number; roas: number; cpa: number; margin: number;
}
export function lineOf(id: string, name: string, x: { sales: number; revenue: number; cost: number; spend: number; adSales: number }, feePct: number): TodayLine {
  const fees = r2(x.revenue * feePct / 100);
  const profit = r2(x.revenue - x.cost - fees - x.spend);
  return {
    id, name, sales: x.sales, revenue: r2(x.revenue), cost: r2(x.cost), fees, spend: r2(x.spend), adSales: x.adSales, profit,
    roas: x.spend > 0 ? r2(x.revenue / x.spend) : 0, cpa: x.sales > 0 && x.spend > 0 ? r2(x.spend / x.sales) : 0,
    margin: x.revenue > 0 ? r2((profit / x.revenue) * 100) : 0,
  };
}

adsTodayRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const currency = typeof req.query.currency === 'string' && /^[A-Z]{3}$/.test(req.query.currency) ? req.query.currency : 'BRL';
  const fresh = req.query.fresh === '1';
  const acts = parseActIds(req.query.adAccounts);
  const adIds = acts.length ? await adIdsOf(accountId, acts) : [];
  const anyAd = sql`array[${sql.join(adIds.length ? adIds.map((i) => sql`${i}`) : [sql`''`], sql`, `)}]::text[]`;
  const onlyAds = acts.length ? sql`and s.source_id = any(${anyAd})` : sql``;
  const [acc] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const tz = validTz(acc?.tz);
  const today = todayIn(tz);

  // gasto e vendas atribuídas de hoje, por campanha (cache curto: o painel é "ao vivo")
  const m = await loadManagerRows({ accountId, level: 'campaign', d0: today, d1: today, tz, fresh, ttl: 90, acts });
  const camps = m.rows.filter((r) => r.currency === currency);

  const r = (await db.execute(sql`select (${today}::date::timestamp at time zone ${tz}) as s, (${addDays(today, 1)}::date::timestamp at time zone ${tz}) as e,
    (${addDays(today, -30)}::date::timestamp at time zone ${tz}) as m30`)).rows[0] as { s: Date; e: Date; m30: Date };

  const [sales, recent, links, products, adSales30] = await Promise.all([
    db.execute(sql`select coalesce(s.product_id::text, 'nome:' || coalesce(s.product_name, '')) as id,
        coalesce(p.name, s.product_name, 'Sem produto') as name, count(*)::int as n,
        coalesce(sum(s.amount), 0)::float as revenue, coalesce(sum(s.cost), 0)::float as cost,
        count(*) filter (where s.source_id is not null)::int as ad_sales
      from sales s left join products p on p.id = s.product_id
      where s.account_id = ${accountId} and s.status = 'approved' and s.currency = ${currency} and s.created_at >= ${r.s} and s.created_at < ${r.e} ${onlyAds}
      group by 1, 2`),
    db.execute(sql`select s.id, s.amount::float as amount, s.created_at as at, coalesce(p.name, s.product_name, 'Sem produto') as product,
        s.customer_name as customer, s.source_id as ad
      from sales s left join products p on p.id = s.product_id
      where s.account_id = ${accountId} and s.status = 'approved' and s.currency = ${currency} and s.created_at >= ${r.s} and s.created_at < ${r.e} ${onlyAds}
      order by s.created_at desc limit 8`),
    db.select({ campaignId: schema.metaCampaignProducts.campaignId, productId: schema.metaCampaignProducts.productId })
      .from(schema.metaCampaignProducts).where(eq(schema.metaCampaignProducts.accountId, accountId)),
    db.select({ id: schema.products.id, name: schema.products.name }).from(schema.products).where(eq(schema.products.accountId, accountId)),
    db.execute(sql`select source_id as ad, product_id::text as product, count(*)::int as n from sales
      where account_id = ${accountId} and status = 'approved' and source_id is not null and product_id is not null and created_at >= ${r.m30}
      group by 1, 2`),
  ]);

  // produto de cada campanha: escolhido > o que ela mais vendeu em 30 dias
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const campOfAd = new Map(m.ads.map((a) => [a.id, a.campaign_id ?? '']));
  const votes = new Map<string, Map<string, number>>();
  for (const x of adSales30.rows as { ad: string; product: string; n: number }[]) {
    const c = campOfAd.get(x.ad);
    if (!c) continue;
    const v = votes.get(c) ?? new Map<string, number>();
    v.set(x.product, (v.get(x.product) ?? 0) + Number(x.n));
    votes.set(c, v);
  }
  const linked = new Map(links.map((l) => [l.campaignId, l.productId]));
  const productOf = (campaignId: string): { id: string; source: 'manual' | 'auto' } | null => {
    const p = linked.get(campaignId);
    if (p && productName.has(p)) return { id: p, source: 'manual' };
    const v = votes.get(campaignId);
    if (!v) return null;
    const best = [...v.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && productName.has(best[0]) ? { id: best[0], source: 'auto' } : null;
  };

  const acc2 = new Map<string, { name: string; sales: number; revenue: number; cost: number; spend: number; adSales: number }>();
  const slot = (id: string, name: string) => { const x = acc2.get(id) ?? { name, sales: 0, revenue: 0, cost: 0, spend: 0, adSales: 0 }; acc2.set(id, x); return x; };
  for (const s of sales.rows as { id: string; name: string; n: number; revenue: number; cost: number; ad_sales: number }[]) {
    const x = slot(String(s.id), String(s.name));
    x.sales += n(s.n); x.revenue += n(s.revenue); x.cost += n(s.cost); x.adSales += n(s.ad_sales);
  }
  const campaigns = camps.map((c) => {
    const p = productOf(c.id);
    if (c.metrics.spend > 0) {
      const x = p ? slot(p.id, productName.get(p.id)!) : slot('sem-produto', 'Gasto sem produto definido');
      x.spend += c.metrics.spend;
    }
    return {
      id: c.id, name: c.name, actId: c.actId, accountName: c.accountName, status: c.status, budget: c.budget,
      spend: r2(c.metrics.spend), conversations: c.metrics.conversations, sales: c.converza.sales, revenue: c.converza.revenue,
      profit: c.converza.profit, roas: c.converza.roas, cpa: c.converza.cpa,
      product: p ? { id: p.id, name: productName.get(p.id)!, source: p.source } : null,
    };
  }).filter((c) => c.spend > 0 || c.sales > 0 || c.status.key === 'active')
    .sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);

  const lines = [...acc2.entries()].map(([id, x]) => lineOf(id, x.name, x, m.feePct))
    .sort((a, b) => (a.id === 'sem-produto' ? 1 : b.id === 'sem-produto' ? -1 : b.revenue - a.revenue || b.spend - a.spend));
  const tot = lines.reduce((t, l) => ({ sales: t.sales + l.sales, revenue: t.revenue + l.revenue, cost: t.cost + l.cost, spend: t.spend + l.spend, adSales: t.adSales + l.adSales }),
    { sales: 0, revenue: 0, cost: 0, spend: 0, adSales: 0 });

  res.json({
    date: today, tz, currency, feePct: m.feePct, profit: m.profit,
    totals: lineOf('total', 'Total', tot, m.feePct),
    products: lines,
    campaigns,
    recent: (recent.rows as { id: string; amount: number; at: Date; product: string; customer: string | null; ad: string | null }[])
      .map((x) => ({ id: x.id, amount: r2(n(x.amount)), at: x.at, product: x.product, customer: x.customer, fromAd: !!x.ad })),
    accounts: m.accounts.filter((a) => a.currency === currency && (!acts.length || acts.includes(a.actId))).map((a) => ({ actId: a.actId, name: a.name })),
    otherCurrencies: [...new Set(m.accounts.filter((a) => a.currency !== currency).map((a) => a.currency))],
    errors: m.errors,
    updatedAt: new Date(m.oldest).toISOString(),
  });
}));

/** Liga (ou desliga, com productId null) uma campanha a um produto. */
adsTodayRouter.put('/campaign-product', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores mudam o produto das campanhas');
  const accountId = req.accountId!;
  const d = z.object({
    actId: z.string().regex(/^act_\d{1,30}$/), campaignId: z.string().regex(/^\d{1,30}$/), productId: z.string().nullable(),
  }).parse(req.body);
  if (d.productId === null) {
    await db.delete(schema.metaCampaignProducts).where(and(eq(schema.metaCampaignProducts.accountId, accountId), eq(schema.metaCampaignProducts.campaignId, d.campaignId)));
    res.json({ ok: true });
    return;
  }
  if (!isUuid(d.productId)) throw new AppError(400, 'Produto inválido');
  const [p] = await db.select({ id: schema.products.id }).from(schema.products)
    .where(and(eq(schema.products.id, d.productId), eq(schema.products.accountId, accountId))).limit(1);
  if (!p) throw new AppError(404, 'Produto não encontrado');
  await db.insert(schema.metaCampaignProducts).values({ accountId, actId: d.actId, campaignId: d.campaignId, productId: d.productId })
    .onConflictDoUpdate({ target: [schema.metaCampaignProducts.accountId, schema.metaCampaignProducts.campaignId], set: { productId: d.productId, actId: d.actId } });
  res.json({ ok: true });
}));
