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
import { agentsRouter } from './modules/agents';
import { webhooksRouter, hooksInRouter } from './modules/webhooks';
import { teamRouter } from './modules/team';
import { settingsRouter } from './modules/settings';
import { billingRouter } from './modules/billing';
import { metaRouter } from './modules/meta';
import { whatsappWebhookRouter } from './whatsapp/webhook';
import { initIO } from './realtime/io';
import { startDispatchWorker } from './queue/worker';

const app = express();
app.use(cors({ origin: config.appOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'converza', time: new Date().toISOString() }));

// Webhook público da Meta (sem auth — autenticado pelo verify token / assinatura)
app.use('/api/v1/webhooks/whatsapp', whatsappWebhookRouter);
// Receptor público de integrações externas (identificado por token)
app.use('/api/v1/hooks', hooksInRouter);

// Autenticação
app.use('/api/v1/auth', authRouter);

// Rotas protegidas e isoladas por conta (tenant)
const guard = [authRequired, requireAccount()];
app.use('/api/v1/contacts', ...guard, contactsRouter);
app.use('/api/v1/conversations', ...guard, conversationsRouter);
app.use('/api/v1/connections', ...guard, connectionsRouter);
app.use('/api/v1/dashboard', ...guard, dashboardRouter);
app.use('/api/v1/dispatch', ...guard, dispatchRouter);
app.use('/api/v1/flows', ...guard, flowsRouter);
app.use('/api/v1/agents', ...guard, agentsRouter);
app.use('/api/v1/webhooks', ...guard, webhooksRouter);
app.use('/api/v1/team', ...guard, teamRouter);
app.use('/api/v1/settings', ...guard, settingsRouter);
app.use('/api/v1/billing', ...guard, billingRouter);
app.use('/api/v1/meta', ...guard, metaRouter);

app.use(errorHandler);

const server = http.createServer(app);
initIO(server);

// Em dev, roda o worker no mesmo processo. Em produção, escale com `npm run worker`.
if (process.env.START_WORKER !== 'false') {
  startDispatchWorker();
}

server.listen(config.port, () => {
  console.log(`Converza API em http://localhost:${config.port}  (env: ${config.env})`);
});
