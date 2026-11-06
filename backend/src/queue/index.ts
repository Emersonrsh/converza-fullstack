import { Queue } from 'bullmq';
import { newRedis } from '../redis';

export interface DispatchJobData { campaignId: string; accountId: string; }
export interface FlowResumeJobData { runId: string; nodeId: string; }

export const dispatchQueue = new Queue<DispatchJobData>('dispatch', { connection: newRedis() });
export const flowQueue = new Queue<FlowResumeJobData>('flows', { connection: newRedis() });

/** Enfileira o envio de uma campanha, opcionalmente agendada para o futuro. */
export async function enqueueCampaign(data: DispatchJobData, runAt?: Date | null) {
  const delay = runAt ? Math.max(0, runAt.getTime() - Date.now()) : 0;
  await dispatchQueue.add('send-campaign', data, {
    delay,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

/** Agenda a retomada de uma execução de fluxo após um bloco de espera. */
export async function enqueueFlowResume(data: FlowResumeJobData, delayMs: number) {
  await flowQueue.add('resume', data, {
    delay: Math.max(0, delayMs),
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  });
}
