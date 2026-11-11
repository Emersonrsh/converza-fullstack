/**
 * Sessões do WhatsApp por QR Code (API não oficial, protocolo do WhatsApp Web).
 *
 * - Cada número conectado é uma sessão aberta o tempo todo neste servidor (por isso o plano do Render
 *   precisa ficar sempre ligado). As chaves ficam no Postgres: um deploy não pede o QR de novo.
 * - Uma sessão só roda em um processo por vez (trava no Redis). Outros processos (o worker separado,
 *   outra instância) pedem os envios para o dono da sessão pelo Redis.
 * - O que chega vira o mesmo formato do webhook da Cloud API, então chats, fluxos, agentes e disparos
 *   funcionam igual nos dois tipos de conexão.
 */
import { randomInt, randomUUID } from 'crypto';
import QRCode from 'qrcode';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { db, schema } from '../../db';
import { config } from '../../config';
import { newRedis, redis } from '../../redis';
import { emitToAccount } from '../../realtime/io';
import { emitConnection, type ConnRow } from '../../modules/connectionView';
import { maybeAlertInstance } from '../../modules/instanceAlerts';
import { driver, type DriverSocket } from './driver';
import { clearSession, hasSession, lidPeerJid, pairedConnectionIds, rememberLidPeer } from './auth';
import {
  WEB_PREFIX, formatPhone, isLidJid, isPnJid, isWebMediaId, jidUser, mediaOf, opsFromCloud, peerOf, statusOf, toCloudMessage,
  type WebOp,
} from './convert';
import { readWebMedia, storeWebMedia, sweepWebMedia } from './media';
import { isVoiceFormat, toOggOpus, voiceNoteMeta } from '../../utils/audio';

export const PROCESS_ID = randomUUID();

export type WebState = 'starting' | 'qr' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'qr_expired' | 'replaced';

/** Erro de envio pelo QR Code (o mesmo formato de erro da Cloud API, para quem chama). */
export class WebSendError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) { super(message); this.code = code; }
}

interface Session {
  connectionId: string;
  accountId: string;
  gen: number;
  sock: DriverSocket | null;
  state: WebState;
  me: string | null;
  qrCount: number;
  pairingPhone: string | null;
  pairingCode: string | null;
  attempts: number;
  badSessions: number;
  stopped: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  lockTimer: NodeJS.Timeout | null;
  downSince: number | null;
  sendChain: Promise<unknown>;
  inChain: Promise<unknown>;
  lastSendAt: number;
  jids: Map<string, string>;
  sentIds: Map<string, number>;
  waiters: (() => void)[];
}

const sessions = new Map<string, Session>();
let hosting = false;
let stopping = false;

const MAX_QR = 6; // ~2min40s de QR na tela; depois pede para gerar outro
const LOCK_TTL_MS = 60_000;
const lockKey = (id: string) => `wa-web:lock:${id}`;
const qrKey = (id: string) => `wa-web:qr:${id}`;
const cooldownKey = (id: string) => `wa-web:cooldown:${id}`;
const jidKey = (id: string, digits: string) => `wa-web:jid:${id}:${digits}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: Pick<Session, 'connectionId'>, msg: string) => console.log(`[qr ${s.connectionId.slice(0, 8)}] ${msg}`);

/* ================================================================== trava */

const REFRESH_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function acquire(id: string): Promise<boolean> {
  if ((await redis.set(lockKey(id), PROCESS_ID, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') return true;
  return (await redis.get(lockKey(id))) === PROCESS_ID;
}
const refreshLock = async (id: string) => Number(await redis.eval(REFRESH_LUA, 1, lockKey(id), PROCESS_ID, String(LOCK_TTL_MS))) === 1;
const releaseLock = (id: string) => redis.eval(RELEASE_LUA, 1, lockKey(id), PROCESS_ID).catch(() => undefined);

/* ================================================================== estado no banco */

async function patchConnection(s: Session, patch: Partial<typeof schema.connections.$inferInsert>, alert = false): Promise<ConnRow | null> {
  const [before] = await db.select().from(schema.connections).where(eq(schema.connections.id, s.connectionId)).limit(1);
  if (!before) { stopLocal(s); return null; } // conexão excluída
  const [row] = await db.update(schema.connections).set(patch).where(eq(schema.connections.id, s.connectionId)).returning();
  if (row) {
    emitConnection(row);
    if (alert) void maybeAlertInstance(before, row).catch((err) => console.error('[qr] aviso por e-mail:', (err as Error).message));
  }
  return row ?? null;
}

function setState(s: Session, state: WebState) {
  s.state = state;
  if (state === 'open') { const w = s.waiters.splice(0); w.forEach((f) => f()); }
  emitToAccount(s.accountId, 'wa:state', { connectionId: s.connectionId, state });
}

function waitOpen(s: Session, ms: number): Promise<boolean> {
  if (s.state === 'open') return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { s.waiters = s.waiters.filter((f) => f !== done); resolve(false); }, ms);
    const done = () => { clearTimeout(t); resolve(true); };
    s.waiters.push(done);
  });
}

/* ================================================================== ciclo da sessão */

/**
 * Liga a sessão neste processo (se ninguém mais estiver com ela).
 * `pairingPhone`: em vez de QR, gera o código de 8 letras para digitar no celular.
 */
async function startLocal(connectionId: string, opts: { pairingPhone?: string | null; fresh?: boolean } = {}): Promise<'started' | 'running' | 'busy' | 'missing'> {
  const running = sessions.get(connectionId);
  if (running && !running.stopped) {
    if (opts.pairingPhone && running.state === 'qr' && running.sock) await requestPairing(running, opts.pairingPhone);
    return 'running';
  }
  const [conn] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
  if (!conn || conn.provider !== 'web') return 'missing';
  if (!(await acquire(connectionId))) return 'busy';
  const paired = await hasSession(connectionId);
  // pareamento que não terminou (ex.: pediu o código e não digitou): começa do zero, senão o WhatsApp recusa
  if (opts.fresh || !paired) await clearSession(connectionId);
  await redis.del(cooldownKey(connectionId));
  const s: Session = {
    connectionId, accountId: conn.accountId, gen: 0, sock: null, state: 'starting', me: null, qrCount: 0,
    pairingPhone: opts.pairingPhone ? opts.pairingPhone.replace(/\D/g, '') : null, pairingCode: null,
    attempts: 0, badSessions: 0, stopped: false, reconnectTimer: null, lockTimer: null, downSince: null,
    sendChain: Promise.resolve(), inChain: Promise.resolve(), lastSendAt: 0, jids: new Map(), sentIds: new Map(), waiters: [],
  };
  sessions.set(connectionId, s);
  s.lockTimer = setInterval(() => {
    refreshLock(connectionId).then((ok) => {
      if (!ok && !s.stopped) { log(s, 'outro processo assumiu a sessão'); stopLocal(s); }
    }).catch(() => undefined);
  }, 20_000);
  s.lockTimer.unref();
  if (!paired) await patchConnection(s, { webState: 'starting', status: conn.status === 'connected' ? 'disconnected' : conn.status, lastError: null });
  void connect(s);
  return 'started';
}

async function connect(s: Session) {
  if (s.stopped) return;
  const gen = ++s.gen;
  try { s.sock?.end(); } catch { /* já fechado */ }
  s.sock = null;
  const current = () => !s.stopped && s.gen === gen;
  try {
    const sock = await driver().connect(s.connectionId, {
      onQr: (qr) => { if (current()) void onQr(s, qr).catch((err) => log(s, `QR: ${(err as Error).message}`)); },
      onOpen: (me) => { if (current()) void onOpen(s, me).catch((err) => log(s, `abrir: ${(err as Error).message}`)); },
      onClose: (code, message) => { if (current()) void onClose(s, code, message).catch((err) => log(s, `fechar: ${(err as Error).message}`)); },
      onMessages: (list, type) => {
        if (!current()) return;
        for (const m of list) s.inChain = s.inChain.then(() => onIncoming(s, m, type)).catch((err) => log(s, `mensagem recebida: ${(err as Error).message}`));
      },
      onUpdates: (list) => { if (current()) void onUpdates(s, list).catch((err) => log(s, `status: ${(err as Error).message}`)); },
    });
    if (!current()) { sock.end(); return; }
    s.sock = sock;
  } catch (err) {
    log(s, `não conectou: ${(err as Error).message}`);
    scheduleReconnect(s);
  }
}

function scheduleReconnect(s: Session, delayMs?: number) {
  if (s.stopped) return;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  s.attempts++;
  const wait = delayMs ?? Math.min(300_000, 2000 * 2 ** Math.min(s.attempts - 1, 8)) + randomInt(0, 1500);
  s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; void connect(s); }, wait);
  s.reconnectTimer.unref();
}

/** Para a sessão neste processo (não desconecta o celular: a sessão continua salva). */
function stopLocal(s: Session) {
  if (s.stopped) return;
  s.stopped = true;
  if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
  if (s.lockTimer) clearInterval(s.lockTimer);
  try { s.sock?.end(); } catch { /* já fechado */ }
  s.sock = null;
  if (sessions.get(s.connectionId) === s) sessions.delete(s.connectionId);
  void releaseLock(s.connectionId);
  void redis.del(qrKey(s.connectionId)).catch(() => undefined);
  s.waiters.splice(0).forEach((f) => f());
}

async function publishQr(s: Session, qr: string | null) {
  const payload = { connectionId: s.connectionId, state: s.state, qr, pairingCode: s.pairingCode, attempt: s.qrCount, maxAttempts: MAX_QR };
  await redis.set(qrKey(s.connectionId), JSON.stringify({ ...payload, at: Date.now() }), 'EX', 90);
  emitToAccount(s.accountId, 'wa:qr', payload);
}

async function onQr(s: Session, raw: string) {
  s.qrCount++;
  s.attempts = 0; // chegou QR: a rede até o WhatsApp está funcionando
  if (s.qrCount > MAX_QR) {
    log(s, 'QR Code expirou sem leitura');
    setState(s, 'qr_expired');
    await patchConnection(s, { webState: 'qr_expired', lastError: 'O QR Code expirou sem ser lido. Clique em “Gerar novo QR Code” para tentar de novo.' });
    await clearSession(s.connectionId);
    stopLocal(s);
    emitToAccount(s.accountId, 'wa:qr', { connectionId: s.connectionId, state: 'qr_expired', qr: null, pairingCode: null });
    return;
  }
  setState(s, 'qr');
  if (s.qrCount === 1) await patchConnection(s, { webState: 'qr' });
  const dataUrl = await QRCode.toDataURL(raw, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  if (s.pairingPhone && !s.pairingCode && s.sock) await requestPairing(s, s.pairingPhone);
  await publishQr(s, dataUrl);
}

async function requestPairing(s: Session, phone: string) {
  const digits = phone.replace(/\D/g, '');
  s.pairingPhone = digits;
  try {
    const code = await s.sock!.requestPairingCode(digits);
    s.pairingCode = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  } catch (err) {
    log(s, `código de pareamento: ${(err as Error).message}`);
    s.pairingCode = null;
    emitToAccount(s.accountId, 'wa:qr', { connectionId: s.connectionId, state: s.state, qr: null, pairingCode: null, error: 'Não foi possível gerar o código agora. Use o QR Code ou tente de novo.' });
  }
  const cached = await redis.get(qrKey(s.connectionId));
  await publishQr(s, cached ? (JSON.parse(cached) as { qr: string | null }).qr : null);
}

async function onOpen(s: Session, me: { jid: string; lid: string | null; name: string | null }) {
  const phone = jidUser(me.jid);
  // o mesmo número não pode estar conectado em duas conexões (as mensagens chegariam duas vezes)
  const [dupe] = phone ? await db.select({ id: schema.connections.id, name: schema.connections.name, accountId: schema.connections.accountId })
    .from(schema.connections)
    .where(and(eq(schema.connections.provider, 'web'), ne(schema.connections.id, s.connectionId), eq(schema.connections.status, 'connected'),
      sql`regexp_replace(coalesce(${schema.connections.displayPhone}, ''), '\\D', '', 'g') = ${phone}`)).limit(1) : [];
  if (dupe) {
    log(s, 'número já conectado em outra conexão');
    await s.sock?.logout();
    await clearSession(s.connectionId);
    setState(s, 'logged_out');
    await patchConnection(s, {
      status: 'disconnected', webState: 'logged_out',
      lastError: dupe.accountId === s.accountId
        ? `Esse número já está conectado aqui como “${dupe.name}”. Use aquela conexão ou exclua-a antes.`
        : 'Esse número já está conectado em outra conta do Converza.',
    });
    stopLocal(s);
    return;
  }
  s.me = phone;
  s.attempts = 0;
  s.badSessions = 0;
  s.qrCount = 0;
  s.pairingCode = null;
  s.pairingPhone = null;
  s.downSince = null;
  setState(s, 'open');
  await redis.del(qrKey(s.connectionId));
  emitToAccount(s.accountId, 'wa:qr', { connectionId: s.connectionId, state: 'open', qr: null, pairingCode: null });
  const [before] = await db.select().from(schema.connections).where(eq(schema.connections.id, s.connectionId)).limit(1);
  const firstTime = !before?.displayPhone || before.webState === 'logged_out' || before.webState === 'qr' || before.webState === 'qr_expired' || before.webState === 'starting';
  await patchConnection(s, {
    status: 'connected', webState: 'open', displayPhone: formatPhone(phone), verifiedName: me.name && me.name !== '~' ? me.name : before?.verifiedName ?? null,
    lastError: null, lastCheckedAt: new Date(), ...(firstTime ? { onboardedAt: new Date() } : {}),
  });
  log(s, `conectado (${formatPhone(phone)})`);
}

async function onClose(s: Session, code: number | null, message: string) {
  const paired = await hasSession(s.connectionId);
  s.sock = null;
  const down = async (state: WebState, lastError: string, clear: boolean) => {
    if (clear) await clearSession(s.connectionId);
    setState(s, state);
    await patchConnection(s, { status: 'disconnected', webState: state, lastError }, true);
    stopLocal(s);
  };
  if (code === 401) {
    log(s, 'desconectado pelo celular');
    return down('logged_out', 'O WhatsApp desconectou este aparelho (saiu em “Aparelhos conectados” no celular, ou o número foi removido). Leia o QR Code de novo.', true);
  }
  if (code === 403) {
    return down('logged_out', 'O WhatsApp recusou a conexão deste número (403). Ele pode ter sido banido ou restrito por uso da API não oficial — confira no celular.', true);
  }
  if (code === 411) {
    return down('logged_out', 'O WhatsApp pediu para conectar o aparelho de novo (versão do multiaparelho). Leia o QR Code de novo.', true);
  }
  if (code === 440) {
    // outra sessão com as mesmas chaves entrou (ex.: uma cópia do banco rodando em outro servidor)
    await redis.set(cooldownKey(s.connectionId), '1', 'EX', 600);
    return down('replaced', 'Esta sessão foi aberta em outro lugar (outro servidor com o mesmo banco?). Para evitar briga entre os dois, ela fica parada 10 minutos — depois clique em Reconectar.', false);
  }
  if (!paired) {
    // ainda no QR/código: o QR acabou (408) ou o servidor pediu reinício depois de ler (515)
    if (code === 515) { setState(s, 'connecting'); return scheduleReconnect(s, 300); }
    if (s.qrCount > 0 && ((code === 408 && /QR refs/i.test(message)) || s.qrCount >= MAX_QR)) {
      setState(s, 'qr_expired');
      await clearSession(s.connectionId);
      await patchConnection(s, { webState: 'qr_expired', lastError: 'O QR Code expirou sem ser lido. Clique em “Gerar novo QR Code” para tentar de novo.' });
      emitToAccount(s.accountId, 'wa:qr', { connectionId: s.connectionId, state: 'qr_expired', qr: null, pairingCode: null });
      return stopLocal(s);
    }
    // nem chegou a mostrar o QR (rede/servidor do WhatsApp fora): tenta algumas vezes e depois desiste com o motivo
    if (s.attempts >= 4) {
      setState(s, 'closed');
      await patchConnection(s, { webState: 'closed', lastError: `Não consegui falar com os servidores do WhatsApp (${message}). Confira a internet do servidor e clique em “Gerar novo QR Code”.` });
      emitToAccount(s.accountId, 'wa:qr', { connectionId: s.connectionId, state: 'closed', qr: null, pairingCode: null, error: 'Sem conexão com o WhatsApp.' });
      return stopLocal(s);
    }
    return scheduleReconnect(s);
  }
  if (code === 515) { setState(s, 'connecting'); return scheduleReconnect(s, 300); }
  if (code === 500) {
    s.badSessions++;
    if (s.badSessions >= 3) return down('logged_out', 'A sessão do WhatsApp ficou inválida. Leia o QR Code de novo.', true);
  }
  // queda de rede/servidor: tenta de novo sozinho (cada vez esperando mais, até 5 min)
  log(s, `caiu (${code ?? '?'}: ${message}); tentando de novo`);
  s.downSince ??= Date.now();
  const wasOpen = s.state === 'open';
  setState(s, 'connecting');
  if (wasOpen) await patchConnection(s, { webState: 'connecting' });
  // fora do ar há mais de 3 minutos: marca como desconectado e avisa por e-mail
  if (Date.now() - s.downSince > 180_000) {
    const [c] = await db.select({ status: schema.connections.status }).from(schema.connections).where(eq(schema.connections.id, s.connectionId)).limit(1);
    if (c?.status === 'connected') await patchConnection(s, { status: 'disconnected', lastError: 'Sem conexão com o WhatsApp há alguns minutos. O Converza continua tentando religar sozinho.' }, true);
  }
  scheduleReconnect(s);
}

/* ================================================================== recebimento */

function markSent(s: Session, id: string) {
  s.sentIds.set(id, Date.now());
  if (s.sentIds.size > 2000) {
    const cut = Date.now() - 15 * 60_000;
    for (const [k, at] of s.sentIds) if (at < cut) s.sentIds.delete(k);
  }
}

/** Chama o processamento do webhook da Cloud API (import tardio: evita ciclo entre os módulos). */
async function feedWebhook(s: Session, field: string, value: Record<string, unknown>) {
  const { processWebhook } = await import('../webhook');
  await processWebhook({
    object: 'whatsapp_business_account',
    entry: [{ id: 'web', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { phone_number_id: `${WEB_PREFIX}${s.connectionId}`, display_phone_number: s.me ?? '' }, ...value } }] }],
  });
}

async function onIncoming(s: Session, msg: any, type: string) {
  const key = msg?.key;
  if (!key?.id || !msg.message) return;
  if (s.sentIds.has(String(key.id))) return; // envio do próprio Converza
  // mensagens muito antigas (o servidor guarda as que chegaram com a sessão fora do ar): só até 3 dias
  const ts = Number(typeof msg.messageTimestamp === 'object' ? msg.messageTimestamp?.low : msg.messageTimestamp);
  if (Number.isFinite(ts) && ts > 0 && Date.now() / 1000 - ts > 3 * 86400) return;
  let pnOfLid: string | null = null;
  if (isLidJid(String(key.remoteJid ?? '')) && !isPnJid(String(key.remoteJidAlt ?? '')) && s.sock) pnOfLid = await s.sock.pnForLid(String(key.remoteJid));
  const peer = peerOf(key, pnOfLid);
  if (!peer) return;
  if (peer.lidOnly) await rememberLidPeer(s.connectionId, peer.id, peer.jid);
  else s.jids.set(peer.id, peer.jid);

  // arquivo: baixa agora (o WhatsApp Web não deixa baixar pelo ID depois) e guarda por 31 dias
  let mediaId: string | null = null;
  const media = mediaOf(msg.message);
  let tooBig = false;
  if (media && s.sock) {
    if (media.size > config.waWeb.mediaMaxMb * 1024 * 1024) tooBig = true;
    else {
      try {
        const data = await s.sock.downloadMedia(msg);
        mediaId = await storeWebMedia(s.connectionId, data, media.mime, media.fileName);
      } catch (err) {
        log(s, `não baixou o arquivo recebido: ${(err as Error).message}`);
      }
    }
  }
  const cloud = toCloudMessage(msg, mediaId);
  if (!cloud) return;
  if (tooBig && media) {
    const mb = (media.size / 1048576).toFixed(1);
    const x = cloud[media.type] ?? {};
    x.caption = `${x.caption ? `${x.caption}\n\n` : ''}📎 Arquivo de ${mb} MB (acima do limite de ${config.waWeb.mediaMaxMb} MB) — abra no celular.`;
    cloud[media.type] = x;
  }
  if (key.fromMe) {
    // enviado pelo celular (ou por outro WhatsApp Web): aparece no chat e pausa a automação, como na coexistência
    await feedWebhook(s, 'smb_message_echoes', { message_echoes: [{ ...cloud, from: s.me ?? '', to: peer.id }] });
    return;
  }
  void type;
  await feedWebhook(s, 'messages', {
    contacts: [{ wa_id: peer.id, profile: { name: msg.pushName ? String(msg.pushName) : undefined } }],
    messages: [{ ...cloud, from: peer.id }],
  });
}

async function onUpdates(s: Session, list: { key: any; update: any }[]) {
  const statuses: Record<string, unknown>[] = [];
  for (const u of list) {
    if (!u?.key?.fromMe || !u.key.id || u.update?.status === undefined || u.update?.status === null) continue;
    const st = statusOf(u.update.status);
    if (!st) continue;
    statuses.push({
      id: String(u.key.id), status: st, recipient_id: jidUser(u.key.remoteJid), timestamp: String(Math.floor(Date.now() / 1000)),
      ...(st === 'failed' ? { errors: [{ code: 131000, title: 'O WhatsApp não entregou a mensagem.' }] } : {}),
    });
  }
  if (statuses.length) await feedWebhook(s, 'messages', { statuses });
}

/* ================================================================== envio (local) */

async function jidFor(s: Session, to: string): Promise<string> {
  const raw = String(to ?? '').trim();
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) throw new WebSendError('Número de destino inválido.', 100);
  const hit = s.jids.get(digits);
  if (hit) return hit;
  const lid = await lidPeerJid(s.connectionId, digits);
  if (lid) { s.jids.set(digits, lid); return lid; }
  const cached = await redis.get(jidKey(s.connectionId, digits)).catch(() => null);
  if (cached) { s.jids.set(digits, cached); return cached; }
  const r = await s.sock!.onWhatsApp(digits).catch((err) => { throw new WebSendError(`Não deu para consultar o número no WhatsApp: ${(err as Error).message}`); });
  if (!r?.exists) throw new WebSendError('Esse número não tem WhatsApp (ou digitou errado).', 131026);
  s.jids.set(digits, r.jid);
  if (s.jids.size > 5000) s.jids.delete(s.jids.keys().next().value as string);
  await redis.set(jidKey(s.connectionId, digits), r.jid, 'EX', 30 * 86400).catch(() => undefined);
  return r.jid;
}

const MAX_LINK_BYTES = 64 * 1024 * 1024;
async function fromLink(url: string): Promise<{ data: Buffer; mime: string; fileName: string | null }> {
  let resp: Response;
  try { resp = await fetch(url, { signal: AbortSignal.timeout(60_000) }); } catch (err) {
    throw new WebSendError(`Não consegui baixar o arquivo do link (${(err as Error).message}).`);
  }
  if (!resp.ok) throw new WebSendError(`Não consegui baixar o arquivo do link (HTTP ${resp.status}).`);
  const len = Number(resp.headers.get('content-length') ?? 0);
  if (len > MAX_LINK_BYTES) throw new WebSendError('O arquivo do link é grande demais (máximo 64 MB).');
  const data = Buffer.from(await resp.arrayBuffer());
  if (data.length > MAX_LINK_BYTES) throw new WebSendError('O arquivo do link é grande demais (máximo 64 MB).');
  let fileName: string | null = null;
  try { fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || null; } catch { /* sem nome */ }
  return { data, mime: (resp.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(), fileName };
}

async function quotedOf(s: Session, jid: string, waId: string | null | undefined) {
  if (!waId) return undefined;
  const [m] = await db.select({ body: schema.messages.body, direction: schema.messages.direction }).from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.waMessageId, waId), eq(schema.conversations.connectionId, s.connectionId))).limit(1);
  return { key: { remoteJid: jid, id: waId, fromMe: m?.direction === 'out' }, message: { conversation: m?.body || '📎' } };
}

async function contentOf(s: Session, jid: string, op: WebOp): Promise<{ content: Record<string, any>; opts: Record<string, any> }> {
  const opts: Record<string, any> = {};
  if ((op.kind === 'text' || op.kind === 'media') && op.quoted) opts.quoted = await quotedOf(s, jid, op.quoted);
  switch (op.kind) {
    case 'text':
      return { content: { text: op.text }, opts };
    case 'contacts':
      return { content: { contacts: { displayName: op.displayName, contacts: op.vcards.map((vcard) => ({ vcard })) } }, opts };
    case 'react': {
      const [m] = await db.select({ direction: schema.messages.direction }).from(schema.messages)
        .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
        .where(and(eq(schema.messages.waMessageId, op.messageId), eq(schema.conversations.connectionId, s.connectionId))).limit(1);
      return { content: { react: { text: op.emoji, key: { remoteJid: jid, id: op.messageId, fromMe: m?.direction === 'out' } } }, opts };
    }
    case 'media': {
      let file: { data: Buffer; mime: string; fileName: string | null } | null = null;
      if (op.id) {
        if (!isWebMediaId(op.id)) throw new WebSendError('Este arquivo foi preparado para outra conexão. Envie de novo.');
        file = await readWebMedia(op.id);
        if (!file) throw new WebSendError('O arquivo não existe mais (os arquivos ficam guardados por 31 dias).');
      } else if (op.link) file = await fromLink(op.link);
      if (!file) throw new WebSendError('Mensagem de arquivo sem o arquivo.');
      const caption = op.caption || undefined;
      switch (op.media) {
        case 'image': return { content: { image: file.data, caption, mimetype: file.mime.startsWith('image/') ? file.mime : 'image/jpeg' }, opts };
        case 'video': return { content: { video: file.data, caption, mimetype: file.mime.startsWith('video/') ? file.mime : 'video/mp4' }, opts };
        case 'sticker': return { content: { sticker: file.data }, opts };
        case 'audio': {
          const ogg = isVoiceFormat(file.mime);
          const voice = !!op.voice || ogg;
          if (!voice) return { content: { audio: file.data, mimetype: file.mime || 'audio/mpeg', ptt: false }, opts };
          // mensagem de voz nativa: Ogg/Opus + duração + onda (o WhatsApp mostra o player de voz)
          const data = ogg ? file.data : await toOggOpus(file.data).catch(() => null);
          if (!data) return { content: { audio: file.data, mimetype: file.mime || 'audio/mpeg', ptt: false }, opts };
          const meta = await voiceNoteMeta(data);
          return { content: { audio: data, mimetype: 'audio/ogg; codecs=opus', ptt: true, ...(meta ? { seconds: meta.seconds, waveform: meta.waveform } : {}) }, opts };
        }
        default:
          return { content: { document: file.data, mimetype: file.mime || 'application/octet-stream', fileName: op.fileName || file.fileName || 'arquivo', caption }, opts };
      }
    }
  }
}

/** Envia na fila da sessão: um de cada vez, com uma pausa curta e "digitando…" como uma pessoa. */
function enqueue<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const run = s.sendChain.then(async () => {
    const gap = 700 + randomInt(0, 900);
    const wait = s.lastSendAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { s.lastSendAt = Date.now(); }
  });
  s.sendChain = run.catch(() => undefined);
  return run;
}

export interface WebSendResult { waMessageId: string | null; waId: string | null }

/** "digitando…" em andamento por conversa (renovado a cada 10 s; o envio ou o fim do tempo encerram) */
const typingTimers = new Map<string, { timer: NodeJS.Timeout; until: number }>();
function stopTyping(connectionId: string, jid: string) {
  const k = `${connectionId}|${jid}`;
  const t = typingTimers.get(k);
  if (t) { clearInterval(t.timer); typingTimers.delete(k); }
}
async function typingLocal(s: Session, connectionId: string, to: string, seconds: number, mode: 'text' | 'audio' = 'text') {
  const presence = mode === 'audio' ? 'recording' : 'composing';
  if (!s.sock || s.state !== 'open') return;
  const jid = await jidFor(s, to).catch(() => null);
  if (!jid) return;
  stopTyping(connectionId, jid);
  const until = Date.now() + Math.min(120, seconds) * 1000;
  await s.sock.presence(jid, presence).catch(() => undefined);
  const timer = setInterval(() => {
    if (Date.now() >= until || !s.sock || s.state !== 'open') {
      stopTyping(connectionId, jid);
      if (s.sock && s.state === 'open') void s.sock.presence(jid, 'paused').catch(() => undefined);
      return;
    }
    void s.sock.presence(jid, presence).catch(() => undefined);
  }, 10_000);
  timer.unref?.();
  typingTimers.set(`${connectionId}|${jid}`, { timer, until });
}

async function sendLocal(s: Session, to: string, payload: Record<string, any>): Promise<WebSendResult> {
  if (s.state !== 'open' && !(await waitOpen(s, 25_000))) throw new WebSendError(offlineText(s.state));
  if (!s.sock) throw new WebSendError(offlineText(s.state));
  if (payload.type === 'template') {
    throw new WebSendError('Modelos de mensagem (templates) são da API oficial da Meta e não existem na conexão por QR Code.', 132001);
  }
  const ops = opsFromCloud(payload);
  if (!ops.length) throw new WebSendError('Tipo de mensagem não suportado pela conexão por QR Code.', 131051);
  const jid = await jidFor(s, to);
  for (const k of typingTimers.keys()) if (k.endsWith(`|${jid}`)) { clearInterval(typingTimers.get(k)!.timer); typingTimers.delete(k); }
  return enqueue(s, async () => {
    let first: string | null = null;
    for (const op of ops) {
      const { content, opts } = await contentOf(s, jid, op);
      if (op.kind === 'text' && op.text.length > 0) {
        await s.sock!.presence(jid, 'composing');
        await sleep(Math.min(1500, Math.max(400, op.text.length * 25)));
      }
      let sent: any;
      try { sent = await s.sock!.sendMessage(jid, content, opts); } catch (err) {
        throw new WebSendError(`O WhatsApp não aceitou o envio: ${(err as Error).message}`);
      }
      const id = sent?.key?.id ? String(sent.key.id) : null;
      if (id) { markSent(s, id); first ??= id; }
      if (ops.length > 1) await sleep(500 + randomInt(0, 600));
    }
    await s.sock!.presence(jid, 'paused');
    return { waMessageId: first, waId: isPnJid(jid) ? jidUser(jid) : null };
  });
}

function offlineText(state: WebState) {
  if (state === 'qr' || state === 'starting' || state === 'qr_expired') return 'O número ainda não foi conectado: leia o QR Code em Conexões.';
  if (state === 'logged_out') return 'O WhatsApp por QR Code foi desconectado. Leia o QR Code de novo em Conexões.';
  return 'O WhatsApp por QR Code está sem conexão no momento. O Converza está tentando religar — tente de novo em instantes.';
}

/* ================================================================== RPC entre processos */

let sub: Redis | null = null;
const RELEASED = 'wa-web:released';
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function ensureSub() {
  if (sub) return;
  sub = newRedis();
  void sub.subscribe(`wa-web:rpc:${PROCESS_ID}`, `wa-web:reply:${PROCESS_ID}`, RELEASED).catch((err) => console.error('[qr] redis:', (err as Error).message));
  sub.on('message', (channel: string, raw: string) => {
    // outra instância desligou (deploy) e soltou as sessões: quem continua no ar assume já, sem esperar a ronda
    if (channel === RELEASED) {
      if (hosting && !stopping) setTimeout(() => { void bootSweep().catch(() => undefined); }, 400 + randomInt(0, 600));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (channel === `wa-web:reply:${PROCESS_ID}`) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new WebSendError(String(msg.error?.message ?? 'Falha no envio'), msg.error?.code ?? null));
      return;
    }
    void (async () => {
      let reply: Record<string, unknown>;
      try { reply = { id: msg.id, ok: true, result: await runLocal(msg.connectionId, msg.method, msg.args ?? {}) }; } catch (err) {
        reply = { id: msg.id, ok: false, error: { message: (err as Error).message, code: (err as { code?: number }).code ?? null } };
      }
      await redis.publish(`wa-web:reply:${msg.from}`, JSON.stringify(reply));
    })();
  });
}

async function runLocal(connectionId: string, method: string, args: Record<string, any>): Promise<unknown> {
  const s = sessions.get(connectionId);
  switch (method) {
    case 'send':
      if (!s) throw new WebSendError('Sessão não está neste servidor.');
      return sendLocal(s, args.to, args.payload);
    case 'typing':
      if (s) await typingLocal(s, connectionId, String(args.to), Number(args.seconds) || 0, args.mode === 'audio' ? 'audio' : 'text');
      return true;
    case 'read':
      if (s?.sock && s.state === 'open') {
        const jid = await jidFor(s, args.to).catch(() => null);
        if (jid) await s.sock.readMessages((args.ids as string[]).map((id) => ({ remoteJid: jid, id, fromMe: false }))).catch(() => undefined);
      }
      return true;
    case 'start':
      return startLocal(connectionId, { pairingPhone: args.pairingPhone ?? null, fresh: !!args.fresh });
    case 'logout':
      return logoutLocal(connectionId);
    case 'stop':
      if (s) stopLocal(s);
      return true;
    default:
      throw new WebSendError(`método desconhecido: ${method}`);
  }
}

/** Executa no processo dono da sessão (aqui mesmo, ou pelo Redis). null = ninguém está com a sessão. */
async function callOwner(connectionId: string, method: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ result: unknown } | null> {
  const owner = await redis.get(lockKey(connectionId));
  if (!owner) return null;
  if (owner === PROCESS_ID) {
    if (!sessions.has(connectionId)) return null;
    return { result: await runLocal(connectionId, method, args as Record<string, any>) };
  }
  ensureSub();
  const id = randomUUID();
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new WebSendError('O servidor do WhatsApp por QR Code não respondeu a tempo. Tente de novo.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    redis.publish(`wa-web:rpc:${owner}`, JSON.stringify({ id, from: PROCESS_ID, connectionId, method, args })).then((n) => {
      // ninguém ouvindo: o dono caiu sem soltar a trava
      if (Number(n) === 0) { clearTimeout(timer); pending.delete(id); reject(new WebSendError(offlineText('connecting'))); }
    }).catch((err) => { clearTimeout(timer); pending.delete(id); reject(err as Error); });
  });
  return { result };
}

/* ================================================================== API para o resto do Converza */

/** Envia um payload no formato da Cloud API por uma conexão de QR Code. */
export async function webSend(connectionId: string, to: string, payload: Record<string, any>): Promise<WebSendResult> {
  let r = await callOwner(connectionId, 'send', { to, payload });
  if (!r) {
    const [c] = await db.select({ webState: schema.connections.webState }).from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    const state = (c?.webState ?? 'closed') as WebState;
    // ninguém com a sessão (ex.: o servidor acabou de reiniciar): liga aqui ou espera quem vai ligar
    if (state === 'open' || state === 'connecting') {
      if (hosting) await startLocal(connectionId).catch(() => undefined);
      for (let i = 0; i < 30 && !r; i++) {
        await sleep(1000);
        r = await callOwner(connectionId, 'send', { to, payload });
      }
    }
    if (!r) throw new WebSendError(offlineText(state));
  }
  return r.result as WebSendResult;
}

export async function webTyping(connectionId: string, to: string, seconds: number, mode: 'text' | 'audio' = 'text') {
  await callOwner(connectionId, 'typing', { to, seconds, mode }, 10_000).catch(() => undefined);
}

export async function webMarkRead(connectionId: string, to: string, ids: string[]) {
  await callOwner(connectionId, 'read', { to, ids }, 10_000).catch(() => undefined);
}

export const webUpload = (connectionId: string, data: Buffer, mime: string, fileName: string) => storeWebMedia(connectionId, data, mime, fileName);
export async function webDownload(mediaId: string): Promise<{ data: Buffer; mime: string }> {
  const f = await readWebMedia(mediaId);
  if (!f) throw new WebSendError('O arquivo não está mais disponível (os arquivos da conexão por QR Code ficam guardados por 31 dias).');
  return { data: f.data, mime: f.mime };
}

/** Pede um QR Code (ou código de pareamento) novo — onde quer que a sessão esteja. */
export async function webStart(connectionId: string, opts: { pairingPhone?: string | null; fresh?: boolean } = {}) {
  const args = { pairingPhone: opts.pairingPhone ?? null, fresh: !!opts.fresh };
  if (opts.fresh) {
    const r = await callOwner(connectionId, 'stop', {}, 10_000).catch(() => null);
    if (r) await sleep(300);
  }
  const owned = await callOwner(connectionId, 'start', args, 20_000);
  if (owned) return owned.result;
  if (!hosting) throw new WebSendError('Este processo não liga sessões de QR Code.');
  return startLocal(connectionId, args);
}

async function logoutLocal(connectionId: string) {
  const s = sessions.get(connectionId);
  if (s) {
    s.stopped = true; // não reconecta ao fechar
    await s.sock?.logout().catch(() => undefined);
    s.stopped = false;
    stopLocal(s);
  }
  await clearSession(connectionId);
  return true;
}

/** Desconecta o aparelho (sai de "Aparelhos conectados" no celular) e apaga a sessão. */
export async function webLogout(connectionId: string) {
  const r = await callOwner(connectionId, 'logout', {}, 20_000).catch(() => null);
  if (!r) await clearSession(connectionId);
}

/** O que mostrar na tela: estado e o QR atual (vale para qualquer processo). */
export async function webStatus(connectionId: string) {
  const [raw, owner] = await Promise.all([redis.get(qrKey(connectionId)), redis.get(lockKey(connectionId))]);
  const qr = raw ? JSON.parse(raw) as { state: WebState; qr: string | null; pairingCode: string | null; attempt: number; maxAttempts: number; at: number } : null;
  return { running: !!owner, qr: qr?.qr ?? null, pairingCode: qr?.pairingCode ?? null, qrState: qr?.state ?? null, attempt: qr?.attempt ?? 0, maxAttempts: MAX_QR };
}

/* ================================================================== início e fim do servidor */

async function bootSweep() {
  if (stopping) return;
  const ids = await pairedConnectionIds();
  for (const id of ids) {
    if (stopping) return;
    if (sessions.has(id)) continue;
    if (await redis.exists(lockKey(id))) continue; // outro processo está com ela
    if (await redis.exists(cooldownKey(id))) continue;
    try { await startLocal(id); } catch (err) { console.error(`[qr ${id.slice(0, 8)}] não ligou:`, (err as Error).message); }
    await sleep(250); // não abre dezenas de sessões no mesmo instante
  }
}

/**
 * Liga as sessões salvas e fica de olho nas que ficaram sem dono (instância que caiu).
 * Chame só no processo da API (o worker separado só pede envios).
 */
export function startWebSessions() {
  if (!config.waWeb.enabled || hosting) return;
  hosting = true;
  ensureSub();
  const sweep = () => bootSweep().catch((err) => console.error('[qr] religar sessões:', (err as Error).message));
  setTimeout(sweep, 1500).unref();
  setInterval(sweep, 20_000).unref();
  const media = () => sweepWebMedia().then((n) => { if (n) console.log(`[qr] ${n} arquivos com mais de 31 dias apagados`); })
    .catch((err) => console.error('[qr] limpeza de arquivos:', (err as Error).message));
  setTimeout(media, 120_000).unref();
  setInterval(media, 6 * 3600_000).unref();
  console.log(`WhatsApp por QR Code: ${config.waWeb.driver === 'mock' ? 'SIMULADOR (testes)' : 'ativo'}.`);
}

/** Desligamento (deploy no Render): fecha os sockets e solta as travas, sem desconectar os celulares. */
export async function stopWebSessions() {
  stopping = true;
  const list = [...sessions.values()];
  for (const s of list) stopLocal(s);
  await Promise.all(list.map((s) => releaseLock(s.connectionId)));
  if (list.length) await redis.publish(RELEASED, JSON.stringify(list.map((s) => s.connectionId))).catch(() => undefined);
}

/** Para testes e diagnóstico. */
export const _internal = { sessions, hostingOn: () => hosting };
