import { Redis } from 'ioredis';
import { config } from './config';

// maxRetriesPerRequest: null é exigido pelo BullMQ para as conexões de workers.
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export function newRedis() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}
