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

export async function safeHttpRequest(req: HttpRequestSpec): Promise<HttpResult> {
  let url: URL;
  try { url = new URL(req.url); } catch { return { ok: false, status: 0, body: null, error: 'URL inválida' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 0, body: null, error: 'Somente URLs http ou https' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((net.isIP(host) && isBlockedIp(host)) || host === 'localhost' || host.endsWith('.localhost')
      || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, status: 0, body: null, error: 'Destino bloqueado por segurança' };
  }
  const method = METHODS.has(req.method) ? req.method : 'GET';
  const lib = url.protocol === 'https:' ? https : http;

  return new Promise<HttpResult>((resolve) => {
    let done = false;
    const finish = (r: HttpResult) => { if (!done) { done = true; resolve(r); } };

    const request = lib.request(url, {
      method,
      headers: { 'User-Agent': 'Converza-Flows/1.0', Accept: 'application/json, text/plain, */*', ...req.headers },
      lookup: safeLookup as any,
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          request.destroy();
          finish({ ok: false, status: res.statusCode ?? 0, body: null, error: 'Resposta maior que 1 MB' });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : null; } catch { /* texto puro */ }
        const status = res.statusCode ?? 0;
        finish({ ok: status >= 200 && status < 300, status, body });
      });
      res.on('error', (e) => finish({ ok: false, status: 0, body: null, error: e.message }));
    });

    request.on('timeout', () => request.destroy(new Error('Tempo limite de 10s esgotado')));
    request.on('error', (e) => finish({ ok: false, status: 0, body: null, error: e.message }));
    if (req.body) request.write(req.body);
    request.end();
  });
}
