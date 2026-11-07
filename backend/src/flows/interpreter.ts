/**
 * Interpretador de fluxos — ÚNICO para produção e simulação.
 *
 * Não acessa banco nem WhatsApp: todo efeito passa pelo FlowExecutor injetado.
 * A execução real usa um executor com banco/WhatsApp (runner.ts); o simulador usa
 * um executor em memória (simulate.ts). Assim o "Simular" se comporta exatamente
 * como o fluxo no ar.
 */
import { STAGE_LABEL, type Dict, type FlowEdge, type FlowGraph, type FlowNode, type MenuOption } from './types';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';
export interface ContactSnapshot { name: string; phone: string; stage: string; tags: string[]; email?: string | null; custom?: Record<string, unknown>; }
export interface ProductInfo { id: string; name: string; price: number; checkoutUrl: string | null; }
export interface HttpRequestSpec { method: string; url: string; headers: Record<string, string>; body?: string; }
export interface HttpResult { ok: boolean; status: number; body: unknown; error?: string; }
export interface AiRequest { system: string; model?: string; history: boolean; user?: string; maxTokens?: number; }

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
  random(): number;
}

export interface RunState {
  lastMessage: string;
  lastReplyId: string | null;
  vars: Dict;
  connectionId: string | null;
  retries: Dict;
}

export type Halt =
  | { kind: 'end'; reason?: string }
  | { kind: 'input'; nodeId: string }
  | { kind: 'delay'; nodeId: string; seconds: number }
  | { kind: 'payment'; nodeId: string; timeoutSeconds: number };

const MAX_STEPS = 80;

/* ------------------------------------------------------------------ helpers */

export function normalizeState(raw: unknown): RunState {
  const r = (raw ?? {}) as Dict;
  return {
    lastMessage: String(r.lastMessage ?? ''),
    lastReplyId: r.lastReplyId ? String(r.lastReplyId) : null,
    vars: r.vars && typeof r.vars === 'object' && !Array.isArray(r.vars) ? { ...r.vars } : {},
    connectionId: r.connectionId ? String(r.connectionId) : null,
    retries: r.retries && typeof r.retries === 'object' && !Array.isArray(r.retries) ? { ...r.retries } : {},
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
    resposta: state.lastMessage, lastMessage: state.lastMessage, mensagem: state.lastMessage,
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

function formatBRL(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

/** Executa a partir de um bloco até encontrar uma espera ou o fim. */
export async function runFrom(graph: FlowGraph, startId: string | null | undefined, state: RunState, exec: FlowExecutor): Promise<Halt> {
  let node = findNode(graph, startId);
  let steps = 0;
  while (node) {
    if (++steps > MAX_STEPS) {
      exec.note('⚠️ Execução interrompida: o fluxo entrou em um laço sem nenhuma espera.');
      return { kind: 'end', reason: 'loop' };
    }
    await exec.onEnter(node.id);
    const r = await step(graph, node, state, exec);
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

  switch (node.type) {
    case 'trigger':
      return { next: nextOf(graph, node.id, null) };

    case 'message': {
      const text = render(d.text, await scope());
      if (text.trim()) await exec.sendText(text);
      return { next: nextOf(graph, node.id, null) };
    }

    case 'media': {
      const s = await scope();
      const url = render(d.url, s).trim();
      const kind = (['image', 'audio', 'video', 'document'].includes(d.mediaType) ? d.mediaType : 'image') as MediaKind;
      if (url) await exec.sendMedia(kind, url, d.caption ? render(d.caption, s) : undefined, d.filename ? String(d.filename) : undefined);
      else exec.note('⚠️ Bloco de mídia sem URL — nada foi enviado.');
      return { next: nextOf(graph, node.id, null) };
    }

    case 'menu': {
      const opts = menuOptions(d);
      if (!opts.length) {
        exec.note('⚠️ Menu sem opções — seguindo pela saída "Outro".');
        return { next: nextOf(graph, node.id, 'fallback') };
      }
      const s = await scope();
      await exec.sendMenu(render(d.text, s) || 'Escolha uma opção:', opts.map((o) => ({ ...o, title: render(o.title, s) })),
        String(d.style ?? 'auto'), String(d.buttonLabel || 'Ver opções'));
      state.retries[node.id] = 0;
      return { kind: 'input', nodeId: node.id };
    }

    case 'ask': {
      const text = render(d.text, await scope());
      if (text.trim()) await exec.sendText(text);
      state.retries[node.id] = 0;
      return { kind: 'input', nodeId: node.id };
    }

    case 'condition': {
      const ok = await evaluateCondition(d, state, exec);
      exec.note(`Condição → ${ok ? 'sim' : 'não'}`);
      return { next: nextOf(graph, node.id, ok ? 'true' : 'false') };
    }

    case 'delay':
      return { kind: 'delay', nodeId: node.id, seconds: delaySeconds(d) };

    case 'random': {
      const pa = Math.min(100, Math.max(0, Number(d.percentA ?? 50)));
      const branch = exec.random() * 100 < pa ? 'a' : 'b';
      exec.note(`Divisão A/B → caminho ${branch.toUpperCase()}`);
      return { next: nextOf(graph, node.id, branch) };
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
      return { next: nextOf(graph, node.id, null) };
    }

    case 'handoff': {
      if (d.message) {
        const text = render(d.message, await scope());
        if (text.trim()) await exec.sendText(text);
      }
      await exec.handoff(d.assignUserId ? String(d.assignUserId) : null, d.departmentId ? String(d.departmentId) : null);
      return { next: nextOf(graph, node.id, null) };
    }

    case 'http': {
      const s = await scope();
      const req = buildHttp(d, s);
      let res: HttpResult;
      if (!req.url) res = { ok: false, status: 0, body: null, error: 'URL vazia' };
      else {
        try { res = await exec.http(req); }
        catch (err) { res = { ok: false, status: 0, body: null, error: (err as Error).message }; }
      }
      const key = sanitizeVar(d.saveAs) || 'http';
      state.vars[key] = res.body;
      state.vars[`${key}_status`] = res.status;
      return { next: nextOf(graph, node.id, res.ok ? 'success' : 'error') };
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
      return { next: nextOf(graph, node.id, null) };
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
      return { next: nextOf(graph, node.id, null) };
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
      return { next: nextOf(graph, node.id, chosen ?? 'none') };
    }

    case 'goto_flow': {
      if (!d.flowId) {
        exec.note('⚠️ Nenhum fluxo selecionado no bloco "Ir para fluxo".');
        return { kind: 'end' };
      }
      await exec.gotoFlow(String(d.flowId));
      await exec.onAdvance(node.id);
      return { kind: 'end', reason: 'goto' };
    }

    default:
      return { next: nextOf(graph, node.id, null) };
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

  let value = '';
  if (field === 'lastMessage') value = state.lastMessage;
  else if (field === 'var') value = String(state.vars[sanitizeVar(d.varName)] ?? '');
  else if (field === 'name') value = contact.name;
  else if (field === 'stage') value = contact.stage;
  else if (field === 'phone') value = contact.phone;
  else if (field === 'global') value = String((exec.extras ? await exec.extras() : {})[String(d.globalKey ?? '')] ?? '');

  const v = norm(value);
  const target = norm(render(d.value, scopeOf(contact, state, exec.extras ? await exec.extras() : {})));
  const alts = alternatives(target);

  switch (op) {
    case 'contains': return alts.some((w) => v.includes(w));
    case 'not_contains': return !alts.some((w) => v.includes(w));
    case 'equals': return alts.some((w) => v === w);
    case 'not_equals': return !alts.some((w) => v === w);
    case 'starts_with': return alts.some((w) => v.startsWith(w));
    case 'not_empty': return v.length > 0;
    case 'is_empty': return v.length === 0;
    case 'is_number': return /^-?\d+([.,]\d+)?$/.test(v);
    case 'greater_than': return toNum(v) > toNum(target);
    case 'less_than': return toNum(v) < toNum(target);
    default: return false;
  }
}

function buildHttp(d: Dict, scope: Dict): HttpRequestSpec {
  const method = String(d.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const h of Array.isArray(d.headers) ? d.headers : []) {
    const k = String(h?.key ?? '').trim();
    if (k) headers[k] = render(h.value, scope);
  }
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(method) && String(d.body ?? '').trim()) {
    body = render(d.body, scope, (v) => JSON.stringify(v).slice(1, -1));
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  return { method, url: render(d.url, scope, encodeURIComponent).trim(), headers, body };
}

/* ---------------------------------------------------------- retomadas */

/** Cliente respondeu a uma Pergunta ou Menu. */
export async function resumeInput(
  graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor,
  input: { text: string; replyId?: string | null },
): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.lastMessage = input.text ?? '';
  state.lastReplyId = input.replyId ?? null;
  const d = node.data ?? {};

  if (node.type === 'ask') {
    const validation = String(d.validation ?? 'any');
    if (!validate(validation, state.lastMessage)) {
      const tries = Number(state.retries[node.id] ?? 0) + 1;
      state.retries[node.id] = tries;
      if (tries <= maxRetries(d, 2)) {
        await exec.sendText(render(d.invalidText || defaultInvalid(validation), scopeOf(await exec.getContact(), state)));
        return { kind: 'input', nodeId: node.id };
      }
      delete state.retries[node.id];
      const alt = edgeFrom(graph, node.id, 'invalid');
      exec.note('Resposta inválida após as tentativas → saída "Inválida"');
      if (!alt) return { kind: 'end', reason: 'invalid_input' };
      await exec.onAdvance(node.id);
      return runFrom(graph, alt.target, state, exec);
    }
    delete state.retries[node.id];
    const key = sanitizeVar(d.saveAs);
    if (key) state.vars[key] = cleanAnswer(validation, state.lastMessage);
    const next = nextOf(graph, node.id, null);
    if (!next) return { kind: 'end' };
    await exec.onAdvance(node.id);
    return runFrom(graph, next.id, state, exec);
  }

  if (node.type === 'menu') {
    const opts = menuOptions(d);
    const chosen = matchOption(opts, state.lastMessage, state.lastReplyId);
    if (chosen) {
      delete state.retries[node.id];
      state.vars.opcao = chosen.title;
      const key = sanitizeVar(d.saveAs);
      if (key) state.vars[key] = chosen.title;
      exec.note(`Opção escolhida → ${chosen.title}`);
      const e = edgeFrom(graph, node.id, chosen.id);
      if (!e) return { kind: 'end' };
      await exec.onAdvance(node.id);
      return runFrom(graph, e.target, state, exec);
    }
    const fb = edgeFrom(graph, node.id, 'fallback');
    if (fb) {
      delete state.retries[node.id];
      exec.note('Nenhuma opção reconhecida → saída "Outro"');
      await exec.onAdvance(node.id);
      return runFrom(graph, fb.target, state, exec);
    }
    const tries = Number(state.retries[node.id] ?? 0) + 1;
    state.retries[node.id] = tries;
    if (tries <= maxRetries(d, 1)) {
      const s = scopeOf(await exec.getContact(), state);
      await exec.sendText(render(d.invalidText || 'Não entendi 🤔 Escolha uma das opções:', s));
      await exec.sendMenu(render(d.text, s) || 'Escolha uma opção:', opts.map((o) => ({ ...o, title: render(o.title, s) })),
        String(d.style ?? 'auto'), String(d.buttonLabel || 'Ver opções'));
      return { kind: 'input', nodeId: node.id };
    }
    delete state.retries[node.id];
    return { kind: 'end', reason: 'no_option' };
  }

  // o bloco deixou de esperar resposta (fluxo editado): segue a saída padrão
  const next = nextOf(graph, node.id, null);
  if (!next) return { kind: 'end' };
  await exec.onAdvance(node.id);
  return runFrom(graph, next.id, state, exec);
}

/** Terminou o tempo de um bloco Espera. */
export async function resumeAfterDelay(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  const next = nextOf(graph, node.id, null);
  if (!next) return { kind: 'end' };
  await exec.onAdvance(node.id);
  return runFrom(graph, next.id, state, exec);
}

/** Pagamento confirmado (paid=true) ou tempo esgotado (paid=false). */
export async function resumePayment(graph: FlowGraph, nodeId: string, state: RunState, exec: FlowExecutor, paid: boolean): Promise<Halt> {
  const node = findNode(graph, nodeId);
  if (!node) return { kind: 'end', reason: 'node_removed' };
  state.vars.pagamento = paid ? 'aprovado' : 'nao_pago';
  exec.note(paid ? 'Pagamento confirmado → saída "Pago"' : 'Tempo esgotado sem pagamento → saída "Não pago"');
  const e = edgeFrom(graph, node.id, paid ? 'paid' : 'unpaid');
  if (!e) return { kind: 'end' };
  await exec.onAdvance(node.id);
  return runFrom(graph, e.target, state, exec);
}
