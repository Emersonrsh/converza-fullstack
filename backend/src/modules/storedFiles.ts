/** Arquivos guardados no banco (anexos das respostas rápidas e dos fluxos): limites do WhatsApp, link assinado e envio para a Meta. */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { AppError } from '../utils/http';
import { uploadMedia, type WaConnection } from '../whatsapp/cloud-api';
import { isWebPhoneId, STORED_REF, WEB_MEDIA_PREFIX } from '../whatsapp/web/convert';
import { CHUNK, readStoredFile } from '../db/storedFileData';
import { compressFile } from '../utils/compress';
export { readStoredFile };

export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Tipos e tamanhos que o WhatsApp aceita em cada tipo de mensagem. */
/** `maxInputMb`: o que pode ser enviado (antes da compressão); `maxMb`: o que pode ficar guardado (limite do WhatsApp). */
export const FILE_RULES: Record<FileKind, { mimes: RegExp; maxMb: number; maxInputMb: number; label: string }> = {
  image: { mimes: /^image\/(jpeg|png)$/i, maxMb: 5, maxInputMb: 15, label: 'imagem JPG ou PNG (até 15 MB — comprimimos para o WhatsApp)' },
  video: { mimes: /^video\/(mp4|3gpp)$/i, maxMb: 16, maxInputMb: 16, label: 'vídeo MP4 ou 3GP (até 16 MB)' },
  audio: { mimes: /^audio\/(aac|mp4|mpeg|amr|ogg|opus|x-m4a|wav|x-wav|webm)/i, maxMb: 16, maxInputMb: 30, label: 'áudio MP3, OGG, AAC, AMR, M4A ou WAV (até 30 MB — comprimimos)' },
  document: { mimes: /^(application|text)\//i, maxMb: 30, maxInputMb: 30, label: 'documento (PDF, planilha, texto…) até 30 MB' },
  sticker: { mimes: /^image\/webp$/i, maxMb: 0.5, maxInputMb: 0.5, label: 'figurinha WEBP 512×512 (até 500 KB)' },
};

/** Até 200 MB de anexos por empresa (o banco também guarda o resto). */
const ACCOUNT_LIMIT = 200 * 1024 * 1024;

export async function saveFile(accountId: string, kind: FileKind, data: Buffer, mime: string, fileName: string, purpose: 'quick_reply' | 'flow' = 'quick_reply') {
  let m = mime.split(';')[0].trim().toLowerCase();
  const rule = FILE_RULES[kind];
  if (!rule) throw new AppError(422, 'Tipo de anexo inválido');
  if (!rule.mimes.test(m)) throw new AppError(422, `Esse arquivo não serve: use ${rule.label}.`, { code: 'bad_type' });
  if (data.length > rule.maxInputMb * 1024 * 1024) throw new AppError(413, `Arquivo grande demais: use ${rule.label}.`, { code: 'too_big' });
  // compressão automática (imagem, áudio e PDF) antes de guardar
  const originalSize = data.length;
  const c = await compressFile(data, m, fileName);
  data = c.data; m = c.mime; fileName = c.fileName;
  if (kind === 'audio' && !/^audio\/(aac|mp4|mpeg|amr|ogg|opus)/.test(m)) {
    throw new AppError(422, 'Não foi possível converter este áudio para um formato que o WhatsApp aceita. Envie em MP3, OGG ou M4A.', { code: 'bad_type' });
  }
  if (data.length > rule.maxMb * 1024 * 1024) {
    throw new AppError(413, `Mesmo comprimido, o arquivo ficou com ${(data.length / 1048576).toFixed(1).replace('.', ',')} MB e o WhatsApp aceita até ${rule.maxMb} MB neste tipo.`, { code: 'too_big' });
  }
  const [{ used }] = await db.execute(sqlUsed(accountId)).then((r) => r.rows as { used: number }[]);
  if (Number(used) + data.length > ACCOUNT_LIMIT) throw new AppError(413, 'A empresa chegou ao limite de 200 MB de anexos (respostas rápidas e fluxos). Apague anexos que não usa mais.', { code: 'storage_full' });
  const [row] = await db.insert(schema.storedFiles).values({
    accountId, purpose, mime: m, fileName: fileName.slice(0, 140) || 'arquivo', size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), data: null,
  }).returning({ id: schema.storedFiles.id, mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName, size: schema.storedFiles.size });
  try {
    // um pedaço por comando: o banco nunca recebe mais que ~1 MB de uma vez
    for (let i = 0, idx = 0; i < data.length; i += CHUNK, idx++) {
      await db.insert(schema.storedFileChunks).values({ fileId: row.id, idx, data: data.subarray(i, i + CHUNK) });
    }
  } catch (err) {
    await db.delete(schema.storedFiles).where(eq(schema.storedFiles.id, row.id)).catch(() => undefined);
    console.error(`[arquivos] falha ao gravar "${fileName}" (${data.length} bytes): ${(err as Error).message}`);
    throw new AppError(503, 'Não foi possível guardar o arquivo agora (o banco não respondeu). Tente de novo em instantes.', { code: 'storage_unavailable' });
  }
  return { ...row, originalSize, compressed: c.compressed };
}

const sqlUsed = (accountId: string) => sql`select coalesce(sum(size), 0)::bigint as used from stored_files where account_id = ${accountId}`;

/* ------------------------------------------------------------ link assinado (prévia no app) */

const sig = (id: string, e: number) => createHmac('sha256', config.jwtSecret).update(`file:${id}.${e}`).digest('hex').slice(0, 40);
export function signedFilePath(fileId: string, ttlSec = 12 * 3600) {
  const e = Math.floor(Date.now() / 1000) + ttlSec;
  return `/api/v1/media/files/${fileId}?e=${e}&s=${sig(fileId, e)}`;
}
export function verifyFileSig(fileId: string, e: unknown, s: unknown) {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000 || typeof s !== 'string') return false;
  const a = Buffer.from(sig(fileId, exp)); const b = Buffer.from(s);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ envio */

/** ID da mídia na Meta para este número: reaproveita o envio anterior por até 25 dias (a Meta guarda 30). */
export async function mediaIdFor(fileId: string, conn: WaConnection & { id: string }) {
  const fresh = new Date(Date.now() - 25 * 86_400_000);
  const [hit] = await db.select().from(schema.storedFileMedia)
    .where(and(eq(schema.storedFileMedia.fileId, fileId), eq(schema.storedFileMedia.connectionId, conn.id), gt(schema.storedFileMedia.uploadedAt, fresh))).limit(1);
  if (hit) return hit.waMediaId;
  // conexão por QR Code: aponta para o próprio arquivo guardado (sem copiar dezenas de MB de novo no banco)
  if (isWebPhoneId(conn.phoneNumberId)) {
    const [exists] = await db.select({ id: schema.storedFiles.id }).from(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)).limit(1);
    if (!exists) throw new AppError(410, 'O anexo desta resposta rápida não existe mais.');
    return `${WEB_MEDIA_PREFIX}${STORED_REF}${fileId}`;
  }
  const f = await readStoredFile(fileId);
  if (!f) throw new AppError(410, 'O anexo desta resposta rápida não existe mais.');
  const id = await uploadMedia(conn, f.data, f.mime, f.fileName);
  await db.insert(schema.storedFileMedia).values({ fileId, connectionId: conn.id, waMediaId: id })
    .onConflictDoUpdate({ target: [schema.storedFileMedia.fileId, schema.storedFileMedia.connectionId], set: { waMediaId: id, uploadedAt: new Date() } });
  return id;
}
