import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Links assinados para o proxy de mídia: o navegador carrega <img>/<audio> sem
 * mandar o token de login, então o link carrega uma assinatura com validade.
 */
const sig = (id: string, e: number) => createHmac('sha256', config.jwtSecret).update(`media:${id}.${e}`).digest('hex').slice(0, 40);

export function signedMediaPath(messageId: string, ttlSec = 12 * 3600): string {
  const e = Math.floor(Date.now() / 1000) + ttlSec;
  return `/api/v1/media/${messageId}?e=${e}&s=${sig(messageId, e)}`;
}

export function verifyMediaSig(messageId: string, e: unknown, s: unknown): boolean {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000 || typeof s !== 'string') return false;
  const a = Buffer.from(sig(messageId, exp));
  const b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}
