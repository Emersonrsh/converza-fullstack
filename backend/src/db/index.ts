import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config';
import { schema } from './schema';

export const pool = new Pool({ connectionString: config.databaseUrl });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
