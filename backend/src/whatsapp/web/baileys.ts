/**
 * Carrega o Baileys (biblioteca do WhatsApp Web, só existe como módulo ESM) a partir deste projeto CommonJS.
 * `import()` dentro de `new Function` não é convertido para `require` pelo TypeScript.
 */
import { pathToFileURL } from 'url';
import type * as BaileysNS from '@whiskeysockets/baileys';

export type Baileys = typeof BaileysNS;

const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
let loading: Promise<Baileys> | null = null;

export function loadBaileys(): Promise<Baileys> {
  if (!loading) {
    loading = (async () => {
      // caminho absoluto: funciona com qualquer pasta de trabalho (Docker, tsx, testes)
      const entry = require.resolve('@whiskeysockets/baileys');
      return await dynamicImport(pathToFileURL(entry).href) as Baileys;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/**
 * Logger no formato que o Baileys espera (pino). Só mostra erros, no máximo 20 por minuto,
 * para o log do Render não encher com o "barulho" normal do protocolo.
 */
export function quietLogger(tag: string) {
  let windowStart = Date.now();
  let count = 0;
  const out = (level: 'warn' | 'error') => (obj: unknown, msg?: string) => {
    if (level === 'warn' && process.env.WA_WEB_DEBUG !== '1') return;
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); count = 0; }
    if (++count > 20) return;
    const detail = typeof obj === 'string' ? obj : msg ?? '';
    const err = (obj as { err?: { message?: string }; error?: { message?: string } } | null);
    const reason = err?.err?.message ?? err?.error?.message ?? '';
    console[level](`[qr ${tag}] ${detail}${reason ? `: ${reason}` : ''}`.slice(0, 400));
  };
  const debug = process.env.WA_WEB_DEBUG === '1';
  const logger = {
    level: debug ? 'debug' : 'error',
    child: () => logger,
    trace: () => undefined,
    debug: debug ? (obj: unknown, msg?: string) => console.debug(`[qr ${tag}]`, msg ?? '', typeof obj === 'string' ? obj : '') : () => undefined,
    info: () => undefined,
    warn: out('warn'),
    error: out('error'),
  };
  return logger;
}
