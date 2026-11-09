/** QR Code: arquivos guardados pelo Converza (o WhatsApp Web não tem "baixar pelo ID" como a Cloud API). */
import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../../db';
import { isUuid } from '../../utils/http';
import { WEB_MEDIA_PREFIX } from './convert';

export const MEDIA_DAYS = 31;

export async function storeWebMedia(connectionId: string, data: Buffer, mime: string, fileName: string | null): Promise<string> {
  const [row] = await db.insert(schema.waWebMedia).values({
    connectionId, mime: mime || 'application/octet-stream', fileName: fileName ? fileName.slice(0, 200) : null, size: data.length, data,
  }).returning({ id: schema.waWebMedia.id });
  return `${WEB_MEDIA_PREFIX}${row.id}`;
}

export async function readWebMedia(mediaId: string): Promise<{ data: Buffer; mime: string; fileName: string | null } | null> {
  const id = mediaId.startsWith(WEB_MEDIA_PREFIX) ? mediaId.slice(WEB_MEDIA_PREFIX.length) : mediaId;
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
