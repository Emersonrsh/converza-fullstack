/**
 * Registros de acesso exigidos pelo Marco Civil da Internet (Lei 12.965/2014, art. 15): data, hora e IP de cada
 * acesso ao app, guardados por 6 meses em ambiente seguro. Só a data/hora, o IP e o navegador — nada do conteúdo.
 */
import type { Request } from 'express';
import { lt } from 'drizzle-orm';
import { db, schema } from '../db';

/** IP de verdade do visitante (o Render fica na frente, como proxy). */
export function clientIp(req: Request): string | null {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = fwd || req.socket?.remoteAddress || '';
  return ip ? ip.replace(/^::ffff:/, '').slice(0, 64) : null;
}

export async function recordAccess(req: Request, user: { id: string; email: string }, event: 'login' | 'register' | 'session') {
  const ip = clientIp(req);
  if (event === 'session') {
    // uso normal com o login guardado: no máximo um registro a cada 6 h por pessoa e IP
    // (Redis carregado só aqui: importar este arquivo não abre conexão — os testes de unidade não ficam presos)
    const { redis } = await import('../redis');
    const fresh = await redis.set(`access:${user.id}:${ip ?? '-'}`, '1', 'EX', 6 * 3600, 'NX').catch(() => 'OK');
    if (fresh !== 'OK') return;
  }
  await db.insert(schema.accessLogs).values({
    userId: user.id, email: user.email.toLowerCase(), event, ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
  });
}

/** Não trava a requisição: falha no registro só vai para o log do servidor. */
export function recordAccessLater(req: Request, user: { id: string; email: string }, event: 'login' | 'register' | 'session') {
  void recordAccess(req, user, event).catch((err) => console.error('[acessos] registro:', (err as Error).message));
}

/** Apaga o que passou dos 6 meses (com 10 dias de folga). */
export async function purgeAccessLogs() {
  const cut = new Date(Date.now() - 190 * 86_400_000);
  const r = await db.delete(schema.accessLogs).where(lt(schema.accessLogs.createdAt, cut)).returning({ id: schema.accessLogs.id });
  return r.length;
}
