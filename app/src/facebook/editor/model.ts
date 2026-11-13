/**
 * Modelo do editor de campanhas (o mesmo desenho do Gerenciador de Anúncios da Meta):
 * objetivos, locais da conversão e metas de desempenho, rascunho da campanha → conjuntos → anúncios,
 * conversão para os campos da Marketing API (publicar) e de volta (editar o que já existe), e a conferência.
 */

export type Objective = 'OUTCOME_AWARENESS' | 'OUTCOME_TRAFFIC' | 'OUTCOME_ENGAGEMENT' | 'OUTCOME_LEADS' | 'OUTCOME_APP_PROMOTION' | 'OUTCOME_SALES';

export const OBJECTIVES: { id: Objective; label: string; icon: string; desc: string; short: string }[] = [
  { id: 'OUTCOME_AWARENESS', label: 'Reconhecimento', short: 'Reconhecimento', icon: 'megaphone', desc: 'Mostre seus anúncios para as pessoas com maior probabilidade de lembrar deles.' },
  { id: 'OUTCOME_TRAFFIC', label: 'Tráfego', short: 'Tráfego', icon: 'cursor', desc: 'Leve as pessoas para um destino: site, app, WhatsApp, Instagram ou ligação.' },
  { id: 'OUTCOME_ENGAGEMENT', label: 'Engajamento', short: 'Engajamento', icon: 'chat', desc: 'Mais mensagens, visualizações do vídeo, interações com a publicação ou curtidas na Página.' },
  { id: 'OUTCOME_LEADS', label: 'Leads', short: 'Leads', icon: 'filter', desc: 'Colete cadastros pelo formulário instantâneo, mensagens, ligações ou no seu site.' },
  { id: 'OUTCOME_APP_PROMOTION', label: 'Promoção do app', short: 'Promoção do app', icon: 'grid', desc: 'Encontre pessoas para instalar o seu app e continuar usando.' },
  { id: 'OUTCOME_SALES', label: 'Vendas', short: 'Vendas', icon: 'bag', desc: 'Encontre pessoas com probabilidade de comprar seu produto ou serviço.' },
];
export const objectiveLabel = (o: string | null | undefined) => OBJECTIVES.find((x) => x.id === o)?.label ?? (o || '—');

/** O que o conjunto precisa saber além do público (vira o promoted_object). */
type Need = 'page' | 'pixel' | 'app' | 'whatsapp' | 'form';
export interface Goal { id: string; label: string; desc?: string; needs?: Need[]; value?: boolean }
export interface Location { id: string; label: string; desc?: string; goals: Goal[]; needs: Need[]; messaging?: boolean }

const G = {
  conv: { id: 'OFFSITE_CONVERSIONS', label: 'Maximizar o número de conversões', needs: ['pixel'] as Need[] },
  value: { id: 'VALUE', label: 'Maximizar o valor das conversões', needs: ['pixel'] as Need[], value: true },
  lpv: { id: 'LANDING_PAGE_VIEWS', label: 'Maximizar o número de visualizações da página de destino' },
  clicks: { id: 'LINK_CLICKS', label: 'Maximizar o número de cliques no link' },
  reach: { id: 'REACH', label: 'Maximizar o alcance dos anúncios' },
  imp: { id: 'IMPRESSIONS', label: 'Maximizar o número de impressões' },
  convs: { id: 'CONVERSATIONS', label: 'Maximizar o número de conversas' },
  call: { id: 'QUALITY_CALL', label: 'Maximizar o número de ligações' },
  leads: { id: 'LEAD_GENERATION', label: 'Maximizar o número de leads' },
  qlead: { id: 'QUALITY_LEAD', label: 'Maximizar o número de leads de conversão' },
  thru: { id: 'THRUPLAY', label: 'Maximizar ThruPlays (vídeo assistido até 15 s)' },
  v2s: { id: 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS', label: 'Maximizar visualizações contínuas de 2 segundos' },
  post: { id: 'POST_ENGAGEMENT', label: 'Maximizar o engajamento com a publicação' },
  likes: { id: 'PAGE_LIKES', label: 'Maximizar curtidas na Página' },
  recall: { id: 'AD_RECALL_LIFT', label: 'Maximizar o aumento na lembrança do anúncio' },
  installs: { id: 'APP_INSTALLS', label: 'Maximizar o número de instalações do app' },
  appEvents: { id: 'OFFSITE_CONVERSIONS', label: 'Maximizar o número de eventos do app', needs: ['app'] as Need[] },
  appValue: { id: 'VALUE', label: 'Maximizar o valor das compras no app', needs: ['app'] as Need[], value: true },
  profile: { id: 'VISIT_INSTAGRAM_PROFILE', label: 'Maximizar visitas ao perfil do Instagram' },
};

const MSG_DESTS: Location[] = [
  { id: 'WHATSAPP', label: 'WhatsApp', goals: [], needs: ['page', 'whatsapp'], messaging: true },
  { id: 'MESSENGER', label: 'Messenger', goals: [], needs: ['page'], messaging: true },
  { id: 'INSTAGRAM_DIRECT', label: 'Instagram', goals: [], needs: ['page'], messaging: true },
  { id: 'MESSAGING_MESSENGER_WHATSAPP', label: 'Messenger e WhatsApp', goals: [], needs: ['page', 'whatsapp'], messaging: true },
  { id: 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', label: 'Instagram e Messenger', goals: [], needs: ['page'], messaging: true },
  { id: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', label: 'Instagram e WhatsApp', goals: [], needs: ['page', 'whatsapp'], messaging: true },
  { id: 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', label: 'Messenger, Instagram e WhatsApp', goals: [], needs: ['page', 'whatsapp'], messaging: true },
];
const msg = (goals: Goal[]) => MSG_DESTS.map((d) => ({ ...d, goals }));

/** Local da conversão e metas de desempenho por objetivo (o mesmo que o editor da Meta oferece). */
export const LOCATIONS: Record<Objective, Location[]> = {
  OUTCOME_AWARENESS: [{ id: '', label: 'Sem local de conversão', goals: [G.reach, G.imp, G.recall, G.thru], needs: ['page'] }],
  OUTCOME_TRAFFIC: [
    { id: 'WEBSITE', label: 'Site', goals: [G.lpv, G.clicks, G.reach, G.imp], needs: [] },
    { id: 'APP', label: 'App', goals: [G.clicks], needs: ['app'] },
    ...msg([G.clicks]),
    { id: 'INSTAGRAM_PROFILE', label: 'Perfil do Instagram', goals: [G.profile], needs: ['page'] },
    { id: 'PHONE_CALL', label: 'Ligações', goals: [G.clicks], needs: ['page'] },
  ],
  OUTCOME_ENGAGEMENT: [
    ...msg([G.convs, G.clicks]),
    { id: 'ON_VIDEO', label: 'No seu anúncio (vídeo)', goals: [G.thru, G.v2s], needs: ['page'] },
    { id: 'ON_POST', label: 'No seu anúncio (publicação)', goals: [G.post, G.imp, G.reach], needs: ['page'] },
    { id: 'ON_PAGE', label: 'Página do Facebook', goals: [G.likes], needs: ['page'] },
    { id: 'WEBSITE', label: 'Site', goals: [G.conv, G.lpv, G.clicks, G.imp, G.reach], needs: [] },
    { id: 'APP', label: 'App', goals: [G.appEvents, G.clicks], needs: ['app'] },
    { id: 'PHONE_CALL', label: 'Ligações', goals: [G.call], needs: ['page'] },
  ],
  OUTCOME_LEADS: [
    { id: 'ON_AD', label: 'Formulários instantâneos', goals: [G.leads, G.qlead], needs: ['page', 'form'] },
    { id: 'WEBSITE', label: 'Site', goals: [G.conv, G.lpv, G.clicks, G.imp, G.reach], needs: [] },
    ...msg([G.leads, G.convs]),
    { id: 'PHONE_CALL', label: 'Ligações', goals: [G.call], needs: ['page'] },
    { id: 'APP', label: 'App', goals: [G.appEvents], needs: ['app'] },
  ],
  OUTCOME_APP_PROMOTION: [{ id: 'APP', label: 'App', goals: [G.installs, G.appEvents, G.appValue, G.clicks], needs: ['app'] }],
  OUTCOME_SALES: [
    { id: 'WEBSITE', label: 'Site', goals: [G.conv, G.value, G.lpv, G.clicks, G.imp, G.reach], needs: [] },
    { id: 'APP', label: 'App', goals: [G.appEvents, G.appValue, G.clicks], needs: ['app'] },
    ...msg([G.convs, G.conv]),
    { id: 'PHONE_CALL', label: 'Ligações', goals: [G.call], needs: ['page'] },
  ],
};

export const locationOf = (o: Objective, dest: string) => LOCATIONS[o].find((l) => l.id === dest) ?? LOCATIONS[o][0];
export const goalOf = (o: Objective, dest: string, goal: string) => {
  const l = locationOf(o, dest);
  return l.goals.find((g) => g.id === goal) ?? l.goals[0];
};
/** Tudo que o conjunto precisa (local + meta). */
export const needsOf = (o: Objective, dest: string, goal: string): Need[] => {
  const l = locationOf(o, dest); const g = goalOf(o, dest, goal);
  const n = new Set<Need>([...l.needs, ...(g.needs ?? [])]);
  // conversões no site com WhatsApp/Messenger como destino usam o pixel também
  if (l.messaging && goal === 'OFFSITE_CONVERSIONS') n.add('pixel');
  return [...n];
};

export const PIXEL_EVENTS: [string, string][] = [
  ['PURCHASE', 'Compra'], ['LEAD', 'Lead'], ['COMPLETE_REGISTRATION', 'Cadastro concluído'], ['ADD_TO_CART', 'Adicionar ao carrinho'],
  ['INITIATED_CHECKOUT', 'Iniciar finalização da compra'], ['ADD_PAYMENT_INFO', 'Adicionar dados de pagamento'], ['CONTENT_VIEW', 'Visualização de conteúdo'],
  ['SEARCH', 'Pesquisar'], ['ADD_TO_WISHLIST', 'Adicionar à lista de desejos'], ['CONTACT', 'Contato'], ['SCHEDULE', 'Agendar'],
  ['START_TRIAL', 'Iniciar avaliação gratuita'], ['SUBMIT_APPLICATION', 'Enviar inscrição'], ['SUBSCRIBE', 'Assinar'],
  ['DONATE', 'Doar'], ['FIND_LOCATION', 'Encontrar localização'], ['CUSTOMIZE_PRODUCT', 'Personalizar produto'], ['OTHER', 'Outro'],
];

export const BID_STRATEGIES: { id: string; label: string; desc: string; needs?: 'bid' | 'roas'; valueOnly?: boolean }[] = [
  { id: 'LOWEST_COST_WITHOUT_CAP', label: 'Volume mais alto', desc: 'Gastar todo o orçamento buscando o maior número de resultados.' },
  { id: 'COST_CAP', label: 'Meta de custo por resultado', desc: 'Manter o custo médio por resultado perto do valor que você definir.', needs: 'bid' },
  { id: 'LOWEST_COST_WITH_BID_CAP', label: 'Limite de lance', desc: 'O lance máximo em cada leilão.', needs: 'bid' },
  { id: 'LOWEST_COST_WITH_MIN_ROAS', label: 'Meta de ROAS', desc: 'Retorno mínimo sobre o investimento (só com "valor das conversões").', needs: 'roas', valueOnly: true },
];

export const ATTRIBUTION: { id: string; label: string; spec: { event_type: string; window_days: number }[] }[] = [
  { id: '7c1v', label: 'Padrão: 7 dias após o clique ou 1 dia após a visualização', spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }] },
  { id: '7c1v1e', label: '7 dias após o clique, 1 dia após a visualização ou o engajamento', spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }, { event_type: 'ENGAGED_VIDEO_VIEW', window_days: 1 }] },
  { id: '7c', label: '7 dias após o clique', spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }] },
  { id: '1c1v', label: '1 dia após o clique ou a visualização', spec: [{ event_type: 'CLICK_THROUGH', window_days: 1 }, { event_type: 'VIEW_THROUGH', window_days: 1 }] },
  { id: '1c', label: '1 dia após o clique', spec: [{ event_type: 'CLICK_THROUGH', window_days: 1 }] },
];

export const SPECIAL_CATEGORIES: [string, string][] = [
  ['FINANCIAL_PRODUCTS_SERVICES', 'Produtos e serviços financeiros'], ['EMPLOYMENT', 'Emprego'], ['HOUSING', 'Moradia'],
  ['ISSUES_ELECTIONS_POLITICS', 'Temas sociais, eleições ou política'], ['ONLINE_GAMBLING_AND_GAMING', 'Jogos de azar e apostas on-line'],
];

export const CTAS: [string, string][] = [
  ['LEARN_MORE', 'Saiba mais'], ['SHOP_NOW', 'Comprar agora'], ['BUY_NOW', 'Comprar'], ['SIGN_UP', 'Cadastre-se'], ['CONTACT_US', 'Fale conosco'],
  ['SUBSCRIBE', 'Assinar'], ['GET_OFFER', 'Obter oferta'], ['GET_QUOTE', 'Solicitar orçamento'], ['BOOK_TRAVEL', 'Reservar'], ['APPLY_NOW', 'Candidatar-se'],
  ['ORDER_NOW', 'Peça agora'], ['DOWNLOAD', 'Baixar'], ['WATCH_MORE', 'Assistir mais'], ['SEE_MENU', 'Ver cardápio'], ['GET_DIRECTIONS', 'Como chegar'],
  ['SEND_UPDATES', 'Receber atualizações'], ['DONATE_NOW', 'Doar agora'], ['INSTALL_MOBILE_APP', 'Instalar agora'], ['USE_APP', 'Usar app'],
  ['PLAY_GAME', 'Jogar'], ['LISTEN_NOW', 'Ouvir agora'], ['NO_BUTTON', 'Sem botão'],
];
export const ctaLabel = (c: string) => CTAS.find((x) => x[0] === c)?.[1] ?? c;

export const PLACEMENTS: { platform: string; label: string; key: string; positions: [string, string][] }[] = [
  { platform: 'facebook', label: 'Facebook', key: 'facebook_positions', positions: [['feed', 'Feed'], ['profile_feed', 'Feed do perfil'], ['marketplace', 'Marketplace'], ['video_feeds', 'Feed de vídeos'], ['right_hand_column', 'Coluna da direita'], ['story', 'Stories'], ['facebook_reels', 'Reels'], ['instream_video', 'Vídeos in-stream'], ['search', 'Resultados da pesquisa'], ['notification', 'Notificações']] },
  { platform: 'instagram', label: 'Instagram', key: 'instagram_positions', positions: [['stream', 'Feed'], ['profile_feed', 'Feed do perfil'], ['explore', 'Explorar'], ['explore_home', 'Página inicial do Explorar'], ['story', 'Stories'], ['reels', 'Reels'], ['ig_search', 'Resultados da pesquisa']] },
  { platform: 'messenger', label: 'Messenger', key: 'messenger_positions', positions: [['story', 'Stories'], ['sponsored_messages', 'Mensagens patrocinadas']] },
  { platform: 'audience_network', label: 'Audience Network', key: 'audience_network_positions', positions: [['classic', 'Nativo, banner e intersticial'], ['rewarded_video', 'Vídeos premiados']] },
];

/* ------------------------------------------------------------------ rascunho */

export interface Geo { key: string; name: string; type: string; countryCode?: string | null; radius?: number | null; exclude?: boolean }
export interface Pick { id: string; name: string; type?: string; path?: string | null }
export interface AudienceDraft {
  advantage: boolean;
  savedAudienceId: string | null;
  customInclude: Pick[]; customExclude: Pick[];
  locations: Geo[]; locationTypes: ('home' | 'recent' | 'travel_in')[];
  ageMin: number; ageMax: number; genders: 0 | 1 | 2;
  locales: { key: number; name: string }[];
  /** grupos E (cada grupo: OU entre os itens) */
  detailed: Pick[][]; exclude: Pick[];
}
export interface PlacementsDraft { advantage: boolean; devices: ('mobile' | 'desktop')[]; platforms: string[]; positions: Record<string, string[]> }

export interface CampaignDraft {
  id: string | null; name: string; objective: Objective; status: 'ACTIVE' | 'PAUSED';
  specialCategories: string[]; cbo: boolean; budgetKind: 'daily' | 'lifetime'; budget: number | null; bidStrategy: string;
  spendCap: number | null; flowId: string | null;
}
export interface AdsetDraft {
  key: string; id: string | null; name: string; status: 'ACTIVE' | 'PAUSED';
  destination: string; goal: string; pageId: string; whatsapp: string; pixelId: string; event: string; customConversionId: string; appId: string; storeUrl: string; appEvent: string;
  attribution: string; bidStrategy: string; bidAmount: number | null; roas: number | null;
  budgetKind: 'daily' | 'lifetime'; budget: number | null; minSpend: number | null; maxSpend: number | null;
  start: string; end: string; audience: AudienceDraft; placements: PlacementsDraft;
  frequency: { impressions: number; days: number } | null;
  beneficiary: string; payor: string;
  /** Estratégia de ciclo de vida do cliente (só em Vendas): '' = não definida. */
  lifecycle: Lifecycle;
}
export type Lifecycle = '' | 'all' | 'new' | 'new_engaged';
/** Tipos do `ad_set_goal` da Meta: 0 BROAD, 2 EXCLUDE_EXISTING_CUSTOMERS, 1 EXCLUDE_EXISTING_AND_ENGAGED_CUSTOMERS. */
export const LIFECYCLE_TYPE: Record<Exclude<Lifecycle, ''>, number> = { all: 0, new: 2, new_engaged: 1 };
export const lifecycleOf = (t: unknown): Lifecycle => (Object.entries(LIFECYCLE_TYPE).find(([, v]) => v === Number(t))?.[0] as Lifecycle) ?? '';
export type Crop = [[number, number], [number, number]];
export interface Media {
  kind: 'image' | 'video'; hash?: string; videoId?: string; url: string | null; name?: string;
  width?: number | null; height?: number | null;
  /** cortes da imagem por proporção (chaves da Meta: 100x100, 90x160, 400x500, 191x100) */
  crops?: Record<string, Crop>;
  /** capa escolhida para o vídeo (imagem enviada) */
  thumbHash?: string | null;
}
export const CROPS: { key: string; label: string; w: number; h: number; use: string }[] = [
  { key: '100x100', label: 'Quadrado (1:1)', w: 1, h: 1, use: 'Feeds' },
  { key: '400x500', label: 'Vertical (4:5)', w: 4, h: 5, use: 'Feed do celular' },
  { key: '90x160', label: 'Vertical (9:16)', w: 9, h: 16, use: 'Stories, Status e Reels' },
  { key: '191x100', label: 'Horizontal (1,91:1)', w: 1.91, h: 1, use: 'Coluna da direita, pesquisa e sites' },
];
export interface Card { key: string; media: Media | null; headline: string; description: string; link: string }
export interface AdDraft {
  key: string; id: string | null; name: string; status: 'ACTIVE' | 'PAUSED';
  pageId: string; igId: string;
  /** criar anúncio ou usar uma publicação que já existe na Página/Instagram */
  source: 'create' | 'existing'; postId: string; igMediaId: string; postPicture: string | null; postText: string;
  format: 'single' | 'carousel'; media: Media | null; cards: Card[];
  /** até 10 mídias no anúncio de imagem/vídeo único (a Meta combina) e uma mídia própria para Stories/Reels */
  extraMedia: Media[]; storyMedia: Media | null;
  multiAdvertiser: boolean;
  trackSite: boolean; trackPixelId: string; trackApp: boolean; trackAppId: string;
  texts: string[]; headlines: string[]; description: string;
  cta: string; link: string; displayLink: string; urlTags: string;
  greeting: string; prefill: string; leadFormId: string; phone: string;
  /** criativo já publicado (null = novo); "dirty" = mudou e precisa de um criativo novo */
  creativeId: string | null; dirty: boolean; thumbnail: string | null;
  /** criativo feito de um jeito que o editor não abre (ex.: catálogo); só dá para trocar por um novo */
  foreign: boolean;
}
export interface Draft { actId: string; currency: string; campaign: CampaignDraft; adsets: (AdsetDraft & { ads: AdDraft[] })[]; remove: string[]; orig: Record<string, unknown> | null }

let seq = 0;
export const newKey = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const defaultAudience = (): AudienceDraft => ({
  advantage: true, savedAudienceId: null, customInclude: [], customExclude: [],
  locations: [{ key: 'BR', name: 'Brasil', type: 'country', countryCode: 'BR' }], locationTypes: ['home', 'recent'],
  ageMin: 18, ageMax: 65, genders: 0, locales: [], detailed: [[]], exclude: [],
});
export const defaultPlacements = (): PlacementsDraft => ({
  advantage: true, devices: ['mobile', 'desktop'], platforms: PLACEMENTS.map((p) => p.platform),
  positions: Object.fromEntries(PLACEMENTS.map((p) => [p.platform, p.positions.map((x) => x[0])])),
});

export function newAdset(o: Objective, n = 1, base?: Partial<AdsetDraft>): AdsetDraft & { ads: AdDraft[] } {
  const loc = LOCATIONS[o][0];
  const short = OBJECTIVES.find((x) => x.id === o)!.short;
  return {
    key: newKey('s'), id: null, name: `Novo conjunto de anúncios de ${short}${n > 1 ? ` ${n}` : ''}`, status: 'ACTIVE',
    destination: o === 'OUTCOME_ENGAGEMENT' || o === 'OUTCOME_SALES' ? (o === 'OUTCOME_ENGAGEMENT' ? 'WHATSAPP' : 'WEBSITE') : loc.id,
    goal: '', pageId: '', whatsapp: '', pixelId: '', customConversionId: '', event: o === 'OUTCOME_LEADS' ? 'LEAD' : 'PURCHASE', appId: '', storeUrl: '', appEvent: 'PURCHASE',
    attribution: '7c1v', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, roas: null,
    budgetKind: 'daily', budget: 20, minSpend: null, maxSpend: null, start: '', end: '',
    audience: defaultAudience(), placements: defaultPlacements(), frequency: null, beneficiary: '', payor: '', lifecycle: '',
    ...base, ads: [newAd(o, 1)],
  };
}
export function newAd(o: Objective, n = 1, base?: Partial<AdDraft>): AdDraft {
  const short = OBJECTIVES.find((x) => x.id === o)!.short;
  return {
    key: newKey('a'), id: null, name: `Novo anúncio de ${short}${n > 1 ? ` ${n}` : ''}`, status: 'ACTIVE', pageId: '', igId: '',
    source: 'create', postId: '', igMediaId: '', postPicture: null, postText: '',
    format: 'single', media: null, cards: [], extraMedia: [], storyMedia: null, multiAdvertiser: true,
    trackSite: true, trackPixelId: '', trackApp: false, trackAppId: '', texts: [''], headlines: [''], description: '', cta: 'LEARN_MORE', link: '', displayLink: '', urlTags: '',
    greeting: 'Olá! Que bom ter você por aqui. Como posso te ajudar?', prefill: 'Olá! Vi o anúncio e quero saber mais.', leadFormId: '', phone: '',
    creativeId: null, dirty: true, thumbnail: null, foreign: false, ...base,
  };
}
export function newDraft(actId: string, currency: string, o: Objective): Draft {
  const short = OBJECTIVES.find((x) => x.id === o)!.short;
  return {
    actId, currency, remove: [], orig: null,
    campaign: { id: null, name: `Nova campanha de ${short}`, objective: o, status: 'ACTIVE', specialCategories: [], cbo: true, budgetKind: 'daily', budget: 20, bidStrategy: 'LOWEST_COST_WITHOUT_CAP', spendCap: null, flowId: null },
    adsets: [newAdset(o)],
  };
}

/* ------------------------------------------------------------------ rascunho → Marketing API */

const iso = (local: string) => (local ? new Date(local).toISOString() : undefined);
const digits = (s: string) => s.replace(/\D/g, '');
export const WA_LINK = 'https://api.whatsapp.com/send';

export function buildTargeting(a: AudienceDraft, p: PlacementsDraft): Record<string, unknown> {
  const geo = (ex: boolean) => {
    const g: Record<string, unknown> = {};
    const of = (t: string) => a.locations.filter((l) => !!l.exclude === ex && l.type === t);
    const countries = of('country').map((l) => l.key);
    if (countries.length) g.countries = countries;
    if (of('region').length) g.regions = of('region').map((l) => ({ key: l.key }));
    if (of('city').length) g.cities = of('city').map((l) => ({ key: l.key, ...(l.radius ? { radius: l.radius, distance_unit: 'kilometer' } : {}) }));
    if (of('zip').length) g.zips = of('zip').map((l) => ({ key: l.key }));
    if (of('geo_market').length) g.geo_markets = of('geo_market').map((l) => ({ key: l.key }));
    if (of('neighborhood').length) g.neighborhoods = of('neighborhood').map((l) => ({ key: l.key }));
    return g;
  };
  const inc = geo(false);
  const t: Record<string, unknown> = { geo_locations: { ...inc, location_types: a.locationTypes.length ? a.locationTypes : ['home', 'recent'] } };
  if (!Object.keys(inc).length) (t.geo_locations as Record<string, unknown>).countries = ['BR'];
  const exc = geo(true);
  if (Object.keys(exc).length) t.excluded_geo_locations = exc;
  t.age_min = a.advantage ? Math.min(a.ageMin, 25) : a.ageMin;
  if (!a.advantage) t.age_max = a.ageMax;
  if (a.genders) t.genders = [a.genders];
  if (a.locales.length) t.locales = a.locales.map((l) => l.key);
  if (a.customInclude.length) t.custom_audiences = a.customInclude.map((c) => ({ id: c.id }));
  if (a.customExclude.length) t.excluded_custom_audiences = a.customExclude.map((c) => ({ id: c.id }));
  const byType = (list: Pick[]) => {
    const o: Record<string, { id: string; name: string }[]> = {};
    for (const x of list) (o[x.type || 'interests'] ??= []).push({ id: x.id, name: x.name });
    return o;
  };
  const groups = a.detailed.filter((g) => g.length);
  if (groups.length) t.flexible_spec = groups.map(byType);
  if (a.exclude.length) t.exclusions = byType(a.exclude);
  t.targeting_automation = { advantage_audience: a.advantage ? 1 : 0 };
  if (!p.advantage) {
    t.device_platforms = p.devices;
    t.publisher_platforms = p.platforms;
    for (const pl of PLACEMENTS) if (p.platforms.includes(pl.platform)) t[pl.key] = p.positions[pl.platform] ?? [];
  }
  return t;
}

function promotedObject(o: Objective, s: AdsetDraft): Record<string, unknown> | undefined {
  const goal = goalOf(o, s.destination, s.goal).id;
  const needs = needsOf(o, s.destination, goal);
  const po: Record<string, unknown> = {};
  if (needs.includes('pixel') && s.pixelId) {
    po.pixel_id = s.pixelId;
    if (s.customConversionId) { po.custom_conversion_id = s.customConversionId; po.custom_event_type = 'OTHER'; } else po.custom_event_type = s.event || 'PURCHASE';
  }
  if (needs.includes('app')) {
    if (s.appId) po.application_id = s.appId;
    if (s.storeUrl) po.object_store_url = s.storeUrl;
    if (goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE') po.custom_event_type = s.appEvent || 'PURCHASE';
  }
  if (needs.includes('page') && s.pageId) po.page_id = s.pageId;
  if (needs.includes('whatsapp') && digits(s.whatsapp)) po.whatsapp_phone_number = `+${digits(s.whatsapp)}`;
  return Object.keys(po).length ? po : undefined;
}

export function campaignFields(c: CampaignDraft): Record<string, unknown> {
  const f: Record<string, unknown> = {
    name: c.name.trim(), objective: c.objective, status: c.status, buying_type: 'AUCTION',
    special_ad_categories: c.specialCategories, ...(c.specialCategories.length ? { special_ad_category_country: ['BR'] } : {}),
    spend_cap: c.spendCap,
  };
  if (c.cbo) {
    f[c.budgetKind === 'daily' ? 'daily_budget' : 'lifetime_budget'] = c.budget;
    f.bid_strategy = c.bidStrategy;
  } else {
    f.is_adset_budget_sharing_enabled = false;
  }
  return f;
}

export function adsetFields(o: Objective, c: CampaignDraft, s: AdsetDraft): Record<string, unknown> {
  const goal = goalOf(o, s.destination, s.goal);
  const f: Record<string, unknown> = {
    name: s.name.trim(), status: s.status, optimization_goal: goal.id, billing_event: 'IMPRESSIONS',
    targeting: buildTargeting(s.audience, s.placements),
  };
  if (s.destination) f.destination_type = s.destination;
  const po = promotedObject(o, s);
  if (po) f.promoted_object = po;
  if (goal.id === 'OFFSITE_CONVERSIONS' || goal.id === 'VALUE') f.attribution_spec = ATTRIBUTION.find((a) => a.id === s.attribution)?.spec ?? ATTRIBUTION[0].spec;
  const strategy = c.cbo ? c.bidStrategy : s.bidStrategy;
  if (!c.cbo) {
    f.bid_strategy = s.bidStrategy;
    f[s.budgetKind === 'daily' ? 'daily_budget' : 'lifetime_budget'] = s.budget;
  } else {
    if (s.minSpend) f[c.budgetKind === 'daily' ? 'daily_min_spend_target' : 'lifetime_min_spend_target'] = s.minSpend;
    if (s.maxSpend) f[c.budgetKind === 'daily' ? 'daily_spend_cap' : 'lifetime_spend_cap'] = s.maxSpend;
  }
  if (strategy === 'COST_CAP' || strategy === 'LOWEST_COST_WITH_BID_CAP') f.bid_amount = s.bidAmount;
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS' && s.roas) f.bid_constraints = { roas_average_floor: Math.round(s.roas * 10000) };
  if (s.start) f.start_time = iso(s.start);
  f.end_time = s.end ? iso(s.end) : (s.id ? null : undefined);
  if (s.frequency && (goal.id === 'REACH')) f.frequency_control_specs = [{ event: 'IMPRESSIONS', interval_days: s.frequency.days, max_frequency: s.frequency.impressions }];
  if (s.beneficiary.trim()) f.dsa_beneficiary = s.beneficiary.trim();
  if (s.payor.trim()) f.dsa_payor = s.payor.trim();
  if (o === 'OUTCOME_SALES' && s.lifecycle && !c.specialCategories.length) f.ad_set_goal = { type: LIFECYCLE_TYPE[s.lifecycle] };
  return f;
}

/** Destino do botão a partir do local da conversão do conjunto. */
function ctaFor(o: Objective, s: AdsetDraft, a: AdDraft): { link: string; cta: Record<string, unknown> | null; welcome: string | null } {
  const d = s.destination;
  const welcome = () => JSON.stringify({
    type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text',
    text_format: { customer_action_type: 'autofill_message', message: { text: a.greeting.trim(), autofill_message: { content: a.prefill.trim() } } },
  });
  if (d === 'WHATSAPP') return { link: WA_LINK, cta: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } }, welcome: welcome() };
  if (d === 'MESSENGER') return { link: 'https://fb.com/messenger_doc/', cta: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER' } }, welcome: null };
  if (d === 'INSTAGRAM_DIRECT') return { link: 'https://www.instagram.com', cta: { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT' } }, welcome: null };
  if (d.startsWith('MESSAGING_')) return { link: d.includes('WHATSAPP') ? WA_LINK : 'https://fb.com/messenger_doc/', cta: { type: d.includes('WHATSAPP') ? 'WHATSAPP_MESSAGE' : 'MESSAGE_PAGE' }, welcome: d.includes('WHATSAPP') ? welcome() : null };
  if (d === 'ON_AD' && o === 'OUTCOME_LEADS') return { link: 'http://fb.me/', cta: { type: a.cta === 'LEARN_MORE' ? 'SIGN_UP' : a.cta, value: { lead_gen_form_id: a.leadFormId } }, welcome: null };
  if (d === 'PHONE_CALL') { const tel = `tel:+${digits(a.phone)}`; return { link: tel, cta: { type: 'CALL_NOW', value: { link: tel } }, welcome: null }; }
  const link = a.link.trim() || (s.pageId ? `https://www.facebook.com/${s.pageId}` : '');
  return { link, cta: a.cta === 'NO_BUTTON' ? null : { type: a.cta, value: { link } }, welcome: null };
}

export const multiText = (a: AdDraft) => a.texts.filter((t) => t.trim()).length > 1 || a.headlines.filter((t) => t.trim()).length > 1;
/** usa o formato flexível da Meta (asset_feed_spec): vários textos, várias mídias ou mídia própria para Stories/Reels */
export const usesFeed = (a: AdDraft) => a.format === 'single' && !!a.media && (multiText(a) || a.extraMedia.length > 0 || !!a.storyMedia);
const cropsOf = (m: Media | null | undefined) => (m?.crops && Object.keys(m.crops).length ? { image_crops: m.crops } : {});
const STORY_RULE = { publisher_platforms: ['facebook', 'instagram', 'messenger'], facebook_positions: ['story', 'facebook_reels'], instagram_positions: ['story', 'reels'], messenger_positions: ['story'] };
const FEED_RULE = { publisher_platforms: ['facebook', 'instagram', 'audience_network', 'messenger'], facebook_positions: ['feed', 'profile_feed', 'marketplace', 'video_feeds', 'right_hand_column', 'search', 'instream_video'], instagram_positions: ['stream', 'profile_feed', 'explore', 'explore_home', 'ig_search'], audience_network_positions: ['classic'], messenger_positions: ['messenger_home'] };
/** Várias opções de texto (otimização de texto da Meta) só com destino de site/app. */
export const multiTextAllowed = (s: AdsetDraft) => ['WEBSITE', 'APP', ''].includes(s.destination);

export function creativeFields(o: Objective, s: AdsetDraft, a: AdDraft): Record<string, unknown> {
  const pageId = a.pageId || s.pageId;
  const { link, cta, welcome } = ctaFor(o, s, a);
  const story: Record<string, unknown> = { page_id: pageId, ...(a.igId ? { instagram_user_id: a.igId } : {}) };
  const text = a.texts[0]?.trim() ?? ''; const title = a.headlines[0]?.trim() ?? '';
  const f: Record<string, unknown> = { name: `${a.name.trim()} — Criativo`, contextual_multi_ads: { enroll_status: a.multiAdvertiser ? 'OPT_IN' : 'OPT_OUT' } };
  if (a.urlTags.trim()) f.url_tags = a.urlTags.trim().replace(/^\?/, '');

  // publicação que já existe: Facebook (id da publicação) ou Instagram (id da mídia)
  if (a.source === 'existing') {
    if (a.igMediaId) {
      Object.assign(f, { object_id: pageId, instagram_user_id: a.igId, source_instagram_media_id: a.igMediaId, ...(cta && link.startsWith('http') ? { call_to_action: cta } : {}) });
    } else {
      f.object_story_id = a.postId.includes('_') ? a.postId : `${pageId}_${a.postId}`;
      if (cta && !s.destination.includes('WHATSAPP') && link.startsWith('http')) f.call_to_action = cta;
    }
    return f;
  }

  if (usesFeed(a) && multiTextAllowed(s) && a.media) {
    const all = [a.media, ...a.extraMedia];
    const imgs = all.filter((m) => m.kind === 'image'); const vids = all.filter((m) => m.kind === 'video');
    const story_ = a.storyMedia;
    const label = (m: Media, i: number) => (story_ ? { adlabels: [{ name: i === -1 ? 'cz_story' : 'cz_feed' }] } : {});
    const img = (m: Media, i: number) => ({ hash: m.hash, ...cropsOf(m), ...label(m, i) });
    const vid = (m: Media, i: number) => ({ video_id: m.videoId, ...(m.thumbHash ? { thumbnail_hash: m.thumbHash } : { thumbnail_url: m.url }), ...label(m, i) });
    const images = imgs.map((m) => img(m, 0)); const videos = vids.map((m) => vid(m, 0));
    if (story_) (story_.kind === 'image' ? images : videos).push(story_.kind === 'image' ? img(story_, -1) as never : vid(story_, -1) as never);
    f.object_story_spec = story;
    f.asset_feed_spec = {
      bodies: a.texts.filter((t) => t.trim()).map((t) => ({ text: t.trim() })),
      titles: a.headlines.filter((t) => t.trim()).map((t) => ({ text: t.trim() })),
      ...(a.description.trim() ? { descriptions: [{ text: a.description.trim() }] } : {}),
      ...(images.length ? { images } : {}), ...(videos.length ? { videos } : {}),
      link_urls: [{ website_url: link, ...(a.displayLink.trim() ? { display_url: a.displayLink.trim() } : {}) }],
      call_to_action_types: [cta ? String(cta.type) : 'LEARN_MORE'],
      ad_formats: [...new Set([...(images.length ? ['SINGLE_IMAGE'] : []), ...(videos.length ? ['SINGLE_VIDEO'] : [])])],
      optimization_type: story_ ? 'PLACEMENT' : 'DEGREES_OF_FREEDOM',
      ...(story_ ? {
        asset_customization_rules: [
          { customization_spec: FEED_RULE, [`${a.media.kind}_label`]: { name: 'cz_feed' }, priority: 1 },
          { customization_spec: STORY_RULE, [`${story_.kind}_label`]: { name: 'cz_story' }, priority: 2 },
        ],
      } : {}),
    };
    return f;
  }

  if (a.format === 'carousel') {
    story.link_data = {
      link, message: text, multi_share_optimized: true, multi_share_end_card: false,
      child_attachments: a.cards.map((c) => {
        const l = c.link.trim() || link;
        return {
          link: l, name: c.headline.trim() || title, ...(c.description.trim() ? { description: c.description.trim() } : {}),
          ...(c.media?.kind === 'video' ? { video_id: c.media.videoId, picture: c.media.url } : { image_hash: c.media?.hash, ...cropsOf(c.media) }),
          ...(cta ? { call_to_action: { ...cta, ...(cta.value && (cta.value as Record<string, unknown>).link ? { value: { ...(cta.value as Record<string, unknown>), link: l } } : {}) } } : {}),
        };
      }),
      ...(cta ? { call_to_action: cta } : {}),
      ...(welcome ? { page_welcome_message: welcome } : {}),
    };
  } else if (a.media?.kind === 'video') {
    story.video_data = {
      video_id: a.media.videoId, ...(a.media.thumbHash ? { image_hash: a.media.thumbHash } : a.media.url ? { image_url: a.media.url } : {}), message: text, title,
      ...(a.description.trim() ? { link_description: a.description.trim() } : {}),
      ...(cta ? { call_to_action: { ...cta, value: { ...((cta.value as Record<string, unknown>) ?? {}), ...(link.startsWith('http') ? { link } : {}) } } } : {}),
      ...(welcome ? { page_welcome_message: welcome } : {}),
    };
  } else {
    story.link_data = {
      image_hash: a.media?.hash, ...cropsOf(a.media), link, message: text, name: title,
      ...(a.description.trim() ? { description: a.description.trim() } : {}),
      ...(a.displayLink.trim() ? { caption: a.displayLink.trim() } : {}),
      ...(cta ? { call_to_action: cta } : {}),
      ...(welcome ? { page_welcome_message: welcome } : {}),
    };
  }
  f.object_story_spec = story;
  return f;
}

export function adFields(s: AdsetDraft, a: AdDraft, o: Objective): Record<string, unknown> {
  const f: Record<string, unknown> = { name: a.name.trim(), status: a.status };
  const goal = goalOf(o, s.destination, s.goal).id;
  // rastreamento: eventos do site (pixel) e do app
  const specs: Record<string, unknown>[] = [];
  const pixel = a.trackPixelId || (needsOf(o, s.destination, goal).includes('pixel') ? s.pixelId : '');
  if (a.trackSite && pixel) specs.push({ 'action.type': ['offsite_conversion'], fb_pixel: [pixel] });
  const app = a.trackAppId || s.appId;
  if (a.trackApp && app) specs.push({ 'action.type': ['app_custom_event'], application: [app] }, { 'action.type': ['mobile_app_install'], application: [app] });
  if (specs.length) f.tracking_specs = specs;
  return f;
}

/** Só os campos que mudaram (editar o que já existe não manda o resto). */
function diff(now: Record<string, unknown>, before: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!before) return now;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) {
    if (v === undefined) continue;
    const b = before[k];
    const same = JSON.stringify(v ?? null) === JSON.stringify(b ?? null) || ((v === null || v === 0) && (b === null || b === undefined || b === 0));
    if (!same) out[k] = v;
  }
  return out;
}

export interface PublishBody {
  actId: string; flowId: string | null;
  tree: { campaign: { id: string | null; fields: Record<string, unknown> }; adsets: { key: string; id: string | null; fields: Record<string, unknown>; ads: { key: string; id: string | null; fields: Record<string, unknown>; creative: Record<string, unknown> | null; creativeId: string | null }[] }[]; remove: string[] };
}

/** Rascunho → o que o servidor publica. `orig` são os campos que vieram da Meta (para mandar só o que mudou). */
export function toPublish(d: Draft): PublishBody {
  const o = d.campaign.objective;
  const orig = (d.orig ?? {}) as Record<string, Record<string, unknown>>;
  const strip = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  const cf = campaignFields(d.campaign);
  if (d.campaign.id) { delete cf.objective; delete cf.buying_type; delete cf.is_adset_budget_sharing_enabled; }
  return {
    actId: d.actId, flowId: d.campaign.flowId,
    tree: {
      campaign: { id: d.campaign.id, fields: d.campaign.id ? diff(cf, orig[d.campaign.id]) : strip(cf) },
      adsets: d.adsets.map((s) => {
        const sf = adsetFields(o, d.campaign, s);
        if (s.id) { delete sf.destination_type; delete sf.billing_event; }
        return {
          key: s.key, id: s.id, fields: s.id ? diff(sf, orig[s.id]) : strip(sf),
          ads: s.ads.map((a) => {
            const af = adFields(s, a, o);
            return { key: a.key, id: a.id, fields: a.id ? diff(af, orig[a.id]) : af, creative: a.dirty || !a.creativeId ? creativeFields(o, s, a) : null, creativeId: a.dirty ? null : a.creativeId };
          }),
        };
      }),
      remove: d.remove,
    },
  };
}

/* ------------------------------------------------------------------ Meta → rascunho (editar) */

type R = Record<string, unknown>;
const arr = <T = R>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const localOf = (isoStr: unknown) => {
  if (typeof isoStr !== 'string' || !isoStr) return '';
  const dt = new Date(isoStr); if (Number.isNaN(dt.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
};

export function audienceFrom(t: R | null | undefined): { audience: AudienceDraft; placements: PlacementsDraft } {
  const a = defaultAudience(); const p = defaultPlacements();
  if (!t) return { audience: a, placements: p };
  const geos = (g: R | undefined, exclude: boolean): Geo[] => {
    if (!g) return [];
    const out: Geo[] = arr<string>(g.countries).map((c) => ({ key: c, name: c === 'BR' ? 'Brasil' : c, type: 'country', countryCode: c, exclude }));
    for (const [field, type] of [['regions', 'region'], ['cities', 'city'], ['zips', 'zip'], ['geo_markets', 'geo_market'], ['neighborhoods', 'neighborhood']] as const) {
      for (const x of arr(g[field])) out.push({ key: String(x.key), name: String(x.name ?? x.key) + (x.region ? `, ${x.region}` : ''), type, countryCode: (x.country as string) ?? null, radius: Number(x.radius) || null, exclude });
    }
    return out;
  };
  a.locations = [...geos(t.geo_locations as R, false), ...geos(t.excluded_geo_locations as R, true)];
  const lt = arr<string>((t.geo_locations as R | undefined)?.location_types).filter((x) => ['home', 'recent', 'travel_in'].includes(x)) as AudienceDraft['locationTypes'];
  if (lt.length) a.locationTypes = lt;
  a.ageMin = Number(t.age_min) || 18; a.ageMax = Number(t.age_max) || 65;
  const g = arr<number>(t.genders); a.genders = g.length === 1 ? (g[0] as 1 | 2) : 0;
  a.locales = arr<number>(t.locales).map((k) => ({ key: Number(k), name: `Idioma ${k}` }));
  a.customInclude = arr(t.custom_audiences).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
  a.customExclude = arr(t.excluded_custom_audiences).map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
  const picks = (o: R | undefined): Pick[] => Object.entries(o ?? {}).flatMap(([type, list]) => arr(list).map((x) => ({ id: String(x.id), name: String(x.name ?? x.id), type })));
  const flex = arr(t.flexible_spec).map(picks).filter((x) => x.length);
  a.detailed = flex.length ? flex : [[]];
  a.exclude = picks(t.exclusions as R);
  a.advantage = Number((t.targeting_automation as R | undefined)?.advantage_audience) === 1;
  if (arr(t.publisher_platforms).length) {
    p.advantage = false;
    p.platforms = arr<string>(t.publisher_platforms);
    p.devices = arr<string>(t.device_platforms).length ? arr<string>(t.device_platforms) as PlacementsDraft['devices'] : ['mobile', 'desktop'];
    for (const pl of PLACEMENTS) p.positions[pl.platform] = arr<string>(t[pl.key]).length ? arr<string>(t[pl.key]) : pl.positions.map((x) => x[0]);
  }
  return { audience: a, placements: p };
}

export interface RemoteTree {
  currency: string; flowId: string | null;
  campaign: { id: string; fields: R };
  adsets: { id: string; fields: R; ads: { id: string; fields: R; creative: R | null; creativeId: string | null; thumbnail: string | null }[] }[];
}

function adFrom(x: RemoteTree['adsets'][number]['ads'][number]): AdDraft {
  const cr = x.creative ?? {};
  const story = (cr.object_story_spec ?? {}) as R;
  const ld = (story.link_data ?? null) as R | null;
  const vd = (story.video_data ?? null) as R | null;
  const ctaO = ((ld?.call_to_action ?? vd?.call_to_action) ?? null) as R | null;
  const val = (ctaO?.value ?? {}) as R;
  let greeting = ''; let prefill = '';
  try {
    const w = JSON.parse(String(ld?.page_welcome_message ?? vd?.page_welcome_message ?? '{}')) as R;
    const m = ((w.text_format as R | undefined)?.message ?? {}) as R;
    greeting = String(m.text ?? ''); prefill = String(((m.autofill_message as R | undefined)?.content) ?? '');
  } catch { /* sem mensagem */ }
  const children = arr(ld?.child_attachments);
  const link = String(val.link ?? ld?.link ?? '');
  const base = newAd('OUTCOME_ENGAGEMENT', 1, {
    key: newKey('a'), id: x.id, name: String(x.fields.name ?? ''), status: x.fields.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    pageId: String(story.page_id ?? ''), igId: String(story.instagram_user_id ?? story.instagram_actor_id ?? ''),
    creativeId: x.creativeId, dirty: false, thumbnail: x.thumbnail,
    cta: String(ctaO?.type ?? 'LEARN_MORE'), link: link.startsWith('http') && !link.includes('api.whatsapp.com') && !link.includes('messenger_doc') ? link : '',
    urlTags: String(cr.url_tags ?? ''), leadFormId: String(val.lead_gen_form_id ?? ''), phone: link.startsWith('tel:') ? link.slice(4) : '',
    ...(greeting ? { greeting } : {}), ...(prefill ? { prefill } : {}),
  });
  const multi = (cr.contextual_multi_ads as R | undefined)?.enroll_status;
  if (multi) base.multiAdvertiser = multi !== 'OPT_OUT';
  const tracks = arr(x.fields.tracking_specs);
  const px = tracks.find((t) => arr(t.fb_pixel).length); const ap = tracks.find((t) => arr(t.application).length);
  base.trackSite = !!px || !tracks.length; base.trackPixelId = px ? String(arr(px.fb_pixel)[0]) : '';
  base.trackApp = !!ap; base.trackAppId = ap ? String(arr(ap.application)[0]) : '';
  if (cr.object_story_id && !ld && !vd) return { ...base, source: 'existing', postId: String(cr.object_story_id), postPicture: x.thumbnail };
  if (cr.source_instagram_media_id) return { ...base, source: 'existing', igMediaId: String(cr.source_instagram_media_id), igId: String(cr.instagram_user_id ?? base.igId), postPicture: x.thumbnail };
  if (cr.asset_feed_spec || (!ld && !vd)) return { ...base, foreign: true };
  if (children.length) {
    return {
      ...base, format: 'carousel', texts: [String(ld?.message ?? '')], headlines: [String(children[0]?.name ?? '')],
      cards: children.map((c) => ({
        key: newKey('c'), headline: String(c.name ?? ''), description: String(c.description ?? ''), link: String(c.link ?? ''),
        media: c.video_id ? { kind: 'video', videoId: String(c.video_id), url: (c.picture as string) ?? null } : { kind: 'image', hash: String(c.image_hash ?? ''), url: (c.picture as string) ?? null },
      })),
    };
  }
  if (vd) {
    return { ...base, texts: [String(vd.message ?? '')], headlines: [String(vd.title ?? '')], description: String(vd.link_description ?? ''),
      media: { kind: 'video', videoId: String(vd.video_id ?? ''), url: (vd.image_url as string) ?? x.thumbnail } };
  }
  return {
    ...base, texts: [String(ld?.message ?? '')], headlines: [String(ld?.name ?? '')], description: String(ld?.description ?? ''), displayLink: String(ld?.caption ?? ''),
    media: { kind: 'image', hash: String(ld?.image_hash ?? ''), url: x.thumbnail, ...(ld?.image_crops ? { crops: ld.image_crops as Record<string, Crop> } : {}) },
  };
}

export function draftFrom(actId: string, t: RemoteTree): Draft {
  const cf = t.campaign.fields;
  const o = (OBJECTIVES.some((x) => x.id === cf.objective) ? cf.objective : 'OUTCOME_ENGAGEMENT') as Objective;
  const cbo = Number(cf.daily_budget) > 0 || Number(cf.lifetime_budget) > 0;
  const orig: R = {};
  const d: Draft = {
    actId, currency: t.currency, remove: [], orig,
    campaign: {
      id: t.campaign.id, name: String(cf.name ?? ''), objective: o, status: cf.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
      specialCategories: arr<string>(cf.special_ad_categories).filter((c) => c !== 'NONE'), cbo,
      budgetKind: Number(cf.lifetime_budget) > 0 ? 'lifetime' : 'daily', budget: (cf.daily_budget as number) ?? (cf.lifetime_budget as number) ?? null,
      bidStrategy: String(cf.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'), spendCap: (cf.spend_cap as number) ?? null, flowId: t.flowId,
    },
    adsets: t.adsets.map((s) => {
      const f = s.fields; const po = (f.promoted_object ?? {}) as R;
      const { audience, placements } = audienceFrom(f.targeting as R);
      const att = JSON.stringify(f.attribution_spec ?? null);
      const fc = arr(f.frequency_control_specs)[0];
      return {
        key: newKey('s'), id: s.id, name: String(f.name ?? ''), status: f.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
        destination: String(f.destination_type ?? (o === 'OUTCOME_AWARENESS' ? '' : 'UNDEFINED')).replace('UNDEFINED', ''),
        goal: String(f.optimization_goal ?? ''), pageId: String(po.page_id ?? ''), whatsapp: String(po.whatsapp_phone_number ?? ''),
        pixelId: String(po.pixel_id ?? ''), customConversionId: String(po.custom_conversion_id ?? ''), event: String(po.custom_event_type ?? 'PURCHASE'), appId: String(po.application_id ?? ''), storeUrl: String(po.object_store_url ?? ''),
        appEvent: String(po.custom_event_type ?? 'PURCHASE'),
        attribution: ATTRIBUTION.find((a) => JSON.stringify(a.spec) === att)?.id ?? '7c1v',
        bidStrategy: String(f.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'), bidAmount: (f.bid_amount as number) ?? null,
        roas: Number((f.bid_constraints as R | undefined)?.roas_average_floor) / 10000 || null,
        budgetKind: Number(f.lifetime_budget) > 0 ? 'lifetime' : 'daily', budget: (f.daily_budget as number) ?? (f.lifetime_budget as number) ?? null,
        minSpend: (f.daily_min_spend_target as number) ?? (f.lifetime_min_spend_target as number) ?? null,
        maxSpend: (f.daily_spend_cap as number) ?? (f.lifetime_spend_cap as number) ?? null,
        start: localOf(f.start_time), end: localOf(f.end_time), audience, placements,
        frequency: fc ? { impressions: Number(fc.max_frequency) || 2, days: Number(fc.interval_days) || 7 } : null,
        beneficiary: '', payor: '', lifecycle: lifecycleOf((f.ad_set_goal as R | undefined)?.type),
        ads: s.ads.map(adFrom),
      };
    }),
  };
  // o que a Meta tem hoje (no mesmo formato que o editor manda), para publicar só o que mudar
  orig[t.campaign.id] = campaignFields(d.campaign);
  for (const s of d.adsets) {
    orig[s.id!] = adsetFields(o, d.campaign, s);
    for (const a of s.ads) orig[a.id!] = adFields(s, a, o);
  }
  return d;
}

/* ------------------------------------------------------------------ conferência */

export interface Issue { key: string; level: 'campaign' | 'adset' | 'ad'; msg: string }

export function validate(d: Draft): Issue[] {
  const o = d.campaign.objective; const out: Issue[] = [];
  const c = d.campaign;
  if (!c.name.trim()) out.push({ key: 'campaign', level: 'campaign', msg: 'Dê um nome à campanha.' });
  if (c.cbo && !(Number(c.budget) > 0)) out.push({ key: 'campaign', level: 'campaign', msg: 'Informe o orçamento da campanha.' });
  if (!d.adsets.length) out.push({ key: 'campaign', level: 'campaign', msg: 'A campanha precisa de pelo menos um conjunto de anúncios.' });
  for (const s of d.adsets) {
    const add = (msg: string) => out.push({ key: s.key, level: 'adset', msg });
    const goal = goalOf(o, s.destination, s.goal);
    const needs = needsOf(o, s.destination, goal.id);
    if (!s.name.trim()) add('Dê um nome ao conjunto.');
    if (!c.cbo && !(Number(s.budget) > 0)) add('Informe o orçamento do conjunto.');
    const kind = c.cbo ? c.budgetKind : s.budgetKind;
    if (kind === 'lifetime' && !s.end) add('Orçamento total precisa de data de término.');
    if (s.end && new Date(s.end).getTime() < Math.max(Date.now(), s.start ? new Date(s.start).getTime() : 0) + 3600_000) add('O término precisa ser pelo menos 1 hora depois do início.');
    if (needs.includes('page') && !s.pageId) add('Escolha a Página do Facebook.');
    if (needs.includes('pixel') && !s.pixelId) add('Escolha o conjunto de dados (pixel) e o evento de conversão.');
    if (needs.includes('app') && (!s.appId || !s.storeUrl)) add('Escolha o app e a loja.');
    const strategy = c.cbo ? c.bidStrategy : s.bidStrategy;
    if ((strategy === 'COST_CAP' || strategy === 'LOWEST_COST_WITH_BID_CAP') && !(Number(s.bidAmount) > 0)) add('Informe a meta de custo / o limite de lance.');
    if (strategy === 'LOWEST_COST_WITH_MIN_ROAS' && !(Number(s.roas) > 0)) add('Informe a meta de ROAS.');
    if (!s.audience.advantage && s.audience.ageMin > s.audience.ageMax) add('A idade mínima está maior que a máxima.');
    if (!s.audience.locations.some((l) => !l.exclude)) add('Escolha pelo menos um local.');
    if (!s.placements.advantage && !s.placements.platforms.length) add('Escolha pelo menos uma plataforma nos posicionamentos.');
    if (!s.ads.length) add('O conjunto precisa de pelo menos um anúncio.');
    for (const a of s.ads) {
      const ad = (msg: string) => out.push({ key: a.key, level: 'ad', msg });
      if (!a.name.trim()) ad('Dê um nome ao anúncio.');
      if (!a.dirty && a.creativeId) continue;
      if (a.foreign && !a.dirty) continue;
      if (!(a.pageId || s.pageId)) ad('Escolha a Página do Facebook (identidade).');
      if (a.source === 'existing') {
        if (!a.postId && !a.igMediaId) ad('Escolha a publicação que vai virar anúncio.');
        if (a.igMediaId && !a.igId) ad('Escolha a conta do Instagram da publicação.');
        continue;
      }
      if ((a.extraMedia.length || a.storyMedia) && !multiTextAllowed(s)) ad('Várias mídias e mídia própria para Stories só funcionam com destino Site ou App.');
      if (a.storyMedia?.kind === 'video' && !a.storyMedia.url) ad('O vídeo dos Stories ainda está sendo processado.');
      if (a.format === 'single' && !a.media) ad('Escolha a imagem ou o vídeo.');
      if (a.format === 'carousel') {
        if (a.cards.length < 2) ad('O carrossel precisa de pelo menos 2 cartões.');
        if (a.cards.some((x) => !x.media)) ad('Todos os cartões do carrossel precisam de imagem ou vídeo.');
      }
      if (a.media?.kind === 'video' && !a.media.url) ad('O vídeo ainda está sendo processado pela Meta (falta a capa).');
      if (!a.texts[0]?.trim()) ad('Escreva o texto principal.');
      if (s.destination === 'WEBSITE' && !/^https?:\/\/\S+\.\S+/.test(a.link.trim())) ad('Informe o link do site (começando com https://).');
      if (s.destination === 'APP' && !a.link.trim() && !s.storeUrl) ad('Informe o link do app.');
      if (s.destination === 'ON_AD' && o === 'OUTCOME_LEADS' && !a.leadFormId) ad('Escolha o formulário instantâneo.');
      if (s.destination === 'PHONE_CALL' && digits(a.phone).length < 10) ad('Informe o telefone com DDD e código do país (ex.: 55 11 99999-9999).');
      if ((s.destination === 'WHATSAPP' || s.destination.includes('WHATSAPP')) && (!a.greeting.trim() || !a.prefill.trim())) ad('Escreva a saudação e a mensagem do WhatsApp.');
      if (multiText(a) && !multiTextAllowed(s)) ad('Várias opções de texto só funcionam com destino Site ou App. Deixe um texto e um título.');
    }
  }
  return out;
}
