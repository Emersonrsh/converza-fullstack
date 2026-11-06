import { Router } from 'express';
import { and, between, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler } from '../utils/http';

export const dashboardRouter = Router();

/** KPIs e séries de vendas/atendimento para um intervalo de datas. */
dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const start = req.query.start ? new Date(String(req.query.start)) : startOfToday();
  const end = req.query.end ? new Date(String(req.query.end)) : new Date();

  const inRange = and(eq(schema.sales.accountId, accountId), between(schema.sales.createdAt, start, end));

  const [agg] = await db.select({
    revenue: sql<string>`coalesce(sum(case when ${schema.sales.status} = 'approved' then ${schema.sales.amount} else 0 end), 0)`,
    salesCount: sql<number>`count(*) filter (where ${schema.sales.status} = 'approved')`,
    total: sql<number>`count(*)`,
  }).from(schema.sales).where(inRange);

  const [leads] = await db.select({ c: sql<number>`count(*)` }).from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, accountId), between(schema.contacts.createdAt, start, end)));

  const byHour = await db.select({
    hour: sql<number>`extract(hour from ${schema.sales.createdAt})::int`,
    count: sql<number>`count(*)`,
    revenue: sql<string>`coalesce(sum(${schema.sales.amount}), 0)`,
  }).from(schema.sales).where(inRange).groupBy(sql`1`).orderBy(sql`1`);

  const revenue = Number(agg?.revenue ?? 0);
  const salesCount = Number(agg?.salesCount ?? 0);
  const leadsCount = Number(leads?.c ?? 0);
  const ticket = salesCount ? revenue / salesCount : 0;
  const conversion = leadsCount ? (salesCount / leadsCount) * 100 : 0;

  res.json({
    range: { start, end },
    kpis: {
      leads: leadsCount,
      revenue,
      sales: salesCount,
      ticket,
      conversion: Number(conversion.toFixed(1)),
    },
    series: {
      byHour: Array.from({ length: 24 }, (_, h) => {
        const row = byHour.find((r) => Number(r.hour) === h);
        return { hour: h, count: Number(row?.count ?? 0), revenue: Number(row?.revenue ?? 0) };
      }),
    },
  });
}));

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
