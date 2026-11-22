/**
 * Chamada interna às rotas da própria API (as mesmas das telas), para as ferramentas MCP reaproveitarem
 * validação, limites e regras sem duplicar código. A chave age como administrador da conta (nunca como dono:
 * cobrança, equipe e exclusão de conta ficam fora).
 */
import { Readable } from 'stream';
import type { Router } from 'express';
import { ZodError } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { AppError } from '../utils/http';
import { ToolError, type ToolCtx } from './tools';

export interface RouteOut<T = any> { status: number; body: T }

/** Usuário em nome de quem a chave age: quem criou a chave; senão, o dono da conta. */
async function actingUser(ctx: ToolCtx): Promise<{ id: string; email: string; verified: boolean }> {
  const [k] = await db.select({ createdBy: schema.apiKeys.createdBy }).from(schema.apiKeys).where(eq(schema.apiKeys.id, ctx.keyId)).limit(1);
  let uid = k?.createdBy ?? null;
  if (!uid) {
    const [m] = await db.select({ userId: schema.memberships.userId }).from(schema.memberships)
      .where(and(eq(schema.memberships.accountId, ctx.accountId), inArray(schema.memberships.role, ['owner', 'admin'])))
      .orderBy(asc(schema.memberships.createdAt)).limit(1);
    uid = m?.userId ?? null;
  }
  if (!uid) throw new ToolError('A conta não tem um administrador para esta chave agir em nome dele.');
  const [u] = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, uid)).limit(1);
  if (!u) throw new ToolError('O usuário que criou esta chave não existe mais. Crie uma chave nova.');
  return { id: u.id, email: u.email, verified: true };
}

function toToolError(err: unknown): Error {
  if (err instanceof ToolError) return err;
  if (err instanceof AppError) return new ToolError(err.message);
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return new ToolError(`Dados inválidos${i?.path?.length ? ` (${i.path.join('.')})` : ''}: ${i?.message ?? 'confira o formato'}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Executa `method path` no roteador como se viesse da tela. Erros de validação e de regra viram ToolError
 * (a mensagem em português vai para o assistente).
 */
export async function callRoute<T = any>(router: Router, ctx: ToolCtx, method: string, path: string,
  opts: { body?: unknown; query?: Record<string, string>; stream?: { data: Buffer; type: string; headers?: Record<string, string> } } = {}): Promise<RouteOut<T>> {
  const user = await actingUser(ctx);
  const host = (() => { try { return new URL(config.publicApiUrl || 'https://converza.pro').host; } catch { return 'converza.pro'; } })();
  const base: object = opts.stream ? Readable.from(opts.stream.data) : {};
  const headers: Record<string, string> = {
    host, 'content-type': opts.stream?.type ?? 'application/json',
    ...(opts.stream ? { 'content-length': String(opts.stream.data.length) } : {}),
    ...(opts.stream?.headers ?? {}), 'x-forwarded-proto': 'https', 'user-agent': 'Converza-MCP',
  };
  const req = Object.assign(base, {
    method: method.toUpperCase(), url: path, originalUrl: path, baseUrl: '', path,
    body: opts.stream ? undefined : (opts.body ?? {}), query: opts.query ?? {}, params: {},
    headers, protocol: 'https', secure: true, hostname: host, ip: '127.0.0.1', ips: [], socket: { remoteAddress: '127.0.0.1' },
    accountId: ctx.accountId, role: 'admin' as const, user, mcp: true,
    get(h: string) { return headers[h.toLowerCase()]; }, header(h: string) { return headers[h.toLowerCase()]; },
  });
  return new Promise<RouteOut<T>>((resolve, reject) => {
    let code = 200;
    let settled = false;
    const done = (body: unknown) => { if (!settled) { settled = true; resolve({ status: code, body: body as T }); } };
    const res: Record<string, any> = {
      statusCode: 200, headersSent: false, locals: {},
      status(c: number) { code = c; this.statusCode = c; return this; },
      setHeader() { return this; }, set() { return this; }, header() { return this; }, getHeader() { return undefined; }, type() { return this; },
      json(b: unknown) { done(b); return this; }, send(b: unknown) { done(b); return this; }, end() { done(null); return this; },
      sendStatus(c: number) { code = c; done(null); return this; }, on() { return this; }, once() { return this; }, emit() { return false; },
    };
    (router as unknown as { handle: (q: unknown, s: unknown, n: (e?: unknown) => void) => void }).handle(req, res, (err?: unknown) => {
      if (settled) return;
      settled = true;
      reject(err ? toToolError(err) : new ToolError(`Operação não encontrada: ${method} ${path}`));
    });
  });
}
