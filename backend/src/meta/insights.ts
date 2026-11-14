/**
 * Números do Gerenciador (sem rede, testável): lê as métricas da Meta, status, orçamento e cruza com
 * os leads e as vendas do Converza pelo ID do anúncio (o referral do "clique para o WhatsApp").
 */
import type { InsightRow, Level, RemoteEntity } from './graphAds';

export interface Metrics {
  spend: number; impressions: number; clicks: number; linkClicks: number;
  conversations: number; leads: number; purchases: number; purchaseValue: number;
  reach: number; uniqueLinkClicks: number; landingPageViews: number; videoViews: number; thruplays: number;
  p25: number; p50: number; p75: number; p100: number; postEngagement: number; pageLikes: number;
  addToCart: number; initiateCheckout: number; completeRegistration: number; installs: number; calls: number; messagingReplies: number;
}
const KEYS: (keyof Metrics)[] = ['spend', 'impressions', 'clicks', 'linkClicks', 'conversations', 'leads', 'purchases', 'purchaseValue', 'reach', 'uniqueLinkClicks',
  'landingPageViews', 'videoViews', 'thruplays', 'p25', 'p50', 'p75', 'p100', 'postEngagement', 'pageLikes', 'addToCart', 'initiateCheckout', 'completeRegistration',
  'installs', 'calls', 'messagingReplies'];
export const zero = (): Metrics => Object.fromEntries(KEYS.map((k) => [k, 0])) as unknown as Metrics;

/** Tipos de ação da Meta, do mais completo ao mais específico (usa o primeiro que vier, sem somar duplicados). */
export const CONVERSATION_TYPES = ['onsite_conversion.messaging_conversation_started_7d'];
export const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
export const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.purchase'];
const T = {
  lpv: ['landing_page_view', 'omni_landing_page_view'], video: ['video_view'], post: ['post_engagement'], like: ['like', 'onsite_conversion.page_like'],
  cart: ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'], checkout: ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'],
  reg: ['omni_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration'], install: ['omni_app_install', 'mobile_app_install', 'app_install'],
  call: ['click_to_call_native_call_placed', 'click_to_call_call_confirm'], reply: ['onsite_conversion.messaging_first_reply'],
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function pick(list: { action_type: string; value: string }[] | undefined, types: string[]) {
  for (const t of types) {
    const a = list?.find((x) => x.action_type === t);
    if (a) return num(a.value);
  }
  return 0;
}
const first = (list: { action_type: string; value: string }[] | undefined) => num(list?.[0]?.value);

export function metricsOf(r: InsightRow): Metrics {
  return {
    spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), linkClicks: num(r.inline_link_clicks),
    conversations: pick(r.actions, CONVERSATION_TYPES), leads: pick(r.actions, LEAD_TYPES),
    purchases: pick(r.actions, PURCHASE_TYPES), purchaseValue: pick(r.action_values, PURCHASE_TYPES),
    reach: num(r.reach), uniqueLinkClicks: num(r.unique_inline_link_clicks), landingPageViews: pick(r.actions, T.lpv), videoViews: pick(r.actions, T.video),
    thruplays: first(r.video_thruplay_watched_actions), p25: first(r.video_p25_watched_actions), p50: first(r.video_p50_watched_actions),
    p75: first(r.video_p75_watched_actions), p100: first(r.video_p100_watched_actions), postEngagement: pick(r.actions, T.post), pageLikes: pick(r.actions, T.like),
    addToCart: pick(r.actions, T.cart), initiateCheckout: pick(r.actions, T.checkout), completeRegistration: pick(r.actions, T.reg),
    installs: pick(r.actions, T.install), calls: pick(r.actions, T.call), messagingReplies: pick(r.actions, T.reply),
  };
}

export function addMetrics(a: Metrics, b: Metrics): Metrics {
  return Object.fromEntries(KEYS.map((k) => [k, a[k] + b[k]])) as unknown as Metrics;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const per = (a: number, b: number) => (b ? r2(a / b) : 0);
/** CTR (cliques no link / impressões), CPC (por clique no link), CPM e custo por conversa/lead. */
export function derive(m: Metrics) {
  return {
    ctr: m.impressions ? r2((m.linkClicks / m.impressions) * 100) : 0,
    cpc: per(m.spend, m.linkClicks),
    cpm: m.impressions ? r2((m.spend / m.impressions) * 1000) : 0,
    costPerConversation: per(m.spend, m.conversations),
    costPerLead: per(m.spend, m.leads),
    frequency: per(m.impressions, m.reach),
    ctrAll: m.impressions ? r2((m.clicks / m.impressions) * 100) : 0,
    cpcAll: per(m.spend, m.clicks),
    costPerPurchase: per(m.spend, m.purchases),
    roasMeta: per(m.purchaseValue, m.spend),
    costPerLpv: per(m.spend, m.landingPageViews),
    costPerThruplay: per(m.spend, m.thruplays),
    hookRate: m.impressions ? r2((m.videoViews / m.impressions) * 100) : 0,
  };
}

/** "Resultados" como na Meta: depende da meta de desempenho (ou do objetivo da campanha). */
const RESULT_BY_GOAL: Record<string, [keyof Metrics, string]> = {
  CONVERSATIONS: ['conversations', 'Conversas por mensagem iniciadas'], LINK_CLICKS: ['linkClicks', 'Cliques no link'],
  LANDING_PAGE_VIEWS: ['landingPageViews', 'Visualizações da página de destino'], REACH: ['reach', 'Alcance'], IMPRESSIONS: ['impressions', 'Impressões'],
  THRUPLAY: ['thruplays', 'ThruPlays'], TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: ['videoViews', 'Visualizações do vídeo'], POST_ENGAGEMENT: ['postEngagement', 'Engajamentos com a publicação'],
  PAGE_LIKES: ['pageLikes', 'Curtidas na Página'], LEAD_GENERATION: ['leads', 'Leads'], QUALITY_LEAD: ['leads', 'Leads'], QUALITY_CALL: ['calls', 'Ligações'],
  APP_INSTALLS: ['installs', 'Instalações do app'], VISIT_INSTAGRAM_PROFILE: ['linkClicks', 'Visitas ao perfil'], AD_RECALL_LIFT: ['reach', 'Alcance'],
};
const RESULT_BY_OBJECTIVE: Record<string, [keyof Metrics, string]> = {
  OUTCOME_AWARENESS: ['reach', 'Alcance'], OUTCOME_TRAFFIC: ['linkClicks', 'Cliques no link'], OUTCOME_LEADS: ['leads', 'Leads'],
  OUTCOME_APP_PROMOTION: ['installs', 'Instalações do app'], OUTCOME_SALES: ['purchases', 'Compras'],
};
export function resultOf(m: Metrics, goal: string | null | undefined, objective: string | null | undefined): { key: keyof Metrics; label: string; value: number } | null {
  let r = goal ? RESULT_BY_GOAL[goal] : undefined;
  if (!r && (goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE')) r = m.purchases || objective === 'OUTCOME_SALES' ? ['purchases', 'Compras'] : ['leads', 'Leads'];
  if (!r && objective === 'OUTCOME_ENGAGEMENT') r = m.conversations || !m.postEngagement ? ['conversations', 'Conversas por mensagem iniciadas'] : ['postEngagement', 'Engajamentos com a publicação'];
  if (!r && objective) r = RESULT_BY_OBJECTIVE[objective];
  if (!r) return null;
  return { key: r[0], label: r[1], value: m[r[0]] };
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
export interface Attribution { leads: number; sales: number; revenue: Record<string, number>; cost?: Record<string, number> }
export const noAttr = (): Attribution => ({ leads: 0, sales: 0, revenue: {}, cost: {} });
function addAttr(a: Attribution, b: Attribution) {
  a.leads += b.leads; a.sales += b.sales;
  for (const [cur, v] of Object.entries(b.revenue)) a.revenue[cur] = (a.revenue[cur] ?? 0) + v;
  a.cost ??= {};
  for (const [cur, v] of Object.entries(b.cost ?? {})) a.cost[cur] = (a.cost[cur] ?? 0) + v;
}

/** Números do Converza de uma linha: faturamento das vendas atribuídas, custo dos produtos, taxas e lucro líquido. */
export interface Converza { leads: number; sales: number; revenue: number; roas: number; cost: number; fees: number; profit: number; margin: number; cpa: number }
/** feePct = taxa do gateway + imposto (% do faturamento), dos ajustes do lucro do Dashboard. */
export function converzaOf(leads: number, sales: number, revenue: number, cost: number, spend: number, feePct: number): Converza {
  const fees = r2(revenue * feePct / 100);
  const profit = r2(revenue - cost - fees - spend);
  return {
    leads, sales, revenue: r2(revenue), roas: spend > 0 ? r2(revenue / spend) : 0, cost: r2(cost), fees, profit,
    margin: revenue > 0 ? r2((profit / revenue) * 100) : 0, cpa: sales > 0 ? r2(spend / sales) : 0,
  };
}

export interface EntityIn extends RemoteEntity { actId: string; accountName: string; currency: string }
export interface ManagerRow {
  id: string; level: Level; name: string; actId: string; accountName: string; currency: string;
  campaignId: string | null; adsetId: string | null;
  status: { key: DeliveryKey; label: string }; objective: string | null; optimization: string | null;
  budget: { amount: number; kind: 'daily' | 'lifetime' } | null; thumbnail: string | null;
  /** status escolhido (ACTIVE/PAUSED): o que o botão liga/desliga muda; null = excluída na Meta */
  configured: string | null;
  metrics: Metrics; derived: ReturnType<typeof derive>;
  converza: Converza;
  result: { key: keyof Metrics; label: string; value: number; cost: number } | null;
  bidStrategy: string | null; startTime: string | null; endTime: string | null;
  /** classificações do anúncio (qualidade, engajamento, conversão) */
  rankings: { quality: string | null; engagement: string | null; conversion: string | null } | null;
}

/**
 * Monta as linhas de um nível: as entidades da conta (mesmo sem gasto no período) + as que gastaram e já
 * foram excluídas, com as métricas da Meta e a atribuição do Converza somada a partir dos anúncios.
 */
export function buildRows(level: Level, entities: EntityIn[], insights: (InsightRow & { actId: string; accountName: string; currency: string })[],
  ads: { id: string; campaign_id?: string; adset_id?: string }[], attrByAd: Map<string, Attribution>, feePct = 0): ManagerRow[] {
  const idOf = (r: InsightRow) => (level === 'campaign' ? r.campaign_id : level === 'adset' ? r.adset_id : r.ad_id) ?? '';
  const nameOf = (r: InsightRow) => (level === 'campaign' ? r.campaign_name : level === 'adset' ? r.adset_name : r.ad_name) ?? '';

  const metrics = new Map<string, Metrics>();
  const orphan = new Map<string, (typeof insights)[number]>();
  const ranks = new Map<string, ManagerRow['rankings']>();
  for (const r of insights) {
    const id = idOf(r);
    if (!id) continue;
    metrics.set(id, addMetrics(metrics.get(id) ?? zero(), metricsOf(r)));
    orphan.set(id, r);
    if (r.quality_ranking || r.engagement_rate_ranking || r.conversion_rate_ranking) {
      ranks.set(id, { quality: r.quality_ranking ?? null, engagement: r.engagement_rate_ranking ?? null, conversion: r.conversion_rate_ranking ?? null });
    }
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
    const revenue = at.revenue[base.currency] ?? 0;
    rows.push({
      id, level, ...base,
      status: statusOf(e ? (e.effective_status ?? e.status) : null),
      objective: e?.objective ?? null, optimization: e?.optimization_goal ?? null,
      budget: e ? budgetOf(e, base.currency) : null, thumbnail: e?.creative?.thumbnail_url ?? null,
      configured: e?.status ?? null,
      metrics: m, derived: derive(m),
      converza: converzaOf(at.leads, at.sales, revenue, at.cost?.[base.currency] ?? 0, m.spend, feePct),
      result: (() => { const x = resultOf(m, e?.optimization_goal ?? e?.adset?.optimization_goal ?? null, e?.objective ?? null); return x ? { ...x, cost: x.value ? r2(m.spend / x.value) : 0 } : null; })(),
      bidStrategy: e?.bid_strategy ?? null, startTime: e?.start_time ?? null, endTime: e?.end_time ?? e?.stop_time ?? null,
      rankings: ranks.get(id) ?? null,
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
export function totalsByCurrency(rows: ManagerRow[], feePct = 0) {
  const acc: Record<string, { metrics: Metrics; leads: number; sales: number; revenue: number; cost: number }> = {};
  for (const r of rows) {
    const t = acc[r.currency] ?? { metrics: zero(), leads: 0, sales: 0, revenue: 0, cost: 0 };
    t.metrics = addMetrics(t.metrics, r.metrics);
    t.leads += r.converza.leads; t.sales += r.converza.sales; t.revenue += r.converza.revenue; t.cost += r.converza.cost;
    acc[r.currency] = t;
  }
  const out: Record<string, { metrics: Metrics; derived: ReturnType<typeof derive>; converza: Converza }> = {};
  for (const [cur, t] of Object.entries(acc)) {
    out[cur] = { metrics: t.metrics, derived: derive(t.metrics), converza: converzaOf(t.leads, t.sales, t.revenue, t.cost, t.metrics.spend, feePct) };
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

/* ------------------------------------------------------------------ detalhamento */

const GENDER: Record<string, string> = { male: 'Homens', female: 'Mulheres', unknown: 'Desconhecido' };
const PLATFORM: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', audience_network: 'Audience Network', whatsapp: 'WhatsApp', threads: 'Threads', oculus: 'Meta Quest' };
const POSITION: Record<string, string> = {
  feed: 'Feed', profile_feed: 'Feed do perfil', marketplace: 'Marketplace', video_feeds: 'Feed de vídeos', right_hand_column: 'Coluna da direita', story: 'Stories',
  facebook_stories: 'Stories', instagram_stories: 'Stories', facebook_reels: 'Reels', instagram_reels: 'Reels', reels: 'Reels', instream_video: 'Vídeos in-stream',
  search: 'Resultados da pesquisa', ig_search: 'Resultados da pesquisa', notification: 'Notificações', stream: 'Feed', explore: 'Explorar', explore_home: 'Página inicial do Explorar',
  sponsored_messages: 'Mensagens patrocinadas', messenger_inbox: 'Caixa de entrada', an_classic: 'Nativo, banner e intersticial', rewarded_video: 'Vídeos premiados', status: 'Status',
};
const DEVICE: Record<string, string> = { iphone: 'iPhone', ipad: 'iPad', android_smartphone: 'Celular Android', android_tablet: 'Tablet Android', desktop: 'Computador', ipod: 'iPod', other: 'Outros' };
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Chave e nome de cada linha do detalhamento. */
export function breakdownKey(by: string, r: InsightRow): { key: string; label: string } {
  const g = (k: string) => String(r[k] ?? '');
  switch (by) {
    case 'age': return { key: g('age'), label: g('age') === 'Unknown' ? 'Idade desconhecida' : g('age') };
    case 'gender': return { key: g('gender'), label: GENDER[g('gender')] ?? g('gender') };
    case 'age_gender': return { key: `${g('age')}|${g('gender')}`, label: `${g('age')} · ${GENDER[g('gender')] ?? g('gender')}` };
    case 'country': return { key: g('country'), label: g('country') === 'BR' ? 'Brasil' : g('country') };
    case 'region': return { key: g('region'), label: g('region') };
    case 'platform': return { key: g('publisher_platform'), label: PLATFORM[g('publisher_platform')] ?? g('publisher_platform') };
    case 'placement': return { key: `${g('publisher_platform')}|${g('platform_position')}`, label: `${PLATFORM[g('publisher_platform')] ?? g('publisher_platform')} · ${POSITION[g('platform_position')] ?? g('platform_position').replace(/_/g, ' ')}` };
    case 'device': return { key: g('impression_device'), label: DEVICE[g('impression_device')] ?? g('impression_device') };
    case 'day': return { key: g('date_start'), label: dm(g('date_start')) };
    default: return { key: g('date_start'), label: g('date_start') === g('date_stop') ? dm(g('date_start')) : `${dm(g('date_start'))} a ${dm(g('date_stop'))}` };
  }
}
