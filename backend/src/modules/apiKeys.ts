/** Ferramentas MCP: chaves de API da conta (guardamos só o hash) e o histórico das chamadas. */
import { Router, type Request } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { config } from '../config';
import { notSupport } from '../auth/middleware';
import { TOOL_NAMES, toolCatalog, GROUP_LABEL } from '../mcp/tools';
import { hashKey, RATE_PER_MINUTE, SUPPORTED_VERSIONS } from '../mcp/server';

export const apiKeysRouter = Router();

const MAX_KEYS = 20;

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mexem nas chaves de API.');
}

/** cvz_ + 32 letras/números aleatórios (192 bits). */
export function newApiKey(): string {
  return `cvz_${randomBytes(24).toString('base64url')}`;
}

const toolsSchema = z.array(z.string()).max(TOOL_NAMES.length)
  .refine((list) => list.every((t) => TOOL_NAMES.includes(t)), 'Ferramenta desconhecida')
  .transform((list) => [...new Set(list)]);

const keyView = (k: typeof schema.apiKeys.$inferSelect & { createdByName?: string | null; calls24h?: number }) => ({
  id: k.id, name: k.name, prefix: k.prefix, tools: k.tools, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt,
  createdAt: k.createdAt, createdByName: k.createdByName ?? null, calls24h: Number(k.calls24h ?? 0),
});

apiKeysRouter.get('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const since = new Date(Date.now() - 86_400_000);
  const keys = await db.select({
    k: schema.apiKeys, createdByName: schema.users.name,
    calls24h: sql<number>`(select count(*)::int from mcp_calls c where c.api_key_id = ${schema.apiKeys.id} and c.created_at >= ${since})`,
  }).from(schema.apiKeys)
    .leftJoin(schema.users, eq(schema.users.id, schema.apiKeys.createdBy))
    .where(eq(schema.apiKeys.accountId, accountId))
    .orderBy(sql`${schema.apiKeys.revokedAt} is not null`, desc(schema.apiKeys.createdAt));
  const calls = await db.select({ c: schema.mcpCalls, keyName: schema.apiKeys.name }).from(schema.mcpCalls)
    .leftJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.mcpCalls.apiKeyId))
    .where(eq(schema.mcpCalls.accountId, accountId)).orderBy(desc(schema.mcpCalls.createdAt)).limit(60);
  const base = publicBase(req, config.publicApiUrl);
  res.json({
    keys: keys.map((r) => keyView({ ...r.k, createdByName: r.createdByName, calls24h: r.calls24h })),
    tools: toolCatalog(),
    groups: GROUP_LABEL,
    endpoint: `${base}/mcp`,
    rateLimit: RATE_PER_MINUTE,
    protocolVersions: SUPPORTED_VERSIONS,
    calls: calls.map((r) => ({ id: r.c.id, tool: r.c.tool, ok: r.c.ok, error: r.c.error, summary: r.c.summary, durationMs: r.c.durationMs, createdAt: r.c.createdAt, keyName: r.keyName ?? 'chave apagada' })),
    canCreate: !req.support,
  });
}));

apiKeysRouter.post('/keys', asyncHandler(async (req, res) => {
  managerOnly(req);
  notSupport(req, 'Criar chave de API');
  const accountId = req.accountId!;
  const p = z.object({ name: z.string().trim().min(1, 'Dê um nome para a chave').max(60), tools: toolsSchema }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  if (!p.data.tools.length) throw new AppError(422, 'Marque pelo menos uma ferramenta.');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.accountId, accountId), isNull(schema.apiKeys.revokedAt)));
  if (Number(n) >= MAX_KEYS) throw new AppError(422, `Limite de ${MAX_KEYS} chaves ativas. Revogue as que não usa mais.`);
  const secret = newApiKey();
  const [k] = await db.insert(schema.apiKeys).values({
    accountId, name: p.data.name, prefix: `${secret.slice(0, 10)}…`, hash: hashKey(secret), tools: p.data.tools, createdBy: req.user?.id ?? null,
  }).returning();
  const base = publicBase(req, config.publicApiUrl);
  // a chave completa aparece só agora (guardamos só o hash)
  res.status(201).json({ key: keyView(k), secret, urlWithKey: `${base}/mcp/${secret}` });
}));

apiKeysRouter.patch('/keys/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Chave não encontrada');
  const p = z.object({ name: z.string().trim().min(1).max(60).optional(), tools: toolsSchema.optional() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  if (p.data.tools && !p.data.tools.length) throw new AppError(422, 'Marque pelo menos uma ferramenta (ou revogue a chave).');
  const [k] = await db.update(schema.apiKeys).set({ ...(p.data.name ? { name: p.data.name } : {}), ...(p.data.tools ? { tools: p.data.tools } : {}) })
    .where(and(eq(schema.apiKeys.id, req.params.id), eq(schema.apiKeys.accountId, req.accountId!), isNull(schema.apiKeys.revokedAt))).returning();
  if (!k) throw new AppError(404, 'Chave não encontrada (ou já revogada)');
  res.json({ key: keyView(k) });
}));

/** Revogar: a chave para de funcionar na hora (o histórico das chamadas continua). */
apiKeysRouter.delete('/keys/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Chave não encontrada');
  await db.update(schema.apiKeys).set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, req.params.id), eq(schema.apiKeys.accountId, req.accountId!), isNull(schema.apiKeys.revokedAt)));
  res.status(204).end();
}));
