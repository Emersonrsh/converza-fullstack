/**
 * Webhooks de entrada — parte pura (sem banco), testável:
 * ler caminhos do JSON recebido, detectar sozinho de onde vêm telefone/nome/venda,
 * aplicar o mapeamento, conferir as condições e montar o modelo de mensagem.
 */
import { normalizePhone, isEmail } from '../utils/phone';
import { mapSaleStatus, parseMoney } from './saleParsing';

export type SaleStatus = 'pending' | 'approved' | 'refused' | 'refunded';

export interface WebhookMapping {
  phone?: string; name?: string; email?: string;
  amount?: string; amountInCents?: boolean; status?: string; product?: string; transaction?: string; currency?: string; state?: string;
  event?: string;
  /** campos personalizados do contato (chave do campo → caminho) */
  fields?: { key: string; path: string }[];
  /** variáveis extras para o modelo e o fluxo ({{nome_da_variavel}}) */
  vars?: { name: string; path: string }[];
}

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'exists' | 'empty';
export interface WebhookCondition { path: string; op: ConditionOp; value?: string }

export interface TemplateVarValue { var: string; name?: string; value: string }
export interface TemplateAction {
  name: string; language: string;
  /** texto do corpo do modelo (com {{1}}/{{nome}}) para a prévia no chat */
  preview?: string;
  header?: ({ type: 'text' } & TemplateVarValue) | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  body?: TemplateVarValue[];
  buttons?: { index: number; subType: 'url' | 'copy_code'; value: string }[];
}

export interface WebhookActions {
  /** atualizar nome, e-mail e campos de quem já é contato (senão só preenche o que está vazio) */
  overwrite?: boolean;
  tags?: string[];
  removeTags?: string[];
  kanban?: { boardId: string; columnId: string } | null;
  /** registrar a venda quando o evento tiver valor (padrão: sim) */
  sale?: boolean;
  template?: TemplateAction | null;
  flowId?: string | null;
}

export interface Resolved {
  phone: string | null;
  rawPhone: string | null;
  name: string | null;
  email: string | null;
  amount: number;
  status: SaleStatus;
  statusRaw: string;
  product: string | null;
  transaction: string | null;
  currency: string;
  state: string | null;
  event: string | null;
  fields: Record<string, string>;
  vars: Record<string, string>;
  /** dados achados pela detecção automática (o caminho salvo não veio neste evento) */
  detected: string[];
}

/* ------------------------------------------------------------- caminhos */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "data.buyer.phone" / "items.0.name" → valor (aceita também a chave inteira com ponto, ex.: "e.mail"). */
export function getPath(obj: unknown, path: string): unknown {
  const p = String(path ?? '').trim();
  if (!p) return undefined;
  if (isObj(obj) && p in obj) return obj[p];
  let cur: unknown = obj;
  for (const k of p.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) { const i = Number(k); cur = Number.isInteger(i) ? cur[i] : undefined; continue; }
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

const asText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
};

export interface Leaf { path: string; value: string; kind: 'string' | 'number' | 'boolean' | 'null' }

/** Campos "folha" do JSON (o que dá para escolher no mapeamento), com uma prévia do valor. */
export function leaves(obj: unknown, max = 400, maxDepth = 8): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      if (depth >= maxDepth) return;
      v.slice(0, 20).forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), depth + 1));
      return;
    }
    if (isObj(v)) {
      if (depth >= maxDepth) return;
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if (!path) return;
    const kind = v === null ? 'null' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
    out.push({ path, value: asText(v).slice(0, 160), kind });
  };
  walk(obj, '', 0);
  return out;
}

/* ------------------------------------------------- detecção automática */

const KNOWN: Record<'phone' | 'name' | 'email' | 'amount' | 'status' | 'event' | 'product' | 'transaction' | 'currency' | 'state', string[]> = {
  phone: [
    'data.buyer.checkout_phone', 'data.buyer.phone', 'Customer.mobile', 'customer.phone', 'customer.whatsapp', 'customer.mobile',
    'customer.cellphone', 'customer.phone_number', 'buyer.checkout_phone', 'buyer.phone', 'client.phone', 'cliente.telefone',
    'cliente.celular', 'comprador.telefone', 'billing.phone', 'billing_address.phone', 'shipping_address.phone',
    'customer.default_address.phone', 'contact.phone', 'lead.phone', 'lead.telefone', 'phone', 'telefone', 'celular', 'whatsapp',
    'mobile', 'fone', 'phone_number',
  ],
  name: [
    'data.buyer.name', 'Customer.full_name', 'customer.name', 'customer.full_name', 'buyer.name', 'client.name', 'cliente.nome',
    'comprador.nome', 'contact.name', 'lead.name', 'lead.nome', 'name', 'nome', 'full_name', 'nome_completo', 'first_name',
  ],
  email: [
    'data.buyer.email', 'Customer.email', 'customer.email', 'buyer.email', 'client.email', 'cliente.email', 'comprador.email',
    'billing.email', 'contact.email', 'lead.email', 'email', 'e-mail', 'e_mail',
  ],
  amount: [
    'data.purchase.price.value', 'purchase.price.value', 'Commissions.charge_amount', 'order.total', 'order.total_price', 'total_price',
    'venda.valor', 'amount', 'value', 'valor', 'price', 'total', 'preco',
  ],
  status: ['data.purchase.status', 'order_status', 'status', 'payment_status', 'financial_status', 'venda.status', 'situacao'],
  event: ['event', 'webhook_event_type', 'event_type', 'evento', 'topic', 'type'],
  product: [
    'data.product.name', 'Product.product_name', 'product.name', 'product_name', 'produto.nome', 'produto', 'offer.name',
    'line_items.0.name', 'line_items.0.title', 'items.0.name',
  ],
  transaction: [
    'data.purchase.transaction', 'purchase.transaction', 'order_id', 'transaction', 'transaction_id', 'sale_id', 'venda.codigo', 'order.id', 'orderId',
  ],
  currency: ['data.purchase.price.currency_value', 'purchase.price.currency_value', 'Commissions.currency', 'currency', 'moeda', 'order.currency'],
  state: [
    'data.buyer.address.state', 'Customer.state', 'customer.state', 'customer.address.state', 'buyer.address.state', 'billing.state',
    'comprador.estado', 'address.state', 'estado', 'uf',
  ],
};

const present = (payload: unknown, path: string) => asText(getPath(payload, path)) !== '';
const lastKey = (path: string) => path.split('.').filter((k) => !/^\d+$/.test(k)).pop() ?? '';
const digitsOf = (s: string) => s.replace(/\D/g, '');

/** Procura nas folhas quando nenhum caminho conhecido veio (formulários, N8N, planilhas…). */
function searchLeaf(all: Leaf[], kind: keyof typeof KNOWN): string | undefined {
  const by = (re: RegExp, ok: (l: Leaf) => boolean) =>
    all.filter((l) => re.test(lastKey(l.path)) && ok(l)).sort((a, b) => a.path.split('.').length - b.path.split('.').length)[0]?.path;
  switch (kind) {
    case 'phone': return by(/(phone|fone|telefone|celular|^cel$|^tel$|whats|mobile|contato)/i, (l) => {
      const d = digitsOf(l.value); return d.length >= 10 && d.length <= 15 && !isEmail(l.value);
    });
    case 'email': return all.find((l) => isEmail(l.value))?.path;
    case 'name': return by(/^(full[ _]?name|name|nome|nome[ _]?completo|first[ _]?name|primeiro[ _]?nome|seu[ _]?nome|cliente|lead)$/i, (l) => /[a-zà-ú]{2}/i.test(l.value) && !isEmail(l.value) && l.value.length <= 120);
    case 'amount': return by(/(amount|price|valor|total|preco|value)/i, (l) => parseMoney(l.value) > 0);
    case 'status': return by(/^(status|situacao|payment_status|order_status)$/i, (l) => l.kind === 'string' && !!l.value);
    case 'event': return by(/^(event|evento|event_type|webhook_event_type|topic)$/i, (l) => l.kind === 'string' && !!l.value);
    case 'product': return by(/(product|produto)/i, (l) => l.kind === 'string' && /[a-z]/i.test(l.value));
    default: return undefined;
  }
}

/** Sugere o mapeamento a partir de um evento de exemplo. */
export function detectMapping(payload: unknown): WebhookMapping {
  const all = leaves(payload);
  const pick = (kind: keyof typeof KNOWN) => KNOWN[kind].find((p) => present(payload, p) && typeof getPath(payload, p) !== 'object') ?? searchLeaf(all, kind);
  const m: WebhookMapping = {};
  for (const k of ['phone', 'name', 'email', 'amount', 'status', 'event', 'product', 'transaction', 'currency', 'state'] as const) {
    const p = pick(k);
    if (p) m[k] = p;
  }
  // telefone que só tem o DDD/código do país (ex.: data.buyer.checkout_phone_code) não serve
  if (m.phone && digitsOf(asText(getPath(payload, m.phone))).length < 8) delete m.phone;
  // a Kiwify manda os valores em centavos
  if (m.amount === 'Commissions.charge_amount') m.amountInCents = true;
  // o mesmo campo como status e evento: fica só como status
  if (m.event && m.event === m.status) delete m.event;
  return m;
}

/** Plataforma de onde o evento parece ter vindo (só para mostrar na tela). */
export function detectPlatform(payload: unknown): string | null {
  if (!isObj(payload)) return null;
  const p = payload as Record<string, any>;
  if (isObj(p.data) && (isObj(p.data.purchase) || isObj(p.data.buyer)) && typeof p.event === 'string') return 'Hotmart';
  if ('webhook_event_type' in p || (isObj(p.Customer) && isObj(p.Product))) return 'Kiwify';
  if (isObj(p.venda) && isObj(p.comprador)) return 'Monetizze';
  if (Array.isArray(p.line_items) && 'financial_status' in p) return 'Shopify';
  if (Array.isArray(p.line_items) && isObj(p.billing)) return 'WooCommerce';
  return null;
}

/* ------------------------------------------------------------- mapeamento */

/** Aplica o mapeamento ao evento (o que não veio no caminho salvo é procurado sozinho, para os dados do contato). */
export function resolve(payload: unknown, mapping: WebhookMapping = {}): Resolved {
  const detected: string[] = [];
  let auto: WebhookMapping | null = null;
  const fallback = () => (auto ??= detectMapping(payload));
  const val = (key: keyof WebhookMapping, allowAuto: boolean): string => {
    const path = mapping[key];
    const v = typeof path === 'string' && path ? asText(getPath(payload, path)) : '';
    if (v || !allowAuto) return v;
    const alt = fallback()[key];
    if (typeof alt !== 'string' || !alt) return '';
    const x = asText(getPath(payload, alt));
    if (x) detected.push(String(key));
    return x;
  };
  const rawPhone = val('phone', true);
  const nameRaw = val('name', true).slice(0, 120);
  const emailRaw = val('email', true).toLowerCase();
  const amountRaw = val('amount', !mapping.amount);
  const cents = mapping.amount ? !!mapping.amountInCents : !!fallback().amountInCents;
  const amount = Math.max(0, parseMoney(amountRaw) / (cents ? 100 : 1));
  const statusRaw = [val('status', !mapping.status), val('event', !mapping.event)].filter(Boolean).join(' ');
  const fields: Record<string, string> = {};
  for (const f of mapping.fields ?? []) {
    const v = f?.key && f.path ? asText(getPath(payload, f.path)) : '';
    if (v) fields[f.key] = v.slice(0, 500);
  }
  const vars: Record<string, string> = {};
  for (const x of mapping.vars ?? []) {
    if (x?.name && x.path) vars[x.name] = asText(getPath(payload, x.path)).slice(0, 1000);
  }
  return {
    phone: normalizePhone(rawPhone),
    rawPhone: rawPhone || null,
    name: nameRaw && !isEmail(nameRaw) ? nameRaw : null,
    email: isEmail(emailRaw) ? emailRaw : null,
    amount: Math.round(amount * 100) / 100,
    status: mapSaleStatus(statusRaw),
    statusRaw,
    product: val('product', !mapping.product).slice(0, 200) || null,
    transaction: val('transaction', !mapping.transaction).slice(0, 120) || null,
    currency: (val('currency', !mapping.currency) || 'BRL').toUpperCase(),
    state: val('state', !mapping.state).slice(0, 40) || null,
    event: val('event', !mapping.event).slice(0, 120) || null,
    fields, vars, detected: [...new Set(detected)],
  };
}

/* ------------------------------------------------------------- variáveis */

export const SALE_STATUS_LABEL: Record<SaleStatus, string> = { approved: 'aprovada', pending: 'pendente', refused: 'recusada', refunded: 'reembolsada' };
export const brl = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Nomes prontos para usar no modelo, no fluxo e nas condições. */
export function specials(r: Resolved, contactName?: string | null): Record<string, string> {
  const name = (contactName || r.name || '').trim();
  return {
    nome: name, primeiro_nome: name.split(/\s+/)[0] ?? '', telefone: r.phone ?? '', email: r.email ?? '',
    valor: r.amount > 0 ? brl(r.amount) : '', produto: r.product ?? '', status_venda: SALE_STATUS_LABEL[r.status],
    evento: r.event ?? '', transacao: r.transaction ?? '', moeda: r.currency,
  };
}

export const SPECIAL_NAMES = ['nome', 'primeiro_nome', 'telefone', 'email', 'valor', 'produto', 'status_venda', 'evento', 'transacao', 'moeda'];

/** Valor de um nome: variável extra → nome pronto → caminho no JSON. */
export function tokenValue(token: string, payload: unknown, r: Resolved, contactName?: string | null): string {
  const t = token.trim();
  if (t in r.vars) return r.vars[t];
  const sp = specials(r, contactName);
  if (t in sp) return sp[t];
  return asText(getPath(payload, t));
}

/** "Oi {{primeiro_nome}}, pedido {{data.purchase.transaction}}" → texto final. */
export function renderValue(expr: string, payload: unknown, r: Resolved, contactName?: string | null): string {
  return String(expr ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, tok: string) => tokenValue(tok, payload, r, contactName)).trim();
}

/** Variáveis para o fluxo disparado pelo webhook ({{evento}}, {{valor}}, {{produto}}… e as extras). */
export function flowVars(r: Resolved): Record<string, string> {
  const sp = specials(r);
  return { evento: sp.evento, valor: sp.valor, produto: sp.produto, status_venda: sp.status_venda, transacao: sp.transacao, moeda: sp.moeda, ...r.vars };
}

/* ------------------------------------------------------------- condições */

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'é igual a', neq: 'é diferente de', contains: 'contém', not_contains: 'não contém', exists: 'está preenchido', empty: 'está vazio',
};

/** Todas as condições precisam bater. Valor com vírgula = alternativas ("aprovada, completa"). */
export function conditionsMatch(conds: WebhookCondition[] | null | undefined, payload: unknown, r: Resolved): { ok: true } | { ok: false; failed: WebhookCondition; got: string } {
  for (const c of conds ?? []) {
    if (!c?.path) continue;
    const got = tokenValue(c.path, payload, r);
    const v = norm(got);
    const alts = String(c.value ?? '').split(',').map(norm).filter(Boolean);
    let ok: boolean;
    switch (c.op) {
      case 'exists': ok = v !== ''; break;
      case 'empty': ok = v === ''; break;
      case 'neq': ok = !alts.includes(v); break;
      case 'contains': ok = alts.some((a) => v.includes(a)); break;
      case 'not_contains': ok = !alts.some((a) => v.includes(a)); break;
      default: ok = alts.includes(v);
    }
    if (!ok) return { ok: false, failed: c, got };
  }
  return { ok: true };
}

const SPECIAL_LABEL: Record<string, string> = {
  nome: 'Nome', primeiro_nome: 'Primeiro nome', telefone: 'Telefone', email: 'E-mail', valor: 'Valor', produto: 'Produto',
  status_venda: 'Status da venda', evento: 'Evento', transacao: 'ID da transação', moeda: 'Moeda',
};
export const conditionText = (c: WebhookCondition) =>
  `${SPECIAL_LABEL[c.path] ?? `“${c.path}”`} ${OP_LABEL[c.op] ?? c.op}${c.op === 'exists' || c.op === 'empty' ? '' : ` “${c.value ?? ''}”`}`;

/* ---------------------------------------------------- modelo de mensagem */

export interface TemplateSendPlan {
  name: string; language: string;
  body: { name?: string; value: string }[];
  header?: { type: 'text'; name?: string; value: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  buttons: { index: number; subType: 'url' | 'copy_code'; value: string }[];
  /** texto para registrar no chat */
  preview: string;
  /** variáveis que vieram vazias (foram trocadas por "-") */
  empty: string[];
}

/** Resolve as variáveis do modelo com os dados do evento. */
export function buildTemplate(t: TemplateAction, payload: unknown, r: Resolved, contactName?: string | null): TemplateSendPlan {
  const empty: string[] = [];
  const fill = (v: TemplateVarValue | { var?: string; value: string }, label: string, max = 1024) => {
    const out = renderValue(v.value, payload, r, contactName).slice(0, max);
    if (out) return out;
    empty.push(label);
    return '-';
  };
  const body = (t.body ?? []).map((b) => ({ ...(b.name ? { name: b.name } : {}), value: fill(b, `{{${b.var}}}`) }));
  let header: TemplateSendPlan['header'];
  if (t.header?.type === 'text') header = { type: 'text', ...(t.header.name ? { name: t.header.name } : {}), value: fill(t.header, `cabeçalho {{${t.header.var}}}`, 60) };
  else if (t.header) header = { type: t.header.type, link: renderValue(t.header.link, payload, r, contactName), ...(t.header.filename ? { filename: t.header.filename } : {}) };
  const buttons = (t.buttons ?? []).map((b) => ({ index: b.index, subType: b.subType, value: fill({ value: b.value }, `botão ${b.index + 1}`, 2000) }));
  // prévia: troca {{1}}/{{nome}} pelos valores, na ordem do corpo
  const map = new Map((t.body ?? []).map((b, i) => [b.var, body[i]?.value ?? '']));
  const preview = (t.preview ?? `Modelo: ${t.name}`).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k: string) => map.get(k) ?? m);
  return { name: t.name, language: t.language, body, header, buttons, preview, empty };
}

/* ------------------------------------------------------------- formatos */

/** Lê o corpo recebido: JSON, formulário (já convertido), texto com JSON dentro ou só a query (?nome=…). */
export function payloadOf(body: unknown, query: Record<string, unknown>): Record<string, unknown> {
  let b: unknown = body;
  if (typeof b === 'string') {
    const s = b.trim();
    if (s.startsWith('{') || s.startsWith('[')) { try { b = JSON.parse(s); } catch { /* texto solto */ } }
    if (typeof b === 'string') b = s ? { texto: s.slice(0, 5000) } : {};
  }
  if (Array.isArray(b)) b = b.length === 1 && isObj(b[0]) ? b[0] : { itens: b };
  const obj = isObj(b) ? b : {};
  if (Object.keys(obj).length) return obj;
  const q = { ...query };
  delete q.signature; delete q.token;
  return q;
}

/** Normaliza o mapeamento vindo da tela (só caminhos de texto, sem lixo). */
export function cleanMapping(m: unknown): WebhookMapping {
  const o = isObj(m) ? m : {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
  const out: WebhookMapping = {};
  for (const k of ['phone', 'name', 'email', 'amount', 'status', 'product', 'transaction', 'currency', 'state', 'event'] as const) {
    const v = str(o[k]); if (v) out[k] = v;
  }
  if (o.amountInCents === true) out.amountInCents = true;
  const pairs = (v: unknown, a: 'key' | 'name') => (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => isObj(x) && !!str(x[a]) && !!str(x.path))
    .slice(0, 30).map((x) => ({ [a]: String(x[a]).trim().slice(0, 60), path: String(x.path).trim().slice(0, 300) }));
  const fields = pairs(o.fields, 'key') as { key: string; path: string }[];
  const vars = (pairs(o.vars, 'name') as { name: string; path: string }[])
    .map((v) => ({ ...v, name: v.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))
    .filter((v) => v.name && !SPECIAL_NAMES.includes(v.name));
  if (fields.length) out.fields = fields;
  if (vars.length) out.vars = vars;
  return out;
}
