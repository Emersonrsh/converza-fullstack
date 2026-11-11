/**
 * Requisições HTTP do bloco "Webhook / HTTP", com proteção contra SSRF:
 * só http/https, bloqueio de IPs privados/loopback/link-local (inclusive após
 * resolução de DNS, no momento da conexão), sem seguir redirecionamentos,
 * tempo limite e tamanho máximo de resposta.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { HttpRequestSpec, HttpResult } from './interpreter';

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) return isBlockedIp(v.slice(7));
    if (/^f[cd]/.test(v) || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    if (v.startsWith('64:ff9b:')) return true;
    return false;
  }
  return true;
}

function safeLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (addresses ?? []) as dns.LookupAddress[];
    if (!list.length || list.some((a) => isBlockedIp(a.address))) {
      const e = new Error(`Destino bloqueado por segurança (${hostname})`) as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

interface RawResult { ok: boolean; status: number; headers: http.IncomingHttpHeaders; text: string; buf?: Buffer; error?: string }

/** Pedido HTTP com as travas de segurança. `truncate`: em vez de falhar, guarda só o começo de respostas grandes. */
function rawRequest(urlStr: string, req: { method: string; headers: Record<string, string>; body?: string }, opts: { maxBytes: number; truncate?: boolean; userAgent: string; binary?: boolean; timeoutMs?: number }): Promise<RawResult> {
  let url: URL;
  try { url = new URL(urlStr); } catch { return Promise.resolve({ ok: false, status: 0, headers: {}, text: '', error: 'URL inválida' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.resolve({ ok: false, status: 0, headers: {}, text: '', error: 'Somente URLs http ou https' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((net.isIP(host) && isBlockedIp(host)) || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.internal') || host.endsWith('.local')) {
    return Promise.resolve({ ok: false, status: 0, headers: {}, text: '', error: 'Destino bloqueado por segurança' });
  }
  const method = METHODS.has(req.method) ? req.method : 'GET';
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<RawResult>((resolve) => {
    let done = false;
    const finish = (r: RawResult) => { if (!done) { done = true; resolve(r); } };

    const request = lib.request(url, {
      method,
      headers: { 'User-Agent': opts.userAgent, Accept: 'application/json, text/plain, */*', ...req.headers },
      lookup: safeLookup as any,
      timeout: opts.timeoutMs ?? TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const status = res.statusCode ?? 0;
      const end = () => { const buf = Buffer.concat(chunks); finish({ ok: status >= 200 && status < 300, status, headers: res.headers, text: opts.binary ? '' : buf.toString('utf8'), buf: opts.binary ? buf : undefined }); };
      res.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > opts.maxBytes) {
          if (opts.truncate) {
            chunks.push(c.subarray(0, Math.max(0, c.length - (size - opts.maxBytes))));
            end();
          } else {
            finish({ ok: false, status, headers: res.headers, text: '', error: `Resposta maior que ${Math.round(opts.maxBytes / 1_000_000)} MB` });
          }
          request.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => end());
      res.on('error', (e) => finish({ ok: false, status: 0, headers: {}, text: '', error: e.message }));
    });

    request.on('timeout', () => request.destroy(new Error('Tempo limite de 10s esgotado')));
    request.on('error', (e) => finish({ ok: false, status: 0, headers: {}, text: '', error: e.message }));
    if (req.body) request.write(req.body);
    request.end();
  });
}

export async function safeHttpRequest(req: HttpRequestSpec): Promise<HttpResult> {
  const r = await rawRequest(req.url, { method: req.method, headers: req.headers, body: req.body }, { maxBytes: MAX_BYTES, userAgent: 'Converza-Flows/1.0' });
  if (r.error) return { ok: false, status: r.status, body: null, error: r.error };
  let body: unknown = r.text;
  try { body = r.text ? JSON.parse(r.text) : null; } catch { /* texto puro */ }
  return { ok: r.ok, status: r.status, body };
}

/**
 * Baixa uma página para leitura (ex.: o site do cliente no "Criar agente com IA"): segue até 3
 * redirecionamentos — cada um passa pelas mesmas travas — e guarda só os primeiros 2 MB.
 */
export async function safeFetchPage(urlStr: string): Promise<{ ok: boolean; status: number; url: string; contentType: string; text: string; error?: string }> {
  let current = urlStr;
  for (let hop = 0; hop <= 3; hop++) {
    const r = await rawRequest(current, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'pt-BR,pt;q=0.9' } },
      { maxBytes: 2_000_000, truncate: true, userAgent: 'Mozilla/5.0 (compatible; ConverzaBot/1.0; +https://converza.app)' });
    if (r.error) return { ok: false, status: r.status, url: current, contentType: '', text: '', error: r.error };
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      try { current = new URL(Array.isArray(loc) ? loc[0] : loc, current).toString(); } catch { return { ok: false, status: r.status, url: current, contentType: '', text: '', error: 'Redirecionamento inválido' }; }
      continue;
    }
    return { ok: r.ok, status: r.status, url: current, contentType: String(r.headers['content-type'] ?? ''), text: r.text };
  }
  return { ok: false, status: 0, url: current, contentType: '', text: '', error: 'Redirecionamentos demais' };
}

/**
 * Baixa um arquivo (ex.: o áudio de um bloco por link) com as mesmas travas contra SSRF,
 * seguindo até 3 redirecionamentos. Lança erro com mensagem amigável.
 */
export async function safeDownload(urlStr: string, maxBytes = 16 * 1024 * 1024): Promise<{ data: Buffer; mime: string; fileName: string }> {
  let current = urlStr;
  for (let hop = 0; hop <= 3; hop++) {
    const r = await rawRequest(current, { method: 'GET', headers: { Accept: '*/*' } }, { maxBytes, userAgent: 'Converza-Flows/1.0', binary: true, timeoutMs: 60_000 });
    if (r.error) throw new Error(`Não consegui baixar o arquivo do link (${r.error}).`);
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      try { current = new URL(Array.isArray(loc) ? loc[0] : loc, current).toString(); } catch { throw new Error('Redirecionamento inválido no link do arquivo.'); }
      continue;
    }
    if (!r.ok || !r.buf?.length) throw new Error(`Não consegui baixar o arquivo do link (HTTP ${r.status}).`);
    let fileName = 'audio';
    try { fileName = decodeURIComponent(new URL(current).pathname.split('/').pop() || 'audio'); } catch { /* sem nome */ }
    return { data: r.buf, mime: String(r.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim(), fileName };
  }
  throw new Error('Redirecionamentos demais no link do arquivo.');
}
