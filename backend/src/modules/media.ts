import { readStoredFile } from '../db/storedFileData';
import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { verifyMediaSig } from '../utils/mediaSign';
import { verifyFileSig } from './storedFiles';
import { downloadMedia } from '../whatsapp/cloud-api';

/**
 * Proxy de mídia: baixa da Meta (com o token da conexão) a imagem/áudio/arquivo
 * de uma mensagem e entrega ao navegador. Público, mas exige link assinado.
 * Guarda em memória por alguns minutos (o player de áudio/vídeo pede o arquivo em pedaços).
 */
export const mediaRouter = Router();

const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { data: Buffer; mime: string; at: number }>();
let cacheBytes = 0;

function cacheGet(id: string) {
  const e = cache.get(id);
  if (!e) return null;
  cache.delete(id);
  if (Date.now() - e.at > CACHE_TTL_MS) { cacheBytes -= e.data.length; return null; }
  cache.set(id, e); // mais recente no fim (LRU)
  return e;
}

function cachePut(id: string, data: Buffer, mime: string) {
  if (data.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(id);
  if (old) { cache.delete(id); cacheBytes -= old.data.length; }
  while (cacheBytes + data.length > CACHE_MAX_BYTES && cache.size) {
    const [k, v] = cache.entries().next().value as [string, { data: Buffer }];
    cache.delete(k); cacheBytes -= v.data.length;
  }
  cache.set(id, { data, mime, at: Date.now() });
  cacheBytes += data.length;
}

/** Só imagem, áudio, vídeo e PDF abrem no navegador; o resto é baixado (evita HTML/scripts no domínio da API). */
const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/|video\/|application\/pdf)/i;

function send(req: { headers: { range?: string } }, res: Response, data: Buffer, mime: string, fileName: string | null) {
  const inline = INLINE.test(mime);
  res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Accept-Ranges', 'bytes');
  const name = fileName ? encodeURIComponent(fileName) : null;
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}${name ? `; filename*=UTF-8''${name}` : ''}`);

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (range && (range[1] || range[2])) {
    const size = data.length;
    let start = range[1] ? Number(range[1]) : NaN;
    let end = range[2] ? Number(range[2]) : NaN;
    if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1; } // "bytes=-500": últimos 500
    else if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.end(data.subarray(start, end + 1));
    return;
  }
  res.setHeader('Content-Length', String(data.length));
  res.end(data);
}

/** Anexo guardado no banco (respostas rápidas): link assinado. */
mediaRouter.get('/files/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id) || !verifyFileSig(id, req.query.e, req.query.s)) throw new AppError(403, 'Link de arquivo inválido ou expirado');
  const w = Math.round(Number(req.query.w));
  if (w >= 64 && w <= 1200) {
    // miniatura (canvas do fluxo): imagem grande decodificada várias vezes derruba o Safari do celular
    const key = `${id}:${w}`;
    const hit = thumbs.get(key);
    if (hit) { res.setHeader('Cache-Control', 'private, max-age=3600'); return send(req, res, hit, 'image/webp', null); }
  }
  const f = await readStoredFile(id);
  if (!f) throw new AppError(404, 'Arquivo não encontrado');
  if (w >= 64 && w <= 1200 && /^image\/(jpeg|png|webp|heic|heif|avif)$/i.test(f.mime)) {
    try {
      const sharp = (await import('sharp')).default;
      const out = await sharp(f.data, { failOn: 'none' }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      thumbs.set(`${id}:${w}`, out);
      if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value as string);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return send(req, res, out, 'image/webp', null);
    } catch { /* não deu para reduzir: manda o original */ }
  }
  send(req, res, f.data, f.mime, f.fileName);
}));
const thumbs = new Map<string, Buffer>();

mediaRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isUuid(id) || !verifyMediaSig(id, req.query.e, req.query.s)) throw new AppError(403, 'Link de mídia inválido ou expirado');
  const [row] = await db.select({ m: schema.messages, conn: schema.connections }).from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .leftJoin(schema.connections, eq(schema.connections.id, schema.conversations.connectionId))
    .where(eq(schema.messages.id, id)).limit(1);
  if (!row) throw new AppError(404, 'Mídia não encontrada');
  if (!row.m.waMediaId) {
    if (row.m.mediaUrl && /^https?:\/\//i.test(row.m.mediaUrl)) return res.redirect(302, row.m.mediaUrl);
    throw new AppError(404, 'Mídia não encontrada');
  }
  const hit = cacheGet(id);
  if (hit) return send(req, res, hit.data, row.m.mimeType || hit.mime, row.m.fileName);
  if (!row.conn?.accessToken) throw new AppError(410, 'A conexão desta conversa não está mais disponível');
  let file: { data: Buffer; mime: string };
  try {
    file = await downloadMedia(row.conn.accessToken, row.m.waMediaId);
  } catch (err) {
    throw new AppError(502, (err as Error).message);
  }
  cachePut(id, file.data, file.mime);
  send(req, res, file.data, row.m.mimeType || file.mime, row.m.fileName);
}));
