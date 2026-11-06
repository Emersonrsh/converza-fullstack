import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

async function main() {
  console.log('Rodando migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations aplicadas.');
  await pool.end();
}

main().catch((err) => {
  console.error('Falha ao migrar:', err);
  process.exit(1);
});
