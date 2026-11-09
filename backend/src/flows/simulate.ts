/**
 * Simulador: executa o grafo (inclusive alterações ainda não salvas) com um
 * executor em memória — nada vai para o WhatsApp nem para o banco.
 * O estado da simulação fica com o cliente e volta a cada chamada.
 */
import {
  runFrom, resumeInput, resumePayment, resumeAfterDelay, resumeTimeout, flushBuffer, normalizeState, triggerMatches,
  delayLabel, formatBRL, findNode, type AiCallSpec, type AiRequest, type ContactSnapshot, type FlowExecutor, type Halt,
  type HttpRequestSpec, type HttpResult, type ProductInfo, type RunState,
} from './interpreter';
import { normalizeGraph, STAGE_LABEL, type Dict, type MenuOption } from './types';

export type SimOutput =
  | { kind: 'bot'; text: string }
  | { kind: 'media'; mediaType: string; url: string; caption?: string }
  | { kind: 'menu'; text: string; options: MenuOption[] }
  | { kind: 'contact'; name: string; phone: string }
  | { kind: 'pix'; text: string; amount: number; merchant: string; key: string; code: string }
  | { kind: 'carousel'; text: string; cards: { text: string; image: string; buttons: { id: string; title: string; type: string }[] }[] }
  | { kind: 'template'; name: string; text: string; buttons: { id: string; title: string }[] }
  | { kind: 'reaction'; emoji: string }
  | { kind: 'note'; text: string };

export interface SimHistoryItem { role: 'user' | 'assistant'; content: string; }

export interface SimState {
  status: 'idle' | 'input' | 'payment' | 'end';
  nodeId: string | null;
  run: RunState;
  contact: ContactSnapshot;
  history: SimHistoryItem[];
  started: boolean;
  /** a espera atual tem tempo limite (dá para simular "sem resposta") */
  canTimeout?: boolean;
  /** rodízio e "prevenir repetição" do Distribuidor (só na simulação) */
  memory?: Dict;
}

export type SimInput =
  | { type: 'start' }
  | { type: 'message'; text: string; replyId?: string | null }
  | { type: 'payment'; paid: boolean }
  | { type: 'timeout' };

export interface SimDeps {
  realHttp: boolean;
  ai(req: AiRequest, history: SimHistoryItem[]): Promise<string>;
  /** Bloco de IA: créditos do Converza ou chave própria */
  aiComplete?(spec: AiCallSpec, history: SimHistoryItem[]): Promise<string>;
  http(req: HttpRequestSpec): Promise<HttpResult>;
  product(id: string): Promise<ProductInfo | null>;
  flowName(id: string): Promise<string | null>;
  /** "Quadro › Coluna" para a anotação do simulador (null se não existir mais). */
  kanbanLabel?(boardId: string, columnId: string): Promise<string | null>;
  /** hora/data/dia/saudação e variáveis globais de verdade (a simulação não muda os valores salvos) */
  extras?(): Promise<Dict>;
  /** nome do setor para a anotação */
  departmentName?(id: string): Promise<string | null>;
  agentName?(id: string): Promise<string | null>;
  pixelName?(id: string): Promise<string | null>;
  memberName?(id: string): Promise<string | null>;
  /** link de prévia de um arquivo enviado no editor */
  fileUrl?(fileId: string): Promise<string | null>;
  timezone?(): Promise<string>;
}

export interface SimResult { outputs: SimOutput[]; state: SimState; visited: string[]; }

function freshState(): SimState {
  return {
    status: 'idle', nodeId: null, run: normalizeState({}), started: false, history: [], memory: {},
    contact: { name: 'Cliente Teste', phone: '+55 11 99999-0000', stage: 'new', tags: [], email: null, custom: {} },
  };
}

function sanitizeState(raw: unknown): SimState {
  const s = (raw ?? null) as Dict | null;
  if (!s || typeof s !== 'object') return freshState();
  const f = freshState();
  const c = (s.contact ?? {}) as Dict;
  const mem = s.memory && typeof s.memory === 'object' && !Array.isArray(s.memory) ? s.memory as Dict : {};
  return {
    status: ['idle', 'input', 'payment', 'end'].includes(s.status) ? s.status : 'idle',
    nodeId: typeof s.nodeId === 'string' ? s.nodeId : null,
    run: normalizeState(s.run),
    started: !!s.started,
    canTimeout: !!s.canTimeout,
    memory: Object.fromEntries(Object.entries(mem).slice(0, 200)),
    history: (Array.isArray(s.history) ? s.history : [])
      .filter((h: Dict) => h && (h.role === 'user' || h.role === 'assistant'))
      .slice(-30)
      .map((h: Dict) => ({ role: h.role, content: String(h.content ?? '').slice(0, 4000) })),
    contact: {
      name: String(c.name ?? f.contact.name).slice(0, 120),
      phone: String(c.phone ?? f.contact.phone).slice(0, 40),
      stage: String(c.stage ?? 'new'),
      tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 50) : [],
      email: typeof c.email === 'string' ? c.email.slice(0, 160) : null,
      custom: c.custom && typeof c.custom === 'object' && !Array.isArray(c.custom)
        ? Object.fromEntries(Object.entries(c.custom as Dict).slice(0, 50).map(([k, v]) => [String(k).slice(0, 40), String(v ?? '').slice(0, 500)]))
        : {},
    },
  };
}

const STATUS_LABEL: Record<string, string> = { pending: 'Aguardando', open: 'Atendimento', resolved: 'Resolvido' };

function memoryExecutor(state: SimState, outputs: SimOutput[], visited: string[], deps: SimDeps, typingWait = new Set<number>()): FlowExecutor {
  const note = (text: string) => outputs.push({ kind: 'note', text });
  let extrasCache: Dict | null = null;
  const simGlobals: Dict = {};
  const memory = state.memory ?? (state.memory = {});
  const said = (content: string) => state.history.push({ role: 'assistant', content });
  const fileUrl = async (ref: { url?: string; fileId?: string }) => ref.url || (ref.fileId && deps.fileUrl ? (await deps.fileUrl(ref.fileId)) ?? '' : '');

  const exec: FlowExecutor = {
    async getContact() { return state.contact; },
    async sendText(text) {
      outputs.push({ kind: 'bot', text });
      said(text);
    },
    async typing(seconds) {
      // a espera que vem logo depois é a do "digitando": não precisa do aviso genérico de espera
      outputs.push({ kind: 'note', text: `✍️ Digitando… (${seconds} s) — pulado na simulação` });
      typingWait.add(seconds);
    },
    async sendMedia(kind, url, caption) {
      outputs.push({ kind: 'media', mediaType: kind, url, caption });
      said(caption ? `[${kind}] ${caption}` : `[${kind}]`);
    },
    async sendMenu(text, options) {
      outputs.push({ kind: 'menu', text, options });
      said(`${text}\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`);
    },
    async setStage(stage) {
      state.contact.stage = stage;
      note(`📋 Etapa do funil → ${STAGE_LABEL[stage] ?? stage}`);
    },
    async addTag(tag) {
      if (!state.contact.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) state.contact.tags.push(tag);
      note(`🏷️ Etiqueta adicionada: ${tag}`);
    },
    async removeTag(tag) {
      state.contact.tags = state.contact.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
      note(`🏷️ Etiqueta removida: ${tag}`);
    },
    async setContactName(name) {
      state.contact.name = name;
      note(`👤 Nome do contato → ${name}`);
    },
    async setContactField(key, value) {
      state.contact.custom = { ...(state.contact.custom ?? {}), [key]: value };
      if (!value) delete state.contact.custom[key];
      note(`🗂️ Campo “${key}” do contato → ${value || '(vazio)'}`);
    },
    async moveToKanban(boardId, columnId) {
      const label = deps.kanbanLabel ? await deps.kanbanLabel(boardId, columnId) : null;
      note(label ? `🗂️ Kanban → ${label}` : '🗂️ Kanban: o quadro/coluna escolhido não existe mais.');
    },
    async handoff(_assign, departmentId) {
      const dept = departmentId && deps.departmentName ? await deps.departmentName(departmentId) : null;
      note(dept
        ? `🙋 Conversa enviada para a fila do setor “${dept}” — fluxos e IA ficam pausados nesta conversa.`
        : '🙋 Conversa transferida para atendimento humano — fluxos e IA ficam pausados nesta conversa.');
    },
    async extras() {
      if (!extrasCache) extrasCache = { ...(deps.extras ? await deps.extras() : {}), ...simGlobals };
      return extrasCache;
    },
    async inBusinessHours() {
      note('🕘 Horário de atendimento: na simulação conta como “dentro do horário”.');
      return true;
    },
    async setGlobal(key, op, value) {
      const cur = (await exec.extras!())[key] ?? '';
      const n = Number(String(value).replace(',', '.'));
      const next = op === 'set' ? value : String((Number(String(cur).replace(',', '.')) || 0) + (op === 'subtract' ? -n : n));
      simGlobals[key] = next;
      extrasCache = null;
      note(`🌐 Variável global ${key} → ${next} (na simulação não é salva)`);
    },
    async gotoFlow(flowId) {
      const name = await deps.flowName(flowId);
      note(`↪️ Aqui o contato seria enviado para o fluxo “${name ?? 'não encontrado'}”.`);
    },
    async http(req) {
      if (!deps.realHttp) {
        note(`🌐 ${req.method} ${req.url} — não executado na simulação (ative “Chamar integrações de verdade”).`);
        return { ok: true, status: 200, body: {} };
      }
      const r = await deps.http(req);
      note(`🌐 ${req.method} ${req.url} → ${r.status ? `HTTP ${r.status}` : r.error ?? 'falhou'}`);
      return r;
    },
    ai: (req) => deps.ai(req, state.history),
    getProduct: (id) => deps.product(id),
    onEnter(nodeId) { visited.push(nodeId); },
    onAdvance() {},
    note,
    random: () => Math.random(),

    /* ---- blocos da barra Ferramentas ---- */
    async sendMediaRef(kind, ref, caption) {
      const url = await fileUrl(ref);
      outputs.push({ kind: 'media', mediaType: kind, url, caption });
      said(caption ? `[${kind}] ${caption}` : `[${kind}]`);
    },
    async sendContactCard(name, phone) {
      outputs.push({ kind: 'contact', name, phone });
      said(`[contato] ${name} ${phone}`);
    },
    async react(_id, emoji) { outputs.push({ kind: 'reaction', emoji }); },
    async sendPix(p) {
      outputs.push({ kind: 'pix', text: p.text, amount: p.amount, merchant: p.merchantName, key: p.key, code: p.code });
      said(`[Pix ${formatBRL(p.amount)}] ${p.text}`);
    },
    async sendCarousel(text, cards) {
      const list = await Promise.all(cards.map(async (c) => ({
        text: c.text, image: await fileUrl(c.image), buttons: c.buttons.map((b) => ({ id: b.id, title: b.title, type: b.type })),
      })));
      outputs.push({ kind: 'carousel', text, cards: list });
      said(`${text}\n${cards.map((c) => `• ${c.text}`).join('\n')}`);
    },
    async sendTemplate(t) {
      outputs.push({ kind: 'template', name: t.name, text: t.preview ?? t.body.map((b) => b.value).join(' · '), buttons: t.replyButtons ?? [] });
      said(t.preview ?? `[template ${t.name}]`);
    },
    async setChatStatus(status, assignUserId, pause) {
      const who = assignUserId && deps.memberName ? await deps.memberName(assignUserId) : null;
      note(`💬 Estado do chat → ${STATUS_LABEL[status]}${who ? ` (com ${who})` : ''}${pause ? ' — fluxos e IA ficam pausados nesta conversa' : ''}`);
    },
    async notify(n) {
      note(`🔔 Notificação “${n.name}” para +${n.phone}: ${n.text}${n.template ? ` (se a pessoa não falou com o número nas últimas 24 h, vai pelo template “${n.template.name}”)` : ''}`);
      return { ok: true, info: 'simulação' };
    },
    async setDepartment(id) {
      const name = id && deps.departmentName ? await deps.departmentName(id) : null;
      note(id ? `🏢 Departamento do chat → ${name ?? 'setor removido'}` : '🏢 Departamento do chat removido');
    },
    async assignAgent(id) {
      const name = id && deps.agentName ? await deps.agentName(id) : null;
      note(id ? `🤖 Conversa entregue ao agente “${name ?? 'não encontrado'}” — daqui em diante ele responde o cliente.` : '↩️ Agente removido: a conversa volta para os fluxos.');
    },
    async kanbanAction(action, boardId, columnId) {
      const label = deps.kanbanLabel && columnId ? await deps.kanbanLabel(boardId, columnId) : null;
      note(action === 'remove' ? '🗂️ Kanban: card do contato removido do quadro' : `🗂️ Kanban: ${action === 'move' ? 'mover' : 'adicionar'} card → ${label ?? 'primeira coluna'}`);
    },
    async saveToContact(key, value) {
      const k = key.toLowerCase();
      if (['nome', 'name', 'nome_completo'].includes(k)) { if (value.trim()) state.contact.name = value.trim(); note(`👤 Nome do contato → ${value}`); return true; }
      if (['email', 'e_mail'].includes(k)) { state.contact.email = value.trim(); note(`✉️ E-mail do contato → ${value}`); return true; }
      return false;
    },
    async firePixel(px) {
      const name = deps.pixelName ? await deps.pixelName(px.pixelId) : null;
      note(`📈 Pixel “${name ?? 'não encontrado'}”: evento ${px.event}${px.value !== null ? ` · ${formatBRL(px.value, px.currency)}` : ''} (na simulação não é enviado)`);
    },
    async recordSale(s) {
      const product = s.productId ? await deps.product(s.productId) : null;
      const amount = s.amount ?? product?.price ?? 0;
      const currency = s.currency || 'BRL';
      note(`💰 Venda aprovada: ${formatBRL(amount, currency)}${product ? ` · ${product.name}` : ''} — cliente ${s.customerName} (na simulação não é registrada)`);
      return { productName: product?.name ?? '', amount, currency };
    },
    async notifyApp(title, body) { note(`🔔 Aviso para a equipe no Converza: ${title} — ${body}`); },
    async distribute(nodeId, outs, sticky) {
      const key = `rr:${nodeId}`;
      const stickyKey = `st:${nodeId}`;
      if (sticky && memory[stickyKey] && outs.includes(memory[stickyKey])) return memory[stickyKey];
      const n = Number(memory[key] ?? 0);
      memory[key] = n + 1;
      const id = outs[n % outs.length];
      if (sticky) memory[stickyKey] = id;
      return id;
    },
    async aiComplete(spec) {
      if (!deps.aiComplete) throw new Error('IA indisponível na simulação.');
      return deps.aiComplete(spec, state.history);
    },
    async aiAudio() { throw new Error('na simulação não dá para mandar áudio.'); },
    async lastInboundMedia() { return null; },
    timezone: async () => (deps.timezone ? deps.timezone() : 'America/Sao_Paulo'),
    async businessWindows() { return null; },
    now: () => new Date(),
  };
  return exec;
}

/** A espera tem tempo limite com saída ligada (ou a expiração padrão do menu/carrossel). */
function hasTimeout(graph: ReturnType<typeof normalizeGraph>, nodeId: string): boolean {
  const n = findNode(graph, nodeId);
  if (!n) return false;
  if (['menu', 'carousel', 'template'].includes(n.type)) return true;
  if (n.type === 'ask') return !n.data?.waitForever && n.data?.timeoutAmount !== undefined;
  return false;
}

export async function simulate(rawGraph: unknown, rawState: unknown, input: SimInput, deps: SimDeps): Promise<SimResult> {
  const graph = normalizeGraph(rawGraph);
  const outputs: SimOutput[] = [];
  const visited: string[] = [];
  const state = sanitizeState(rawState);
  // esperas de "digitando" (o próprio typing já avisou na simulação)
  const typingWait = new Set<number>();
  const exec = memoryExecutor(state, outputs, visited, deps, typingWait);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  let halt: Halt | null = null;

  if (input.type === 'payment') {
    if (state.status !== 'payment' || !state.nodeId) {
      outputs.push({ kind: 'note', text: 'Não há pagamento pendente nesta simulação.' });
      return { outputs, state, visited };
    }
    halt = await resumePayment(graph, state.nodeId, state.run, exec, input.paid);
  } else if (input.type === 'timeout') {
    if (state.status !== 'input' || !state.nodeId) {
      outputs.push({ kind: 'note', text: 'O fluxo não está esperando uma resposta agora.' });
      return { outputs, state, visited };
    }
    halt = await resumeTimeout(graph, state.nodeId, state.run, exec);
  } else if (input.type === 'message' && state.status === 'input' && state.nodeId) {
    state.history.push({ role: 'user', content: input.text });
    halt = await resumeInput(graph, state.nodeId, state.run, exec, { text: input.text, replyId: input.replyId ?? null, waId: 'sim', mediaMsgId: null });
  } else {
    if (!trigger) {
      outputs.push({ kind: 'note', text: 'O fluxo não tem o bloco de Início.' });
      return { outputs, state, visited };
    }
    const t = trigger.data ?? {};
    const type = String(t.type ?? 'any_message');
    const text = input.type === 'message' ? input.text : '';
    if (input.type === 'message') {
      state.history.push({ role: 'user', content: text });
      if (type === 'webhook' || type === 'manual') {
        outputs.push({ kind: 'note', text: type === 'webhook'
          ? 'Este fluxo começa por um evento de webhook, não por mensagem. Use “Iniciar” para simular o evento.'
          : 'Este fluxo é iniciado por outro fluxo (gatilho manual). Use “Iniciar” para testar.' });
        return { outputs, state, visited };
      }
      if (type === 'keyword' && !triggerMatches(t, { source: 'inbound_message', text })) {
        outputs.push({ kind: 'note', text: `A mensagem não contém as palavras-chave do gatilho (${t.keywords || 'nenhuma definida'}), então o fluxo não começaria.` });
        return { outputs, state, visited };
      }
      if (type === 'first_message' && state.started) {
        outputs.push({ kind: 'note', text: 'Gatilho “primeira mensagem”: numa conversa real só dispara no primeiro contato. Clique em Reiniciar para testar de novo.' });
        return { outputs, state, visited };
      }
    }
    state.run = normalizeState({ lastMessage: text, lastWaId: input.type === 'message' ? 'sim' : null });
    state.started = true;
    halt = await runFrom(graph, trigger.id, state.run, exec);
  }

  // na simulação as esperas são puladas e o buffer segue na hora
  let guard = 0;
  while (halt && (halt.kind === 'delay' || halt.kind === 'buffer') && guard++ < 120) {
    if (halt.kind === 'delay') {
      if (!typingWait.delete(halt.seconds)) outputs.push({ kind: 'note', text: `⏱️ Espera de ${delayLabel(halt.seconds)} — pulada na simulação` });
      halt = await resumeAfterDelay(graph, halt.nodeId, state.run, exec);
    } else {
      outputs.push({ kind: 'note', text: `⏳ Buffer de mensagens (${halt.seconds} s) — na simulação segue na hora` });
      halt = await flushBuffer(graph, halt.nodeId, state.run, exec);
    }
  }

  state.canTimeout = false;
  if (!halt || halt.kind === 'end' || halt.kind === 'delay' || halt.kind === 'buffer') {
    state.status = 'end';
    state.nodeId = null;
    if (!halt || halt.kind !== 'end' || halt.reason !== 'goto') outputs.push({ kind: 'note', text: '✅ Fluxo finalizado.' });
  } else if (halt.kind === 'input') {
    state.status = 'input';
    state.nodeId = halt.nodeId;
    state.canTimeout = hasTimeout(graph, halt.nodeId);
  } else if (halt.kind === 'payment') {
    state.status = 'payment';
    state.nodeId = halt.nodeId;
    outputs.push({ kind: 'note', text: `💳 Aguardando confirmação do pagamento (até ${delayLabel(halt.timeoutSeconds)}).` });
  }

  state.history = state.history.slice(-30);
  return { outputs, state, visited };
}
