/**
 * Simulador: executa o grafo (inclusive alterações ainda não salvas) com um
 * executor em memória — nada vai para o WhatsApp nem para o banco.
 * O estado da simulação fica com o cliente e volta a cada chamada.
 */
import {
  runFrom, resumeInput, resumePayment, resumeAfterDelay, normalizeState, triggerMatches,
  delayLabel, type AiRequest, type ContactSnapshot, type FlowExecutor, type Halt,
  type HttpRequestSpec, type HttpResult, type ProductInfo, type RunState,
} from './interpreter';
import { normalizeGraph, STAGE_LABEL, type Dict, type MenuOption } from './types';

export type SimOutput =
  | { kind: 'bot'; text: string }
  | { kind: 'media'; mediaType: string; url: string; caption?: string }
  | { kind: 'menu'; text: string; options: MenuOption[] }
  | { kind: 'note'; text: string };

export interface SimHistoryItem { role: 'user' | 'assistant'; content: string; }

export interface SimState {
  status: 'idle' | 'input' | 'payment' | 'end';
  nodeId: string | null;
  run: RunState;
  contact: ContactSnapshot;
  history: SimHistoryItem[];
  started: boolean;
}

export type SimInput =
  | { type: 'start' }
  | { type: 'message'; text: string; replyId?: string | null }
  | { type: 'payment'; paid: boolean };

export interface SimDeps {
  realHttp: boolean;
  ai(req: AiRequest, history: SimHistoryItem[]): Promise<string>;
  http(req: HttpRequestSpec): Promise<HttpResult>;
  product(id: string): Promise<ProductInfo | null>;
  flowName(id: string): Promise<string | null>;
  /** "Quadro › Coluna" para a anotação do simulador (null se não existir mais). */
  kanbanLabel?(boardId: string, columnId: string): Promise<string | null>;
  /** hora/data/dia/saudação e variáveis globais de verdade (a simulação não muda os valores salvos) */
  extras?(): Promise<Dict>;
  /** nome do setor para a anotação */
  departmentName?(id: string): Promise<string | null>;
}

export interface SimResult { outputs: SimOutput[]; state: SimState; visited: string[]; }

function freshState(): SimState {
  return {
    status: 'idle', nodeId: null, run: normalizeState({}), started: false, history: [],
    contact: { name: 'Cliente Teste', phone: '+55 11 99999-0000', stage: 'new', tags: [], email: null, custom: {} },
  };
}

function sanitizeState(raw: unknown): SimState {
  const s = (raw ?? null) as Dict | null;
  if (!s || typeof s !== 'object') return freshState();
  const f = freshState();
  const c = (s.contact ?? {}) as Dict;
  return {
    status: ['idle', 'input', 'payment', 'end'].includes(s.status) ? s.status : 'idle',
    nodeId: typeof s.nodeId === 'string' ? s.nodeId : null,
    run: normalizeState(s.run),
    started: !!s.started,
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

function memoryExecutor(state: SimState, outputs: SimOutput[], visited: string[], deps: SimDeps): FlowExecutor {
  const note = (text: string) => outputs.push({ kind: 'note', text });
  let extrasCache: Dict | null = null;
  const simGlobals: Dict = {};
  return {
    async getContact() { return state.contact; },
    async sendText(text) {
      outputs.push({ kind: 'bot', text });
      state.history.push({ role: 'assistant', content: text });
    },
    async sendMedia(kind, url, caption) {
      outputs.push({ kind: 'media', mediaType: kind, url, caption });
      state.history.push({ role: 'assistant', content: caption ? `[${kind}] ${caption}` : `[${kind}]` });
    },
    async sendMenu(text, options) {
      outputs.push({ kind: 'menu', text, options });
      state.history.push({ role: 'assistant', content: `${text}\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}` });
    },
    async setStage(stage) {
      state.contact.stage = stage;
      note(`📋 Etapa do funil → ${STAGE_LABEL[stage] ?? stage}`);
    },
    async addTag(tag) {
      if (!state.contact.tags.includes(tag)) state.contact.tags.push(tag);
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
      const cur = (await this.extras!())[key] ?? '';
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
  };
}

export async function simulate(rawGraph: unknown, rawState: unknown, input: SimInput, deps: SimDeps): Promise<SimResult> {
  const graph = normalizeGraph(rawGraph);
  const outputs: SimOutput[] = [];
  const visited: string[] = [];
  const state = sanitizeState(rawState);
  const exec = memoryExecutor(state, outputs, visited, deps);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  let halt: Halt | null = null;

  if (input.type === 'payment') {
    if (state.status !== 'payment' || !state.nodeId) {
      outputs.push({ kind: 'note', text: 'Não há pagamento pendente nesta simulação.' });
      return { outputs, state, visited };
    }
    halt = await resumePayment(graph, state.nodeId, state.run, exec, input.paid);
  } else if (input.type === 'message' && state.status === 'input' && state.nodeId) {
    state.history.push({ role: 'user', content: input.text });
    halt = await resumeInput(graph, state.nodeId, state.run, exec, { text: input.text, replyId: input.replyId ?? null });
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
    state.run = normalizeState({ lastMessage: text });
    state.started = true;
    halt = await runFrom(graph, trigger.id, state.run, exec);
  }

  // na simulação as esperas são puladas
  let guard = 0;
  while (halt && halt.kind === 'delay' && guard++ < 30) {
    outputs.push({ kind: 'note', text: `⏱️ Espera de ${delayLabel(halt.seconds)} — pulada na simulação` });
    halt = await resumeAfterDelay(graph, halt.nodeId, state.run, exec);
  }

  if (!halt || halt.kind === 'end' || halt.kind === 'delay') {
    state.status = 'end';
    state.nodeId = null;
    if (!halt || halt.kind !== 'end' || halt.reason !== 'goto') outputs.push({ kind: 'note', text: '✅ Fluxo finalizado.' });
  } else if (halt.kind === 'input') {
    state.status = 'input';
    state.nodeId = halt.nodeId;
  } else if (halt.kind === 'payment') {
    state.status = 'payment';
    state.nodeId = halt.nodeId;
    outputs.push({ kind: 'note', text: `💳 Aguardando confirmação do pagamento (até ${delayLabel(halt.timeoutSeconds)}).` });
  }

  state.history = state.history.slice(-30);
  return { outputs, state, visited };
}
