import { Worker } from 'bullmq';
import { newRedis } from '../redis';
import { resumeStaleCampaigns, runCampaignChunk } from '../modules/dispatchRunner';
import { handleFlowJob } from '../flows/runner';
import { runAgentJob } from '../ai/agent';
import { processWebhookEvent, markWebhookEventFailed } from '../modules/webhookProcessor';
import { sendPixelEvent } from '../pixels/sender';
import type { AgentJobData, DispatchJobData, FlowJobData, PixelJobData, WebhookJobData } from './index';


/** Worker dos disparos em massa (cada job é uma parte de ~45 s do envio). */
export function startDispatchWorker() {
  const worker = new Worker<DispatchJobData>('dispatch', async (job) => {
    if (!job.data?.campaignId) return; // job antigo (formato anterior)
    await runCampaignChunk(job.data.campaignId, { auto: job.data.auto });
  }, { connection: newRedis(), concurrency: 4 });
  worker.on('failed', (job, err) => console.error(`[dispatch] job ${job?.id} falhou:`, err.message));
  // disparos que pararam no meio (reinício do servidor) continuam sozinhos
  const sweep = () => resumeStaleCampaigns().catch((err) => console.error('[dispatch] retomada:', (err as Error).message));
  setTimeout(sweep, 5_000).unref();
  setInterval(sweep, 3 * 60_000).unref();
  console.log('Worker de disparo iniciado.');
  return worker;
}

/** Worker que retoma execuções de fluxo (fim de espera, tempo do pagamento). */
export function startFlowWorker() {
  const worker = new Worker<FlowJobData>('flows', async (job) => {
    await handleFlowJob(job.data);
  }, { connection: newRedis(), concurrency: 5 });
  worker.on('failed', (job, err) => console.error(`[flows] job ${job?.id} falhou:`, err.message));
  console.log('Worker de fluxos iniciado.');
  return worker;
}

/** Worker das respostas dos agentes de IA (depois da espera configurada no agente). */
export function startAgentWorker() {
  const worker = new Worker<AgentJobData>('agents', async (job) => {
    await runAgentJob(job.data);
  }, { connection: newRedis(), concurrency: 5 });
  worker.on('failed', (job, err) => console.error(`[agents] job ${job?.id} falhou:`, err.message));
  console.log('Worker de agentes iniciado.');
  return worker;
}

/** Worker dos eventos recebidos pelos webhooks de entrada. */
export function startWebhookWorker() {
  const worker = new Worker<WebhookJobData>('webhooks', async (job) => {
    await processWebhookEvent(job.data.eventId);
  }, { connection: newRedis(), concurrency: 5 });
  worker.on('failed', (job, err) => {
    console.error(`[webhooks] job ${job?.id} falhou:`, err.message);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markWebhookEventFailed(job.data.eventId, err.message);
  });
  console.log('Worker de webhooks iniciado.');
  return worker;
}

/** Worker dos eventos de conversão (pixels da Meta e do TikTok). */
export function startPixelWorker() {
  const worker = new Worker<PixelJobData>('pixels', async (job) => {
    await sendPixelEvent(job.data.eventId, job.attemptsMade + 1, job.opts.attempts ?? 1);
  }, { connection: newRedis(), concurrency: 5 });
  worker.on('failed', (job, err) => console.error(`[pixels] job ${job?.id} falhou:`, err.message));
  console.log('Worker de pixels iniciado.');
  return worker;
}

if (require.main === module) {
  startDispatchWorker();
  startFlowWorker();
  startAgentWorker();
  startWebhookWorker();
  startPixelWorker();
}
