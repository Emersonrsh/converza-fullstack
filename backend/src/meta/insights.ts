/**
 * Números do Gerenciador (sem rede, testável): lê as métricas da Meta, status, orçamento e cruza com
 * os leads e as vendas do Converza pelo ID do anúncio (o referral do "clique para o WhatsApp").
 */
import type { InsightRow, Level, RemoteEntity } from './graphAds';

export interface Metrics {
  spend: number; impressions: number; clicks: number; linkClicks: number;
  conversations: number; leads: number; purchases: number; purchaseValue: number;
}
export const zero = (): Metrics => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, conversations: 0, leads: 0, purchases: 0, purchaseValue: 0 });

/** Tipos de ação da Meta, do mais completo ao mais específico (usa o primeiro que vier, sem somar duplicados). */
export const CONVERSATION_TYPES = ['onsite_conversion.messaging_conversation_started_7d'];
export const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
export const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.purchase'];

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function pick(list: { action_type: string; value: string }[] | undefined, types: string[]) {
  for (const t of types) {
    const a = list?.find((x) => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
}

export function metricsOf(r: InsightRow): Metrics {
  return {
    spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), linkClicks: num(r.inline_link_clicks),
    conversations: pick(r.actions, CONVERSATION_TYPES), leads: pick(r.actions, LEAD_TYPES),
    purchases: pick(r.actions, PURCHASE_TYPES), purchaseValue: pick(r.action_values, PURCHASE_TYPES),
  };
}

export function addMetrics(a: Metrics, b: Metrics): Metrics {
  return {
    spend: a.spend + b.spend, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, linkClicks: a.linkClicks + b.linkClicks,
    conversations: a.conversations + b.conversations, leads: a.leads + b.leads, purchases: a.purchases + b.purchases, purchaseValue: a.purchaseValue + b.purchaseValue,
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
/** CTR (cliques no link / impressões), CPC (por clique no link), CPM e custo por conversa/lead. */
export function derive(m: Metrics) {
  return {
    ctr: m.impressions ? r2((m.linkClicks / m.impressions) * 100) : 0,
    cpc: m.linkClicks ? r2(m.spend / m.linkClicks) : 0,
    cpm: m.impressions ? r2((m.spend / m.impressions) * 1000) : 0,
    costPerConversation: m.conversations ? r2(m.spend / m.conversations) : 0,
    costPerLead: m.leads ? r2(m.spend / m.leads) : 0,
  };
}

/** Moedas sem centavos na Meta (o orçamento vem na unidade); as outras vêm em centavos. */
export const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'VND', 'TWD', 'ISK', 'HUF', 'PYG', 'COP', 'CRC', 'IDR']);
export function budgetOf(e: Pick<RemoteEntity, 'daily_budget' | 'lifetime_budget'>, currency: string): { amount: number; kind: 'daily' | 'lifetime' } | null {
  const div = ZERO_DECIMAL.has(currency) ? 1 : 100;
  if (num(e.daily_budget) > 0) return { amount: num(e.daily_budget) / div, kind: 'daily' };
  if (num(e.lifetime_budget) > 0) return { amount: num(e.lifetime_budget) / div, kind: 'lifetime' };
  return null;
}

export type DeliveryKey = 'active' | 'paused' | 'review' | 'issue' | 'off';
export function statusOf(effective?: string | null): { key: DeliveryKey; label: string } {
  const s = String(effective ?? '').toUpperCase();
  if (s === 'ACTIVE') return { key: 'active', label: 'Ativa' };
  if (['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(s)) return { key: 'paused', label: s === 'PAUSED' ? 'Pausada' : s === 'CAMPAIGN_PAUSED' ? 'Campanha pausada' : 'Conjunto pausado' };
  if (['IN_PROCESS', 'PENDING_REVIEW', 'PREAPPROVED'].includes(s)) return { key: 'review', label: 'Em análise' };
  if (['WITH_ISSUES', 'DISAPPROVED', 'PENDING_BILLING_INFO'].includes(s)) return { key: 'issue', label: s === 'DISAPPROVED' ? 'Reprovada' : s === 'PENDING_BILLING_INFO' ? 'Pagamento pendente' : 'Com problema' };
  if (!s) return { key: 'off', label: 'Excluída' };
  return { key: 'off', label: 'Desligada' };
}

/** Situação da conta de anúncios (account_status da Meta). */
export function accountStatusLabel(s: number | null | undefined): { ok: boolean; label: string } {
  switch (s) {
    case 1: return { ok: true, label: 'Ativa' };
    case 2: return { ok: false, label: 'Desativada' };
    case 3: return { ok: false, label: 'Pagamento pendente' };
    case 7: return { ok: false, label: 'Em análise de risco' };
    case 8: return { ok: false, label: 'Acerto pendente' };
    case 9: return { ok: false, label: 'Em período de carência' };
    case 100: return { ok: false, label: 'Encerramento pendente' };
    case 101: return { ok: false, label: 'Encerrada' };
    default: return { ok: true, label: s == null ? '—' : `Situação ${s}` };
  }
}

/** Leads e vendas do Converza que vieram de um anúncio (por ID do anúncio). */
export interface Attribution { leads: number; sales: number; revenue: Record<string, number> }
export const noAttr = (): Attribution => ({ leads: 0, sales: 0, revenue: {} });
function addAttr(a: Attribution, b: Attribution) {
  a.leads += b.leads; a.sales += b.sales;
  for (const [cur, v] of Object.entries(b.revenue)) a.revenue[cur] = (a.revenue[cur] ?? 0) + v;
}

export interface EntityIn extends RemoteEntity { actId: string; accountName: string; currency: string }
export interface ManagerRow {
  id: string; level: Level; name: string; actId: string; accountName: string; currency: string;
  campaignId: string | null; adsetId: string | null;
  status: { key: DeliveryKey; label: string }; objective: string | null; optimization: string | null;
  budget: { amount: number; kind: 'daily' | 'lifetime' } | null; thumbnail: string | null;
  metrics: Metrics; derived: ReturnType<typeof derive>;
  converza: { leads: number; sales: number; revenue: number; roas: number };
}

/**
 * Monta as linhas de um nível: as entidades da conta (mesmo sem gasto no período) + as que gastaram e já
 * foram excluídas, com as métricas da Meta e a atribuição do Converza somada a partir dos anúncios.
 */
export function buildRows(level: Level, entities: EntityIn[], insights: (InsightRow & { actId: string; accountName: string; currency: string })[],
  ads: { id: string; campaign_id?: string; adset_id?: string }[], attrByAd: Map<string, Attribution>): ManagerRow[] {
  const idOf = (r: InsightRow) => (level === 'campaign' ? r.campaign_id : level === 'adset' ? r.adset_id : r.ad_id) ?? '';
  const nameOf = (r: InsightRow) => (level === 'campaign' ? r.campaign_name : level === 'adset' ? r.adset_name : r.ad_name) ?? '';

  const metrics = new Map<string, Metrics>();
  const orphan = new Map<string, (typeof insights)[number]>();
  for (const r of insights) {
    const id = idOf(r);
    if (!id) continue;
    metrics.set(id, addMetrics(metrics.get(id) ?? zero(), metricsOf(r)));
    orphan.set(id, r);
  }

  // atribuição do Converza somada por campanha / conjunto / anúncio
  const attr = new Map<string, Attribution>();
  for (const ad of ads) {
    const a = attrByAd.get(ad.id);
    if (!a) continue;
    const key = level === 'campaign' ? ad.campaign_id : level === 'adset' ? ad.adset_id : ad.id;
    if (!key) continue;
    const cur = attr.get(key) ?? noAttr();
    addAttr(cur, a);
    attr.set(key, cur);
  }

  const rows: ManagerRow[] = [];
  const seen = new Set<string>();
  const push = (id: string, base: { name: string; actId: string; accountName: string; currency: string; campaignId: string | null; adsetId: string | null },
    e: Partial<RemoteEntity> | null) => {
    seen.add(id);
    const m = metrics.get(id) ?? zero();
    const at = attr.get(id) ?? noAttr();
    const revenue = Math.round((at.revenue[base.currency] ?? 0) * 100) / 100;
    rows.push({
      id, level, ...base,
      status: statusOf(e ? (e.effective_status ?? e.status) : null),
      objective: e?.objective ?? null, optimization: e?.optimization_goal ?? null,
      budget: e ? budgetOf(e, base.currency) : null, thumbnail: e?.creative?.thumbnail_url ?? null,
      metrics: m, derived: derive(m),
      converza: { leads: at.leads, sales: at.sales, revenue, roas: m.spend > 0 ? Math.round((revenue / m.spend) * 100) / 100 : 0 },
    });
  };
  for (const e of entities) {
    push(e.id, { name: e.name, actId: e.actId, accountName: e.accountName, currency: e.currency,
      campaignId: level === 'campaign' ? e.id : e.campaign_id ?? null, adsetId: level === 'ad' ? e.adset_id ?? null : level === 'adset' ? e.id : null }, e);
  }
  for (const [id, r] of orphan) {
    if (seen.has(id)) continue;
    push(id, { name: nameOf(r) || id, actId: r.actId, accountName: r.accountName, currency: r.currency,
      campaignId: r.campaign_id ?? null, adsetId: level === 'ad' ? r.adset_id ?? null : level === 'adset' ? id : null }, null);
  }
  // quem gastou primeiro, depois as ativas, depois por nome
  const rank = (x: ManagerRow) => (x.status.key === 'active' ? 0 : x.status.key === 'off' ? 2 : 1);
  return rows.sort((a, b) => b.metrics.spend - a.metrics.spend || rank(a) - rank(b) || a.name.localeCompare(b.name, 'pt-BR'));
}

/** Totais por moeda (contas em moedas diferentes não se somam). */
export function totalsByCurrency(rows: ManagerRow[]) {
  const out: Record<string, { metrics: Metrics; derived: ReturnType<typeof derive>; converza: { leads: number; sales: number; revenue: number; roas: number } }> = {};
  for (const r of rows) {
    const t = out[r.currency] ?? { metrics: zero(), derived: derive(zero()), converza: { leads: 0, sales: 0, revenue: 0, roas: 0 } };
    t.metrics = addMetrics(t.metrics, r.metrics);
    t.converza.leads += r.converza.leads; t.converza.sales += r.converza.sales;
    t.converza.revenue = Math.round((t.converza.revenue + r.converza.revenue) * 100) / 100;
    out[r.currency] = t;
  }
  for (const t of Object.values(out)) {
    t.derived = derive(t.metrics);
    t.converza.roas = t.metrics.spend > 0 ? Math.round((t.converza.revenue / t.metrics.spend) * 100) / 100 : 0;
  }
  return out;
}

/** Gasto/conversas por dia (insights da conta com time_increment=1), por moeda. */
export function dailySeries(rows: (InsightRow & { currency: string })[], days: string[]) {
  const by = new Map<string, Map<string, Metrics>>();
  for (const r of rows) {
    const d = r.date_start ?? '';
    if (!d) continue;
    const cur = by.get(r.currency) ?? new Map<string, Metrics>();
    cur.set(d, addMetrics(cur.get(d) ?? zero(), metricsOf(r)));
    by.set(r.currency, cur);
  }
  const out: Record<string, { date: string; spend: number; conversations: number; linkClicks: number }[]> = {};
  for (const [cur, m] of by) {
    out[cur] = days.map((d) => {
      const x = m.get(d) ?? zero();
      return { date: d, spend: Math.round(x.spend * 100) / 100, conversations: x.conversations, linkClicks: x.linkClicks };
    });
  }
  return out;
}
