import type { Request } from 'express';
import { redis } from '../redis';
import { AppError } from '../utils/http';
import { config } from '../config';

/**
 * Limite de tentativas (login e cadastro), contado no Redis.
 * Se o Redis estiver fora, não bloqueia ninguém: melhor deixar entrar do que travar todo mundo.
 */
export interface Limit { key: string; max: number; windowSec: number }

/** IP de quem pede, como o Render repassa (o primeiro do X-Forwarded-For). */
export function clientIp(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '?').slice(0, 64);
}

const minutes = (sec: number) => Math.max(1, Math.ceil(sec / 60));

/** Recusa com 429 se algum dos limites já estourou. */
export async function assertUnderLimits(limits: Limit[], what: string) {
  if (!config.authThrottle) return;
  let counts: (string | null)[];
  try { counts = await redis.mget(...limits.map((l) => `rl:${l.key}`)); } catch { return; }
  for (let i = 0; i < limits.length; i++) {
    if (Number(counts[i] ?? 0) < limits[i].max) continue;
    let ttl = limits[i].windowSec;
    try { ttl = Math.max(1, await redis.ttl(`rl:${limits[i].key}`)); } catch { /* usa a janela inteira */ }
    throw new AppError(429, `Muitas tentativas de ${what}. Espere ${minutes(ttl)} min e tente de novo.`, { code: 'too_many_attempts', retryAfterSec: ttl });
  }
}

/** Conta uma tentativa em cada limite (a janela começa na primeira). */
export async function countAttempt(limits: Limit[]) {
  if (!config.authThrottle) return;
  try {
    const m = redis.multi();
    // SET NX abre a janela só na primeira tentativa; o INCR mantém o prazo dela
    for (const l of limits) { m.set(`rl:${l.key}`, 0, 'EX', l.windowSec, 'NX'); m.incr(`rl:${l.key}`); }
    await m.exec();
  } catch { /* sem Redis, sem contagem */ }
}

export async function clearAttempts(keys: string[]) {
  try { if (keys.length) await redis.del(...keys.map((k) => `rl:${k}`)); } catch { /* ignora */ }
}
