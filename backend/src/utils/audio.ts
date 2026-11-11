import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** O servidor não tem o ffmpeg instalado (o Dockerfile do Converza já instala). */
export class FfmpegMissingError extends Error {}

/** Roda o ffmpeg e devolve o que ele escreveu no stderr (onde ficam duração e progresso). */
function ffmpeg(args: string[], timeoutMs: number, verb = 'converter'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('A conversão do áudio demorou demais')); }, timeoutMs);
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); if (err.length > 200_000) err = err.slice(-100_000); });
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new FfmpegMissingError('O servidor não tem o ffmpeg instalado para converter o áudio.') : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else {
        const last = err.trim().split('\n').filter((l) => !/^\s*(size|frame)=/.test(l)).pop();
        reject(new Error(`Não foi possível ${verb} o áudio (${last?.slice(0, 160) || `código ${code}`})`));
      }
    });
  });
}

/** Converte usando arquivos temporários (MP4/M4A precisa de leitura com "seek"). */
async function convert(input: Buffer, outArgs: string[], ext: string, timeoutMs: number): Promise<Buffer> {
  const base = join(tmpdir(), `cvz-${randomUUID()}`);
  const src = `${base}.in`;
  const dst = `${base}.${ext}`;
  await fs.writeFile(src, input);
  try {
    await ffmpeg(['-loglevel', 'error', '-y', '-i', src, '-vn', ...outArgs, dst], timeoutMs);
    const out = await fs.readFile(dst);
    if (!out.length) throw new Error('A conversão do áudio gerou um arquivo vazio');
    return out;
  } finally {
    await Promise.all([fs.rm(src, { force: true }), fs.rm(dst, { force: true })]);
  }
}

/**
 * Áudio qualquer (WebM/Opus do Chrome, MP4/AAC do Safari, MP3 da voz gerada…) → Ogg/Opus mono,
 * o formato que o WhatsApp mostra como mensagem de voz.
 */
export const toOggOpus = (input: Buffer, timeoutMs = 60_000) =>
  convert(input, ['-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg'], 'ogg', timeoutMs);

/** Áudio qualquer → MP3 mono (amostras para clonar a voz). */
export const toMp3 = (input: Buffer, timeoutMs = 60_000) =>
  convert(input, ['-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'], 'mp3', timeoutMs);

/**
 * Duração em segundos, decodificando o arquivo (o WebM gravado no navegador não traz a duração no cabeçalho).
 * Lança erro se o arquivo não for um áudio legível.
 */
export async function audioSeconds(input: Buffer, timeoutMs = 60_000): Promise<number> {
  const src = join(tmpdir(), `cvz-${randomUUID()}.in`);
  await fs.writeFile(src, input);
  try {
    const log = await ffmpeg(['-nostdin', '-i', src, '-vn', '-f', 'null', '-'], timeoutMs, 'ler');
    if (!/Audio:/.test(log)) throw new Error('O arquivo não tem áudio');
    const times = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const t = times.pop() ?? /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
    if (!t) return 0;
    return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  } finally {
    await fs.rm(src, { force: true });
  }
}

/** O áudio já está no formato da mensagem de voz do WhatsApp (Ogg/Opus)? */
export const isVoiceFormat = (mime: string | null | undefined) => /ogg|opus/i.test(String(mime ?? ''));

/**
 * Duração e "onda" (64 barras de 0 a 100) para a mensagem de voz nativa do WhatsApp,
 * como o próprio app gera. Decodifica com o ffmpeg; em caso de erro devolve null.
 */
export async function voiceNoteMeta(input: Buffer, timeoutMs = 60_000): Promise<{ seconds: number; waveform: Uint8Array } | null> {
  const src = join(tmpdir(), `cvz-${randomUUID()}.in`);
  await fs.writeFile(src, input);
  try {
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const parts: Buffer[] = [];
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
      p.stdout.on('data', (c: Buffer) => parts.push(c));
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`ffmpeg ${code}`)); });
    });
    const n = Math.floor(pcm.length / 2);
    if (!n) return null;
    const seconds = Math.max(1, Math.round(n / 8000));
    const bars = 64; const block = Math.max(1, Math.floor(n / bars));
    const avg: number[] = [];
    for (let b = 0; b < bars; b++) {
      let sum = 0; const start = b * block; const end = Math.min(n, start + block);
      for (let i = start; i < end; i++) sum += Math.abs(pcm.readInt16LE(i * 2));
      avg.push(end > start ? sum / (end - start) : 0);
    }
    const max = Math.max(...avg) || 1;
    return { seconds, waveform: new Uint8Array(avg.map((v) => Math.min(100, Math.floor((v / max) * 100)))) };
  } catch {
    return null;
  } finally {
    await fs.rm(src, { force: true });
  }
}
