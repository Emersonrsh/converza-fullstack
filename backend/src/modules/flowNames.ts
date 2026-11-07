import { eq } from 'drizzle-orm';
import { db, schema } from '../db';

/** Nome livre para um fluxo novo na conta ("Atendimento", "Atendimento 2", ...). */
export async function uniqueFlowName(accountId: string, base: string): Promise<string> {
  const rows = await db.select({ name: schema.flows.name }).from(schema.flows).where(eq(schema.flows.accountId, accountId));
  const names = new Set(rows.map((r) => r.name.toLowerCase()));
  const clean = base.trim().slice(0, 110) || 'Novo fluxo';
  if (!names.has(clean.toLowerCase())) return clean;
  for (let i = 2; i < 500; i++) {
    const n = `${clean} ${i}`;
    if (!names.has(n.toLowerCase())) return n;
  }
  return `${clean} ${Date.now()}`;
}
