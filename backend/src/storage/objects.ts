/**
 * Arquivos grandes (PDFs e capas da área de membros) fora do banco.
 *
 * - Produção: Cloudflare R2 (API compatível com S3). Variáveis: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *   R2_SECRET_ACCESS_KEY e R2_BUCKET. O download sai direto do R2 por link assinado e curto (sem passar
 *   pelo servidor do Converza, que paga banda).
 * - Desenvolvimento e testes: pasta local (OBJECT_STORE_DIR), servida por /api/v1/mfiles/<token assinado>.
 * - Produção sem R2: o envio de arquivos é recusado com uma mensagem clara.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { S3Client, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { AppError } from '../utils/http';

const R2 = {
  account: process.env.R2_ACCOUNT_ID?.trim() ?? '',
  key: process.env.R2_ACCESS_KEY_ID?.trim() ?? '',
  secret: process.env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
  bucket: process.env.R2_BUCKET?.trim() ?? '',
};
const r2Ready = () => Boolean(R2.account && R2.key && R2.secret && R2.bucket);
const LOCAL_DIR = process.env.OBJECT_STORE_DIR?.trim() || (config.env === 'production' ? '' : path.resolve(process.cwd(), '.object-store'));

export type StoreDriver = 'r2' | 'local' | null;
export const storeDriver = (): StoreDriver => (r2Ready() ? 'r2' : LOCAL_DIR ? 'local' : null);

let client: S3Client | null = null;
function s3() {
  client ??= new S3Client({
    region: 'auto', endpoint: `https://${R2.account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2.key, secretAccessKey: R2.secret },
  });
  return client;
}

const safeKey = (key: string) => {
  if (!/^[a-z0-9][a-z0-9/_.-]{5,200}$/i.test(key) || key.includes('..')) throw new AppError(400, 'Nome de arquivo inválido');
  return key;
};

/** Conta os bytes do envio e para no limite (o arquivo nunca fica inteiro na memória). */
function limiter(max: number) {
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new AppError(413, `Arquivo grande demais: o limite é ${Math.round(max / 1024 / 1024)} MB.`));
      else cb(null, chunk);
    },
  });
  return { t, size: () => n };
}

/** Guarda um arquivo vindo de um stream (o corpo da requisição). Devolve o tamanho em bytes. */
export async function putObject(key: string, body: Readable, contentType: string, maxBytes: number): Promise<number> {
  safeKey(key);
  const drv = storeDriver();
  if (!drv) throw new AppError(503, 'O armazenamento de arquivos (Cloudflare R2) ainda não foi configurado no servidor.');
  const lim = limiter(maxBytes);
  if (drv === 'r2') {
    const up = new Upload({ client: s3(), params: { Bucket: R2.bucket, Key: key, Body: body.pipe(lim.t), ContentType: contentType }, queueSize: 2, partSize: 8 * 1024 * 1024 });
    body.on('error', (err) => lim.t.destroy(err));
    await up.done();
  } else {
    const file = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await pipeline(body, lim.t, createWriteStream(file)); }
    catch (err) { await fs.rm(file, { force: true }); throw err; }
    await fs.writeFile(`${file}.type`, contentType);
  }
  return lim.size();
}

export async function deleteObject(key: string | null | undefined) {
  if (!key) return;
  const drv = storeDriver();
  try {
    if (drv === 'r2') await s3().send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: safeKey(key) }));
    else if (drv === 'local') { const f = path.join(LOCAL_DIR, safeKey(key)); await fs.rm(f, { force: true }); await fs.rm(`${f}.type`, { force: true }); }
  } catch (err) { console.error('[arquivos] não apagou', key, (err as Error).message); }
}

const sign = (payload: string) => createHmac('sha256', `${config.jwtSecret}:objects`).update(payload).digest('base64url');

/**
 * Link de leitura com validade curta. `inline` abre no navegador (PDF no leitor); senão, baixa.
 * `apiBase` = endereço público da API (para o modo local).
 */
export async function signedUrl(key: string, opts: { seconds: number; fileName?: string | null; inline?: boolean; apiBase: string }): Promise<string> {
  safeKey(key);
  const name = (opts.fileName || path.basename(key)).replace(/["\\\r\n]/g, '');
  const disp = `${opts.inline === false ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (storeDriver() === 'r2') {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: R2.bucket, Key: key, ResponseContentDisposition: disp }), { expiresIn: opts.seconds });
  }
  const exp = Math.floor(Date.now() / 1000) + opts.seconds;
  const payload = Buffer.from(JSON.stringify({ k: key, e: exp, d: disp })).toString('base64url');
  return `${opts.apiBase}/api/v1/mfiles/${payload}.${sign(payload)}`;
}

/** Só no modo local: entrega o arquivo de um link assinado. */
export const objectFilesRouter = Router();
objectFilesRouter.get('/:token', async (req, res) => {
  try {
    if (storeDriver() !== 'local') { res.status(404).end(); return; }
    const [payload, sig] = String(req.params.token).split('.');
    const want = sign(payload ?? '');
    if (!payload || !sig || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) { res.status(403).end(); return; }
    const { k, e, d } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { k: string; e: number; d: string };
    if (e < Date.now() / 1000) { res.status(410).send('Link expirado'); return; }
    const file = path.join(LOCAL_DIR, safeKey(k));
    const type = await fs.readFile(`${file}.type`, 'utf8').catch(() => 'application/octet-stream');
    const st = await fs.stat(file);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Content-Disposition', d);
    res.setHeader('Cache-Control', 'private, max-age=300');
    // o leitor de PDF da área de membros abre o arquivo dentro da página do app
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${config.appOrigins.join(' ')}`);
    createReadStream(file).pipe(res);
  } catch { res.status(404).end(); }
});
