/**
 * Interpretador de fluxos — ÚNICO para produção e simulação.
 *
 * Não acessa banco nem WhatsApp: todo efeito passa pelo FlowExecutor injetado.
 * A execução real usa um executor com banco/WhatsApp (runner.ts); o simulador usa
 * um executor em memória (simulate.ts). Assim o "Simular" se comporta exatamente
 * como o fluxo no ar.
 */
import { randomBytes } from 'crypto';
import {
  STAGE_LABEL, MAX_WAIT_SECONDS, carouselReplyButtons, carouselVisibleReplies, numberReply, durationSeconds, templateReplyButtons, templateWaits,
  type Dict, type FlowEdge, type FlowGraph, type FlowNode, type MenuOption,
} from './types';
import { META_KEY_TYPE, normalizePixKey, parseMoney, pixCode, type PixKeyType } from './pix';
import { secondsUntilWindow, type WeekWindow } from './timing';
import { runAiBlock } from './aiBlock';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';
export interface ContactSnapshot { name: string; phone: string; stage: string; tags: string[]; email?: string | null; custom?: Record<string, unknown>; }
export interface ProductInfo { id: string; name: string; price: number; checkoutUrl: string | null; }
export interface HttpRequestSpec { method: string; url: string; headers: Record<string, string>; body?: string; }
export interface HttpResult { ok: boolean; status: number; body: unknown; error?: string; }
export interface AiRequest { system: string; model?: string; history: boolean; user?: string; maxTokens?: number; }

/** Arquivo enviado no editor (guardado no Converza) ou link público. */
export interface MediaRef { url?: string; fileId?: string; filename?: string }
export interface PixSpec {
  code: string; key: string; keyType: string; merchantName: string; amount: number; text: string;
  image: MediaRef | null; referenceId: string;
}
export interface CarouselButton { id: string; type: 'reply' | 'url'; title: string; url?: string }
export interface CarouselCard { text: string; image: MediaRef; buttons: CarouselButton[] }
export interface TemplateSpec {
  name: string; language: string;
  body: { name?: string; value: string }[];
  header?: { type: 'text'; name?: string; value: string } | { type: 'image' | 'video' | 'document'; link: string };
  buttons?: { index: number; subType: 'url' | 'copy_code'; value: string }[];
  /** texto do modelo com as variáveis preenchidas (para o inbox e o simulador) */
  preview?: string;
  replyButtons?: { id: string; title: string }[];
}
export interface NotifySpec { name: string; phone: string; text: string; template: { name: string; language: string; withText: boolean; paramName?: string } | null }
export interface SaleSpec { productId: string | null; customerName: string; amount: number | null; currency: string }
export interface SaleResult { productName: string; amount: number; currency: string }
export interface PixelSpec { pixelId: string; event: string; value: number | null; currency: string; nodeId: string; pageId?: string | null }

/** Parte do pedido para a IA (texto, imagem, PDF ou áudio já em base64). */
export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'file'; mime: string; data: string; filename: string }
  | { type: 'audio'; format: 'mp3' | 'wav'; data: string };
export type AiProvider = 'converza' | 'openai' | 'gemini' | 'openrouter';
export interface AiCallSpec {
  provider: AiProvider; apiKey?: string; model?: string; system: string;
  /** quantas mensagens anteriores da conversa entram como contexto (0 = nenhuma) */
  history: number;
  user: AiPart[]; json?: boolean; maxTokens?: number;
}
export interface InboundMedia { kind: 'audio' | 'image' | 'document' | 'video' | 'sticker'; mime: string; filename: string | null; data: Buffer }

export interface FlowExecutor {
  getContact(): Promise<ContactSnapshot>;
  sendText(text: string): Promise<void>;
  sendMedia(kind: MediaKind, url: string, caption?: string, filename?: string): Promise<void>;
  sendMenu(text: string, options: MenuOption[], style: string, buttonLabel: string): Promise<void>;
  setStage(stage: string): Promise<void>;
  addTag(tag: string): Promise<void>;
  removeTag(tag: string): Promise<void>;
  setContactName(name: string): Promise<void>;
  /** Coloca o contato no quadro/coluna do Kanban (cria o card no topo ou move o existente). */
  moveToKanban(boardId: string, columnId: string): Promise<void>;
  /** Salva um valor num campo personalizado do contato (ex.: CPF perguntado no fluxo). */
  setContactField(key: string, value: string): Promise<void>;
  handoff(assignUserId: string | null, departmentId?: string | null): Promise<void>;
  /** hora/data/dia/saudação e variáveis globais ({{g_…}}) */
  extras?(): Promise<Dict>;
  /** dentro do horário de atendimento do número? (null = horário desligado) */
  inBusinessHours?(): Promise<boolean | null>;
  /** muda uma variável global (definir, somar ou subtrair) */
  setGlobal?(key: string, op: 'set' | 'add' | 'subtract', value: string): Promise<void>;
  gotoFlow(flowId: string): Promise<void>;
  http(req: HttpRequestSpec): Promise<HttpResult>;
  ai(req: AiRequest): Promise<string>;
  getProduct(productId: string): Promise<ProductInfo | null>;
  onEnter(nodeId: string): Promise<void> | void;
  onAdvance(nodeId: string): Promise<void> | void;
  /** Anotação visível só na simulação (no ar é ignorada). */
  note(text: string): void;
  /** Mostra "digitando…" (ou "gravando áudio…") para o cliente por alguns segundos (o envio vem depois da espera). */
  typing?(seconds: number, mode?: 'text' | 'audio'): Promise<void>;
  random(): number;

  /* ---- blocos da barra Ferramentas ---- */
  /** mídia por link ou arquivo enviado no editor (figurinha = WEBP) */
  sendMediaRef(kind: MediaKind | 'sticker', ref: MediaRef, caption?: string): Promise<void>;
  sendContactCard(name: string, phone: string): Promise<void>;
  react(waMessageId: string, emoji: string): Promise<void>;
  sendPix(p: PixSpec): Promise<void>;
  sendCarousel(text: string, cards: CarouselCard[]): Promise<void>;
  sendTemplate(t: TemplateSpec): Promise<void>;
  setChatStatus(status: 'pending' | 'open' | 'resolved', assignUserId: string | null, pause: boolean): Promise<void>;
  /** avisa alguém (outro número) pelo WhatsApp */
  notify(n: NotifySpec): Promise<{ ok: boolean; info: string }>;
  setDepartment(departmentId: string | null): Promise<void>;
  assignAgent(agentId: string | null): Promise<void>;
  kanbanAction(action: 'add' | 'move' | 'remove', boardId: string, columnId: string): Promise<void>;
  /** nome / e-mail / campo personalizado com esse nome: grava no contato (true = gravou) */
  saveToContact(key: string, value: string): Promise<boolean>;
  firePixel(p: PixelSpec): Promise<void>;
  recordSale(s: SaleSpec): Promise<SaleResult>;
  /** aviso para a equipe dentro do Converza */
  notifyApp(title: string, body: string): Promise<void>;
  distribute(nodeId: string, outputIds: string[], sticky: boolean): Promise<string>;
  aiComplete(spec: AiCallSpec): Promise<string>;
  /** áudio do cliente: vira texto (transcrição) ou uma parte do pedido (provedores que ouvem o áudio direto) */
  aiAudio(provider: AiProvider, apiKey: string | undefined, media: InboundMedia): Promise<{ text: string } | { part: AiPart }>;
  lastInboundMedia(): Promise<InboundMedia | null>;
  timezone(): Promise<string>;
  /** horários de atendimento do número da conversa (null = desligados) */
  businessWindows?(): Promise<WeekWindow | null>;
  now(): Date;
}

export interface RunState {
  lastMessage: string;
  lastReplyId: string | null;
  vars: Dict;
  connectionId: string | null;
  retries: Dict;
  /** wamid da última mensagem do cliente (para citar ou reagir) */
  lastWaId: string | null;
  /** id (no Converza) da última mensagem do cliente que tinha mídia */
  mediaMsgId: string | null;
  /** a próxima mensagem do fluxo sai citando esta mensagem do cliente */
  quoteNext: string | null;
  /** identifica a espera atual (o tempo limite de uma espera antiga não vale para a nova) */
  waitToken: string | null;
  /** mensagens juntadas pelo "buffer" do Aguarda Resposta */
  buffer: string[];
  /** onde parou o bloco Mensagem quando tem Intervalo entre os itens */
  cursor: Dict;
  /** bloco → item de texto cujo "digitando…" já foi mostrado (na volta da espera, envia o texto) */
  typed?: Dict;
  /** execução parada (pausa da equipe ou mensagem que falhou): de onde veio e qual mensagem */
  held?: Dict;
}

export type Halt =
  | { kind: 'end'; reason?: string }
  | { kind: 'input'; nodeId: string; timeoutSeconds?: number; token?: string }
  | { kind: 'buffer'; nodeId: string; seconds: number; token: string }
  | { kind: 'delay'; nodeId: string; seconds: number }
  | { kind: 'payment'; nodeId: string; timeoutSeconds: number };

const MAX_STEPS = 80;
/** limite do "Delay do digitando" de cada texto do bloco Mensagem */
export const TYPING_MAX_SECONDS = 60;
/** "gravando áudio…" antes de um áudio: até 2 minutos */
export const RECORDING_MAX_SECONDS = 120;
/** intervalo aleatório entre conteúdos de uma mensagem: 0 a 120 s */
export const RANDOM_INTERVAL_MAX_SECONDS = 120;

/** Segundos de um item "Intervalo": fixo (quantidade + unidade) ou sorteado entre mínimo e máximo. */
export function intervalSeconds(it: Dict, rnd: () => number): number {
  if (it.mode === 'random') {
    const clamp = (v: unknown) => Math.min(RANDOM_INTERVAL_MAX_SECONDS, Math.max(0, Math.round(Number(v)) || 0));
    let lo = clamp(it.min ?? 10); let hi = clamp(it.max ?? 40);
    if (lo > hi) [lo, hi] = [hi, lo];
    return lo + Math.min(hi - lo, Math.floor(rnd() * (hi - lo + 1)));
  }
  return durationSeconds(it.amount ?? 3, it.unit ?? 'seconds');
}
/** Menu/carrossel sem tempo de expiração: o padrão é 2 dias (depois disso a conversa sai do fluxo). */
export const DEFAULT_EXPIRE_SECONDS = 2 * 86400;

/* ------------------------------------------------------------------ helpers */

export function normalizeState(raw: unknown): RunState {
  const r = (raw ?? {}) as Dict;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Dict) } : {});
  return {
    lastMessage: String(r.lastMessage ?? ''),
    lastReplyId: r.lastReplyId ? String(r.lastReplyId) : null,
    vars: obj(r.vars),
    connectionId: r.connectionId ? String(r.connectionId) : null,
    retries: obj(r.retries),
    lastWaId: r.lastWaId ? String(r.lastWaId) : null,
    mediaMsgId: r.mediaMsgId ? String(r.mediaMsgId) : null,
    quoteNext: r.quoteNext ? String(r.quoteNext) : null,
    waitToken: r.waitToken ? String(r.waitToken) : null,
    buffer: Array.isArray(r.buffer) ? r.buffer.map(String).slice(-50) : [],
    cursor: obj(r.cursor),
    // "digitando/gravando já mostrado" — sem isto, ao voltar da espera o fluxo mostra de novo e nunca envia
    typed: obj(r.typed),
    ...(r.held && typeof r.held === 'object' ? { held: { ...(r.held as Dict) } } : {}),
  };
}

export function norm(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function sanitizeVar(s: unknown): string {
  return norm(s).replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

export function findNode(graph: FlowGraph, id: string | null | undefined): FlowNode | undefined {
  return id ? graph.nodes.find((n) => n.id === id) : undefined;
}

/** handle null = saída padrão (aceita arestas antigas sem handle). */
export function edgeFrom(graph: FlowGraph, nodeId: string, handle: string | null): FlowEdge | undefined {
  const out = graph.edges.filter((e) => e.source === nodeId);
  if (handle === null) return out.find((e) => e.sourceHandle == null || e.sourceHandle === 'out');
  return out.find((e) => e.sourceHandle === handle);
}

function nextOf(graph: FlowGraph, nodeId: string, handle: string | null): FlowNode | undefined {
  const e = edgeFrom(graph, nodeId, handle);
  return e ? findNode(graph, e.target) : undefined;
}

export function scopeOf(contact: ContactSnapshot, state: RunState, extras: Dict = {}): Dict {
  const first = contact.name.split(/\s+/)[0] ?? contact.name;
  return {
    // hora, data, dia, saudação e variáveis globais (g_…)
    ...extras,
    nome: contact.name, name: contact.name,
    primeiro_nome: first, first_name: first,
    telefone: contact.phone, phone: contact.phone,
    etapa: STAGE_LABEL[contact.stage] ?? contact.stage, stage: contact.stage,
    email: contact.email ?? '',
    // campos personalizados do contato: {{campos.cpf}}
    campos: contact.custom ?? {},
    resposta: state.lastMessage, lastMessage: state.lastMessage, mensagem: state.lastMessage, ultima_mensagem: state.lastMessage,
    // variáveis salvas pelo fluxo têm prioridade (ex.: perguntar e salvar "nome")
    ...state.vars,
  };
}

export function render(text: unknown, scope: Dict, escape?: (v: string) => string): string {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    let v: any = scope;
    for (const k of path.split('.')) {
      if (v == null) break;
      v = v[k];
    }
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return escape ? escape(s) : s;
  });
}

/** Lê um caminho como "data.cliente.id" ou "itens.0.nome" num JSON. */
export function getPath(obj: unknown, path: string): unknown {
  let v: any = obj;
  for (const k of String(path ?? '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

const UNIT_SECONDS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

export function delaySeconds(d: Dict): number {
  if (d.amount !== undefined && d.amount !== null && d.amount !== '') {
    return Math.max(1, Math.round(Number(d.amount) * (UNIT_SECONDS[String(d.unit)] ?? 60)) || 60);
  }
  return Math.max(1, Math.round(Number(d.seconds ?? 60)) || 60);
}

export function delayLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} ${seconds === 86400 ? 'dia' : 'dias'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function menuOptions(d: Dict): MenuOption[] {
  return (Array.isArray(d.options) ? d.options : [])
    .filter((o: Dict) => o && o.id && String(o.title ?? '').trim())
    .map((o: Dict) => ({
      id: String(o.id),
      title: String(o.title).trim(),
      ...(o.description ? { description: String(o.description) } : {}),
    }));
}

function categories(d: Dict): { id: string; label: string; description: string }[] {
  return (Array.isArray(d.categories) ? d.categories : [])
    .filter((c: Dict) => c && c.id && String(c.label ?? '').trim())
    .map((c: Dict) => ({ id: String(c.id), label: String(c.label).trim(), description: String(c.description ?? '').trim() }));
}

export function matchOption(options: MenuOption[], text: string, replyId: string | null): MenuOption | undefined {
  if (replyId) {
    const byId = options.find((o) => o.id === replyId);
    if (byId) return byId;
  }
  const t = norm(text);
  if (!t) return undefined;
  const byTitle = options.find((o) => norm(o.title) === t);
  if (byTitle) return byTitle;
  const num = t.match(/^(\d{1,2})\b/)?.[1];
  if (num) {
    const idx = Number(num) - 1;
    if (options[idx]) return options[idx];
  }
  const partial = options.filter((o) => norm(o.title).length >= 3 && t.includes(norm(o.title)));
  return partial.length === 1 ? partial[0] : undefined;
}

function validate(kind: string, text: string): boolean {
  const t = text.trim();
  switch (kind) {
    case 'number': return /^-?\d+([.,]\d+)?$/.test(t);
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
    case 'phone': { const digits = t.replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 13; }
    case 'text': return t.length > 0;
    default: return true;
  }
}

function cleanAnswer(kind: string, text: string): string {
  const t = text.trim();
  if (kind === 'email') return t.toLowerCase();
  if (kind === 'phone') return t.replace(/\D/g, '');
  if (kind === 'number') return t.replace(',', '.');
  return t;
}

function defaultInvalid(kind: string): string {
  switch (kind) {
    case 'email': return 'Hmm, esse e-mail não parece válido. Pode conferir e enviar de novo?';
    case 'number': return 'Por favor, responda apenas com números.';
    case 'phone': return 'Esse telefone não parece válido. Envie com DDD, por favor.';
    default: return 'Não entendi 🤔 Pode responder de novo?';
  }
}

function maxRetries(d: Dict, def: number): number {
  const n = Math.round(Number(d.maxRetries ?? def));
  return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : def;
}

function tagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function alternatives(target: string): string[] {
  return target.split(',').map((s) => s.trim()).filter(Boolean);
}

function toNum(s: string): number {
  const n = Number(String(s).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

export function formatBRL(n: number, currency = 'BRL'): string {
  try { return n.toLocaleString('pt-BR', { style: 'currency', currency }); } catch { return `${currency} ${n.toFixed(2)}`; }
}

function aiSystem(prompt: unknown): string {
  const base = String(prompt ?? '').trim() || 'Você é um atendente cordial e objetivo de uma empresa no WhatsApp.';
  return `${base}\n\nResponda em mensagens curtas e naturais, adequadas ao WhatsApp. Não invente informações que não foram fornecidas.`;
}

function classifyPrompt(cats: { label: string; description: string }[], extra: unknown): string {
  const list = cats.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}`).join('\n');
  const rules = String(extra ?? '').trim();
  return [
    'Você classifica a intenção da mensagem de um cliente no WhatsApp.',
    'Categorias:', list,
    rules ? `Regras extras: ${rules}` : '',
    'Responda APENAS com o número da categoria que melhor descreve a mensagem. Se nenhuma se aplicar, responda 0.',
  ].filter(Boolean).join('\n');
}

const newToken = () => randomBytes(6).toString('hex');

/** Espera a resposta do cliente; com tempo limite, a saída "timeout" entra quando ele acaba. */
function waitInput(state: RunState, nodeId: string, timeoutSeconds: number): Halt {
  const token = newToken();
  state.waitToken = token;
  return timeoutSeconds > 0
    ? { kind: 'input', nodeId, timeoutSeconds: Math.min(MAX_WAIT_SECONDS, timeoutSeconds), token }
    : { kind: 'input', nodeId, token };
}

/** Itens do bloco Mensagem (o formato antigo era só { text }). */
export function messageItems(d: Dict): Dict[] {
  if (Array.isArray(d.items)) return d.items.filter((it: Dict) => it && typeof it === 'object');
  return d.text !== undefined ? [{ id: 'txt', type: 'text', text: d.text }] : [];
}

/** Regras do Condicional (o formato antigo era uma regra só no próprio bloco). */
export function conditionRules(d: Dict): Dict[] {
  if (Array.isArray(d.rules)) return d.rules.filter((r: Dict) => r && typeof r === 'object');
  return d.field !== undefined || d.op !== undefined ? [d] : [];
}

/** Operações do Manipulador. */
export function applyVarOp(op: string, current: unknown, value: string): string {
  const num = (v: unknown) => parseMoney(v);
  const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '');
  switch (op) {
    case 'add': return fmt((num(current) || 0) + (num(value) || 0));
    case 'subtract': return fmt((num(current) || 0) - (num(value) || 0));
    case 'multiply': return fmt((num(current) || 0) * (Number.isFinite(num(value)) ? num(value) : 1));
    case 'divide': { const v = num(value); return v ? fmt((num(current) || 0) / v) : String(current ?? ''); }
    case 'append': return `${current ?? ''}${value}`;
    case 'clear': return '';
    default: return value;
  }
}

/** "2026-11-20 14:30", "20/11/2026 14:30" ou ISO → Date no fuso da empresa (null se inválida). */
export function parseLocalDate(raw: string, tz: string): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let y: number, mo: number, da: number, h = 0, mi = 0;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?/);
  if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; h = +(m[4] ?? 0); mi = +(m[5] ?? 0); }
  else {
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
    da = +m[1]; mo = +m[2]; y = +m[3]; h = +(m[4] ?? 0); mi = +(m[5] ?? 0);
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  // descobre o deslocamento do fuso naquele instante
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce<Dict>((a, p) => { a[p.type] = p.value; return a; }, {});
  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const d = new Date(guess - (asLocal - guess));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function triggerMatches(
  t: Dict,
  ev: { source: 'inbound_message' | 'webhook'; text: string; isFirstMessage?: boolean; connectionId?: string | null; webhookId?: string | null },
): boolean {
  const type = String(t.type ?? 'any_message');
  if (ev.source === 'webhook') return type === 'webhook' && (!t.webhookId || t.webhookId === ev.webhookId);
  if (t.connectionId && ev.connectionId && t.connectionId !== ev.connectionId) return false;
  switch (type) {
    case 'any_message': return true;
    case 'first_message': return !!ev.isFirstMessage;
    case 'keyword': {
      const words = String(t.keywords ?? '').split(',').map(norm).filter(Boolean);
      const msg = norm(ev.text);
      if (!words.length || !msg) return false;
      if (t.match === 'exact') return words.includes(msg);
      return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(msg));
    }
    default: return false;
  }
}

/* --------------------------------------------------------------- execução */

type StepResult = { next: FlowNode | undefined } | Halt;
const isHalt = (r: StepResult): r is Halt => 'kind' in r;

/** Executa a partir de um bloco até encontrar uma espera ou o fim. `resume`: continua um bloco que já tinha começado. */
export async function runFrom(graph: FlowGraph, startId: string | null | undefined, state: RunState, exec: FlowExecutor, opts: { resume?: boolean } = {}): Promise<Halt> {
  let node = findNode(graph, startId);
  let steps = 0;
  let resume = !!opts.resume;
  while (node) {
    if (++steps > MAX_STEPS) {
      exec.note('⚠️ Execução interrompida: o fluxo entrou em um laço sem nenhuma espera.');
      return { kind: 'end', reason: 'loop' };
    }
    if (!resume) await exec.onEnter(node.id);
    resume = false;
    let r: StepResult;
    try { r = await step(graph, node, state, exec); } catch (err) {
      // quem parou o fluxo precisa saber em qual bloco (para retomar dali)
      if (err && typeof err === 'object' && !(err as Dict).nodeId) (err as Dict).nodeId = node.id;
      throw err;
    }
    if (isHalt(r)) return r;
    // o contato passou pelo bloco (seguiu para o próximo ou concluiu o fluxo nele)
    await exec.onAdvance(node.id);
    node = r.next;
  }
  return { kind: 'end' };
}

async function step(graph: FlowGraph, node: FlowNode, state: RunState, exec: FlowExecutor): Promise<StepResult> {
  const d = node.data ?? {};
  const scope = async () => scopeOf(await exec.getContact(), state, exec.extras ? await exec.extras() : {});
  const go = (handle: string | null) => ({ next: nextOf(graph, node.id, handle) });

  switch (node.type) {
    case 'trigger':
      return go(null);

    case 'message': {
      const items = messageItems(d);
      const start = Math.max(0, Number(state.cursor[node.id] ?? 0) || 0);
      delete state.cursor[node.id];
      const s = await scope();
      for (let i = start; i < items.length; i++) {
        const it = items[i];
        const type = String(it.type ?? 'text');
        try {
        if (type === 'text') {
          const text = render(it.text, s);
          const typing = Math.min(TYPING_MAX_SECONDS, Math.max(0, Math.round(Number(it.typingSeconds ?? 0)) || 0));
          if (text.trim() && typing > 0 && Number(state.typed?.[node.id]) !== i) {
            // "digitando…" agora, o texto quando a espera acabar (volta para este mesmo item)
            state.typed = { ...(state.typed ?? {}), [node.id]: i };
            state.cursor[node.id] = i;
            if (exec.typing) await exec.typing(typing).catch(() => undefined);
            return { kind: 'delay', nodeId: node.id, seconds: typing };
          }
          if (state.typed) delete state.typed[node.id];
          if (text.trim()) await exec.sendText(text);
        } else if (type === 'interval') {
          const secs = intervalSeconds(it, () => exec.random());
          if (it.mode === 'random' && i < items.length - 1) exec.note(`🎲 Intervalo sorteado: ${secs} s`);
          if (secs > 0 && i < items.length - 1) {
            state.cursor[node.id] = i + 1;
            return { kind: 'delay', nodeId: node.id, seconds: secs };
          }
        } else if (type === 'contact') {
          const name = render(it.name, s).trim();
          const phone = render(it.phone, s).replace(/[^\d+]/g, '');
          if (name && phone) await exec.sendContactCard(name, phone);
          else exec.note('⚠️ Contato sem nome ou telefone — não foi enviado.');
        } else if (['image', 'video', 'audio', 'file', 'sticker'].includes(type)) {
          const url = render(it.url, s).trim();
          const ref: MediaRef = { url: url || undefined, fileId: it.fileId ? String(it.fileId) : undefined, filename: it.filename ? render(it.filename, s) : undefined };
          if (!ref.url && !ref.fileId) { exec.note(`⚠️ ${type === 'sticker' ? 'Sticker' : 'Mídia'} sem arquivo ou link — nada foi enviado.`); continue; }
          const kind = type === 'file' ? 'document' : type as MediaKind | 'sticker';
          if (type === 'audio') {
            const rec = Math.min(RECORDING_MAX_SECONDS, Math.max(0, Math.round(Number(it.recordingSeconds ?? 0)) || 0));
            if (rec > 0 && Number(state.typed?.[node.id]) !== i) {
              // "gravando áudio…" agora, o áudio quando a espera acabar (volta para este mesmo item)
              state.typed = { ...(state.typed ?? {}), [node.id]: i };
              state.cursor[node.id] = i;
              if (exec.typing) await exec.typing(rec, 'audio').catch(() => undefined);
              return { kind: 'delay', nodeId: node.id, seconds: rec };
            }
            if (state.typed) delete state.typed[node.id];
          }
          await exec.sendMediaRef(kind, ref, it.caption ? render(it.caption, s) : undefined);
        }
        } catch (err) {
          // não saiu: ao retomar, volta para este conteúdo (sem repetir o digitando/gravando)
          state.cursor[node.id] = i;
          state.typed = { ...(state.typed ?? {}), [node.id]: i };
          throw err;
        }
      }
      return go(null);
    }

    case 'media': {
      const s = await scope();
      const url = render(d.url, s).trim();
      const kind = (['image', 'audio', 'video', 'document'].includes(d.mediaType) ? d.mediaType : 'image') as MediaKind;
      if (url) await exec.sendMedia(kind, url, d.caption ? render(d.caption, s) : undefined, d.filename ? String(d.filename) : undefined);
      else exec.note('⚠️ Bloco de mídia sem URL — nada foi enviado.');
      return go(null);
    }

    case 'template': {
      if (!d.name) {
        exec.note('⚠️ Nenhum template escolhido — nada foi enviado.');
        return go(templateWaits(d) ? 'timeout' : null);
      }
      const s = await scope();
      const vars = (d.vars && typeof d.vars === 'object' ? d.vars : {}) as Dict;
      const names: string[] = Array.isArray(d.bodyVars) ? d.bodyVars.map(String) : [];
      const spec: TemplateSpec = {
        name: String(d.name), language: String(d.language || 'pt_BR'),
        body: names.map((n) => ({ ...(d.paramFormat === 'named' ? { name: n } : {}), value: render(vars[n] ?? '', s).trim() || '-' })),
      };
      if (d.headerFormat === 'TEXT' && d.headerVar) spec.header = { type: 'text', ...(d.paramFormat === 'named' ? { name: String(d.headerVar) } : {}), value: render(d.headerText ?? '', s).trim() || '-' };
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(d.headerFormat)) && String(d.headerMediaUrl ?? '').trim()) {
        spec.header = { type: String(d.headerFormat).toLowerCase() as 'image' | 'video' | 'document', link: render(d.headerMediaUrl, s).trim() };
      }
      const btnValues = (d.buttonValues && typeof d.buttonValues === 'object' ? d.buttonValues : {}) as Dict;
      spec.buttons = (Array.isArray(d.buttons) ? d.buttons : []).map((b: Dict, i: number) => ({ b, i }))
        .filter(({ b }) => (String(b.type).toUpperCase() === 'URL' && b.hasVar) || String(b.type).toUpperCase() === 'COPY_CODE')
        .map(({ b, i }) => ({ index: i, subType: String(b.type).toUpperCase() === 'COPY_CODE' ? 'copy_code' as const : 'url' as const, value: render(btnValues[i] ?? '', s).trim() || '-' }));
      // prévia do texto: troca {{1}} / {{nome}} pelos valores
      const bodyText = String(d.bodyText ?? '');
      if (bodyText) {
        spec.preview = bodyText.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
          const i = names.indexOf(k);
          return i >= 0 ? spec.body[i]?.value ?? '' : `{{${k}}}`;
        });
      }
      spec.replyButtons = templateReplyButtons(d);
      await exec.sendTemplate(spec);
      if (!templateWaits(d)) return go(null);
      state.retries[node.id] = 0;
      return waitInput(state, node.id, durationSeconds(d.timeoutAmount ?? 60, d.timeoutUnit ?? 'minutes'));
    }

    case 'tags': {
      const s = await scope();
      const remove = d.mode === 'remove';
      for (const t of tagList(d.tags)) {
        const tag = render(t, s).trim();
        if (!tag) continue;
        if (remove) await exec.removeTag(tag); else await exec.addTag(tag);
      }
      return go(null);
    }

    case 'pix': {
      const s = await scope();
      const keyType = (['evp', 'cpf', 'cnpj', 'email', 'phone'].includes(d.keyType) ? d.keyType : 'evp') as PixKeyType;
      const amount = parseMoney(render(d.amount, s));
      const merchant = render(d.merchantName, s).trim();
      const ref = `cvz${newToken()}`;
      let code: string; let key: string;
      try {
        key = normalizePixKey(keyType, render(d.key, s));
        if (!merchant) throw new Error('Falta o nome de quem recebe o pagamento.');
        if (!(amount > 0)) throw new Error('Falta o valor do Pix (obrigatório no WhatsApp oficial).');
        code = pixCode({ type: keyType, key, name: merchant, amount, txid: ref });
      } catch (err) {
        state.vars.pix = { erro: (err as Error).message };
        exec.note(`⚠️ Botão PIX não enviado: ${(err as Error).message}`);
        return go(null);
      }
      const sc = { ...s, valor: formatBRL(amount), chave: key };
      const imageUrl = render(d.imageUrl, s).trim();
      await exec.sendPix({
        code, key, keyType: META_KEY_TYPE[keyType], merchantName: merchant, amount,
        text: render(d.text, sc).trim(), referenceId: ref,
        image: imageUrl || d.imageFileId ? { url: imageUrl || undefined, fileId: d.imageFileId ? String(d.imageFileId) : undefined } : null,
      });
      state.vars.pix = { codigo: code, valor: amount.toFixed(2), chave: key, referencia: ref };
      return go(null);
    }

    case 'menu': {
      const opts = menuOptions(d);
      if (!opts.length) {
        exec.note('⚠️ Menu sem opções — seguindo pela saída "Outro".');
        return go('fallback');
      }
      const s = await scope();
      const style = d.style === 'buttons' && opts.length > 3 ? 'list' : String(d.style ?? 'auto');
      await exec.sendMenu(render(d.text, s) || 'Escolha uma opção:', opts.map((o) => ({ ...o, title: render(o.title, s) })),
        style, String(d.buttonLabel || 'Ver opções'));
      state.retries[node.id] = 0;
      const expire = durationSeconds(d.expireAmount, d.expireUnit);
      return waitInput(state, node.id, expire > 0 ? expire : DEFAULT_EXPIRE_SECONDS);
    }

    case 'carousel': {
      const s = await scope();
      const cards: CarouselCard[] = (Array.isArray(d.cards) ? d.cards : []).map((c: Dict) => ({
        text: render(c.text, s).trim(),
        image: { url: render(c.imageUrl, s).trim() || undefined, fileId: c.imageFileId ? String(c.imageFileId) : undefined },
        buttons: (Array.isArray(c.buttons) ? c.buttons : []).map((b: Dict) => ({
          id: String(b.id), type: b.type === 'url' ? 'url' as const : 'reply' as const,
          title: render(b.title, s).trim(), ...(b.type === 'url' ? { url: render(b.url, s).trim() } : {}),
        })),
      }));
      if (cards.length < 2) exec.note('⚠️ O carrossel precisa de pelo menos 2 cartões no WhatsApp.');
      await exec.sendCarousel(render(d.text, s).trim() || 'Escolha uma opção:', cards);
      if (!carouselReplyButtons(d).length) return go(null);
      const expire = durationSeconds(d.expireAmount, d.expireUnit);
      return waitInput(state, node.id, expire > 0 ? expire : DEFAULT_EXPIRE_SECONDS);
    }

    case 'ask': {
      const text = render(d.text, await scope());
      if (text.trim()) await exec.sendText(text);
      state.retries[node.id] = 0;
      state.buffer = [];
      // blocos antigos (sem tempo definido) esperam sem limite, como antes
      const limit = d.waitForever || d.timeoutAmount === undefined ? 0 : durationSeconds(d.timeoutAmount, d.timeoutUnit ?? 'days');
      return waitInput(state, node.id, limit);
    }

    case 'chat_status': {
      const status = (['pending', 'open', 'resolved'].includes(d.status) ? d.status : 'pending') as 'pending' | 'open' | 'resolved';
      await exec.setChatStatus(status, status === 'open' && d.assignUserId ? String(d.assignUserId) : null, status !== 'resolved' && d.pause !== false);
      return go(null);
    }

    case 'notify': {
      const s = await scope();
      const cc = String(d.country ?? '55').replace(/\D/g, '') || '55';
      let phone = render(d.phone, s).replace(/\D/g, '');
      if (phone && !phone.startsWith(cc)) phone = `${cc}${phone}`;
      const text = render(d.text, s).trim();
      if (!phone || !text) {
        exec.note('⚠️ Notificação sem número ou mensagem — não foi enviada.');
        state.vars.notificacao = 'falhou';
        return go(null);
      }
      const r = await exec.notify({
        name: String(d.name ?? '').trim() || 'Notificação', phone, text,
        template: d.templateName ? {
          name: String(d.templateName), language: String(d.templateLanguage || 'pt_BR'), withText: Number(d.templateVarCount ?? 0) > 0,
          ...(d.templateParam && !/^\d+$/.test(String(d.templateParam)) ? { paramName: String(d.templateParam) } : {}),
        } : null,
      });
      state.vars.notificacao = r.ok ? 'enviada' : 'falhou';
      return go(null);
    }

    case 'condition': {
      const rules = conditionRules(d);
      const results: boolean[] = [];
      for (const r of rules) results.push(await evaluateCondition(r, state, exec));
      const ok = !rules.length ? true : d.logic === 'any' ? results.some(Boolean) : results.every(Boolean);
      exec.note(`Condição → ${ok ? 'sim' : 'não'}`);
      return go(ok ? 'true' : 'false');
    }

    case 'distributor': {
      const outs: { id: string; label: string }[] = (Array.isArray(d.outputs) ? d.outputs : [])
        .filter((o: Dict) => o?.id).map((o: Dict, i: number) => ({ id: String(o.id), label: String(o.label || `Saída ${i + 1}`) }));
      if (!outs.length) { exec.note('⚠️ Distribuidor sem saídas.'); return { kind: 'end' }; }
      const id = await exec.distribute(node.id, outs.map((o) => o.id), d.mode !== 'next');
      exec.note(`Distribuidor → ${outs.find((o) => o.id === id)?.label ?? id}`);
      return go(id);
    }

    case 'pixel': {
      const s = await scope();
      if (!d.pixelId) { exec.note('⚠️ Nenhum pixel escolhido.'); return go(null); }
      const value = parseMoney(render(d.value, s));
      await exec.firePixel({
        pixelId: String(d.pixelId), event: String(d.event || 'Purchase'), nodeId: node.id,
        value: Number.isFinite(value) ? value : null, currency: (render(d.currency || 'BRL', s).trim() || 'BRL').toUpperCase().slice(0, 3),
        pageId: render(d.pageId ?? '', s).replace(/\D/g, '').slice(0, 30) || null,
      });
      return go(null);
    }

    case 'delay': {
      const mode = String(d.mode ?? 'interval');
      let secs = 0;
      if (mode === 'date') {
        const tz = await exec.timezone();
        const target = parseLocalDate(render(d.date, await scope()), tz);
        if (!target) { exec.note('⚠️ Data inválida no Intervalo Inteligente — seguindo sem esperar.'); return go(null); }
        secs = Math.ceil((target.getTime() - exec.now().getTime()) / 1000);
      } else if (mode === 'hours') {
        const tz = await exec.timezone();
        const win: WeekWindow | null = d.useBusinessHours
          ? (exec.businessWindows ? await exec.businessWindows() : null)
          : { days: Array.isArray(d.days) ? d.days.map(Number) : [1, 2, 3, 4, 5], from: String(d.from || '09:00'), to: String(d.to || '18:00') };
        if (!win) { exec.note('Horários de atendimento desligados — seguindo sem esperar.'); return go(null); }
        secs = secondsUntilWindow(win, tz, exec.now());
      } else if (d.amount !== undefined && String(d.amount).includes('{{')) {
        secs = durationSeconds(render(d.amount, await scope()), d.unit);
      } else {
        secs = d.mode === undefined ? delaySeconds(d) : durationSeconds(d.amount, d.unit);
      }
      if (secs <= 0) return go(null);
      return { kind: 'delay', nodeId: node.id, seconds: Math.min(MAX_WAIT_SECONDS, secs) };
    }

    case 'random': {
      const pa = Math.min(100, Math.max(0, Number(d.percentA ?? 50)));
      const branch = exec.random() * 100 < pa ? 'a' : 'b';
      exec.note(`Divisão A/B → caminho ${branch.toUpperCase()}`);
      return go(branch);
    }

    case 'department':
      await exec.setDepartment(d.action === 'clear' ? null : d.departmentId ? String(d.departmentId) : null);
      return go(null);

    case 'ai_agent':
      await exec.assignAgent(d.action === 'remove' ? null : d.agentId ? String(d.agentId) : null);
      return go(null);

    case 'kanban': {
      const action = (['add', 'move', 'remove'].includes(d.action) ? d.action : 'add') as 'add' | 'move' | 'remove';
      if (!d.boardId) { exec.note('⚠️ Nenhum Kanban escolhido.'); return go(null); }
      await exec.kanbanAction(action, String(d.boardId), String(d.columnId ?? ''));
      return go(null);
    }

    case 'set_var': {
      const s = await scope();
      const raw = render(d.name, s).trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
      const isGlobal = /^g_/i.test(raw);
      const name = isGlobal ? raw.toLowerCase().replace(/[^a-z0-9_]/g, '_') : sanitizeVar(raw);
      if (!name) { exec.note('⚠️ Manipulador sem nome de variável.'); return go(null); }
      const op = String(d.op ?? 'set');
      const value = render(d.value, s);
      const current = isGlobal ? s[name] : (state.vars[name] ?? s[name] ?? '');
      const result = applyVarOp(op, current, value);
      state.vars[name] = result;
      if (isGlobal && exec.setGlobal) {
        if (op === 'add' || op === 'subtract') await exec.setGlobal(name, op, value);
        else await exec.setGlobal(name, 'set', result);
      } else if (!isGlobal) {
        await exec.saveToContact(name, result);
      }
      exec.note(`🧮 ${name} → ${result || '(vazio)'}`);
      return go(null);
    }

    case 'sale': {
      const s = await scope();
      const contact = await exec.getContact();
      const customer = render(d.customerName ?? '{{comprovante.nome_pagador}}', s).trim() || contact.name;
      const amount = parseMoney(render(d.amount ?? '{{comprovante.valor}}', s));
      const currency = render(d.currency ?? '{{comprovante.currency}}', s).trim().toUpperCase();
      const r = await exec.recordSale({
        productId: d.productId ? String(d.productId) : null, customerName: customer,
        amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency: /^[A-Z]{3}$/.test(currency) ? currency : '',
      });
      const venda = { cliente: customer, valor: formatBRL(r.amount, r.currency), valor_numero: r.amount.toFixed(2), moeda: r.currency, produto: r.productName };
      state.vars.venda = venda;
      const sc = { ...s, venda, produto: { nome: r.productName } };
      const title = render(d.notifyTitle, sc).trim() || `💰 Nova venda${r.productName ? ` de ${r.productName}` : ''}!`;
      const body = render(d.notifySubtitle, sc).trim() || `${customer} pagou ${venda.valor}${r.productName ? ` em ${r.productName}` : ''}.`;
      await exec.notifyApp(title, body);
      return go(null);
    }

    case 'action': {
      const s = await scope();
      if (d.setStage) await exec.setStage(String(d.setStage));
      for (const t of tagList(d.addTags ?? d.addTag)) await exec.addTag(render(t, s));
      for (const t of tagList(d.removeTags)) await exec.removeTag(render(t, s));
      if (d.setName) {
        const name = render(d.setName, s).trim();
        if (name) await exec.setContactName(name);
      }
      for (const f of Array.isArray(d.setFields) ? d.setFields : []) {
        const key = String(f?.key ?? '').trim();
        if (key) await exec.setContactField(key, render(f?.value ?? '', s).trim());
      }
      // variáveis globais da conta: definir, somar ou subtrair
      for (const g of Array.isArray(d.setGlobals) ? d.setGlobals : []) {
        const key = String(g?.key ?? '').trim();
        const op = g?.op === 'add' || g?.op === 'subtract' ? g.op : 'set';
        if (key && exec.setGlobal) await exec.setGlobal(key, op, render(g?.value ?? '', s).trim());
      }
      if (d.kanbanBoardId && d.kanbanColumnId) await exec.moveToKanban(String(d.kanbanBoardId), String(d.kanbanColumnId));
      return go(null);
    }

    case 'handoff': {
      if (d.message) {
        const text = render(d.message, await scope());
        if (text.trim()) await exec.sendText(text);
      }
      await exec.handoff(d.assignUserId ? String(d.assignUserId) : null, d.departmentId ? String(d.departmentId) : null);
      return go(null);
    }

    case 'http': {
      const s = await scope();
      let req: HttpRequestSpec;
      try { req = buildHttp(d, s); }
      catch (err) {
        state.vars[sanitizeVar(d.saveAs) || 'http'] = null;
        exec.note(`⚠️ Integração: ${(err as Error).message}`);
        return go('error');
      }
      let res: HttpResult;
      if (!req.url) res = { ok: false, status: 0, body: null, error: 'URL vazia' };
      else {
        try { res = await exec.http(req); }
        catch (err) { res = { ok: false, status: 0, body: null, error: (err as Error).message }; }
      }
      const key = sanitizeVar(d.saveAs) || 'http';
      state.vars[key] = res.body;
      state.vars[`${key}_status`] = res.status;
      // Mapear resposta: campo do JSON → variável (e campo do contato, se existir)
      for (const m of Array.isArray(d.mappings) ? d.mappings : []) {
        const v = sanitizeVar(m?.var);
        if (!v || !String(m?.path ?? '').trim()) continue;
        const val = getPath(res.body, String(m.path).trim());
        state.vars[v] = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
        if (res.ok && m.saveToContact) await exec.saveToContact(v, String(state.vars[v]));
      }
      return go(res.ok ? 'success' : 'error');
    }

    case 'payment': {
      const s = await scope();
      let link = render(d.url, s).trim();
      let produto = '';
      let preco = '';
      if (d.productId) {
        const p = await exec.getProduct(String(d.productId));
        if (p) {
          produto = p.name;
          preco = formatBRL(p.price);
          if (!link) link = p.checkoutUrl ?? '';
        }
      }
      const sc = { ...s, link, produto, preco, product: produto, price: preco };
      let text = render(d.text || 'Segue o link para pagamento: {{link}}', sc);
      if (link && !text.includes(link)) text = `${text}\n${link}`;
      if (!link) exec.note('⚠️ Pagamento sem link: cadastre o link de checkout do produto em Pagamentos.');
      if (text.trim()) await exec.sendText(text);
      state.vars.link_pagamento = link;
      if (d.wait) {
        return { kind: 'payment', nodeId: node.id, timeoutSeconds: Math.max(60, Math.round(Number(d.timeoutMinutes ?? 60) * 60)) };
      }
      return go(null);
    }

    case 'ai': {
      const r = await runAiBlock(d, state, exec, await scope());
      // falha sem a saída "Falha" ligada: segue o caminho normal
      if (r.handle === 'error' && !edgeFrom(graph, node.id, 'error')) return go(null);
      return go(r.handle);
    }

    case 'ai_reply': {
      let reply = '';
      try {
        reply = (await exec.ai({ system: aiSystem(d.prompt), model: d.model || undefined, history: d.useHistory !== false })).trim();
      } catch (err) {
        exec.note(`⚠️ IA: ${(err as Error).message}`);
      }
      if (reply) {
        if (d.send !== false) await exec.sendText(reply);
        state.vars[sanitizeVar(d.saveAs) || 'ia'] = reply;
      } else if (d.fallbackText) {
        const text = render(d.fallbackText, await scope());
        if (text.trim()) await exec.sendText(text);
      }
      return go(null);
    }

    case 'ai_classify': {
      const cats = categories(d);
      let chosen: string | null = null;
      if (cats.length) {
        try {
          const answer = await exec.ai({
            system: classifyPrompt(cats, d.instructions),
            history: false,
            user: state.lastMessage || '(mensagem vazia)',
            maxTokens: 10,
          });
          const n = parseInt(answer.match(/\d+/)?.[0] ?? '0', 10);
          if (n >= 1 && n <= cats.length) chosen = cats[n - 1].id;
        } catch (err) {
          exec.note(`⚠️ IA: ${(err as Error).message}`);
        }
      }
      const cat = cats.find((c) => c.id === chosen);
      state.vars.categoria = cat?.label ?? '';
      exec.note(`Classificação da IA → ${cat?.label ?? 'nenhuma categoria'}`);
      return go(chosen ?? 'none');
    }

    case 'goto_flow': {
      if (!d.flowId) {
        exec.note('⚠️ Nenhum fluxo selecionado no bloco "Conexão de Fluxo".');
        return { kind: 'end' };
      }
      await exec.gotoFlow(String(d.flowId));
      await exec.onAdvance(node.id);
      return { kind: 'end', reason: 'goto' };
    }

    default:
      return go(null);
  }
}

async function evaluateCondition(d: Dict, state: RunState, exec: FlowExecutor): Promise<boolean> {
  const field = String(d.field ?? 'lastMessage');
  const op = String(d.op ?? 'contains');
  const contact = await exec.getContact();

  if (field === 'tags') {
    const has = contact.tags.some((t) => norm(t) === norm(d.value));
    return op === 'not_has_tag' ? !has : has;
  }
  // horário de atendimento do número (desligado conta como "aberto")
  if (field === 'business_hours') {
    const open = exec.inBusinessHours ? await exec.inBusinessHours() : null;
    return op === 'closed' ? open === false : open !== false;
  }

  const extras = exec.extras ? await exec.extras() : {};
  let value = '';
  if (field === 'lastMessage') value = state.lastMessage;
  else if (field === 'var') {
    const v = getPath(state.vars, String(d.varName ?? '').trim()) ?? state.vars[sanitizeVar(d.varName)];
    value = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  else if (field === 'name') value = contact.name;
  else if (field === 'stage') value = contact.stage;
  else if (field === 'phone') value = contact.phone;
  else if (field === 'email') value = contact.email ?? '';
  else if (field === 'field') value = String((contact.custom ?? {})[String(d.fieldKey ?? '')] ?? '');
  else if (field === 'global') value = String(extras[String(d.globalKey ?? '')] ?? '');

  const v = norm(value);
  const target = norm(render(d.value, scopeOf(contact, state, extras)));
  const alts = alternatives(target);

  switch (op) {
    case 'contains': return alts.some((w) => v.includes(w));
    case 'not_contains': return !alts.some((w) => v.includes(w));
    case 'equals': return alts.some((w) => v === w);
    case 'not_equals': return !alts.some((w) => v === w);
    case 'starts_with': return alts.some((w) => v.startsWith(w));
    case 'ends_with': return alts.some((w) => v.endsWith(w));
    case 'not_empty': return v.length > 0;
    case 'is_empty': return v.length === 0;
    case 'is_number': return /^-?\d+([.,]\d+)?$/.test(v);
    case 'greater_than': return toNum(v) > toNum(target);
    case 'less_than': return toNum(v) < toNum(target);
    default: return false;
  }
}

/** Cabeçalhos em JSON (Integração) ou a lista antiga { key, value }. Lança Error se o JSON estiver quebrado. */
function headersOf(d: Dict, scope: Dict): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof d.headersJson === 'string' && d.headersJson.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(render(d.headersJson, scope, (v) => JSON.stringify(v).slice(1, -1))); }
    catch { throw new Error('os cabeçalhos não são um JSON válido'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('os cabeçalhos precisam ser um objeto JSON');
    for (const [k, v] of Object.entries(parsed as Dict)) if (k.trim()) headers[k.trim()] = String(v ?? '');
    return headers;
  }
  for (const h of Array.isArray(d.headers) ? d.headers : []) {
    const k = String(h?.key ?? '').trim();
    if (k) headers[k] = render(h.value, scope);
  }
  return headers;
}

function buildHttp(d: Dict, scope: Dict): HttpRequestSpec {
  const method = String(d.method ?? 'GET').toUpperCase();
  const headers = headersOf(d, scope);
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(method) && String(d.body ?? '').trim()) {
    body = render(d.body, scope, (v) => JSON.stringify(v).slice(1, -1));
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  return { method, url: render(d.url, scope, encodeURIComponent).trim(), headers, body };
}

/* ---------------------------------------------------------- retomadas */

async function continueFrom(graph: FlowGraph, node: FlowNode, handle: string | null, state: RunState, exec: FlowExecutor, endReason?: string): Promise<Halt> {
  const e = edgeFrom(graph, node.id, handle);
  if (!e) return { kind: 'end', ...(endReason ? { reason: endReason } : {}) };
  await exec.onAdvance(node.id);
  return runFrom(graph, e.target, state, exec);
}

/** O cliente respondeu o Aguarda Resposta (já com as mensagens do buffer juntadas). */
async function completeAsk(graph: FlowGraph, node: FlowNode, state: RunState, exec: FlowExecutor): Promise<Halt> {
  const d = node.data ?? {};
  const validation = String(d.validation ?? 'any');
  if (!validate(validation, state.lastMessage)) {
    const tries = Number(state.retries[node.id] ?? 0) + 1;
    state.retries[node.id] = tries;
    if (tries <= maxRetries(d, 2)) {
      await exec.sendText(render(d.invalidText || defaultInvalid(validation), scopeOf(await exec.getContact(), state)));
      return { kind: 'input', nodeId: node.id };
    }
    delete state.retries[node.id];
    exec.note('Resposta inválida após as tentativas → saída "Inválida"');
    return continueFrom(graph, node, 'invalid', state, exec, 'invalid_input');
  }
  delete state.retries[node.id];
  const key = sanitizeVar(d.saveAs);
  if (key) {
    const value = cleanAnswer(validation, state.lastMessage);
    state.vars[key] = value;
    await exec.saveToContact(key, value);
  }
  if (d.react && state.lastWaId) await exec.react(state.lastWaId, String(d.reactEmoji || '👍'));
  if (d.quote && state.lastWaId) state.quoteNext = state.lastWaId;
  state.waitToken = null;
  return continueFrom(graph, node, null, state, exec);
}

/** Cliente respondeu a uma espera (Aguarda Resposta, Menu, Carrossel ou Template). */
export async function resumeInput(
  graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor,
  input: { text: string; replyId?: string | null; waId?: string | null; mediaMsgId?: string | null },
): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.lastMessage = input.text ?? '';
  state.lastReplyId = input.replyId ?? null;
  if (input.waId !== undefined) state.lastWaId = input.waId ?? null;
  if (input.mediaMsgId !== undefined) state.mediaMsgId = input.mediaMsgId ?? null;
  const d = node.data ?? {};

  if (node.type === 'ask') {
    if (d.buffer) {
      // junta as mensagens seguidas: só segue quando o cliente fica alguns segundos sem escrever
      state.buffer = [...state.buffer, state.lastMessage].filter((x) => x.trim()).slice(-50);
      const token = newToken();
      state.waitToken = token;
      const seconds = Math.min(120, Math.max(1, Math.round(Number(d.bufferSeconds ?? 5)) || 5));
      return { kind: 'buffer', nodeId: node.id, seconds, token };
    }
    return completeAsk(graph, node, state, exec);
  }

  if (node.type === 'menu') {
    const opts = menuOptions(d);
    const chosen = matchOption(opts, state.lastMessage, state.lastReplyId);
    if (chosen) {
      delete state.retries[node.id];
      state.vars.opcao = chosen.title;
      const key = sanitizeVar(d.saveAs);
      if (key) { state.vars[key] = chosen.title; await exec.saveToContact(key, chosen.title); }
      exec.note(`Opção escolhida → ${chosen.title}`);
      state.waitToken = null;
      return continueFrom(graph, node, chosen.id, state, exec);
    }
    if (edgeFrom(graph, node.id, 'fallback')) {
      delete state.retries[node.id];
      exec.note('Nenhuma opção reconhecida → saída "Outro"');
      state.waitToken = null;
      return continueFrom(graph, node, 'fallback', state, exec);
    }
    const tries = Number(state.retries[node.id] ?? 0) + 1;
    state.retries[node.id] = tries;
    if (tries <= maxRetries(d, 1)) {
      const s = scopeOf(await exec.getContact(), state);
      await exec.sendText(render(d.invalidText || 'Não entendi 🤔 Escolha uma das opções:', s));
      const style = d.style === 'buttons' && opts.length > 3 ? 'list' : String(d.style ?? 'auto');
      await exec.sendMenu(render(d.text, s) || 'Escolha uma opção:', opts.map((o) => ({ ...o, title: render(o.title, s) })),
        style, String(d.buttonLabel || 'Ver opções'));
      return { kind: 'input', nodeId: node.id };
    }
    delete state.retries[node.id];
    return { kind: 'end', reason: 'no_option' };
  }

  if (node.type === 'carousel') {
    const btns = carouselReplyButtons(d);
    const byId = state.lastReplyId ? btns.find((b) => b.id === state.lastReplyId) : undefined;
    const byTitle = btns.filter((b) => norm(b.title) && norm(b.title) === norm(state.lastMessage));
    // pelo QR Code os botões chegam como opções numeradas: "2" = 2º botão que o cliente viu
    const n = !state.lastReplyId ? numberReply(state.lastMessage) : null;
    const byNumber = n ? carouselVisibleReplies(d)[n - 1] : undefined;
    const chosen = byId ?? (byTitle.length === 1 ? byTitle[0] : undefined) ?? byNumber;
    if (chosen) {
      state.vars.opcao = chosen.title;
      exec.note(`Botão do carrossel → ${chosen.title}`);
      state.waitToken = null;
      return continueFrom(graph, node, chosen.id, state, exec);
    }
    if (edgeFrom(graph, node.id, 'fallback')) {
      exec.note('Respondeu sem tocar num botão → saída "Outro"');
      state.waitToken = null;
      return continueFrom(graph, node, 'fallback', state, exec);
    }
    // continua esperando um toque (o prazo original vale)
    return { kind: 'input', nodeId: node.id };
  }

  if (node.type === 'template') {
    const btns = templateReplyButtons(d);
    const t = norm(state.lastMessage);
    const r = norm(state.lastReplyId);
    const n = !state.lastReplyId ? numberReply(state.lastMessage) : null;
    const chosen = btns.find((b) => norm(b.title) && (norm(b.title) === t || norm(b.title) === r)) ?? (n ? btns[n - 1] : undefined);
    state.vars.resposta_template = chosen && n && norm(chosen.title) !== t ? chosen.title : state.lastMessage;
    state.waitToken = null;
    if (chosen && edgeFrom(graph, node.id, chosen.id)) {
      exec.note(`Botão do template → ${chosen.title}`);
      return continueFrom(graph, node, chosen.id, state, exec);
    }
    exec.note('Cliente respondeu o template → saída "Respondeu"');
    return continueFrom(graph, node, 'replied', state, exec);
  }

  // o bloco deixou de esperar resposta (fluxo editado): segue a saída padrão
  return continueFrom(graph, node, null, state, exec);
}

/** Acabou o tempo do buffer do Aguarda Resposta: junta as mensagens e segue. */
export async function flushBuffer(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.lastMessage = state.buffer.join('\n');
  state.buffer = [];
  if (node.type !== 'ask') return continueFrom(graph, node, null, state, exec);
  return completeAsk(graph, node, state, exec);
}

/** Acabou o tempo de uma espera (Aguarda Resposta, Menu, Carrossel ou Template). */
export async function resumeTimeout(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.waitToken = null;
  delete state.retries[node.id];
  if (node.type === 'ask' && state.buffer.length) return flushBuffer(graph, nodeId, state, exec);
  exec.note('⏰ O cliente não respondeu a tempo → saída "Sem resposta"');
  return continueFrom(graph, node, 'timeout', state, exec, 'timeout');
}

/** Terminou o tempo de uma espera (Intervalo Inteligente ou Intervalo dentro de uma Mensagem). */
export async function resumeAfterDelay(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  if (node.type === 'message' && state.cursor[node.id] !== undefined) return runFrom(graph, node.id, state, exec, { resume: true });
  return continueFrom(graph, node, null, state, exec);
}

/** Pagamento confirmado (paid=true) ou tempo esgotado (paid=false). */
export async function resumePayment(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor, paid: boolean): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.vars.pagamento = paid ? 'aprovado' : 'nao_pago';
  exec.note(paid ? 'Pagamento confirmado → saída "Pago"' : 'Tempo esgotado sem pagamento → saída "Não pago"');
  return continueFrom(graph, node, paid ? 'paid' : 'unpaid', state, exec);
}
