/**
 * Pixels (sem rede, testável): plataformas, eventos aceitos, regras e o corpo de cada envio.
 * Dados pessoais vão sempre em SHA-256, no formato que cada plataforma pede.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

export type Platform = 'meta' | 'meta_whatsapp' | 'tiktok';
export type Trigger = 'lead' | 'sale' | 'stage';
export type LeadScope = 'ad' | 'whatsapp' | 'all';

export const PLATFORMS: Record<Platform, { label: string; events: string[] }> = {
  meta: {
    label: 'Meta (Facebook/Instagram)',
    events: ['Lead', 'Purchase', 'Contact', 'CompleteRegistration', 'Schedule', 'SubmitApplication', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'Subscribe', 'StartTrial'],
  },
  // API de Conversões para mensagens comerciais: só esses nomes são aceitos com action_source = business_messaging
  meta_whatsapp: {
    label: 'Meta — WhatsApp (clique para o WhatsApp)',
    events: ['LeadSubmitted', 'QualifiedLead', 'Purchase', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'OrderCreated', 'OrderShipped', 'OrderDelivered', 'OrderCanceled', 'OrderReturned'],
  },
  tiktok: {
    label: 'TikTok',
    events: ['Lead', 'Purchase', 'Contact', 'CompleteRegistration', 'Schedule', 'SubmitApplication', 'InitiateCheckout', 'AddToCart', 'ViewContent', 'Subscribe', 'StartTrial', 'ApplicationApproval'],
  },
};

export const isPlatform = (p: unknown): p is Platform => typeof p === 'string' && p in PLATFORMS;

export interface Rule { id: string; trigger: Trigger; scope?: LeadScope; boardId?: string | null; columnId?: string | null; event: string }

export function defaultRules(platform: Platform): Rule[] {
  return [
    { id: 'lead', trigger: 'lead', scope: 'ad', event: platform === 'meta_whatsapp' ? 'LeadSubmitted' : 'Lead' },
    { id: 'sale', trigger: 'sale', event: 'Purchase' },
  ];
}

const uuid = z.string().uuid();
export const ruleSchema = z.object({
  id: z.string().trim().min(1).max(40),
  trigger: z.enum(['lead', 'sale', 'stage']),
  scope: z.enum(['ad', 'whatsapp', 'all']).optional(),
  boardId: uuid.nullable().optional(),
  columnId: uuid.nullable().optional(),
  event: z.string().trim().min(2).max(60),
});

/** Confere as regras para a plataforma (eventos aceitos, etapa do Kanban obrigatória…). */
export function checkRules(platform: Platform, rules: Rule[]): string | null {
  if (rules.length > 12) return 'No máximo 12 regras por pixel';
  for (const r of rules) {
    if (!PLATFORMS[platform].events.includes(r.event)) return `O evento “${r.event}” não é aceito por ${PLATFORMS[platform].label}`;
    if (r.trigger === 'stage' && !r.columnId) return 'Escolha a etapa do Kanban da regra';
    if (r.trigger === 'lead' && platform === 'meta_whatsapp' && r.scope && r.scope !== 'ad') {
      return 'Pelo WhatsApp, a Meta só aceita eventos de quem veio de um anúncio de clique para o WhatsApp';
    }
  }
  const ids = new Set(rules.map((r) => r.id));
  if (ids.size !== rules.length) return 'Regras repetidas';
  return null;
}

/* ------------------------------------------------------------------ quem dispara */

export interface TriggerCtx {
  contactId?: string | null; saleId?: string | null;
  /** lead: contato criado agora; newAdClick: contato antigo que voltou por um anúncio (novo ctwa_clid) */
  isNew?: boolean; newAdClick?: boolean; fromAd?: boolean; channel?: 'whatsapp' | 'webhook';
  ctwaClid?: string | null; columnId?: string | null;
}

/** A regra vale para este acontecimento? */
export function ruleMatches(r: Rule, trigger: Trigger, c: TriggerCtx): boolean {
  if (r.trigger !== trigger) return false;
  if (trigger === 'lead') {
    if (c.newAdClick) return true;
    if (!c.isNew) return false;
    const scope = r.scope ?? 'ad';
    if (scope === 'ad') return !!c.fromAd;
    if (scope === 'whatsapp') return c.channel === 'whatsapp';
    return true;
  }
  if (trigger === 'stage') return !!r.columnId && r.columnId === c.columnId;
  return true;
}

/** Chave contra duplicar: a mesma conversão sai uma vez só para cada pixel. */
export function eventKey(trigger: Trigger, c: TriggerCtx): string | null {
  if (trigger === 'lead') return c.contactId ? `lead:${c.contactId}:${c.ctwaClid ? c.ctwaClid.slice(0, 80) : 'novo'}` : null;
  if (trigger === 'sale') return c.saleId ? `sale:${c.saleId}` : null;
  return c.contactId && c.columnId ? `stage:${c.columnId}:${c.contactId}` : null;
}

/* ------------------------------------------------------------------ dados do cliente */

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Só dígitos, com o código do país (55 quando o número é brasileiro sem DDI). */
export function normPhone(p: string | null | undefined): string | null {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) return `55${d}`;
  return d;
}
export function normEmail(e: string | null | undefined): string | null {
  const v = String(e ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}
/** Nome em minúsculas, só letras (acentos ficam, em UTF-8). */
export function normNames(name: string | null | undefined, phone?: string | null): { fn: string | null; ln: string | null } {
  const raw = String(name ?? '').normalize('NFC').toLowerCase();
  if (!raw.trim() || (phone && raw.replace(/\D/g, '') === String(phone).replace(/\D/g, ''))) return { fn: null, ln: null };
  const parts = raw.split(/\s+/).map((w) => w.replace(/[^\p{L}]/gu, '')).filter(Boolean);
  if (!parts.length) return { fn: null, ln: null };
  return { fn: parts[0], ln: parts.length > 1 ? parts[parts.length - 1] : null };
}

export interface Person { id: string; name: string | null; phone: string | null; email: string | null; ctwaClid?: string | null; state?: string | null }
export interface Money { value: number; currency: string; product?: string | null; orderId?: string | null }

/** Campos do cliente para a Meta (pixel com action_source = chat). */
export function metaUserData(p: Person) {
  const ph = normPhone(p.phone);
  const em = normEmail(p.email);
  const { fn, ln } = normNames(p.name, p.phone);
  const ud: Record<string, string[]> = { external_id: [sha256(p.id)] };
  if (ph) ud.ph = [sha256(ph)];
  if (em) ud.em = [sha256(em)];
  if (fn) ud.fn = [sha256(fn)];
  if (ln) ud.ln = [sha256(ln)];
  if (ph?.startsWith('55')) ud.country = [sha256('br')];
  if (p.state && /^[A-Za-z]{2}$/.test(p.state)) ud.st = [sha256(p.state.toLowerCase())];
  return ud;
}

export interface BuildIn {
  platform: Platform; pixelId: string; wabaId?: string | null;
  event: string; key: string; time: Date; person: Person | null; money?: Money | null; testCode?: string | null;
  /** Página do Facebook ligada ao WhatsApp (bloco Pixel do fluxo, para conexões sem WABA). */
  pageId?: string | null;
}

/** Evento do pixel da Meta → nome aceito pela API de Conversões para mensagens comerciais (null = não tem). */
export function businessMessagingEvent(event: string): string | null {
  if (event === 'Lead') return 'LeadSubmitted';
  return PLATFORMS.meta_whatsapp.events.includes(event) ? event : null;
}
export type Built = { ok: true; body: Record<string, unknown>; preview: Record<string, unknown> } | { ok: false; skip: string };

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** Monta o envio de um evento para a plataforma do pixel (ou diz por que não dá para mandar). */
export function buildEvent(i: BuildIn): Built {
  const t = unix(i.time);
  const money = i.money && i.money.value > 0 ? i.money : null;
  if (i.platform === 'meta') {
    // cliente veio de um anúncio de clique para o WhatsApp e o bloco tem a Página: manda como mensagem comercial,
    // que a Meta atribui ao anúncio (sem isso, segue como evento de chat cruzado pelo telefone)
    const bmEvent = businessMessagingEvent(i.event);
    const pageId = String(i.pageId ?? '').replace(/\D/g, '');
    if (pageId && bmEvent && i.person?.ctwaClid) {
      const ev: Record<string, unknown> = {
        event_name: bmEvent, event_time: t, event_id: i.key, action_source: 'business_messaging', messaging_channel: 'whatsapp',
        user_data: { page_id: pageId, ctwa_clid: i.person.ctwaClid },
        ...(money ? { custom_data: { currency: money.currency, value: money.value } } : {}),
      };
      const body = { data: [ev], partner_agent: 'converza', ...(i.testCode ? { test_event_code: i.testCode } : {}) };
      return { ok: true, body, preview: body };
    }
    if (!i.person) return { ok: false, skip: 'Sem contato para identificar o cliente' };
    const user_data = metaUserData(i.person);
    if (!user_data.ph && !user_data.em) return { ok: false, skip: 'O contato não tem telefone nem e-mail para a Meta cruzar' };
    const ev: Record<string, unknown> = {
      event_name: i.event, event_time: t, event_id: i.key, action_source: 'chat', user_data,
      ...(money ? { custom_data: { currency: money.currency, value: money.value, ...(money.product ? { content_name: money.product } : {}), ...(money.orderId ? { order_id: money.orderId } : {}) } } : {}),
    };
    const body = { data: [ev], partner_agent: 'converza', ...(i.testCode ? { test_event_code: i.testCode } : {}) };
    return { ok: true, body, preview: body };
  }
  if (i.platform === 'meta_whatsapp') {
    if (!i.wabaId) return { ok: false, skip: 'A conexão do WhatsApp deste pixel não tem o ID da conta do WhatsApp Business' };
    const clid = i.person?.ctwaClid;
    if (!clid) return { ok: false, skip: 'O cliente não veio de um anúncio de clique para o WhatsApp (sem ctwa_clid)' };
    const ev: Record<string, unknown> = {
      event_name: i.event, event_time: t, event_id: i.key, action_source: 'business_messaging', messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: i.wabaId, ctwa_clid: clid },
      ...(money ? { custom_data: { currency: money.currency, value: money.value } } : {}),
    };
    const body = { data: [ev], partner_agent: 'converza', ...(i.testCode ? { test_event_code: i.testCode } : {}) };
    return { ok: true, body, preview: body };
  }
  // TikTok: telefone no formato +55..., tudo em SHA-256
  if (!i.person) return { ok: false, skip: 'Sem contato para identificar o cliente' };
  const ph = normPhone(i.person.phone);
  const em = normEmail(i.person.email);
  if (!ph && !em) return { ok: false, skip: 'O contato não tem telefone nem e-mail para o TikTok cruzar' };
  const user: Record<string, string> = { external_id: sha256(i.person.id) };
  if (ph) user.phone = sha256(`+${ph}`);
  if (em) user.email = sha256(em);
  const ev: Record<string, unknown> = {
    event: i.event, event_time: t, event_id: i.key, user,
    ...(money ? { properties: { currency: money.currency, value: money.value, content_type: 'product',
      ...(money.product ? { contents: [{ content_name: money.product, quantity: 1, price: money.value }] } : {}),
      ...(money.orderId ? { order_id: money.orderId } : {}) } } : {}),
  };
  const body = { event_source: 'web', event_source_id: i.pixelId, data: [ev], ...(i.testCode ? { test_event_code: i.testCode } : {}) };
  return { ok: true, body, preview: body };
}

/** Texto do gatilho para o histórico. */
export function triggerLabel(r: Pick<Rule, 'trigger' | 'scope'>): string {
  if (r.trigger === 'lead') return r.scope === 'all' ? 'Contato novo' : r.scope === 'whatsapp' ? 'Contato novo no WhatsApp' : 'Contato novo de anúncio';
  if (r.trigger === 'sale') return 'Venda aprovada';
  return 'Etapa do Kanban';
}

/* ------------------------------------------------------------------ Página do anúncio */

export type AdRead = {
  creative?: { effective_object_story_id?: string; object_story_spec?: { page_id?: string } };
  adcreatives?: { data?: { effective_object_story_id?: string; object_story_spec?: { page_id?: string } }[] };
};

/** Página dona do anúncio a partir da resposta da Graph (story id = "PAGEID_POSTID"). */
export function pageFromAd(a: AdRead): string | null {
  const creatives = [a.creative, ...(a.adcreatives?.data ?? [])].filter(Boolean) as NonNullable<AdRead['creative']>[];
  for (const c of creatives) {
    const direct = String(c.object_story_spec?.page_id ?? '').replace(/\D/g, '');
    if (direct) return direct;
    const story = String(c.effective_object_story_id ?? '');
    const m = /^(\d+)_\d+$/.exec(story);
    if (m) return m[1];
  }
  return null;
}

