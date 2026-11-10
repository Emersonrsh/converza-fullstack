import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';
import { explainDbError } from './explainError';

async function main() {
  console.log('Rodando migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations aplicadas.');
  await pool.end();
}

main().catch((err) => {
  console.error(`Falha ao migrar.\n${explainDbError(err)}`);
  process.exit(1);
});
