/** QR Code: arquivos guardados pelo Converza (o WhatsApp Web não tem "baixar pelo ID" como a Cloud API). */
import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../../db';
import { isUuid } from '../../utils/http';
import { STORED_REF, WEB_MEDIA_PREFIX } from './convert';
import { readStoredFile } from '../../db/storedFileData';
import { compressFile } from '../../utils/compress';

export const MEDIA_DAYS = 31;

export async function storeWebMedia(connectionId: string, data: Buffer, mime: string, fileName: string | null): Promise<string> {
  // arquivos de mais de 1 MB (imagem, áudio, PDF) são comprimidos antes de guardar
  if (data.length > 1024 * 1024) {
    const c = await compressFile(data, mime || '', fileName || 'arquivo');
    if (c.compressed) { data = c.data; mime = c.mime; fileName = fileName ? c.fileName : null; }
  }
  const [row] = await db.insert(schema.waWebMedia).values({
    connectionId, mime: mime || 'application/octet-stream', fileName: fileName ? fileName.slice(0, 200) : null, size: data.length, data,
  }).returning({ id: schema.waWebMedia.id });
  return `${WEB_MEDIA_PREFIX}${row.id}`;
}

export async function readWebMedia(mediaId: string): Promise<{ data: Buffer; mime: string; fileName: string | null } | null> {
  const id = mediaId.startsWith(WEB_MEDIA_PREFIX) ? mediaId.slice(WEB_MEDIA_PREFIX.length) : mediaId;
  if (id.startsWith(STORED_REF)) {
    const fid = id.slice(STORED_REF.length);
    return isUuid(fid) ? readStoredFile(fid) : null;
  }
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(schema.waWebMedia).where(eq(schema.waWebMedia.id, id)).limit(1);
  return row ? { data: Buffer.from(row.data), mime: row.mime, fileName: row.fileName } : null;
}

/** Apaga os arquivos com mais de 31 dias (como a Meta faz com a mídia da Cloud API). */
export async function sweepWebMedia(): Promise<number> {
  const cut = new Date(Date.now() - MEDIA_DAYS * 86_400_000);
  const r = await db.delete(schema.waWebMedia).where(lt(schema.waWebMedia.createdAt, cut)).returning({ id: schema.waWebMedia.id });
  return r.length;
}
