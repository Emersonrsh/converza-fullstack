import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError } from '../utils/http';
import { exchangeCodeForToken, subscribeAppToWaba, registerPhone, getPhoneInfo } from '../whatsapp/graph';

export const connectionsRouter = Router();

/** Config pública do Embedded Signup para o frontend montar o botão da Meta. */
connectionsRouter.get('/embedded-signup/config', (_req, res) => {
  const configured = Boolean(config.whatsapp.appId && config.whatsapp.configId);
  res.json({ configured, appId: config.whatsapp.appId, configId: config.whatsapp.configId, graphVersion: config.whatsapp.graphVersion });
});

// Nunca devolve o accessToken ao cliente.
const publicCols = {
  id: schema.connections.id,
  name: schema.connections.name,
  displayPhone: schema.connections.displayPhone,
  phoneNumberId: schema.connections.phoneNumberId,
  status: schema.connections.status,
  createdAt: schema.connections.createdAt,
};

connectionsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select(publicCols).from(schema.connections)
    .where(eq(schema.connections.accountId, req.accountId!));
  res.json({ connections: rows });
}));

const createSchema = z.object({
  name: z.string().min(1),
  phoneNumberId: z.string().min(1),
  wabaId: z.string().optional(),
  displayPhone: z.string().optional(),
  accessToken: z.string().min(1),
});

connectionsRouter.post('/', asyncHandler(async (req, res) => {
  const data = createSchema.parse(req.body);
  const [row] = await db.insert(schema.connections).values({
    accountId: req.accountId!, ...data, status: 'connected',
  }).returning(publicCols);
  res.status(201).json({ connection: row });
}));

/**
 * Finaliza o Embedded Signup: recebe o `code` (e os ids do WABA/número que o
 * SDK devolve), troca por token, inscreve o app nos webhooks, registra o número
 * e salva a conexão. Tudo do lado do operador — o cliente só autorizou.
 */
const exchangeSchema = z.object({
  code: z.string().min(1),
  phoneNumberId: z.string().min(1),
  wabaId: z.string().min(1),
});

connectionsRouter.post('/embedded-signup/exchange', asyncHandler(async (req, res) => {
  if (!config.whatsapp.appId || !config.whatsapp.appSecret) {
    throw new AppError(400, 'Embedded Signup não configurado no servidor (META_APP_ID/SECRET)');
  }
  const { code, phoneNumberId, wabaId } = exchangeSchema.parse(req.body);

  const token = await exchangeCodeForToken(code);
  // Passos que podem já estar feitos — não quebram a conexão se falharem.
  try { await subscribeAppToWaba(wabaId, token); } catch (e) { console.warn('[ES] subscribe:', (e as Error).message); }
  try { await registerPhone(phoneNumberId, token); } catch (e) { console.warn('[ES] register:', (e as Error).message); }

  let displayPhone: string | null = null;
  let name = 'WhatsApp';
  try {
    const info = await getPhoneInfo(phoneNumberId, token);
    displayPhone = info.display_phone_number ?? null;
    name = info.verified_name || name;
  } catch (e) { console.warn('[ES] phone info:', (e as Error).message); }

  const [existing] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.accountId, req.accountId!), eq(schema.connections.phoneNumberId, phoneNumberId))).limit(1);

  const row = existing
    ? (await db.update(schema.connections)
        .set({ wabaId, accessToken: token, displayPhone, status: 'connected', name })
        .where(eq(schema.connections.id, existing.id)).returning(publicCols))[0]
    : (await db.insert(schema.connections)
        .values({ accountId: req.accountId!, name, phoneNumberId, wabaId, displayPhone, accessToken: token, status: 'connected' })
        .returning(publicCols))[0];

  res.status(201).json({ connection: row });
}));

connectionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const [row] = await db.delete(schema.connections)
    .where(and(eq(schema.connections.id, req.params.id), eq(schema.connections.accountId, req.accountId!)))
    .returning({ id: schema.connections.id });
  if (!row) throw new AppError(404, 'Conexão não encontrada');
  res.status(204).end();
}));
