/** Leitura dos arquivos guardados no banco (sem depender do WhatsApp, para não criar import circular). */
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { db, schema } from './index';

export const CHUNK = 1024 * 1024;

/** Conteúdo de um arquivo guardado (em pedaços ou, nos antigos, de uma vez). */
export async function readStoredFile(fileId: string): Promise<{ data: Buffer; mime: string; fileName: string } | null> {
  const [f] = await db.select({ mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName, size: schema.storedFiles.size })
    .from(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)).limit(1);
  if (!f) return null;
  const parts: Buffer[] = [];
  // lê de 4 em 4 pedaços para não pedir tudo numa consulta só
  for (let from = 0; ; from += 4) {
    const rows = await db.select({ data: schema.storedFileChunks.data }).from(schema.storedFileChunks)
      .where(and(eq(schema.storedFileChunks.fileId, fileId), gte(schema.storedFileChunks.idx, from), lt(schema.storedFileChunks.idx, from + 4)))
      .orderBy(asc(schema.storedFileChunks.idx));
    for (const r of rows) parts.push(Buffer.from(r.data));
    if (rows.length < 4) break;
  }
  if (parts.length) return { data: Buffer.concat(parts), mime: f.mime, fileName: f.fileName };
  const [old] = await db.select({ data: schema.storedFiles.data }).from(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)).limit(1);
  return old?.data ? { data: Buffer.from(old.data), mime: f.mime, fileName: f.fileName } : null;
}


