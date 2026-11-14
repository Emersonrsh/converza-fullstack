import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { promptActions, resolveAutomations, type AgentAutomation, type AgentPersona, type AgentStage } from './agentBrain';
import { basesText } from '../modules/knowledge';

type AgentLike = Partial<typeof schema.agents.$inferSelect>;

/** Instruções do agente (persona) já com bases, etapas e as ações das automações; usado na resposta real e no teste. */
export async function loadPersona(accountId: string, a: AgentLike): Promise<{
  persona: AgentPersona; automations: AgentAutomation[]; flows: Record<string, { name: string; active: boolean }>;
}> {
  const automations = resolveAutomations({
    automations: a.automations as AgentAutomation[] | undefined, flowId: a.flowId, flowWhen: a.flowWhen, flowTag: a.flowTag,
    handoffMessage: a.handoffMessage, handoffTag: a.handoffTag, handoffDepartmentId: a.handoffDepartmentId,
  });
  const flowIds = [...new Set(automations.map((x) => (x.action === 'flow' ? x.flowId : null)).filter((x): x is string => !!x))];
  const rows = flowIds.length
    ? await db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status }).from(schema.flows)
      .where(and(eq(schema.flows.accountId, accountId), inArray(schema.flows.id, flowIds), isNull(schema.flows.archivedAt)))
    : [];
  const flows = Object.fromEntries(rows.map((f) => [f.id, { name: f.name, active: f.status === 'active' }]));
  const active = Object.fromEntries(rows.filter((f) => f.status === 'active').map((f) => [f.id, f.name]));
  const bases = await basesText(accountId, a.knowledgeBaseIds);
  const persona: AgentPersona = {
    name: a.name || 'Agente', role: a.role ?? 'custom', tone: a.tone ?? '', systemPrompt: a.systemPrompt ?? '', knowledge: a.knowledge ?? '',
    faq: a.faq ?? [], rules: a.rules ?? '', flowName: null, flowWhen: a.flowWhen ?? '', handoffWhen: a.handoffWhen ?? '',
    language: a.language, identity: a.identity, pace: a.pace, formality: a.formality, emoji: a.emoji,
    stages: (a.stages ?? []) as AgentStage[], actions: promptActions(automations, active, a.handoffWhen ?? ''), bases,
  };
  return { persona, automations, flows };
}

/** "*Bia:*" antes da mensagem, quando o agente assina as conversas. */
export const signed = (name: string, text: string, on: boolean | null | undefined) => (on && name.trim() ? `*${name.trim()}:*\n${text}` : text);
