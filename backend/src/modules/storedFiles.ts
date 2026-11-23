/** Arquivos guardados (no R2 ou, os antigos, no banco: anexos das respostas rápidas e dos fluxos): limites do WhatsApp, link assinado e envio para a Meta. */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { AppError } from '../utils/http';
import { uploadMedia, type WaConnection } from '../whatsapp/cloud-api';
import { isWebPhoneId, STORED_REF, WEB_MEDIA_PREFIX } from '../whatsapp/web/convert';
import { CHUNK, readStoredFile } from '../db/storedFileData';
import { putBuffer, storeDriver } from '../storage/objects';
import { compressFile } from '../utils/compress';
import { isVoiceFormat, toOggOpus } from '../utils/audio';
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

/** Padrão de 200 MB de anexos por empresa; o painel da plataforma pode mudar por empresa (accounts.attachments_limit_mb). */
export const DEFAULT_LIMIT_MB = 200;

async function accountLimitMb(accountId: string) {
  const [a] = await db.select({ mb: schema.accounts.attachmentsLimitMb }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  return a?.mb && a.mb > 0 ? a.mb : DEFAULT_LIMIT_MB;
}

const fileRow = { id: schema.storedFiles.id, mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName, size: schema.storedFiles.size };

export async function saveFile(accountId: string, kind: FileKind, data: Buffer, mime: string, fileName: string, purpose: 'quick_reply' | 'flow' = 'quick_reply') {
  let m = mime.split(';')[0].trim().toLowerCase();
  const rule = FILE_RULES[kind];
  if (!rule) throw new AppError(422, 'Tipo de anexo inválido');
  if (!rule.mimes.test(m)) throw new AppError(422, `Esse arquivo não serve: use ${rule.label}.`, { code: 'bad_type' });
  if (data.length > rule.maxInputMb * 1024 * 1024) throw new AppError(413, `Arquivo grande demais: use ${rule.label}.`, { code: 'too_big' });
  const originalSize = data.length;
  // o mesmo arquivo já guardado nesta empresa (mesmo uso): reaproveita em vez de ocupar espaço de novo.
  // Documento só se o nome for o mesmo, porque o nome aparece para o cliente.
  const sourceSha256 = createHash('sha256').update(data).digest('hex');
  const same = and(eq(schema.storedFiles.accountId, accountId), eq(schema.storedFiles.purpose, purpose), eq(schema.storedFiles.sourceSha256, sourceSha256),
    ...(kind === 'document' ? [eq(schema.storedFiles.fileName, fileName.slice(0, 140) || 'arquivo')] : []));
  // created_at renovado: a limpeza de anexos sem uso não apaga um arquivo que acabou de ser escolhido de novo
  const [dup] = await db.update(schema.storedFiles).set({ createdAt: new Date() })
    .where(eq(schema.storedFiles.id, sql`(select id from stored_files where ${same} order by created_at desc limit 1)`)).returning(fileRow);
  if (dup) return { ...dup, originalSize, compressed: dup.size < originalSize, reused: true };
  // compressão automática (imagem, áudio e PDF) antes de guardar
  const c = await compressFile(data, m, fileName);
  data = c.data; m = c.mime; fileName = c.fileName;
  if (kind === 'audio' && !/^audio\/(aac|mp4|mpeg|amr|ogg|opus)/.test(m)) {
    throw new AppError(422, 'Não foi possível converter este áudio para um formato que o WhatsApp aceita. Envie em MP3, OGG ou M4A.', { code: 'bad_type' });
  }
  if (data.length > rule.maxMb * 1024 * 1024) {
    throw new AppError(413, `Mesmo comprimido, o arquivo ficou com ${(data.length / 1048576).toFixed(1).replace('.', ',')} MB e o WhatsApp aceita até ${rule.maxMb} MB neste tipo.`, { code: 'too_big' });
  }
  const [{ used }] = await db.execute(sqlUsed(accountId)).then((r) => r.rows as { used: number }[]);
  const limitMb = await accountLimitMb(accountId);
  if (Number(used) + data.length > limitMb * 1024 * 1024) throw new AppError(413, `A empresa chegou ao limite de ${limitMb} MB de anexos (respostas rápidas e fluxos). Apague anexos que não usa mais.`, { code: 'storage_full' });
  const [row] = await db.insert(schema.storedFiles).values({
    accountId, purpose, mime: m, fileName: fileName.slice(0, 140) || 'arquivo', size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), sourceSha256, data: null,
  }).returning(fileRow);
  try {
    if (storeDriver()) {
      // R2 (ou a pasta local em desenvolvimento): o banco guarda só a chave
      const key = `files/${accountId}/${row.id}`;
      await putBuffer(key, data, m);
      await db.update(schema.storedFiles).set({ storageKey: key }).where(eq(schema.storedFiles.id, row.id));
    } else {
      // sem armazenamento de objetos: um pedaço por comando, o banco nunca recebe mais que ~1 MB de uma vez
      for (let i = 0, idx = 0; i < data.length; i += CHUNK, idx++) {
        await db.insert(schema.storedFileChunks).values({ fileId: row.id, idx, data: data.subarray(i, i + CHUNK) });
      }
    }
  } catch (err) {
    await db.delete(schema.storedFiles).where(eq(schema.storedFiles.id, row.id)).catch(() => undefined);
    console.error(`[arquivos] falha ao gravar "${fileName}" (${data.length} bytes): ${(err as Error).message}`);
    throw new AppError(503, 'Não foi possível guardar o arquivo agora (o armazenamento não respondeu). Tente de novo em instantes.', { code: 'storage_unavailable' });
  }
  return { ...row, originalSize, compressed: c.compressed, reused: false };
}

/** Folga antes de apagar um anexo sem uso: protege o arquivo que alguém acabou de escolher num editor ainda não salvo. */
export const UNUSED_GRACE = sql`interval '10 minutes'`;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Libera na hora o espaço dos anexos que saíram de um fluxo (bloco apagado, arquivo trocado ou fluxo excluído):
 * `before` é o fluxo como estava. Só apaga o que nenhum fluxo da empresa usa mais.
 */
export async function dropFlowFilesNoLongerUsed(accountId: string, before: unknown) {
  const ids = [...new Set((JSON.stringify(before ?? null).match(UUID_RE) ?? []).map((x) => x.toLowerCase()))];
  if (!ids.length) return 0;
  const r = await db.execute(sql`
    delete from stored_files f
    where f.account_id = ${accountId} and f.purpose = 'flow' and f.id = any(${`{${ids.join(',')}}`}::uuid[])
      and f.created_at < now() - ${UNUSED_GRACE}
      and not exists (select 1 from flows w where w.account_id = f.account_id and w.graph::text like '%' || f.id::text || '%')
    returning f.id`);
  return r.rows.length;
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
export async function mediaIdFor(fileId: string, conn: WaConnection & { id: string }, opts: { asVoice?: boolean } = {}) {
  // o arquivo precisa ser da mesma empresa da conexão (um fluxo não pode mandar o anexo de outra conta)
  const [own] = await db.select({ id: schema.storedFiles.id }).from(schema.storedFiles)
    .innerJoin(schema.connections, eq(schema.connections.accountId, schema.storedFiles.accountId))
    .where(and(eq(schema.storedFiles.id, fileId), eq(schema.connections.id, conn.id))).limit(1);
  if (!own) {
    console.warn(`[arquivos] anexo ${fileId} recusado: não é da empresa da conexão ${conn.id}`);
    throw new AppError(410, 'O anexo não existe mais nesta conta. Envie o arquivo de novo no bloco.');
  }
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
  // mensagem de voz na API oficial precisa ser Ogg/Opus (arquivos antigos podem ser MP3/M4A)
  if (opts.asVoice && !isVoiceFormat(f.mime)) {
    const ogg = await toOggOpus(f.data).catch(() => null);
    if (ogg) { f.data = ogg; f.mime = 'audio/ogg'; f.fileName = f.fileName.replace(/\.[a-z0-9]{1,5}$/i, '') + '.ogg'; }
  }
  const id = await uploadMedia(conn, f.data, f.mime, f.fileName);
  await db.insert(schema.storedFileMedia).values({ fileId, connectionId: conn.id, waMediaId: id })
    .onConflictDoUpdate({ target: [schema.storedFileMedia.fileId, schema.storedFileMedia.connectionId], set: { waMediaId: id, uploadedAt: new Date() } });
  return id;
}
