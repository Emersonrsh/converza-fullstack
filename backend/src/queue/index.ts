import { Queue } from 'bullmq';
import { newRedis } from '../redis';

/** Uma parte do disparo em massa; auto = retomada depois do limite diário da Meta. */
export interface DispatchJobData { campaignId: string; auto?: boolean; }
/** kind: 'delay' = fim de um bloco Espera; 'payment_timeout' = tempo do Pagamento esgotado. */
export interface FlowJobData { runId: string; nodeId: string; kind?: 'delay' | 'payment_timeout'; }

/** Resposta do agente de IA, agendada para depois da espera (junta mensagens seguidas do cliente). */
export interface AgentJobData { accountId: string; conversationId: string; messageId: string; }

export const dispatchQueue = new Queue<DispatchJobData>('dispatch', { connection: newRedis() });
export const flowQueue = new Queue<FlowJobData>('flows', { connection: newRedis() });
export const agentQueue = new Queue<AgentJobData>('agents', { connection: newRedis() });

/** Evento recebido por um webhook de entrada (processado fora da requisição, com nova tentativa). */
export interface WebhookJobData { eventId: string; }
export const webhookQueue = new Queue<WebhookJobData>('webhooks', { connection: newRedis() });

export async function enqueueWebhookEvent(eventId: string) {
  await webhookQueue.add('process', { eventId }, {
    jobId: `wh-${eventId}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

/** Evento de conversão para um pixel (Meta/TikTok), com novas tentativas se a plataforma falhar. */
export interface PixelJobData { eventId: string; }
export const pixelQueue = new Queue<PixelJobData>('pixels', { connection: newRedis() });

export async function enqueuePixelEvent(eventId: string, delayMs = 0) {
  await pixelQueue.add('send', { eventId }, {
    jobId: `px-${eventId}-${Date.now()}`,
    delay: Math.max(0, delayMs),
    attempts: 4,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

/** Agenda a próxima parte de um disparo em massa (o disparo é enviado em partes de ~45 s). */
export async function enqueueCampaignChunk(campaignId: string, delayMs = 0, opts: { auto?: boolean } = {}) {
  await dispatchQueue.add('chunk', { campaignId, ...(opts.auto ? { auto: true } : {}) }, {
    jobId: `camp-${campaignId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    delay: Math.max(0, delayMs),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  });
}

/** Agenda a retomada de uma execução de fluxo. */
export async function enqueueFlowJob(data: FlowJobData, delayMs: number) {
  await flowQueue.add(data.kind ?? 'resume', data, {
    delay: Math.max(0, delayMs),
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}

/** Agenda a resposta do agente (um job por mensagem; ao rodar, só responde se ela ainda for a última). */
export async function enqueueAgentJob(data: AgentJobData, delayMs: number) {
  await agentQueue.add('reply', data, {
    jobId: `agent-${data.messageId}`,
    delay: Math.max(0, delayMs),
    attempts: 1,
    removeOnComplete: 500,
    removeOnFail: 500,
  });
}
