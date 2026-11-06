import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { sendText } from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';
import { ensureConversation } from '../modules/conversations';
import { enqueueFlowResume } from '../queue';

/**
 * Motor de fluxos.
 * Grafo: { nodes: [{ id, type, data }], edges: [{ source, target, branch? }] }
 * Blocos: trigger | message | ask | condition | action | delay
 *  - message:   envia data.text (aceita {{name}}, {{phone}}, {{lastMessage}})
 *  - ask:       envia data.text e PAUSA até o contato responder; a resposta
 *               vira ctx.lastMessage para os blocos seguintes
 *  - condition: avalia ctx[data.field] com data.op/data.value; segue a aresta
 *               com branch 'true' ou 'false'
 *  - action:    data.setStage / data.addTag no contato
 *  - delay:     aguarda data.seconds e retoma automaticamente pela fila
 */
export interface FlowNode { id: string; type: string; data?: Record<string, any>; }
export interface FlowEdge { source: string; target: string; branch?: 'true' | 'false'; }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; }
type Ctx = Record<string, any>;
export type TriggerSource = 'inbound_message' | 'webhook';

const ACTIVE_STATUSES = ['running', 'waiting', 'waiting_input'];

/** Chamado a cada mensagem recebida (ou evento de webhook) de um contato. */
export async function triggerFlowsForInbound(
  accountId: string, contactId: string, text: string, connectionId?: string | null,
  source: TriggerSource = 'inbound_message',
): Promise<void> {
  // 1) Se o contato está respondendo a uma "pergunta", retoma essa execução.
  if (source === 'inbound_message') {
    const waiting = await db.select().from(schema.flowRuns).where(and(
      eq(schema.flowRuns.accountId, accountId),
      eq(schema.flowRuns.contactId, contactId),
      eq(schema.flowRuns.status, 'waiting_input'),
    ));
    if (waiting.length) {
      for (const run of waiting) {
        const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, run.flowId)).limit(1);
        if (!flow || flow.status !== 'active') {
          await db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(eq(schema.flowRuns.id, run.id));
          continue;
        }
        const graph = flow.graph as unknown as FlowGraph;
        const ctx: Ctx = { ...(run.context as Ctx), lastMessage: text, ...(connectionId ? { connectionId } : {}) };
        const next = nextNode(graph, run.currentNodeId ?? '');
        await executeFrom(run.id, accountId, contactId, graph, next, ctx)
          .catch((err) => console.error(`[flow ${flow.id}] erro ao retomar:`, (err as Error).message));
      }
      return; // a resposta a uma pergunta não dispara novos fluxos
    }
  }

  // 2) Inicia os fluxos ativos cujo gatilho bate com a origem.
  const activeFlows = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.accountId, accountId), eq(schema.flows.status, 'active')));

  for (const flow of activeFlows) {
    const trig = (flow.trigger ?? {}) as { type?: string };
    if ((trig.type ?? 'inbound_message') !== source) continue;

    const [inProgress] = await db.select({ id: schema.flowRuns.id }).from(schema.flowRuns).where(and(
      eq(schema.flowRuns.flowId, flow.id),
      eq(schema.flowRuns.contactId, contactId),
      inArray(schema.flowRuns.status, ACTIVE_STATUSES),
    )).limit(1);
    if (inProgress) continue; // já tem uma execução em andamento para este contato

    await startFlow(accountId, flow.id, flow.graph as unknown as FlowGraph, contactId,
      { lastMessage: text, ...(connectionId ? { connectionId } : {}) })
      .catch((err) => console.error(`[flow ${flow.id}] erro:`, (err as Error).message));
  }
}

export async function startFlow(
  accountId: string, flowId: string, graph: FlowGraph, contactId: string, ctx: Ctx,
): Promise<void> {
  if (!graph?.nodes?.length) return;
  const [run] = await db.insert(schema.flowRuns)
    .values({ accountId, flowId, contactId, status: 'running', context: ctx }).returning();
  const start = graph.nodes.find((n) => n.type === 'trigger') ?? graph.nodes[0];
  const first = start.type === 'trigger' ? nextNode(graph, start.id) : start;
  await executeFrom(run.id, accountId, contactId, graph, first, ctx);
}

/** Retomada após um bloco de espera (chamado pelo worker da fila). */
export async function resumeFlowRun(runId: string, nodeId: string): Promise<void> {
  const [run] = await db.select().from(schema.flowRuns).where(eq(schema.flowRuns.id, runId)).limit(1);
  if (!run || run.status !== 'waiting') return;
  const [flow] = await db.select().from(schema.flows).where(eq(schema.flows.id, run.flowId)).limit(1);
  if (!flow || flow.status !== 'active') {
    await db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() }).where(eq(schema.flowRuns.id, runId));
    return;
  }
  const graph = flow.graph as unknown as FlowGraph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  await executeFrom(run.id, run.accountId, run.contactId, graph, node, run.context as Ctx);
}

async function executeFrom(
  runId: string, accountId: string, contactId: string, graph: FlowGraph,
  node: FlowNode | undefined, ctx: Ctx,
): Promise<void> {
  await db.update(schema.flowRuns).set({ status: 'running' }).where(eq(schema.flowRuns.id, runId));
  let current = node;
  let guard = 0;

  while (current && guard++ < 200) {
    const n: FlowNode = current;
    const data = n.data ?? {};
    switch (n.type) {
      case 'message':
        await sendMessage(accountId, contactId, String(data.text ?? ''), ctx);
        current = nextNode(graph, n.id);
        break;
      case 'ask':
        await sendMessage(accountId, contactId, String(data.text ?? ''), ctx);
        await db.update(schema.flowRuns)
          .set({ status: 'waiting_input', currentNodeId: n.id, context: ctx })
          .where(eq(schema.flowRuns.id, runId));
        return;
      case 'condition':
        current = nextNode(graph, n.id, evaluate(data, ctx) ? 'true' : 'false');
        break;
      case 'action':
        await applyAction(accountId, contactId, data);
        current = nextNode(graph, n.id);
        break;
      case 'delay': {
        const next = nextNode(graph, n.id);
        if (!next) { current = undefined; break; }
        const seconds = Math.max(1, Number(data.seconds ?? 60));
        await db.update(schema.flowRuns)
          .set({ status: 'waiting', currentNodeId: n.id, context: ctx })
          .where(eq(schema.flowRuns.id, runId));
        await enqueueFlowResume({ runId, nodeId: next.id }, seconds * 1000);
        return;
      }
      default:
        current = nextNode(graph, n.id);
    }
  }

  await db.update(schema.flowRuns)
    .set({ status: 'done', finishedAt: new Date(), context: ctx })
    .where(eq(schema.flowRuns.id, runId));
}

function nextNode(graph: FlowGraph, fromId: string, branch?: 'true' | 'false'): FlowNode | undefined {
  const edge = graph.edges.find((e) => e.source === fromId && (branch ? e.branch === branch : true));
  if (!edge) return undefined;
  return graph.nodes.find((n) => n.id === edge.target);
}

function evaluate(data: Record<string, any>, ctx: Ctx): boolean {
  const value = String(ctx[data.field ?? 'lastMessage'] ?? '').toLowerCase().trim();
  const target = String(data.value ?? '').toLowerCase().trim();
  switch (data.op) {
    case 'contains': return value.includes(target);
    case 'equals': return value === target;
    case 'starts_with': return value.startsWith(target);
    case 'not_empty': return value.length > 0;
    case 'is_number': return /^\d+([.,]\d+)?$/.test(value);
    default: return false;
  }
}

async function applyAction(accountId: string, contactId: string, data: Record<string, any>) {
  if (data.setStage) {
    await db.update(schema.contacts).set({ stage: data.setStage })
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId)));
  }
  if (data.addTag) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1);
    if (c && !c.tags.includes(String(data.addTag))) {
      await db.update(schema.contacts).set({ tags: [...c.tags, String(data.addTag)] })
        .where(eq(schema.contacts.id, contactId));
    }
  }
}

function render(text: string, ctx: Ctx, contact: Record<string, any>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(ctx[k] ?? contact[k] ?? ''));
}

async function sendMessage(accountId: string, contactId: string, text: string, ctx: Ctx) {
  if (!text.trim()) return;
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1);
  if (!contact) return;

  const [conn] = ctx.connectionId
    ? await db.select().from(schema.connections)
        .where(and(eq(schema.connections.id, String(ctx.connectionId)), eq(schema.connections.accountId, accountId))).limit(1)
    : await db.select().from(schema.connections)
        .where(and(eq(schema.connections.accountId, accountId), eq(schema.connections.status, 'connected'))).limit(1);

  const body = render(text, ctx, contact as Record<string, any>);
  let status: 'sent' | 'failed' = 'failed';
  let waMessageId: string | null = null;
  if (conn) {
    try {
      const to = contact.waId ?? contact.phone.replace(/\D/g, '');
      const r = await sendText({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, to, body);
      waMessageId = r.waMessageId; status = 'sent';
    } catch (err) {
      console.error('[flow] envio falhou:', (err as Error).message);
    }
  }

  // registra no inbox para a equipe acompanhar o que o fluxo enviou
  const conv = await ensureConversation(accountId, contactId, conn?.id ?? null);
  const [msg] = await db.insert(schema.messages).values({
    accountId, conversationId: conv.id, direction: 'out', type: 'text', body, status, waMessageId,
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
  emitToAccount(accountId, 'message:new', { conversationId: conv.id, message: msg });
}
