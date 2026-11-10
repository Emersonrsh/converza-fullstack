import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { config } from '../config';
import { schema } from './schema';

export const pool = new Pool({ connectionString: config.databaseUrl });
// Conexão ociosa que o banco derrubou (reinício, falta de memória…): só registra. Sem isto o Node
// trata como "erro não tratado" e a API inteira cai ("Instance failed" no Render).
pool.on('error', (err) => {
  console.error(`[db] conexão com o banco perdida: ${(err as Error).message} — o pool abre outra na próxima consulta.`);
});
export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
