/** Leitura dos arquivos guardados (no R2 ou, os antigos, no banco), sem depender do WhatsApp para não criar import circular. */
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { Response } from 'express';
import { db, schema } from './index';
import { readObjectBuffer } from '../storage/objects';

export const CHUNK = 1024 * 1024;

export interface StoredFileInfo { id: string; mime: string; fileName: string; size: number; storageKey: string | null }

export async function storedFileInfo(fileId: string): Promise<StoredFileInfo | null> {
  const [f] = await db.select({ id: schema.storedFiles.id, mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName, size: schema.storedFiles.size, storageKey: schema.storedFiles.storageKey })
    .from(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)).limit(1);
  return f ?? null;
}

/** Pedaços [from, to) do banco, de 4 em 4 (nunca pede o arquivo inteiro numa consulta). */
async function* chunksOf(fileId: string, from = 0, to = Number.MAX_SAFE_INTEGER) {
  for (let i = from; i < to; i += 4) {
    const rows = await db.select({ data: schema.storedFileChunks.data }).from(schema.storedFileChunks)
      .where(and(eq(schema.storedFileChunks.fileId, fileId), gte(schema.storedFileChunks.idx, i), lt(schema.storedFileChunks.idx, Math.min(i + 4, to))))
      .orderBy(asc(schema.storedFileChunks.idx));
    for (const r of rows) yield Buffer.from(r.data);
    if (rows.length < Math.min(4, to - i)) return;
  }
}

/** Conteúdo inteiro de um arquivo (para mandar à Meta/WhatsApp Web ou gerar miniatura: no máximo 30 MB). */
export async function readStoredFile(fileId: string): Promise<{ data: Buffer; mime: string; fileName: string } | null> {
  const f = await storedFileInfo(fileId);
  if (!f) return null;
  if (f.storageKey) return { data: await readObjectBuffer(f.storageKey), mime: f.mime, fileName: f.fileName };
  const parts: Buffer[] = [];
  for await (const c of chunksOf(fileId)) parts.push(c);
  if (parts.length) return { data: Buffer.concat(parts), mime: f.mime, fileName: f.fileName };
  const [old] = await db.select({ data: schema.storedFiles.data }).from(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)).limit(1);
  return old?.data ? { data: Buffer.from(old.data), mime: f.mime, fileName: f.fileName } : null;
}

/**
 * Entrega um arquivo que ainda está no banco direto para a resposta, pedaço por pedaço
 * (só os pedaços do trecho pedido; o arquivo nunca fica inteiro na memória). Cabeçalhos de tipo/cache já definidos.
 */
export async function streamStoredChunks(f: StoredFileInfo, rangeHeader: string | undefined, res: Response): Promise<boolean> {
  const [has] = await db.select({ idx: schema.storedFileChunks.idx }).from(schema.storedFileChunks).where(eq(schema.storedFileChunks.fileId, f.id)).limit(1);
  if (!has) return false; // arquivo antigo, inteiro numa coluna: quem chamou usa readStoredFile
  const size = f.size;
  let start = 0; let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? '').trim());
  if (range && (range[1] || range[2])) {
    start = range[1] ? Number(range[1]) : NaN;
    end = range[2] ? Number(range[2]) : NaN;
    if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1; }
    else if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) { res.status(416).setHeader('Content-Range', `bytes */${size}`); res.end(); return true; }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  const first = Math.floor(start / CHUNK); const last = Math.floor(end / CHUNK);
  let pos = first * CHUNK;
  for await (const c of chunksOf(f.id, first, last + 1)) {
    const a = Math.max(0, start - pos); const b = Math.min(c.length, end - pos + 1);
    pos += c.length;
    if (res.destroyed) return true;
    if (!res.write(c.subarray(a, b))) await new Promise<void>((ok) => { res.once('drain', ok); res.once('close', ok); });
  }
  res.end();
  return true;
}
