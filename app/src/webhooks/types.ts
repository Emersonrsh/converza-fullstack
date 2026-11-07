export interface WebhookMapping {
  phone?: string; name?: string; email?: string;
  amount?: string; amountInCents?: boolean; status?: string; product?: string; transaction?: string; currency?: string; state?: string;
  event?: string;
  fields?: { key: string; path: string }[];
  vars?: { name: string; path: string }[];
}

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'exists' | 'empty';
export interface WebhookCondition { path: string; op: ConditionOp; value?: string }

export interface TemplateVarValue { var: string; name?: string; value: string }
export interface TemplateAction {
  name: string; language: string; preview?: string;
  header?: ({ type: 'text' } & TemplateVarValue) | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  body?: TemplateVarValue[];
  buttons?: { index: number; subType: 'url' | 'copy_code'; value: string }[];
}

export interface WebhookActions {
  overwrite?: boolean;
  tags?: string[];
  removeTags?: string[];
  kanban?: { boardId: string; columnId: string } | null;
  sale?: boolean;
  template?: TemplateAction | null;
  flowId?: string | null;
}

export interface WebhookSummary {
  id: string; name: string; enabled: boolean; connectionId: string | null; connectionName: string | null;
  hits: number; lastEventAt: string | null; lastStatus: string | null; createdAt: string; updatedAt: string;
  platform: string | null; url?: string;
  setup: { hasPhone: boolean; conditions: number; actions: string[] };
}

export interface WebhookFull extends WebhookSummary {
  mapping: WebhookMapping; conditions: WebhookCondition[]; actions: WebhookActions;
  sample: Record<string, unknown> | null; sampleAt: string | null;
}

export interface Usage { used: number; limit: number; month: string; active: boolean; instances: number }
export interface Leaf { path: string; value: string; kind: 'string' | 'number' | 'boolean' | 'null' }

export interface WebhookDetail {
  webhook: WebhookFull; leaves: Leaf[]; detected: WebhookMapping; fields: { key: string; label: string }[]; usage: Usage;
}

export interface ActionResult { kind: string; ok: boolean; warn?: boolean; text: string }
export type EventStatus = 'queued' | 'processed' | 'partial' | 'skipped' | 'error' | 'blocked' | 'paused';
export interface WebhookEvent {
  id: string; webhookId: string; status: EventStatus; summary: string | null; results: ActionResult[];
  contactId: string | null; contactName: string | null; createdAt: string; processedAt: string | null;
  payload?: Record<string, unknown>;
}

export interface DryRun {
  matched: boolean;
  steps: ActionResult[];
  resolved: { phone: string | null; name: string | null; email: string | null; amount: number; status: string; product: string | null; transaction: string | null; event: string | null; detected: string[] };
}

export const EVENT_STATUS: Record<EventStatus, [string, string]> = {
  queued: ['Na fila', ''], processed: ['Processado', 'green'], partial: ['Com falhas', 'amber'], skipped: ['Ignorado', ''],
  error: ['Erro', 'red'], blocked: ['Sem cota', 'red'], paused: ['Pausado', ''],
};

export const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'é igual a', neq: 'é diferente de', contains: 'contém', not_contains: 'não contém', exists: 'está preenchido', empty: 'está vazio',
};

/** Nomes prontos que valem no modelo, nas condições e no fluxo. */
export const SPECIALS: [string, string][] = [
  ['nome', 'Nome do lead'], ['primeiro_nome', 'Primeiro nome'], ['telefone', 'Telefone'], ['email', 'E-mail'],
  ['valor', 'Valor (97,00)'], ['produto', 'Produto'], ['status_venda', 'Status da venda (aprovada, pendente…)'],
  ['evento', 'Evento'], ['transacao', 'ID da transação'],
];
