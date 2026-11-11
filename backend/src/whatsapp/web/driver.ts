/**
 * "Motor" da conexão por QR Code. `baileys` fala com o WhatsApp de verdade (protocolo do WhatsApp Web);
 * `mock` simula um celular para os testes automáticos (nunca é usado em produção — ver config.waWeb.driver).
 */
import { createHash, randomBytes } from 'crypto';
import { config } from '../../config';
import { loadBaileys, quietLogger } from './baileys';
import { clearSession, dbAuthState } from './auth';
import { jidUser } from './convert';
import { db, schema } from '../../db';
import { and, eq } from 'drizzle-orm';
import { redis } from '../../redis';

export interface DriverHandlers {
  onQr(qr: string): void;
  onOpen(me: { jid: string; lid: string | null; name: string | null }): void;
  onClose(code: number | null, message: string): void;
  onMessages(messages: any[], type: string): void;
  onUpdates(updates: { key: any; update: any }[]): void;
  onLidMapping?(m: { lid: string; pn: string }): void;
}

/** Menu clicável (mensagem interativa "nativa" do WhatsApp): botões de resposta ou lista. */
export type InteractiveSpec =
  | { kind: 'buttons'; body: string; header?: string; footer?: string; buttons: { id: string; title: string }[] }
  | { kind: 'list'; body: string; header?: string; footer?: string; buttonText: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] };

export interface DriverSocket {
  /** menu clicável; devolve a mensagem enviada (key.id) */
  sendInteractive(jid: string, spec: InteractiveSpec): Promise<any>;
  /**
   * Opções escolhidas num voto de enquete (sha256 do texto de cada opção), ou null se não deu para abrir.
   * `secret` é o messageSecret da enquete que o Converza enviou.
   */
  pollVoteHashes(msg: any, secret: Buffer): Buffer[] | null;
  /** devolve a mensagem enviada (formato do Baileys: key.id é o id da mensagem) */
  sendMessage(jid: string, content: Record<string, any>, opts?: Record<string, any>): Promise<any>;
  /** número → JID de verdade no WhatsApp (o celular antigo pode estar sem o 9) */
  onWhatsApp(phone: string): Promise<{ jid: string; exists: boolean } | null>;
  readMessages(keys: { remoteJid: string; id: string; fromMe: boolean }[]): Promise<void>;
  requestPairingCode(phone: string): Promise<string>;
  downloadMedia(msg: any): Promise<Buffer>;
  pnForLid(lid: string): Promise<string | null>;
  presence(jid: string, kind: 'composing' | 'paused' | 'recording'): Promise<void>;
  registered(): boolean;
  /** desconecta o aparelho do celular (sai de "Aparelhos conectados") */
  logout(): Promise<void>;
  /** só fecha o socket (a sessão continua valendo para o próximo início) */
  end(): void;
}

export interface Driver {
  name: 'baileys' | 'mock';
  connect(connectionId: string, handlers: DriverHandlers): Promise<DriverSocket>;
}

/* ===================================================================== Baileys */

let versionCache: { at: number; version: [number, number, number] | undefined } | null = null;
async function waVersion(B: Awaited<ReturnType<typeof loadBaileys>>): Promise<[number, number, number] | undefined> {
  if (versionCache && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.version;
  try {
    const r = await B.fetchLatestBaileysVersion();
    versionCache = { at: Date.now(), version: r.version as [number, number, number] };
  } catch {
    versionCache = { at: Date.now() - 5 * 3600_000, version: undefined }; // tenta de novo em 1 h; usa a versão embutida
  }
  return versionCache.version;
}

/** Texto das mensagens enviadas (o WhatsApp pede de novo quando o celular do cliente não conseguiu abrir). */
async function storedMessage(connectionId: string, id: string | null | undefined) {
  if (!id) return undefined;
  // enquete de menu: reenvia a própria enquete (com o mesmo segredo, para o voto continuar valendo)
  const poll = await redis.get(`wa-web:poll:${connectionId}:${id}`).catch(() => null);
  if (poll) {
    const p = JSON.parse(poll) as { secret: string; name?: string; options: { title: string }[] };
    return {
      messageContextInfo: { messageSecret: Buffer.from(p.secret, 'base64') },
      pollCreationMessageV3: { name: p.name ?? '', selectableOptionsCount: 1, options: p.options.map((o) => ({ optionName: o.title })) },
    };
  }
  const r = await db.select({ body: schema.messages.body }).from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.waMessageId, id), eq(schema.conversations.connectionId, connectionId))).limit(1);
  return r[0]?.body ? { conversation: r[0].body } : undefined;
}

const baileysDriver: Driver = {
  name: 'baileys',
  async connect(connectionId, h) {
    const B = await loadBaileys();
    const logger = quietLogger(connectionId.slice(0, 8)) as any;
    const { state, saveCreds } = await dbAuthState(B, connectionId);
    const version = await waVersion(B);
    const sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: B.Browsers.ubuntu(config.waWeb.deviceName),
      // o celular continua recebendo as notificações normalmente
      markOnlineOnConnect: false,
      // nada de baixar o histórico antigo: só as conversas daqui para a frente
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // os envios do próprio Converza já são gravados por quem enviou
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid: string) => B.isJidGroup(jid) || B.isJidBroadcast(jid) || B.isJidNewsletter(jid) || B.isJidStatusBroadcast(jid),
      getMessage: async (key: { id?: string | null }) => storedMessage(connectionId, key.id) as any,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 60_000,
    });

    sock.ev.on('creds.update', () => { void saveCreds().catch((err) => console.error('[qr] salvar sessão:', (err as Error).message)); });
    sock.ev.on('connection.update', (u: any) => {
      if (u.qr) h.onQr(u.qr);
      if (u.connection === 'open') {
        const me = sock.user ?? state.creds.me;
        h.onOpen({ jid: String(me?.id ?? ''), lid: (me as any)?.lid ? String((me as any).lid) : null, name: (me as any)?.name ?? (me as any)?.verifiedName ?? null });
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as any;
        const code = typeof err?.output?.statusCode === 'number' ? err.output.statusCode : null;
        h.onClose(code, String(err?.message ?? 'conexão fechada'));
      }
    });
    sock.ev.on('messages.upsert', (e: any) => h.onMessages(e.messages ?? [], String(e.type ?? 'notify')));
    sock.ev.on('messages.update', (list: any[]) => h.onUpdates(list ?? []));
    sock.ev.on('lid-mapping.update', (m: any) => { if (m?.lid && m?.pn) h.onLidMapping?.({ lid: String(m.lid), pn: String(m.pn) }); });

    return {
      sendMessage: (jid, content, opts) => sock.sendMessage(jid, content as any, opts as any),
      pollVoteHashes(msg, secret) {
        const upd = B.normalizeMessageContent(msg.message)?.pollUpdateMessage;
        const pollId = upd?.pollCreationMessageKey?.id;
        if (!upd?.vote?.encPayload || !pollId) return null;
        const me: any = sock.user ?? state.creds.me ?? {};
        // o WhatsApp assina o voto com o número ou com o LID: tenta as combinações
        const creators = [...new Set([me.id, me.lid].filter(Boolean).map((j: string) => B.jidNormalizedUser(j)))];
        const k = msg.key ?? {};
        const voters = [...new Set([k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt].filter(Boolean).map((j: string) => B.jidNormalizedUser(j)))];
        for (const pollCreatorJid of creators) for (const voterJid of voters) {
          try {
            const vote = B.decryptPollVote(upd.vote, { pollCreatorJid, pollMsgId: String(pollId), pollEncKey: secret, voterJid });
            return (vote.selectedOptions ?? []).map((o: Uint8Array) => Buffer.from(o));
          } catch { /* outra combinação */ }
        }
        return null;
      },
      async sendInteractive(jid, spec) {
        const buttons = spec.kind === 'buttons'
          ? spec.buttons.map((b) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.title, id: b.id }) }))
          : [{ name: 'single_select', buttonParamsJson: JSON.stringify({
            title: spec.buttonText,
            sections: spec.sections.map((sec) => ({ title: sec.title, highlight_label: '', rows: sec.rows.map((r) => ({ header: '', title: r.title, description: r.description ?? '', id: r.id })) })),
          }) }];
        const interactiveMessage = {
          body: { text: spec.body },
          ...(spec.footer ? { footer: { text: spec.footer } } : {}),
          header: { title: spec.header ?? '', subtitle: '', hasMediaAttachment: false },
          nativeFlowMessage: { buttons, messageParamsJson: '' },
        };
        // formato atual: interactiveMessage direto (o invólucro viewOnce deixou de ser exibido)
        const content = { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage };
        const msg = B.generateWAMessageFromContent(jid, content as any, { userJid: String(sock.user?.id ?? '') } as any);
        const nodes: any[] = [{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] }];
        // conversa individual: o celular só mostra os botões com a marca de bot comercial
        if (!jid.endsWith('@g.us')) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
        await sock.relayMessage(jid, msg.message as any, { messageId: msg.key.id!, additionalNodes: nodes });
        return msg;
      },
      async onWhatsApp(phone) {
        const r = await sock.onWhatsApp(phone);
        const hit = r?.[0];
        return hit ? { jid: String(hit.jid), exists: !!hit.exists } : null;
      },
      async readMessages(keys) { await sock.readMessages(keys as any); },
      requestPairingCode: (phone) => sock.requestPairingCode(phone),
      async downloadMedia(msg) {
        const data = await B.downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
        return data as Buffer;
      },
      async pnForLid(lid) {
        try { return (await (sock as any).signalRepository?.lidMapping?.getPNForLID(lid)) ?? null; } catch { return null; }
      },
      async presence(jid, kind) { await sock.sendPresenceUpdate(kind, jid).catch(() => undefined); },
      registered: () => !!state.creds.account,
      async logout() { await sock.logout().catch(() => undefined); },
      end() { try { sock.end(undefined); } catch { /* já fechado */ } },
    };
  },
};

/* ===================================================================== Simulador (testes) */

export interface MockSent { connectionId: string; jid: string; content: Record<string, any>; id: string; at: number }

/**
 * Celular de mentira, controlado pelos testes por /api/v1/__wa_mock. Guarda a sessão no banco como o real
 * (assim os testes de reinício funcionam) e responde os envios com "entregue" logo depois.
 */
export const mock = {
  sockets: new Map<string, { h: DriverHandlers; open: boolean; me: { jid: string; name: string } | null; qrTimer: NodeJS.Timeout | null; qrs: number }>(),
  sent: [] as MockSent[],
  /** simula o WhatsApp recusando a mensagem interativa (testa a volta para a lista numerada) */
  rejectInteractive: false, failSends: false,
  /** números que "não têm WhatsApp" no simulador */
  missing: new Set<string>(),
  /** responde os envios como entregues? (desligue para testar o status) */
  autoDeliver: true,
  async scan(connectionId: string, phone: string, name = 'Loja Teste') {
    const s = mock.sockets.get(connectionId);
    if (!s) throw new Error('sessão do simulador não iniciada');
    const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    s.me = { jid, name };
    if (s.qrTimer) clearInterval(s.qrTimer);
    s.qrTimer = null;
    const value = JSON.stringify({ me: { id: jid, name }, account: { mock: true } });
    await db.insert(schema.waWebAuth).values({ connectionId, kind: 'creds', keyId: 'creds', value })
      .onConflictDoUpdate({ target: [schema.waWebAuth.connectionId, schema.waWebAuth.kind, schema.waWebAuth.keyId], set: { value } });
    // como o WhatsApp de verdade: depois de ler o QR o servidor pede para reiniciar (515) e então abre
    s.h.onClose(515, 'restart required');
  },
  emit(connectionId: string, messages: any[], type = 'notify') {
    const s = mock.sockets.get(connectionId);
    if (!s?.open) throw new Error('simulador desconectado');
    s.h.onMessages(messages, type);
  },
  status(connectionId: string, id: string, remoteJid: string, status: number) {
    const s = mock.sockets.get(connectionId);
    if (!s?.open) throw new Error('simulador desconectado');
    s.h.onUpdates([{ key: { id, remoteJid, fromMe: true }, update: { status } }]);
  },
  drop(connectionId: string, code: number) {
    const s = mock.sockets.get(connectionId);
    if (!s) throw new Error('sessão do simulador não iniciada');
    s.open = false;
    s.h.onClose(code, `simulado ${code}`);
  },
  media: new Map<string, Buffer>(),
};

const mockDriver: Driver = {
  name: 'mock',
  async connect(connectionId, h) {
    const [row] = await db.select().from(schema.waWebAuth)
      .where(and(eq(schema.waWebAuth.connectionId, connectionId), eq(schema.waWebAuth.kind, 'creds'))).limit(1);
    const saved = row ? JSON.parse(row.value) as { me?: { id: string; name: string }; account?: unknown } : null;
    const s = { h, open: false, me: saved?.me && saved.account ? { jid: saved.me.id, name: saved.me.name } : null, qrTimer: null as NodeJS.Timeout | null, qrs: 0 };
    mock.sockets.set(connectionId, s);
    setTimeout(() => {
      if (mock.sockets.get(connectionId) !== s) return;
      if (s.me) {
        s.open = true;
        h.onOpen({ jid: s.me.jid, lid: null, name: s.me.name });
        return;
      }
      const qr = () => { s.qrs++; h.onQr(`MOCK-QR-${connectionId.slice(0, 8)}-${s.qrs}-${randomBytes(3).toString('hex')}`); };
      qr();
      s.qrTimer = setInterval(qr, Number(process.env.WA_WEB_MOCK_QR_MS ?? 20_000));
    }, 150);
    return {
      async sendInteractive(jid, spec) {
        if (!s.open) throw new Error('Connection Closed');
        if (mock.rejectInteractive) throw new Error('interactive not allowed');
        const id = `3EB0${randomBytes(8).toString('hex').toUpperCase()}`;
        mock.sent.push({ connectionId, jid, content: { interactive: spec }, id, at: Date.now() });
        return { key: { id, remoteJid: jid, fromMe: true } };
      },
      pollVoteHashes(msg) {
        // simulador: o "voto" traz o texto da opção em claro
        const p = msg?.message?.pollUpdateMessage?.vote?.encPayload;
        return p ? [createHash('sha256').update(Buffer.from(String(p))).digest()] : null;
      },
      async sendMessage(jid, content) {
        if (!s.open) throw new Error('Connection Closed');
        if (content.poll && mock.rejectInteractive) throw new Error('poll not allowed');
        if (mock.failSends) throw new Error('simulado: envio recusado');
        const id = `3EB0${randomBytes(8).toString('hex').toUpperCase()}`;
        mock.sent.push({ connectionId, jid, content, id, at: Date.now() });
        if (mock.autoDeliver) setTimeout(() => { if (s.open) h.onUpdates([{ key: { id, remoteJid: jid, fromMe: true }, update: { status: 3 } }]); }, 200);
        return { key: { id, remoteJid: jid, fromMe: true } };
      },
      async onWhatsApp(phone) {
        const d = phone.replace(/\D/g, '');
        if (mock.missing.has(d)) return { jid: `${d}@s.whatsapp.net`, exists: false };
        // como no Brasil: celular antigo cadastrado sem o 9 (simulado para números que terminam em 0000)
        const canonical = /^55\d{2}9\d{8}$/.test(d) && d.endsWith('0000') ? d.slice(0, 4) + d.slice(5) : d;
        return { jid: `${canonical}@s.whatsapp.net`, exists: true };
      },
      async readMessages() { /* nada */ },
      async requestPairingCode() { return 'MOCK-1234'; },
      async downloadMedia(msg) {
        const id = String(msg?.key?.id ?? '');
        const buf = mock.media.get(id);
        if (!buf) throw new Error('mídia indisponível no simulador');
        return buf;
      },
      async pnForLid() { return null; },
      async presence() { /* nada */ },
      registered: () => !!s.me,
      async logout() {
        s.open = false;
        if (s.qrTimer) clearInterval(s.qrTimer);
        await clearSession(connectionId);
      },
      end() {
        s.open = false;
        if (s.qrTimer) clearInterval(s.qrTimer);
        if (mock.sockets.get(connectionId) === s) mock.sockets.delete(connectionId);
      },
    };
  },
};

export function driver(): Driver {
  return config.waWeb.driver === 'mock' ? mockDriver : baileysDriver;
}

export { jidUser };
