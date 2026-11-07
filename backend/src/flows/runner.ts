/**
 * Execução real dos fluxos: guarda o estado em flow_runs, envia pelo WhatsApp,
 * registra no inbox, conta estatísticas por bloco e agenda esperas na fila.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';
import { ensureConversation } from '../modules/conversationStore';
import { upsertContactCard } from '../modules/kanbanStore';
import { enqueueFlowJob, type FlowJobData } from '../queue';
import { aiCall } from '../ai/usage';
import { sendText, sendMedia, sendButtons, sendList, type WaConnection, type SendResult } from '../whatsapp/cloud-api';
import { safeHttpRequest } from './http';
import { flowExtras, setGlobalValue } from './globals';
import { openNow } from '../modules/businessHours';
import { defaultFlowsFor } from '../modules/defaultFlows';
import { normalizeGraph, triggerOf, STAGES, type Dict, type FlowGraph } from './types';
import {
  runFrom, resumeInput, resumeAfterDelay, resumePayment, normalizeState, triggerMatches, norm,
  type FlowExecutor, type Halt, type RunState,
} from './interpreter';

type FlowRow = typeof schema.flows.$inferSelect;
type RunRow = typeof schema.flowRuns.$inferSelect;
type ContactRow = typeof schema.contacts.$inferSelect;
type ConnectionRow = typeof schema.connections.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;
type MsgType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'template';

export const ACTIVE_RUN_STATUSES = ['running', 'waiting', 'waiting_input', 'waiting_payment'];

export interface InboundEvent {
  accountId: string;
  contactId: string;
  text: string;
  replyId?: string | null;
  connectionId?: string | null;
  source: 'inbound_message' | 'webhook';
  isFirstMessage?: boolean;
  webhookId?: string | null;
  vars?: Dict;
  /** fluxos que não devem começar por este evento (o webhook já cuidou deles) */
  excludeFlowIds?: string[];
}

/* -------------------------------------------------------------- executor */

interface DbExecutor extends FlowExecutor { pendingGoto: string | null; }

function createDbExecutor(p: { accountId: string; flowId: string; contactId: string; state: RunState }): DbExecutor {
  let contactRow: ContactRow | null = null;
  let connCache: ConnectionRow | null | undefined;
  let convCache: ConversationRow | null = null;
  let extrasCache: Record<string, string> | null = null;

  const contact = async (): Promise<ContactRow> => {
    if (!contactRow) {
      const [c] = await db.select().from(schema.contacts)
        .where(and(eq(schema.contacts.id, p.contactId), eq(schema.contacts.accountId, p.accountId))).limit(1);
      if (!c) throw new Error('Contato não encontrado');
      contactRow = c;
    }
    return contactRow;
  };

  const connection = async (): Promise<ConnectionRow | null> => {
    if (connCache !== undefined) return connCache;
    let row: ConnectionRow | undefined;
    if (p.state.connectionId && isUuid(p.state.connectionId)) {
      [row] = await db.select().from(schema.connections)
        .where(and(eq(schema.connections.id, p.state.connectionId), eq(schema.connections.accountId, p.accountId))).limit(1);
    }
    if (!row) {
      [row] = await db.select().from(schema.connections)
        .where(and(eq(schema.connections.accountId, p.accountId), eq(schema.connections.status, 'connected'))).limit(1);
    }
    connCache = row ?? null;
    return connCache;
  };

  const conversation = async (): Promise<ConversationRow> => {
    if (!convCache) {
      const c = await connection();
      convCache = await ensureConversation(p.accountId, p.contactId, c?.id ?? null);
    }
    return convCache;
  };

  const recipient = async () => {
    const c = await contact();
    return c.waId ?? c.phone.replace(/\D/g, '');
  };

  const deliver = async (
    send: (conn: WaConnection, to: string) => Promise<SendResult>,
    body: string, type: MsgType, mediaUrl: string | null,
  ) => {
    const conn = await connection();
    let status: 'sent' | 'failed' = 'failed';
    let waMessageId: string | null = null;
    let error: string | null = conn ? null : 'Conversa sem conexão de WhatsApp';
    if (conn) {
      try {
        const r = await send({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, await recipient());
        waMessageId = r.waMessageId;
        status = 'sent';
      } catch (err) {
        error = (err as Error).message;
        console.error('[flow] envio falhou:', error);
      }
    }
    // registra no inbox para a equipe acompanhar o que o fluxo enviou
    const conv = await conversation();
    const [msg] = await db.insert(schema.messages).values({
      accountId: p.accountId, conversationId: conv.id, direction: 'out', type, body, mediaUrl, status, waMessageId, error,
    }).returning();
    await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
    emitToAccount(p.accountId, 'message:new', { conversationId: conv.id, message: msg });
  };

  const bump = async (nodeId: string, col: 'entries' | 'advances') => {
    try {
      await db.insert(schema.flowNodeStats)
        .values({ flowId: p.flowId, nodeId, entries: col === 'entries' ? 1 : 0, advances: col === 'advances' ? 1 : 0 })
        .onConflictDoUpdate({
          target: [schema.flowNodeStats.flowId, schema.flowNodeStats.nodeId],
          set: col === 'entries'
            ? { entries: sql`${schema.flowNodeStats.entries} + 1` }
            : { advances: sql`${schema.flowNodeStats.advances} + 1` },
        });
    } catch (err) {
      console.warn('[flow] estatística:', (err as Error).message);
    }
  };

  const updateContact = async (patch: Partial<ContactRow>) => {
    const [row] = await db.update(schema.contacts).set(patch)
      .where(and(eq(schema.contacts.id, p.contactId), eq(schema.contacts.accountId, p.accountId))).returning();
    if (row) contactRow = row;
  };

  const exec: DbExecutor = {
    pendingGoto: null,
    async getContact() {
      const c = await contact();
      return { name: c.name, phone: c.phone, stage: c.stage, tags: [...c.tags], email: c.email, custom: { ...(c.custom as Record<string, unknown> ?? {}) } };
    },
    async sendText(text) {
      await deliver((conn, to) => sendText(conn, to, text), text, 'text', null);
    },
    async sendMedia(kind, url, caption, filename) {
      await deliver((conn, to) => sendMedia(conn, to, kind, url, caption, filename), caption ?? '', kind, url);
    },
    async sendMenu(text, options, style, buttonLabel) {
      const numbered = `${text}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}`;
      const mode = style === 'auto' ? (options.length <= 3 ? 'buttons' : options.length <= 10 ? 'list' : 'text') : style;
      await deliver(async (conn, to) => {
        try {
          if (mode === 'buttons' && options.length <= 3) return await sendButtons(conn, to, text, options);
          if (mode === 'list' && options.length <= 10) return await sendList(conn, to, text, buttonLabel, options);
        } catch (err) {
          console.warn('[flow] menu interativo falhou, enviando como texto:', (err as Error).message);
        }
        return sendText(conn, to, numbered);
      }, numbered, 'text', null);
    },
    async setStage(stage) {
      if (!(STAGES as readonly string[]).includes(stage)) return;
      await updateContact({ stage: stage as ContactRow['stage'] });
    },
    async addTag(tag) {
      const t = tag.trim();
      const c = await contact();
      if (!t || c.tags.some((x) => norm(x) === norm(t))) return;
      await updateContact({ tags: [...c.tags, t] });
    },
    async removeTag(tag) {
      const c = await contact();
      const tags = c.tags.filter((x) => norm(x) !== norm(tag));
      if (tags.length !== c.tags.length) await updateContact({ tags });
    },
    async setContactName(name) {
      await updateContact({ name: name.slice(0, 120) });
    },
    async setContactField(key, value) {
      const [f] = await db.select().from(schema.contactFields)
        .where(and(eq(schema.contactFields.accountId, p.accountId), eq(schema.contactFields.key, key))).limit(1);
      if (!f) { console.warn('[flow] campo personalizado não existe:', key); return; }
      const c = await contact();
      const custom = { ...((c.custom ?? {}) as Record<string, unknown>) };
      if (value) custom[key] = value.slice(0, 500); else delete custom[key];
      await updateContact({ custom });
    },
    async moveToKanban(boardId, columnId) {
      if (!isUuid(boardId) || !isUuid(columnId)) return;
      const r = await upsertContactCard(p.accountId, p.contactId, boardId, columnId);
      if ('error' in r) console.warn('[flow] Kanban:', r.error);
    },
    async handoff(assignUserId, departmentId) {
      const conv = await conversation();
      let assigned: string | null = null;
      if (assignUserId && isUuid(assignUserId)) {
        const [m] = await db.select().from(schema.memberships)
          .where(and(eq(schema.memberships.userId, assignUserId), eq(schema.memberships.accountId, p.accountId))).limit(1);
        if (m) assigned = assignUserId;
      }
      // fila do setor: fica em Aguardando só para os membros do setor
      let dept: string | null = null;
      if (!assigned && departmentId && isUuid(departmentId)) {
        const [d] = await db.select({ id: schema.departments.id }).from(schema.departments)
          .where(and(eq(schema.departments.id, departmentId), eq(schema.departments.accountId, p.accountId))).limit(1);
        dept = d?.id ?? null;
      }
      const [updated] = await db.update(schema.conversations)
        .set({ botPaused: true, status: 'pending', ...(assigned ? { assignedUserId: assigned } : {}), ...(dept ? { departmentId: dept, assignedUserId: null } : {}) })
        .where(eq(schema.conversations.id, conv.id)).returning();
      if (updated) convCache = updated;
      emitToAccount(p.accountId, 'conversation:updated', { conversation: updated });
    },
    async gotoFlow(flowId) { exec.pendingGoto = flowId; },
    async extras() {
      if (!extrasCache) extrasCache = await flowExtras(p.accountId);
      return extrasCache;
    },
    async inBusinessHours() {
      const c = await connection();
      const h = await openNow(p.accountId, c?.id ?? null);
      return h.enabled ? h.open : null;
    },
    async setGlobal(key, op, value) {
      await setGlobalValue(p.accountId, key, op, value);
      extrasCache = null;
    },
    http: (req) => safeHttpRequest(req),
    async ai(req) {
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: req.system }];
      if (req.history) {
        const conv = await conversation();
        const hist = await db.select().from(schema.messages)
          .where(eq(schema.messages.conversationId, conv.id))
          .orderBy(desc(schema.messages.createdAt)).limit(12);
        for (const m of hist.reverse()) {
          if (m.body) messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body });
        }
      }
      if (req.user) messages.push({ role: 'user', content: req.user });
      // para "Uso da IA": a conversa do contato (sem criar uma nova só por isso)
      const convId = convCache?.id ?? (await db.select({ id: schema.conversations.id }).from(schema.conversations)
        .where(and(eq(schema.conversations.accountId, p.accountId), eq(schema.conversations.contactId, p.contactId)))
        .orderBy(desc(schema.conversations.lastMessageAt)).limit(1))[0]?.id ?? null;
      return aiCall(p.accountId, messages, {
        model: req.model, maxTokens: req.maxTokens,
        usage: { kind: 'flow_ai', conversationId: convId, contactId: p.contactId, flowId: p.flowId, label: 'Bloco de IA do fluxo' },
      });
    },
    async getProduct(id) {
      if (!isUuid(id)) return null;
      const [r] = await db.select().from(schema.products)
        .where(and(eq(schema.products.id, id), eq(schema.products.accountId, p.accountId))).limit(1);
      return r ? { id: r.id, name: r.name, price: Number(r.price), checkoutUrl: r.checkoutUrl } : null;
    },
    onEnter: (nodeId) => bump(nodeId, 'entries'),
    onAdvance: (nodeId) => bump(nodeId, 'advances'),
    note: () => {},
    random: () => Math.random(),
  };
  return exec;
}

/* ------------------------------------------------------------- execução */

async function persist(runId: string, halt: Halt, state: RunState) {
  const set = (patch: Partial<RunRow>) =>
    db.update(schema.flowRuns).set({ context: state as any, ...patch }).where(eq(schema.flowRuns.id, runId));
  switch (halt.kind) {
    case 'end':
      await set({ status: 'done', currentNodeId: null, finishedAt: new Date() });
      break;
    case 'input':
      await set({ status: 'waiting_input', currentNodeId: halt.nodeId });
      break;
    case 'delay':
      await set({ status: 'waiting', currentNodeId: halt.nodeId });
      await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'delay' }, halt.seconds * 1000);
      break;
    case 'payment':
      await set({ status: 'waiting_payment', currentNodeId: halt.nodeId });
      await enqueueFlowJob({ runId, nodeId: halt.nodeId, kind: 'payment_timeout' }, halt.timeoutSeconds * 1000);
      break;
  }
}

async function execute(run: RunRow, flow: FlowRow, state: RunState, fn: (exec: FlowExecutor) => Promise<Halt>) {
  const exec = createDbExecutor({ accountId: flow.accountId, flowId: flow.id, contactId: run.contactId, state });
  let halt: Halt;
  try {
    halt = await fn(exec);
  } catch (err) {
    console.error(`[flow ${flow.id}] erro na execução ${run.id}:`, (err as Error).message);
    await db.update(schema.flowRuns).set({ status: 'error', finishedAt: new Date(), context: state as any })
      .where(eq(schema.flowRuns.id, run.id));
    return;
  }
  await persist(run.id, halt, state);
  if (exec.pendingGoto) {
    await startFlowById(flow.accountId, exec.pendingGoto, run.contactId, state).catch((err) =>
      console.error('[flow] ir para fluxo falhou:', (err as Error).message));
  }
}

/** Troca o status de forma atômica — só um processo retoma cada execução. */
async function claim(runId: string, from: string, nodeId?: string | null): Promise<RunRow | null> {
  const conds = [eq(schema.flowRuns.id, runId), eq(schema.flowRuns.status, from)];
  if (nodeId) conds.push(eq(schema.flowRuns.currentNodeId, nodeId));
  const [row] = await db.update(schema.flowRuns).set({ status: 'running' }).where(and(...conds)).returning();
  return row ?? null;
}

async function loadRunnableFlow(run: RunRow): Promise<FlowRow | null> {
  const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, run.flowId)).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) {
    await db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(eq(schema.flowRuns.id, run.id));
    return null;
  }
  return flow;
}

async function startRun(flow: FlowRow, contactId: string, state: RunState, opts: { ignoreReentry?: boolean } = {}): Promise<boolean> {
  const graph = normalizeGraph(flow.graph);
  const t = triggerOf(flow.trigger, graph);
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return false;

  if (!opts.ignoreReentry && (t.reentry === 'once' || t.reentry === 'cooldown')) {
    const [last] = await db.select({ startedAt: schema.flowRuns.startedAt }).from(schema.flowRuns)
      .where(and(eq(schema.flowRuns.flowId, flow.id), eq(schema.flowRuns.contactId, contactId)))
      .orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (last) {
      if (t.reentry === 'once') return false;
      const hours = Math.max(1, Number(t.cooldownHours ?? 24) || 24);
      if (Date.now() - last.startedAt.getTime() < hours * 3_600_000) return false;
    }
  }

  // índice único parcial: no máximo uma execução em andamento por fluxo + contato
  const [run] = await db.insert(schema.flowRuns)
    .values({ accountId: flow.accountId, flowId: flow.id, contactId, status: 'running', context: state as any })
    .onConflictDoNothing().returning();
  if (!run) return false;

  await execute(run, flow, state, (exec) => runFrom(graph, trigger.id, state, exec));
  return true;
}

async function startFlowById(accountId: string, flowId: string, contactId: string, from: RunState) {
  if (!isUuid(flowId)) return;
  const [flow] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) return;
  const state = normalizeState({ lastMessage: from.lastMessage, vars: from.vars, connectionId: from.connectionId });
  await startRun(flow, contactId, state, { ignoreReentry: true });
}

/**
 * Dispara um fluxo para o contato por fora do gatilho (ex.: o agente de IA manda o checkout).
 * 'started' = começou; 'running' = já está em andamento para esse contato; 'inactive' = fluxo pausado/arquivado/inexistente.
 */
export async function startFlowForContact(accountId: string, flowId: string, contactId: string,
  from: { lastMessage?: string; connectionId?: string | null; vars?: Dict } = {}): Promise<'started' | 'running' | 'inactive'> {
  if (!isUuid(flowId)) return 'inactive';
  const [flow] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow || flow.status !== 'active' || flow.archivedAt) return 'inactive';
  const state = normalizeState({ lastMessage: from.lastMessage ?? '', vars: from.vars ?? {}, connectionId: from.connectionId ?? null });
  return (await startRun(flow, contactId, state, { ignoreReentry: true })) ? 'started' : 'running';
}

/**
 * Fluxo que espera o cliente responder (o webhook mandou um modelo fora da janela de 24h).
 * Na próxima mensagem dele, o fluxo começa do início com as variáveis do evento.
 */
async function startPendingFlow(ev: InboundEvent): Promise<boolean> {
  const [p] = await db.delete(schema.flowPending)
    .where(and(eq(schema.flowPending.contactId, ev.contactId), eq(schema.flowPending.accountId, ev.accountId)))
    .returning();
  if (!p || p.expiresAt.getTime() < Date.now()) return false;
  const r = await startFlowForContact(ev.accountId, p.flowId, ev.contactId, {
    lastMessage: ev.text, connectionId: ev.connectionId ?? p.connectionId, vars: (p.vars ?? {}) as Dict,
  });
  return r === 'started';
}

/* ------------------------------------------------------------ entradas */

/**
 * Chamado a cada mensagem recebida ou evento de webhook.
 * Retorna true se algum fluxo tratou o evento (para o agente de IA não responder junto).
 */
export async function triggerFlowsForInbound(ev: InboundEvent): Promise<boolean> {
  // 1) o contato está respondendo uma Pergunta/Menu → retoma a execução mais recente
  if (ev.source === 'inbound_message') {
    const [waiting] = await db.select().from(schema.flowRuns).where(and(
      eq(schema.flowRuns.accountId, ev.accountId),
      eq(schema.flowRuns.contactId, ev.contactId),
      eq(schema.flowRuns.status, 'waiting_input'),
    )).orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (waiting) {
      const run = await claim(waiting.id, 'waiting_input');
      if (run) {
        const flow = await loadRunnableFlow(run);
        if (flow) {
          const graph = normalizeGraph(flow.graph);
          const state = normalizeState(run.context);
          if (ev.connectionId) state.connectionId = ev.connectionId;
          await execute(run, flow, state, (exec) =>
            resumeInput(graph, run.currentNodeId ?? '', state, exec, { text: ev.text, replyId: ev.replyId ?? null }));
          return true;
        }
      }
    }
  }

  // 1b) respondeu o modelo mandado pelo webhook → começa o fluxo que estava esperando
  if (ev.source === 'inbound_message' && await startPendingFlow(ev)) return true;

  // 2) inicia os fluxos cujo gatilho combina (palavra-chave tem prioridade)
  const flows = await db.select().from(schema.flows).where(and(
    eq(schema.flows.accountId, ev.accountId), eq(schema.flows.status, 'active'), isNull(schema.flows.archivedAt),
  ));
  const skip = new Set(ev.excludeFlowIds ?? []);
  const matched = flows
    .filter((f) => !skip.has(f.id))
    .map((f) => ({ flow: f, trigger: triggerOf(f.trigger, normalizeGraph(f.graph)) }))
    .filter(({ trigger }) => triggerMatches(trigger, ev));
  const byKeyword = matched.filter(({ trigger }) => trigger.type === 'keyword');

  // 3) fluxos padrões do número (palavra-chave continua valendo antes de tudo)
  if (!byKeyword.length && ev.source === 'inbound_message') {
    const defaults = await defaultFlowsFor(ev.connectionId);
    if (defaults?.offHoursFlowId) {
      const h = await openNow(ev.accountId, ev.connectionId);
      // fora do horário: só o aviso de fora do horário responde (uma vez a cada 12 h por contato)
      if (h.enabled && !h.open) {
        await startDefaultFlow(defaults.offHoursFlowId, ev, 12);
        return true;
      }
    }
    // boas-vindas: primeira mensagem de um contato novo, quando nenhum fluxo tem gatilho para ela
    if (!matched.length && ev.isFirstMessage && defaults?.welcomeFlowId && await startDefaultFlow(defaults.welcomeFlowId, ev, 0)) return true;
  }
  const selected = byKeyword.length ? byKeyword : matched;

  let started = false;
  for (const { flow } of selected) {
    try {
      const state = normalizeState({
        lastMessage: ev.text, lastReplyId: ev.replyId ?? null, vars: ev.vars ?? {}, connectionId: ev.connectionId ?? null,
      });
      if (await startRun(flow, ev.contactId, state)) started = true;
    } catch (err) {
      console.error(`[flow ${flow.id}] erro ao iniciar:`, (err as Error).message);
    }
  }
  return started;
}

/**
 * Começa um fluxo padrão (escolhido em Configurações › Fluxos Padrões). Vale para fluxos ativos e rascunhos
 * (o gatilho deles não importa aqui); fluxo pausado ou arquivado não roda. `throttleHours`: não repete para
 * o mesmo contato dentro desse tempo (0 = sem trava).
 */
async function startDefaultFlow(flowId: string, ev: InboundEvent, throttleHours: number): Promise<boolean> {
  const [flow] = await db.select().from(schema.flows).where(and(
    eq(schema.flows.id, flowId), eq(schema.flows.accountId, ev.accountId), isNull(schema.flows.archivedAt),
  )).limit(1);
  if (!flow || flow.status === 'paused') return false;
  if (throttleHours > 0) {
    const [last] = await db.select({ startedAt: schema.flowRuns.startedAt }).from(schema.flowRuns)
      .where(and(eq(schema.flowRuns.flowId, flow.id), eq(schema.flowRuns.contactId, ev.contactId)))
      .orderBy(desc(schema.flowRuns.startedAt)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < throttleHours * 3_600_000) return false;
  }
  try {
    const state = normalizeState({ lastMessage: ev.text, lastReplyId: ev.replyId ?? null, vars: ev.vars ?? {}, connectionId: ev.connectionId ?? null });
    return await startRun(flow, ev.contactId, state, { ignoreReentry: true });
  } catch (err) {
    console.error(`[flow ${flow.id}] fluxo padrão não começou:`, (err as Error).message);
    return false;
  }
}

/** Nada respondeu a mensagem (nenhum fluxo e nenhum agente de IA): o fluxo padrão "quando nada responde". */
export async function startFallbackFlow(ev: InboundEvent): Promise<boolean> {
  const defaults = await defaultFlowsFor(ev.connectionId);
  if (!defaults?.fallbackFlowId) return false;
  return startDefaultFlow(defaults.fallbackFlowId, ev, 1);
}

/** Pagamento aprovado (webhook de venda) → retoma execuções aguardando pagamento do contato. */
export async function onPaymentApproved(accountId: string, contactId: string) {
  const runs = await db.select().from(schema.flowRuns).where(and(
    eq(schema.flowRuns.accountId, accountId), eq(schema.flowRuns.contactId, contactId),
    eq(schema.flowRuns.status, 'waiting_payment'),
  ));
  for (const r of runs) await resumePaymentRun(r.id, r.currentNodeId ?? '', true);
}

async function resumePaymentRun(runId: string, nodeId: string, paid: boolean) {
  const run = await claim(runId, 'waiting_payment', nodeId || null);
  if (!run) return;
  const flow = await loadRunnableFlow(run);
  if (!flow) return;
  const graph = normalizeGraph(flow.graph);
  const state = normalizeState(run.context);
  await execute(run, flow, state, (exec) => resumePayment(graph, nodeId, state, exec, paid));
}

/** Processa os jobs da fila de fluxos (fim de espera / tempo do pagamento). */
export async function handleFlowJob(data: FlowJobData) {
  if (data.kind === 'payment_timeout') return resumePaymentRun(data.runId, data.nodeId, false);

  if (data.kind === 'delay') {
    const run = await claim(data.runId, 'waiting', data.nodeId);
    if (!run) return;
    const flow = await loadRunnableFlow(run);
    if (!flow) return;
    const graph = normalizeGraph(flow.graph);
    const state = normalizeState(run.context);
    return execute(run, flow, state, (exec) => resumeAfterDelay(graph, data.nodeId, state, exec));
  }

  // job do motor antigo: nodeId era o PRÓXIMO bloco
  const run = await claim(data.runId, 'waiting');
  if (!run) return;
  const flow = await loadRunnableFlow(run);
  if (!flow) return;
  const graph: FlowGraph = normalizeGraph(flow.graph);
  const state = normalizeState(run.context);
  return execute(run, flow, state, (exec) => runFrom(graph, data.nodeId, state, exec));
}

/** Ao subir o servidor, execuções presas em "running" (processo reiniciado) viram erro. */
export async function cleanupOrphanRuns() {
  await db.update(schema.flowRuns).set({ status: 'error', finishedAt: new Date() })
    .where(eq(schema.flowRuns.status, 'running'));
}

export async function stopRunsForContact(accountId: string, contactId: string, runId?: string) {
  const conds = [
    eq(schema.flowRuns.accountId, accountId), eq(schema.flowRuns.contactId, contactId),
    inArray(schema.flowRuns.status, ACTIVE_RUN_STATUSES),
  ];
  if (runId) conds.push(eq(schema.flowRuns.id, runId));
  return db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(and(...conds)).returning({ id: schema.flowRuns.id });
}
