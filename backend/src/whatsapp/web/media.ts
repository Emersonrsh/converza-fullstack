/** QR Code: arquivos guardados pelo Converza (o WhatsApp Web não tem "baixar pelo ID" como a Cloud API). */
import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../../db';
import { isUuid } from '../../utils/http';
import { STORED_REF, WEB_MEDIA_PREFIX } from './convert';
import { readStoredFile } from '../../db/storedFileData';
import { compressFile } from '../../utils/compress';
import { putBuffer, readObjectBuffer, storeDriver } from '../../storage/objects';

export const MEDIA_DAYS = 31;

export async function storeWebMedia(connectionId: string, data: Buffer, mime: string, fileName: string | null): Promise<string> {
  // arquivos de mais de 1 MB (imagem, áudio, PDF) são comprimidos antes de guardar
  if (data.length > 1024 * 1024) {
    const c = await compressFile(data, mime || '', fileName || 'arquivo');
    if (c.compressed) { data = c.data; mime = c.mime; fileName = fileName ? c.fileName : null; }
  }
  const base = { connectionId, mime: mime || 'application/octet-stream', fileName: fileName ? fileName.slice(0, 200) : null, size: data.length };
  if (storeDriver()) {
    // R2: o banco guarda só a chave (se o R2 falhar, cai para o banco para não perder a mensagem)
    const [row] = await db.insert(schema.waWebMedia).values({ ...base, data: null }).returning({ id: schema.waWebMedia.id });
    const key = `wa/${connectionId}/${row.id}`;
    try {
      await putBuffer(key, data, base.mime);
      await db.update(schema.waWebMedia).set({ storageKey: key }).where(eq(schema.waWebMedia.id, row.id));
    } catch (err) {
      console.error('[qr] mídia no armazenamento:', (err as Error).message);
      await db.update(schema.waWebMedia).set({ data }).where(eq(schema.waWebMedia.id, row.id));
    }
    return `${WEB_MEDIA_PREFIX}${row.id}`;
  }
  const [row] = await db.insert(schema.waWebMedia).values({ ...base, data }).returning({ id: schema.waWebMedia.id });
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
  if (!row) return null;
  if (row.storageKey) return { data: await readObjectBuffer(row.storageKey), mime: row.mime, fileName: row.fileName };
  return row.data ? { data: Buffer.from(row.data), mime: row.mime, fileName: row.fileName } : null;
}

/** Arquivo de mídia guardado no R2 (para o navegador baixar direto de lá). Nulo se está no banco. */
export async function webMediaObject(mediaId: string | null | undefined): Promise<{ key: string; mime: string; fileName: string | null } | null> {
  if (!mediaId?.startsWith(WEB_MEDIA_PREFIX)) return null;
  const id = mediaId.slice(WEB_MEDIA_PREFIX.length);
  if (id.startsWith(STORED_REF)) {
    const fid = id.slice(STORED_REF.length);
    if (!isUuid(fid)) return null;
    const [f] = await db.select({ key: schema.storedFiles.storageKey, mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName }).from(schema.storedFiles).where(eq(schema.storedFiles.id, fid)).limit(1);
    return f?.key ? { key: f.key, mime: f.mime, fileName: f.fileName } : null;
  }
  if (!isUuid(id)) return null;
  const [row] = await db.select({ key: schema.waWebMedia.storageKey, mime: schema.waWebMedia.mime, fileName: schema.waWebMedia.fileName }).from(schema.waWebMedia).where(eq(schema.waWebMedia.id, id)).limit(1);
  return row?.key ? { key: row.key, mime: row.mime, fileName: row.fileName } : null;
}

/** Apaga os arquivos com mais de 31 dias (como a Meta faz com a mídia da Cloud API). */
export async function sweepWebMedia(): Promise<number> {
  const cut = new Date(Date.now() - MEDIA_DAYS * 86_400_000);
  const r = await db.delete(schema.waWebMedia).where(lt(schema.waWebMedia.createdAt, cut)).returning({ id: schema.waWebMedia.id });
  return r.length;
}
