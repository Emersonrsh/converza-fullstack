import type { InteractiveSpec } from './driver';
/**
 * QR Code (WhatsApp Web): conversões puras entre as mensagens do WhatsApp Web (formato do Baileys) e o formato
 * da Cloud API que o resto do Converza já entende — assim chats, fluxos, agentes e disparos funcionam igual.
 * Sem dependências (usado nos testes).
 */

/** id de conexão por QR Code guardado em connections.phone_number_id */
export const WEB_PREFIX = 'web:';
export const isWebPhoneId = (id: string | null | undefined): id is string => !!id && id.startsWith(WEB_PREFIX);
export const connectionIdOf = (phoneNumberId: string) => phoneNumberId.slice(WEB_PREFIX.length);
/** id de mídia guardada pelo Converza (tabela wa_web_media) */
export const WEB_MEDIA_PREFIX = 'webm:';
/** id de mídia que aponta para um arquivo dos fluxos/respostas rápidas (webm:sf-<uuid>), sem cópia */
export const STORED_REF = 'sf-';
export const isWebMediaId = (id: string | null | undefined): id is string => !!id && id.startsWith(WEB_MEDIA_PREFIX);

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** "5511999990000:12@s.whatsapp.net" → "5511999990000" */
export function jidUser(jid: string | null | undefined): string {
  return String(jid ?? '').split('@')[0].split(':')[0];
}
export const isGroupJid = (jid: string) => /@g\.us$/.test(jid);
export const isLidJid = (jid: string) => /@lid$/.test(jid);
export const isPnJid = (jid: string) => /@s\.whatsapp\.net$/.test(jid);
/** grupos, status, listas de transmissão e canais ficam de fora */
export const ignoredJid = (jid: string) => !jid || isGroupJid(jid) || /@broadcast$/.test(jid) || /@newsletter$/.test(jid) || jid === 'status@broadcast';

/** Número exibido: "+55 11 99999-0000" (Brasil) ou "+<dígitos>". */
export function formatPhone(raw: string): string {
  const d = digits(raw);
  if (/^55\d{10,11}$/.test(d)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    return `+55 ${ddd} ${rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`}`;
  }
  return d ? `+${d}` : '';
}

/**
 * Tira os "envelopes" (mensagem temporária, documento com legenda, enviada por outro aparelho).
 * Visualização única NÃO é aberta: quem mandou quer que só dê para ver uma vez, no celular.
 */
export function unwrap(message: any): any {
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    const inner = m.ephemeralMessage?.message ?? m.documentWithCaptionMessage?.message ?? m.deviceSentMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

const isViewOnce = (m: any) => !!(m?.viewOnceMessage || m?.viewOnceMessageV2 || m?.viewOnceMessageV2Extension
  || m?.imageMessage?.viewOnce || m?.videoMessage?.viewOnce || m?.audioMessage?.viewOnce);

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'] as const;
type MediaKey = typeof MEDIA_KEYS[number];
const MEDIA_TYPE: Record<MediaKey, 'image' | 'video' | 'audio' | 'document' | 'sticker'> = {
  imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker',
};

/** Qual mídia a mensagem tem (para baixar antes de entregar ao Converza). */
export function mediaOf(message: any): { key: MediaKey; type: 'image' | 'video' | 'audio' | 'document' | 'sticker'; mime: string; fileName: string | null; size: number } | null {
  const m = unwrap(message);
  if (!m) return null;
  for (const k of MEDIA_KEYS) {
    const x = m[k];
    if (x) {
      return {
        key: k, type: MEDIA_TYPE[k], mime: String(x.mimetype ?? defaultMime(MEDIA_TYPE[k])).split(';')[0].trim() || defaultMime(MEDIA_TYPE[k]),
        fileName: x.fileName ? String(x.fileName) : null, size: Number(x.fileLength ?? 0) || 0,
      };
    }
  }
  return null;
}

function defaultMime(t: string) {
  return t === 'image' ? 'image/jpeg' : t === 'video' ? 'video/mp4' : t === 'audio' ? 'audio/ogg' : t === 'sticker' ? 'image/webp' : 'application/octet-stream';
}

const tsOf = (t: unknown): string => {
  const n = typeof t === 'object' && t !== null && 'low' in (t as any) ? Number((t as any).low) : Number(t);
  return String(Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.floor(Date.now() / 1000));
};

/**
 * Quem é o cliente da conversa. `id` vira o telefone/wa_id do contato no Converza; `jid` é para onde responder.
 * Quando o WhatsApp só informa o identificador anônimo (@lid, número oculto), o id são os dígitos do lid.
 */
export function peerOf(key: { remoteJid?: string | null; remoteJidAlt?: string | null }, pnOfLid?: string | null): { id: string; jid: string; lidOnly: boolean } | null {
  const jid = String(key.remoteJid ?? '');
  if (ignoredJid(jid)) return null;
  const alt = String(key.remoteJidAlt ?? '');
  if (isPnJid(jid)) return { id: jidUser(jid), jid: `${jidUser(jid)}@s.whatsapp.net`, lidOnly: false };
  if (isLidJid(jid)) {
    const pn = isPnJid(alt) ? alt : pnOfLid && isPnJid(pnOfLid) ? pnOfLid : null;
    if (pn) return { id: jidUser(pn), jid: `${jidUser(pn)}@s.whatsapp.net`, lidOnly: false };
    return { id: jidUser(jid), jid: `${jidUser(jid)}@lid`, lidOnly: true };
  }
  return null;
}

const contextIdOf = (m: any): string | null => {
  for (const k of ['extendedTextMessage', ...MEDIA_KEYS, 'contactMessage', 'locationMessage'] as const) {
    const id = m?.[k]?.contextInfo?.stanzaId;
    if (id) return String(id);
  }
  return null;
};

/**
 * Anúncio de clique para o WhatsApp: o WhatsApp Web traz o anúncio no externalAdReply da primeira mensagem.
 * Vira o mesmo `referral` da Cloud API (com o ctwa_clid, que a Meta usa para atribuir a conversão).
 */
const adReplyOf = (m: any): Record<string, string> | null => {
  for (const k of ['extendedTextMessage', ...MEDIA_KEYS, 'contactMessage', 'locationMessage'] as const) {
    const ad = m?.[k]?.contextInfo?.externalAdReply;
    if (ad?.sourceId || ad?.ctwaClid) {
      const ref: Record<string, string> = { source_id: String(ad.sourceId || ad.ctwaClid) };
      if (ad.sourceType) ref.source_type = String(ad.sourceType);
      if (ad.sourceUrl) ref.source_url = String(ad.sourceUrl);
      if (ad.ctwaClid) ref.ctwa_clid = String(ad.ctwaClid);
      return ref;
    }
  }
  return null;
};

/**
 * Mensagem recebida (ou enviada pelo celular) → mensagem no formato da Cloud API.
 * `mediaId`: o id da mídia já baixada e guardada pelo Converza. null = não é algo que o Converza mostra.
 */
export function toCloudMessage(msg: any, mediaId: string | null = null): Record<string, any> | null {
  const m = unwrap(msg?.message);
  if (!m || !msg?.key?.id) return null;
  if (m.protocolMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return null;
  const base: Record<string, any> = { id: String(msg.key.id), timestamp: tsOf(msg.messageTimestamp) };
  const ctx = contextIdOf(m);
  if (ctx) base.context = { id: ctx };
  const ad = adReplyOf(m);
  if (ad) base.referral = ad;
  if (isViewOnce(m)) return { ...base, type: 'unsupported', unsupported: { text: '👁️ Mensagem de visualização única — só dá para abrir no celular.' } };
  if (m.editedMessage || m.protocolMessage?.editedMessage) return null; // edição: a mensagem original continua no chat

  if (typeof m.conversation === 'string' || m.extendedTextMessage) {
    return { ...base, type: 'text', text: { body: String(m.conversation ?? m.extendedTextMessage?.text ?? '') } };
  }
  const media = mediaOf(m);
  if (media) {
    const x = m[media.key];
    return {
      ...base, type: media.type,
      [media.type]: { id: mediaId ?? undefined, mime_type: media.mime, caption: x.caption ?? undefined, filename: media.fileName ?? undefined, voice: !!x.ptt },
    };
  }
  if (m.locationMessage || m.liveLocationMessage) {
    const l = m.locationMessage ?? m.liveLocationMessage;
    return { ...base, type: 'location', location: { latitude: l.degreesLatitude, longitude: l.degreesLongitude, name: l.name ?? undefined, address: l.address ?? undefined } };
  }
  if (m.contactMessage || m.contactsArrayMessage) {
    const list = m.contactMessage ? [m.contactMessage] : (m.contactsArrayMessage.contacts ?? []);
    return {
      ...base, type: 'contacts',
      contacts: list.map((c: any) => ({ name: { formatted_name: c.displayName ?? 'Contato' }, phones: vcardPhones(c.vcard).map((p) => ({ phone: p })) })),
    };
  }
  if (m.reactionMessage) {
    return { ...base, type: 'reaction', reaction: { message_id: String(m.reactionMessage.key?.id ?? ''), emoji: m.reactionMessage.text || '' } };
  }
  if (m.buttonsResponseMessage) {
    return { ...base, type: 'button', button: { text: m.buttonsResponseMessage.selectedDisplayText ?? '', payload: m.buttonsResponseMessage.selectedButtonId ?? '' } };
  }
  if (m.templateButtonReplyMessage) {
    return { ...base, type: 'button', button: { text: m.templateButtonReplyMessage.selectedDisplayText ?? '', payload: m.templateButtonReplyMessage.selectedId ?? '' } };
  }
  if (m.interactiveResponseMessage) {
    const r = m.interactiveResponseMessage;
    let params: any = {};
    try { params = JSON.parse(r.nativeFlowResponseMessage?.paramsJson ?? '{}'); } catch { /* sem id */ }
    const id = String(params.id ?? params.selected_row_id ?? '');
    const title = String(r.body?.text ?? params.title ?? params.display_text ?? '');
    return { ...base, type: 'interactive', interactive: params.selected_row_id || r.nativeFlowResponseMessage?.name === 'single_select'
      ? { type: 'list_reply', list_reply: { id, title } }
      : { type: 'button_reply', button_reply: { id, title } } };
  }
  if (m.listResponseMessage) {
    return { ...base, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: m.listResponseMessage.singleSelectReply?.selectedRowId ?? '', title: m.listResponseMessage.title ?? '' } } };
  }
  if (m.pollUpdateMessage || m.keepInChatMessage || m.pinInChatMessage || m.messageContextInfo && Object.keys(m).length === 1) return null;
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    const p = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
    return { ...base, type: 'unsupported', unsupported: { text: `📊 Enquete: ${p?.name ?? ''} (responda pelo celular)`.trim() } };
  }
  // pagamento, evento, chamada…: aparece no chat como "não suportada"
  return { ...base, type: 'unsupported', unsupported: { text: 'Mensagem de um tipo que o Converza não mostra (abra no celular).' } };
}

/** Telefones de um vCard (linhas TEL ou waid=). */
export function vcardPhones(vcard: unknown): string[] {
  const out: string[] = [];
  for (const line of String(vcard ?? '').split(/\r?\n/)) {
    if (!/^TEL/i.test(line)) continue;
    const waid = /waid=(\d+)/i.exec(line)?.[1];
    const num = waid ?? digits(line.split(':').pop());
    if (num) out.push(`+${num}`);
  }
  return out;
}

/** Status de entrega do WhatsApp Web (0 erro · 2 enviada · 3 entregue · 4 lida · 5 ouvida). */
export function statusOf(code: unknown): 'sent' | 'delivered' | 'read' | 'failed' | null {
  const n = Number(code);
  if (n === 0) return 'failed';
  if (n === 2) return 'sent';
  if (n === 3) return 'delivered';
  if (n === 4 || n === 5) return 'read';
  return null;
}

/* ---------------------------------------------------------------------- envio */

/** O que mandar pelo WhatsApp Web (no formato do Baileys), a partir do payload da Cloud API. */
export type WebOp =
  | { kind: 'text'; text: string; quoted?: string | null }
  | { kind: 'media'; media: 'image' | 'video' | 'audio' | 'document' | 'sticker'; link?: string; id?: string; caption?: string; fileName?: string; voice?: boolean; quoted?: string | null }
  | { kind: 'contacts'; displayName: string; vcards: string[] }
  | { kind: 'react'; messageId: string; emoji: string }
  | { kind: 'interactive'; spec: InteractiveSpec; fallback: string; quoted?: string | null };

const nums = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const numLabel = (i: number) => nums[i] ?? `${i}.`;

export function vcardOf(name: string, phone: string): string {
  const d = digits(phone);
  const safe = String(name || 'Contato').replace(/[\r\n;]/g, ' ').trim() || 'Contato';
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${safe}\nN:${safe};;;;\nTEL;type=CELL;type=VOICE;waid=${d}:+${d}\nEND:VCARD`;
}

/** Texto do modelo + botões de resposta numerados (QR Code não tem modelos da Meta). */
export function templateAsText(preview: string, buttons: { title: string }[]): string {
  return numbered(preview, buttons.filter((b) => b.title.trim()).map((b) => ({ title: b.title })));
}

/** Botões e listas não aparecem no WhatsApp Web: viram texto com as opções numeradas (o cliente responde o número). */
function numbered(body: string, options: { title: string; description?: string }[], footer?: string): string {
  const lines = options.map((o, i) => `${numLabel(i + 1)} ${o.title}${o.description ? ` — ${o.description}` : ''}`);
  return [body.trim(), lines.join('\n'), footer?.trim() ? `_${footer.trim()}_` : '', options.length ? '_Responda com o número da opção._' : '']
    .filter(Boolean).join('\n\n');
}

const brl = (cents: number, offset: number) => (cents / (offset || 100)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Converte o payload da Cloud API em envios do WhatsApp Web. Templates não existem por QR Code
 * (quem chama manda o texto do modelo como mensagem normal).
 */
export function opsFromCloud(payload: Record<string, any>): WebOp[] {
  const quoted = payload.context?.message_id ? String(payload.context.message_id) : null;
  const type = String(payload.type ?? '');
  switch (type) {
    case 'text':
      return [{ kind: 'text', text: String(payload.text?.body ?? ''), quoted }];
    case 'image': case 'video': case 'audio': case 'document': case 'sticker': {
      const x = payload[type] ?? {};
      return [{
        kind: 'media', media: type, link: x.link ? String(x.link) : undefined, id: x.id ? String(x.id) : undefined,
        caption: x.caption ? String(x.caption) : undefined, fileName: x.filename ? String(x.filename) : undefined,
        voice: type === 'audio' && !!x.voice, quoted,
      }];
    }
    case 'contacts': {
      const list: any[] = payload.contacts ?? [];
      const cards = list.map((c) => vcardOf(c.name?.formatted_name ?? c.name?.first_name ?? 'Contato', c.phones?.[0]?.wa_id ?? c.phones?.[0]?.phone ?? ''));
      return [{ kind: 'contacts', displayName: list[0]?.name?.formatted_name ?? 'Contato', vcards: cards }];
    }
    case 'reaction':
      return [{ kind: 'react', messageId: String(payload.reaction?.message_id ?? ''), emoji: String(payload.reaction?.emoji ?? '') }];
    case 'interactive':
      return interactiveOps(payload.interactive ?? {}, quoted);
    default:
      return [];
  }
}

/** Menus clicáveis no QR Code: experimental (WA_WEB_INTERACTIVE=on). Sem a variável vai a lista numerada,
 *  que sempre chega: o WhatsApp pode aceitar os botões e não entregar ao cliente. */
const interactiveOn = () => process.env.WA_WEB_INTERACTIVE === 'on';
const headerPlain = (it: Record<string, any>) => (it.header?.type === 'text' && it.header.text ? String(it.header.text) : undefined);

function interactiveOps(it: Record<string, any>, quoted: string | null): WebOp[] {
  const body = String(it.body?.text ?? '');
  const footer = it.footer?.text ? String(it.footer.text) : undefined;
  const headerText = it.header?.type === 'text' && it.header.text ? `*${String(it.header.text)}*\n` : '';
  switch (String(it.type)) {
    case 'button': {
      const opts = (it.action?.buttons ?? []).map((b: any) => ({ id: String(b.reply?.id ?? b.reply?.title ?? ''), title: String(b.reply?.title ?? '') }));
      const fallback = numbered(headerText + body, opts, footer);
      if (!interactiveOn()) return [{ kind: 'text', text: fallback, quoted }];
      return [{ kind: 'interactive', spec: { kind: 'buttons', body, header: headerPlain(it), footer, buttons: opts }, fallback, quoted }];
    }
    case 'list': {
      const sections = (it.action?.sections ?? []).map((s: any) => ({
        title: String(s.title ?? ''),
        rows: (s.rows ?? []).map((r: any) => ({ id: String(r.id ?? r.title ?? ''), title: String(r.title ?? ''), description: r.description ? String(r.description) : undefined })),
      }));
      const rows = sections.flatMap((s: any) => s.rows);
      const fallback = numbered(headerText + body, rows, footer);
      if (!interactiveOn()) return [{ kind: 'text', text: fallback, quoted }];
      // poucas opções sem descrição: botões na própria mensagem (como no app); senão, lista que abre ao tocar
      if (rows.length <= 6 && !rows.some((r: any) => r.description)) {
        return [{ kind: 'interactive', spec: { kind: 'buttons', body, header: headerPlain(it), footer, buttons: rows.map((r: any) => ({ id: r.id, title: r.title })) }, fallback, quoted }];
      }
      return [{ kind: 'interactive', spec: { kind: 'list', body, header: headerPlain(it), footer, buttonText: String(it.action?.button ?? 'Ver opções'), sections }, fallback, quoted }];
    }
    case 'cta_url': {
      const p = it.action?.parameters ?? {};
      return [{ kind: 'text', text: [headerText + body, `🔗 ${p.display_text ?? 'Abrir'}: ${p.url ?? ''}`, footer ? `_${footer}_` : ''].filter(Boolean).join('\n\n'), quoted }];
    }
    case 'order_details': {
      const p = it.action?.parameters ?? {};
      const pix = (p.payment_settings ?? []).find((x: any) => x.type === 'pix_dynamic_code')?.pix_dynamic_code ?? {};
      const total = p.total_amount ? brl(Number(p.total_amount.value ?? 0), Number(p.total_amount.offset ?? 100)) : '';
      const head = [body, total ? `💰 Valor: *${total}*` : '', pix.merchant_name ? `Recebedor: ${pix.merchant_name}` : '', 'Pix copia e cola 👇'].filter(Boolean).join('\n');
      const ops: WebOp[] = [];
      const img = it.header?.type === 'image' ? it.header.image : null;
      if (img?.link || img?.id) ops.push({ kind: 'media', media: 'image', link: img.link, id: img.id, caption: head });
      else ops.push({ kind: 'text', text: head, quoted });
      if (pix.code) ops.push({ kind: 'text', text: String(pix.code) });
      return ops;
    }
    case 'carousel': {
      const cards: any[] = it.action?.cards ?? [];
      const ops: WebOp[] = [];
      if (body) ops.push({ kind: 'text', text: body, quoted });
      let n = 0;
      for (const c of cards) {
        const lines: string[] = [];
        if (c.type === 'cta_url' || c.action?.name === 'cta_url') {
          const p = c.action?.parameters ?? {};
          lines.push(`🔗 ${p.display_text ?? 'Abrir'}: ${p.url ?? ''}`);
        } else {
          for (const b of (c.action?.buttons ?? []) as any[]) lines.push(`${numLabel(++n)} ${b.quick_reply?.title ?? b.title ?? ''}`);
        }
        const caption = [String(c.body?.text ?? ''), lines.join('\n')].filter(Boolean).join('\n\n');
        const h = c.header?.image ?? c.header?.video;
        const media = c.header?.type === 'video' ? 'video' : 'image';
        if (h?.link || h?.id) ops.push({ kind: 'media', media, link: h.link, id: h.id, caption });
        else ops.push({ kind: 'text', text: caption });
      }
      if (n) ops.push({ kind: 'text', text: '_Responda com o número da opção._' });
      return ops;
    }
    default:
      return body ? [{ kind: 'text', text: body, quoted }] : [];
  }
}
