/**
 * Servidor MCP (Model Context Protocol) da Converza, transporte "Streamable HTTP" sem sessão:
 * o cliente faz POST de mensagens JSON-RPC e recebe a resposta em JSON. Não abrimos canal SSE
 * (GET responde 405, como o protocolo permite) porque não mandamos nada por iniciativa própria.
 *
 * Autenticação: chave de API da conta (cvz_...), no cabeçalho Authorization: Bearer <chave>
 * ou no próprio endereço (/mcp/<chave>) para clientes que só aceitam uma URL.
 */
import { Router, type Request, type Response } from 'express';
import { createHash } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { toolByName, mcpToolList, ToolError, type ToolCtx } from './tools';

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];
export const RATE_PER_MINUTE = 120;

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

type Id = string | number | null;
export interface RpcError { code: number; message: string; data?: unknown }
export interface RpcResponse { jsonrpc: '2.0'; id: Id; result?: unknown; error?: RpcError }
export interface RpcCtx extends ToolCtx { tools: string[] }
export interface CallLog { tool: string; ok: boolean; error: string | null; summary: string; durationMs: number }

const INSTRUCTIONS = 'Ferramentas da Converza (CRM e atendimento no WhatsApp). Antes de mandar mensagem, leia a conversa com get_messages: o WhatsApp só aceita texto livre até 24h depois da última mensagem do cliente. Use list_tags e list_flows para ver os nomes e ids válidos.';

const err = (id: Id, code: number, message: string, data?: unknown): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
}

function textOf(result: unknown) {
  return JSON.stringify(result, null, 2);
}

/**
 * Trata uma mensagem JSON-RPC. Devolve null para notificações e respostas do cliente (não respondemos).
 * `log` recebe cada chamada de ferramenta (para o histórico da tela).
 */
export async function handleRpc(msg: unknown, ctx: RpcCtx, log: (c: CallLog) => Promise<void> | void = () => {}): Promise<RpcResponse | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(null, -32600, 'Invalid Request');
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
  const id: Id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
  if (m.jsonrpc !== '2.0') return hasId ? err(id, -32600, 'Invalid Request: jsonrpc precisa ser "2.0"') : null;
  if (typeof m.method !== 'string') {
    // resposta do cliente a um pedido nosso (não fazemos pedidos) ou lixo
    return hasId && !('result' in m) && !('error' in m) ? err(id, -32600, 'Invalid Request') : null;
  }
  if (!hasId) return null; // notificação (ex.: notifications/initialized): só confirmamos com 202
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'converza', title: 'Converza', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: mcpToolList(ctx.tools) });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const tool = toolByName(name);
      if (!tool || !ctx.tools.includes(name)) {
        return err(id, -32602, `Ferramenta desconhecida ou não liberada para esta chave: ${name || '(sem nome)'}`);
      }
      const started = Date.now();
      const parsed = tool.args.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const text = `Argumentos inválidos${issue?.path?.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'confira o formato'}`;
        await log({ tool: name, ok: false, error: text, summary: '', durationMs: Date.now() - started });
        return ok(id, { content: [{ type: 'text', text }], isError: true });
      }
      try {
        const out = await tool.run(ctx, parsed.data);
        await log({ tool: name, ok: true, error: null, summary: out.summary, durationMs: Date.now() - started });
        return ok(id, { content: [{ type: 'text', text: textOf(out.result) }], structuredContent: out.result, isError: false });
      } catch (e) {
        const known = e instanceof ToolError;
        const text = known ? (e as Error).message : 'Erro interno ao executar a ferramenta. Tente de novo em instantes.';
        if (!known) console.error(`[mcp] ${name}:`, (e as Error).message);
        await log({ tool: name, ok: false, error: known ? text : (e as Error).message.slice(0, 300), summary: '', durationMs: Date.now() - started });
        return ok(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return err(id, -32601, `Método não suportado: ${m.method}`);
  }
}

/* ------------------------------------------------------------- HTTP */

export const mcpRouter = Router();

function keyFrom(req: Request): string | null {
  const auth = String(req.headers.authorization ?? '');
  const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  const raw = bearer ?? (req.headers['x-api-key'] as string | undefined) ?? req.params.key ?? null;
  return raw && /^cvz_[A-Za-z0-9_-]{20,80}$/.test(raw) ? raw : null;
}

async function rateLimited(keyId: string): Promise<boolean> {
  try {
    const { redis } = await import('../redis');
    const k = `mcp:rl:${keyId}:${Math.floor(Date.now() / 60_000)}`;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 70);
    return n > RATE_PER_MINUTE;
  } catch {
    return false; // sem Redis, não trava
  }
}

const sendRpcError = (res: Response, status: number, message: string, code = -32001) =>
  res.status(status).json(err(null, code, message));

async function handleHttp(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && version && !SUPPORTED_VERSIONS.includes(version)) {
    return sendRpcError(res, 400, `Versão do protocolo MCP não suportada: ${version}. Suportadas: ${SUPPORTED_VERSIONS.join(', ')}`, -32600);
  }
  const key = keyFrom(req);
  if (!key) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="converza"');
    return sendRpcError(res, 401, 'Falta a chave de API da Converza (Authorization: Bearer cvz_...). Crie em Configurações → Ferramentas MCP.');
  }
  const [row] = await db.select({ k: schema.apiKeys, status: schema.subscriptions.status }).from(schema.apiKeys)
    .leftJoin(schema.subscriptions, eq(schema.subscriptions.accountId, schema.apiKeys.accountId))
    .where(and(eq(schema.apiKeys.hash, hashKey(key)), isNull(schema.apiKeys.revokedAt))).limit(1);
  if (!row) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="converza", error="invalid_token"');
    return sendRpcError(res, 401, 'Chave de API inválida ou revogada.');
  }
  if (row.status !== 'active') {
    return sendRpcError(res, 403, 'A assinatura desta conta não está ativa — as ferramentas MCP voltam quando a assinatura estiver em dia.');
  }
  if (await rateLimited(row.k.id)) {
    res.setHeader('Retry-After', '60');
    return sendRpcError(res, 429, `Muitas chamadas: o limite é ${RATE_PER_MINUTE} por minuto por chave.`);
  }
  if (!row.k.lastUsedAt || Date.now() - row.k.lastUsedAt.getTime() > 60_000) {
    void db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.k.id)).catch(() => {});
  }

  const ctx: RpcCtx = { accountId: row.k.accountId, keyId: row.k.id, tools: row.k.tools };
  const log = async (c: CallLog) => {
    try {
      await db.insert(schema.mcpCalls).values({ accountId: ctx.accountId, apiKeyId: ctx.keyId, tool: c.tool, ok: c.ok, error: c.error, summary: c.summary.slice(0, 200), durationMs: c.durationMs });
    } catch (e) {
      console.error('[mcp] histórico:', (e as Error).message);
    }
  };

  const body = req.body as unknown;
  if (Array.isArray(body)) {
    if (!body.length) return res.status(400).json(err(null, -32600, 'Invalid Request: lote vazio'));
    const out = (await Promise.all(body.slice(0, 20).map((m) => handleRpc(m, ctx, log)))).filter((r): r is RpcResponse => !!r);
    return out.length ? res.json(out) : res.status(202).end();
  }
  const out = await handleRpc(body, ctx, log);
  return out ? res.json(out) : res.status(202).end();
}

const notAllowed = (_req: Request, res: Response) =>
  res.status(405).set('Allow', 'POST').json(err(null, -32000, 'Use POST (este servidor não abre canal SSE).'));

for (const path of ['/', '/:key']) {
  mcpRouter.post(path, (req, res, next) => { handleHttp(req, res).catch(next); });
  mcpRouter.get(path, notAllowed);
  mcpRouter.delete(path, notAllowed);
}
