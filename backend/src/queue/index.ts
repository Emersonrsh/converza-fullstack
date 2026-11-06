import { Queue } from 'bullmq';
import { newRedis } from '../redis';

export interface DispatchJobData { campaignId: string; accountId: string; }

export const dispatchQueue = new Queue<DispatchJobData>('dispatch', { connection: newRedis() });

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
