import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler } from '../utils/http';

export const metaRouter = Router();

/**
 * Integração Meta Ads. O OAuth real da Meta exige um app aprovado e as
 * credenciais do cliente; esta rota devolve a URL de autorização a montar no
 * front. As métricas abaixo derivam das vendas atribuídas no banco.
 */
metaRouter.get('/status', asyncHandler(async (req, res) => {
  const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, req.accountId!)).limit(1);
  res.json({ connected: false, account: acc?.name ?? null });
}));

metaRouter.get('/campaigns', asyncHandler(async (_req, res) => {
  // Sem conexão Meta ativa ainda; devolve estrutura vazia pronta para preencher.
  res.json({ campaigns: [] as Array<unknown> });
}));

metaRouter.post('/connect', asyncHandler(async (_req, res) => {
  res.json({
    oauthUrl: 'https://www.facebook.com/dialog/oauth?client_id=SEU_APP_ID&scope=ads_read,ads_management',
    note: 'Configure META_APP_ID/META_APP_SECRET e o redirect para habilitar o OAuth real.',
  });
}));
