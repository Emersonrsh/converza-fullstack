import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { sendText } from '../whatsapp/cloud-api';

/**
 * Motor de fluxos — versão fundacional.
 * Grafo: { nodes: [{ id, type, data }], edges: [{ source, target, branch? }] }
 * Tipos suportados: trigger | message | condition | action | delay
 * Limitações atuais: 'delay' interrompe a execução (o agendamento entra via fila
 * depois); laços e concorrência ainda não são tratados.
 */
interface FlowNode { id: string; type: string; data?: Record<string, any>; }
interface FlowEdge { source: string; target: string; branch?: 'true' | 'false'; }
interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; }

export async function triggerFlowsForInbound(accountId: string, contactId: string, text: string) {
  const activeFlows = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.accountId, accountId), eq(schema.flows.status, 'active')));

  for (const flow of activeFlows) {
    const trig = (flow.trigger ?? {}) as { type?: string };
    if (trig.type && trig.type !== 'inbound_message') continue;
    await runFlow(accountId, flow.id, flow.graph as unknown as FlowGraph, contactId, { lastMessage: text })
      .catch((err) => console.error(`[flow ${flow.id}] erro:`, (err as Error).message));
  }
}

export async function runFlow(
  accountId: string, flowId: string, graph: FlowGraph, contactId: string, ctx: Record<string, any>,
) {
  if (!graph?.nodes?.length) return;
  const [run] = await db.insert(schema.flowRuns)
    .values({ accountId, flowId, contactId, status: 'running', context: ctx }).returning();

  const start = graph.nodes.find((n) => n.type === 'trigger') ?? graph.nodes[0];
  let current: FlowNode | undefined = nextNode(graph, start.id);
  let guard = 0;

  while (current && guard++ < 100) {
    const node: FlowNode = current;
    if (node.type === 'message') {
      await sendMessage(accountId, contactId, String(node.data?.text ?? ''), ctx);
      current = nextNode(graph, node.id);
    } else if (node.type === 'action') {
      await applyAction(accountId, contactId, node.data ?? {});
      current = nextNode(graph, node.id);
    } else if (node.type === 'condition') {
      const result = evaluate(node.data ?? {}, ctx);
      current = nextNode(graph, node.id, result ? 'true' : 'false');
    } else if (node.type === 'delay') {
      await db.update(schema.flowRuns).set({ status: 'waiting', currentNodeId: node.id })
        .where(eq(schema.flowRuns.id, run.id));
      return; // TODO: reagendar via fila após node.data.seconds
    } else {
      current = nextNode(graph, node.id);
    }
  }

  await db.update(schema.flowRuns).set({ status: 'done', finishedAt: new Date() })
    .where(eq(schema.flowRuns.id, run.id));
}

function nextNode(graph: FlowGraph, fromId: string, branch?: 'true' | 'false'): FlowNode | undefined {
  const edge = graph.edges.find((e) => e.source === fromId && (branch ? e.branch === branch : true));
  if (!edge) return undefined;
  return graph.nodes.find((n) => n.id === edge.target);
}

function evaluate(data: Record<string, any>, ctx: Record<string, any>): boolean {
  const value = String(ctx[data.field ?? 'lastMessage'] ?? '').toLowerCase();
  const target = String(data.value ?? '').toLowerCase();
  switch (data.op) {
    case 'contains': return value.includes(target);
    case 'equals': return value === target;
    case 'not_empty': return value.trim().length > 0;
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
    if (c && !c.tags.includes(data.addTag)) {
      await db.update(schema.contacts).set({ tags: [...c.tags, data.addTag] })
        .where(eq(schema.contacts.id, contactId));
    }
  }
}

async function sendMessage(accountId: string, contactId: string, text: string, ctx: Record<string, any>) {
  if (!text) return;
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1);
  if (!contact) return;
  const [conn] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.accountId, accountId), eq(schema.connections.status, 'connected'))).limit(1);
  if (!conn) return;
  const rendered = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(ctx[k] ?? contact[k as keyof typeof contact] ?? ''));
  const to = contact.waId ?? contact.phone.replace(/\D/g, '');
  await sendText({ phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken }, to, rendered).catch(() => {});
}
