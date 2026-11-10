/**
 * Compressão automática dos arquivos antes de irem para o banco.
 * - Imagem: no máximo 1600 px no lado maior, JPEG 82% (PNG com transparência continua PNG), sem metadados,
 *   já girada conforme a foto do celular.
 * - Áudio: Ogg/Opus mono 32 kbps (o formato da mensagem de voz do WhatsApp).
 * - PDF: Ghostscript com imagens a 150 dpi (qualidade de leitura no celular).
 * Só troca pelo comprimido se ficar pelo menos 10% menor; qualquer falha guarda o original.
 * Uma compressão por vez no servidor, para não estourar a memória da instância pequena.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { toOggOpus } from './audio';

export interface Compressed {
  data: Buffer; mime: string; fileName: string;
  /** tamanho antes e depois (iguais quando não comprimiu) */
  before: number; after: number;
  compressed: boolean;
}

const MAX_SIDE = 1600;
const MIN_GAIN = 0.9;

/* ---------- uma de cada vez ---------- */
let running = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const next = running.then(job, job);
  running = next.then(() => undefined, () => undefined);
  return next;
}

const swapExt = (name: string, ext: string) => {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '') || 'arquivo';
  return `${base}.${ext}`;
};

async function compressImage(data: Buffer, mime: string, fileName: string): Promise<Omit<Compressed, 'before' | 'after' | 'compressed'>> {
  sharp.cache(false);
  const img = sharp(data, { failOn: 'none', limitInputPixels: 80_000_000 }).rotate();
  const meta = await img.metadata();
  const resized = img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
  // PNG com transparência (logo, figura recortada) continua PNG
  if (/png/i.test(mime) && meta.hasAlpha) {
    const out = await resized.png({ compressionLevel: 9, palette: true, quality: 85, effort: 7 }).toBuffer();
    return { data: out, mime: 'image/png', fileName: swapExt(fileName, 'png') };
  }
  const out = await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return { data: out, mime: 'image/jpeg', fileName: swapExt(fileName, 'jpg') };
}

let gsMissingWarned = false;
function ghostscript(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.GS_PATH || 'gs', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('a compressão do PDF demorou demais')); }, timeoutMs);
    p.stderr.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-4000); });
    p.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `gs saiu com ${code}`)); });
  });
}

async function compressPdf(data: Buffer, fileName: string): Promise<Omit<Compressed, 'before' | 'after' | 'compressed'>> {
  const base = join(tmpdir(), `cvz-pdf-${randomUUID()}`);
  const src = `${base}.in.pdf`; const dst = `${base}.out.pdf`;
  await fs.writeFile(src, data);
  try {
    await ghostscript([
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', '-dPDFSETTINGS=/ebook',
      '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
      '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER', `-sOutputFile=${dst}`, src,
    ], 180_000);
    const out = await fs.readFile(dst);
    if (out.length < 100 || out.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF comprimido inválido');
    return { data: out, mime: 'application/pdf', fileName };
  } finally {
    await Promise.all([fs.rm(src, { force: true }), fs.rm(dst, { force: true })]);
  }
}

/** Tipo que dá para comprimir (o resto é guardado como veio). */
export function compressibleKind(mime: string): 'image' | 'audio' | 'pdf' | null {
  const m = mime.toLowerCase();
  if (/^image\/(jpeg|png)$/.test(m)) return 'image';
  if (/^audio\//.test(m)) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  return null;
}

/**
 * Comprime se for imagem, áudio ou PDF. `minBytes`: abaixo disso nem tenta (arquivo já pequeno).
 * Nunca lança erro: na dúvida, devolve o original.
 */
export async function compressFile(data: Buffer, mime: string, fileName: string, opts: { minBytes?: number } = {}): Promise<Compressed> {
  const original: Compressed = { data, mime, fileName, before: data.length, after: data.length, compressed: false };
  const kind = compressibleKind(mime);
  if (!kind || data.length < (opts.minBytes ?? 0)) return original;
  try {
    const out = await oneAtATime(async () => {
      if (kind === 'image') return compressImage(data, mime, fileName);
      if (kind === 'audio') return { data: await toOggOpus(data, 120_000), mime: 'audio/ogg', fileName: swapExt(fileName, 'ogg') };
      return compressPdf(data, fileName);
    });
    if (!out.data.length || out.data.length > data.length * MIN_GAIN) return original;
    return { ...out, before: data.length, after: out.data.length, compressed: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (kind === 'pdf' && e.code === 'ENOENT') {
      if (!gsMissingWarned) { gsMissingWarned = true; console.warn('[compressão] Ghostscript (gs) não instalado: PDFs são guardados sem compressão.'); }
    } else {
      console.warn(`[compressão] ${kind} "${fileName}" guardado sem compressão: ${e.message}`);
    }
    return original;
  }
}
