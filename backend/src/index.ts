import http from 'http';
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { errorHandler } from './utils/http';
import { authRequired, requireAccount } from './auth/middleware';
import { authRouter } from './auth/routes';
import { contactsRouter } from './modules/contacts';
import { connectionsRouter } from './modules/connections';
import { conversationsRouter } from './modules/conversations';
import { dashboardRouter } from './modules/dashboard';
import { dispatchRouter } from './modules/dispatch';
import { flowsRouter } from './modules/flows';
import { flowFoldersRouter } from './modules/flowFolders';
import { salesRouter } from './modules/sales';
import { adSpendRouter } from './modules/adSpend';
import { partnersRouter } from './modules/partners';
import { mediaRouter } from './modules/media';
import { quickRepliesRouter } from './modules/quickReplies';
import { kanbanRouter } from './modules/kanban';
import { cleanupOrphanRuns, sweepFlowFiles } from './flows/runner';
import { agentsRouter } from './modules/agents';
import { startConnectionHealthSweep } from './modules/connections';
import { webhooksRouter, hooksInRouter } from './modules/webhooks';
import { teamRouter } from './modules/team';
import { settingsRouter } from './modules/settings';
import { billingRouter } from './modules/billing';
import { billingHooksRouter, startBillingJobs } from './billing/hooks';
import { accountsRouter } from './modules/accounts';
import { invitesRouter } from './modules/invites';
import { departmentsRouter } from './modules/departments';
import { businessHoursRouter } from './modules/businessHours';
import { defaultFlowsRouter } from './modules/defaultFlows';
import { supportAccessRouter } from './modules/supportAccess';
import { platformInvitesRouter } from './modules/platformInvites';
import { templatesRouter } from './modules/templates';
import { globalsRouter } from './modules/globals';
import { translationsRouter, startTranslationSweep } from './modules/translations';
import { aiUsageRouter } from './modules/aiUsage';
import { trackingRouter, trackingPublicRouter } from './modules/tracking';
import { apiKeysRouter } from './modules/apiKeys';
import { mcpRouter } from './mcp/server';
import { integrationsRouter } from './modules/integrations';
import { metaRouter } from './modules/meta';
import { pixelsRouter } from './modules/pixels';
import { startMetaAdsSync } from './meta/adsSync';
import { whatsappWebhookRouter } from './whatsapp/webhook';
import { initIO } from './realtime/io';
import { startAgentWorker, startDispatchWorker, startFlowWorker, startPixelWorker, startWebhookWorker } from './queue/worker';

const app = express();
app.use(cors({ origin: config.appOrigin, credentials: true, exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({
  limit: '2mb',
  // guarda o corpo original para conferir a assinatura dos webhooks da Meta
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; },
}));

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'converza', time: new Date().toISOString() }));

// Webhook público da Meta (sem auth — autenticado pelo verify token / assinatura)
app.use('/api/v1/webhooks/whatsapp', whatsappWebhookRouter);
// Receptor público de integrações externas (identificado por token)
app.use('/api/v1/hooks', hooksInRouter);
// mídia das conversas (link assinado, sem login)
app.use('/api/v1/media', mediaRouter);
// servidor MCP (público, autenticado pela chave de API da conta)
app.use('/mcp', mcpRouter);
// link rastreável (público): conta o clique e abre o WhatsApp com a mensagem pronta
app.use('/t', trackingPublicRouter);
// avisos de pagamento da Asaas e da Paddle (sem login — token / assinatura de cada gateway)
app.use('/api/v1/billing-hooks', billingHooksRouter);

// Autenticação
app.use('/api/v1/auth', authRouter);
// convites (o link abre sem login; aceitar exige login com o e-mail convidado)
app.use('/api/v1/invites', invitesRouter);
// criar outra empresa e ver convites recebidos (só precisa estar logado)
app.use('/api/v1/accounts', authRequired, accountsRouter);

// Rotas protegidas e isoladas por conta (tenant)
const guard = [authRequired, requireAccount()];
app.use('/api/v1/contacts', ...guard, contactsRouter);
app.use('/api/v1/conversations', ...guard, conversationsRouter);
app.use('/api/v1/connections', ...guard, connectionsRouter);
app.use('/api/v1/dashboard', ...guard, dashboardRouter);
app.use('/api/v1/sales', ...guard, salesRouter);
app.use('/api/v1/ad-spend', ...guard, adSpendRouter);
app.use('/api/v1/partners', ...guard, partnersRouter);
app.use('/api/v1/quick-replies', ...guard, quickRepliesRouter);
app.use('/api/v1/kanban', ...guard, kanbanRouter);
app.use('/api/v1/dispatch', ...guard, dispatchRouter);
app.use('/api/v1/flows', ...guard, flowsRouter);
app.use('/api/v1/flow-folders', ...guard, flowFoldersRouter);
app.use('/api/v1/agents', ...guard, agentsRouter);
app.use('/api/v1/webhooks', ...guard, webhooksRouter);
app.use('/api/v1/team', ...guard, teamRouter);
app.use('/api/v1/settings', ...guard, settingsRouter);
app.use('/api/v1/billing', ...guard, billingRouter);
app.use('/api/v1/meta', ...guard, metaRouter);
app.use('/api/v1/pixels', ...guard, pixelsRouter);
app.use('/api/v1/departments', ...guard, departmentsRouter);
app.use('/api/v1/business-hours', ...guard, businessHoursRouter);
app.use('/api/v1/default-flows', ...guard, defaultFlowsRouter);
app.use('/api/v1/support-access', ...guard, supportAccessRouter);
app.use('/api/v1/platform-invites', ...guard, platformInvitesRouter);
app.use('/api/v1/templates', ...guard, templatesRouter);
app.use('/api/v1/globals', ...guard, globalsRouter);
app.use('/api/v1/flow-translations', ...guard, translationsRouter);
app.use('/api/v1/ai-usage', ...guard, aiUsageRouter);
app.use('/api/v1/tracking', ...guard, trackingRouter);
app.use('/api/v1/mcp', ...guard, apiKeysRouter);
app.use('/api/v1/integrations', ...guard, integrationsRouter);

app.use(errorHandler);

const server = http.createServer(app);
initIO(server);

// Em dev, roda o worker no mesmo processo. Em produção, escale com `npm run worker`.
if (process.env.START_WORKER !== 'false') {
  startDispatchWorker();
  startFlowWorker();
  startAgentWorker();
  startWebhookWorker();
  startPixelWorker();
  startConnectionHealthSweep();
  startMetaAdsSync();
  startBillingJobs();
  startTranslationSweep();
  // anexos de blocos apagados dos fluxos: limpeza de hora em hora
  const sweepFiles = () => sweepFlowFiles().catch((err) => console.error('[fluxos] limpeza de anexos:', (err as Error).message));
  setTimeout(sweepFiles, 60_000).unref();
  setInterval(sweepFiles, 3600_000).unref();
}

// execuções que ficaram presas em "running" por reinício do servidor viram "erro"
cleanupOrphanRuns().catch((err) => console.error('[flows] limpeza de execuções:', (err as Error).message));

server.listen(config.port, () => {
  console.log(`Converza API em http://localhost:${config.port}  (env: ${config.env})`);
});

// rede de segurança: uma promessa rejeitada sem tratamento não pode derrubar a API de todas as contas
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.stack ?? err.message : err);
});
