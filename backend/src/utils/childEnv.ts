import { tmpdir } from 'os';

/**
 * Ambiente mínimo para programas externos que leem arquivos de terceiros (Ghostscript, ffmpeg):
 * sem as variáveis da API (banco, chaves, tokens). Se um desses programas tiver uma falha, ele não
 * enxerga os segredos do servidor.
 */
export function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: tmpdir(), TMPDIR: tmpdir(), LANG: 'C.UTF-8' };
}
