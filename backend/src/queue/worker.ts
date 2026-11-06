import { Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { newRedis } from '../redis';
import { db, schema } from '../db';
import { sendText } from '../whatsapp/cloud-api';
import { resolveAudienceContacts, type Audience } from '../modules/audience';
import { ensureConversation } from '../modules/conversationStore';
import { emitToAccount } from '../realtime/io';
import { handleFlowJob } from '../flows/runner';
import type { DispatchJobData, FlowJobData } from './index';

const THROTTLE_MS = 1200; // intervalo anti-bloqueio entre envios
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Inicia o worker de disparo em massa. Pode rodar junto da API ou em processo próprio. */
export function startDispatchWorker() {
  const worker = new Worker<DispatchJobData>('dispatch', async (job) => {
    const { campaignId, accountId } = job.data;
    const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1);
    if (!campaign) return;

    const [conn] = campaign.connectionId
      ? await db.select().from(schema.connections).where(eq(schema.connections.id, campaign.connectionId)).limit(1)
      : [undefined];

    const contacts = await resolveAudienceContacts(accountId, (campaign.audience ?? {}) as Audience);
    await db.update(schema.campaigns).set({ status: 'sending', totalCount: contacts.length })
      .where(eq(schema.campaigns.id, campaignId));

    let sent = 0;
    for (const contact of contacts) {
      const text = campaign.message.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
        String((contact as Record<string, unknown>)[k] ?? ''));
      try {
        const to = contact.waId ?? contact.phone.replace(/\D/g, '');
        await sendText({ phoneNumberId: conn?.phoneNumberId ?? null, accessToken: conn?.accessToken ?? null }, to, text);
        const conv = await ensureConversation(accountId, contact.id, campaign.connectionId ?? null);
        await db.insert(schema.messages).values({
          accountId, conversationId: conv.id, direction: 'out', type: 'text', body: text, status: 'sent',
        });
      } catch (err) {
        console.error(`[dispatch] falha p/ ${contact.phone}:`, (err as Error).message);
      }
      sent += 1;
      await db.update(schema.campaigns).set({ sentCount: sent }).where(eq(schema.campaigns.id, campaignId));
      emitToAccount(accountId, 'campaign:progress', { campaignId, sent, total: contacts.length });
      await sleep(THROTTLE_MS);
    }

    await db.update(schema.campaigns).set({ status: 'done' }).where(eq(schema.campaigns.id, campaignId));
    emitToAccount(accountId, 'campaign:done', { campaignId, sent });
  }, { connection: newRedis(), concurrency: 1 });

  worker.on('failed', (job, err) => console.error(`[dispatch] job ${job?.id} falhou:`, err.message));
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

if (require.main === module) {
  startDispatchWorker();
  startFlowWorker();
}
