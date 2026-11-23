/**
 * Manutenção do armazenamento de arquivos:
 * - lixeira: remove do R2 os arquivos cujo registro foi apagado (inclusive em cascata);
 * - migração aos poucos: tira do banco os anexos antigos e leva para o R2 (o banco fica menor e mais barato).
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { readStoredFile } from '../db/storedFileData';
import { putBuffer, removeObject, storeDriver } from './objects';

export async function sweepObjectTrash(limit = 300): Promise<number> {
  if (!storeDriver()) return 0;
  const rows = await db.select({ key: schema.objectTrash.key }).from(schema.objectTrash).orderBy(asc(schema.objectTrash.createdAt)).limit(limit);
  const done: string[] = [];
  for (const r of rows) if (await removeObject(r.key)) done.push(r.key);
  if (done.length) await db.delete(schema.objectTrash).where(inArray(schema.objectTrash.key, done));
  return done.length;
}

/** Leva até `limit` anexos antigos do banco para o R2. Devolve quantos foram. */
export async function migrateStoredFiles(limit = 20): Promise<number> {
  if (!storeDriver()) return 0;
  const rows = await db.select({ id: schema.storedFiles.id, accountId: schema.storedFiles.accountId })
    .from(schema.storedFiles).where(isNull(schema.storedFiles.storageKey)).orderBy(asc(schema.storedFiles.createdAt)).limit(limit);
  let n = 0;
  for (const r of rows) {
    try {
      const f = await readStoredFile(r.id);
      if (!f) continue;
      const key = `files/${r.accountId}/${r.id}`;
      await putBuffer(key, f.data, f.mime);
      const ok = await db.transaction(async (tx) => {
        const up = await tx.update(schema.storedFiles).set({ storageKey: key, data: null })
          .where(and(eq(schema.storedFiles.id, r.id), isNull(schema.storedFiles.storageKey))).returning({ id: schema.storedFiles.id });
        if (up.length) await tx.delete(schema.storedFileChunks).where(eq(schema.storedFileChunks.fileId, r.id));
        return up.length > 0;
      });
      if (ok) n++;
    } catch (err) {
      console.error(`[arquivos] migrar ${r.id} para o armazenamento:`, (err as Error).message);
    }
  }
  return n;
}

export function startStorageMaintenance() {
  const run = async () => {
    try {
      const gone = await sweepObjectTrash();
      const moved = await migrateStoredFiles();
      if (gone || moved) console.log(`[arquivos] ${moved} anexo(s) levado(s) do banco para o armazenamento, ${gone} removido(s) da lixeira`);
    } catch (err) { console.error('[arquivos] manutenção:', (err as Error).message); }
  };
  setTimeout(run, 120_000).unref();
  setInterval(run, 10 * 60_000).unref();
}
