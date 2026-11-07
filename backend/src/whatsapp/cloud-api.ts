import { sql } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';

export interface WaConnection {
  phoneNumberId: string | null;
  accessToken: string | null;
}

export interface SendResult {
  waMessageId: string | null;
  /** wa_id "oficial" que o WhatsApp atribuiu ao número (ex.: celular antigo sem o 9). */
  waId: string | null;
  raw: unknown;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/** Como o WhatsApp trata o arquivo: imagem (JPEG/PNG), vídeo (MP4/3GP), áudio ou documento (o resto). */
export function mediaKind(mime: string): MediaKind {
  if (/^image\/(jpeg|png)$/i.test(mime)) return 'image';
  if (/^video\/(mp4|3gpp)$/i.test(mime)) return 'video';
  if (/^audio\/(aac|mp4|mpeg|amr|ogg)/i.test(mime)) return 'audio';
  return 'document';
}

/** Erro da Cloud API com uma mensagem em português para mostrar no app. */
export class WhatsAppError extends Error {
  code: number | null;
  constructor(message: string, code: number | null = null) { super(message); this.code = code; }
}

const ERRORS: Record<number, string> = {
  131047: 'Fora da janela de 24h: o cliente não fala com você há mais de 24 horas. Envie um modelo de mensagem aprovado.',
  470: 'Fora da janela de 24h: envie um modelo de mensagem aprovado.',
  131026: 'Não foi possível entregar: o número pode não ter WhatsApp ou não aceitou os termos atuais.',
  131051: 'Tipo de mensagem não suportado pelo WhatsApp.',
  131053: 'O WhatsApp não aceitou o arquivo (formato ou tamanho).',
  131056: 'Muitas mensagens para este número em pouco tempo. Aguarde um pouco.',
  132000: 'O número de variáveis não bate com o modelo de mensagem.',
  132001: 'Modelo de mensagem não encontrado ou não aprovado neste idioma.',
  131031: 'A conta do WhatsApp Business está bloqueada.',
  190: 'O token da conexão expirou. Reconecte o número em Conexões.',
  10: 'O app não tem permissão para esta conta do WhatsApp.',
  200: 'O app não tem permissão para esta conta do WhatsApp.',
  100: 'Parâmetro inválido enviado ao WhatsApp.',
  368: 'A conta está temporariamente bloqueada pela Meta por violação de políticas.',
  131000: 'A Meta teve um erro ao processar. Tente de novo em instantes.',
  131030: 'Número de teste: o destino precisa estar na lista de números permitidos da Meta.',
  133005: 'O PIN de verificação em duas etapas não confere. Use o PIN que já está definido para esse número.',
  133006: 'O número precisa ser verificado na Meta (código por SMS ou ligação) antes de registrar.',
  133008: 'Muitas tentativas de PIN. Aguarde algumas horas e tente de novo.',
  133009: 'PIN digitado rápido demais. Aguarde um pouco e tente de novo.',
  133010: 'O número não está registrado na Cloud API. Registre o número em Conexões.',
  133016: 'Muitas tentativas de registrar este número. Aguarde e tente de novo.',
};

/** Erros que indicam que a conexão parou de funcionar (token, bloqueio, registro). */
export const CONNECTION_DOWN_CODES = new Set([190, 10, 200, 368, 131031, 133010]);
type ConnectionIssue = (phoneNumberId: string, message: string, code: number | null) => void;
let connectionIssue: ConnectionIssue | null = null;
/** Quem quiser saber quando um envio falha por problema da conexão (o módulo de Conexões marca como desconectada). */
export function onConnectionIssue(fn: ConnectionIssue) { connectionIssue = fn; }
function reportIssue(conn: { phoneNumberId: string | null }, e: WhatsAppError) {
  if (conn.phoneNumberId && e.code !== null && CONNECTION_DOWN_CODES.has(e.code)) {
    try { connectionIssue?.(conn.phoneNumberId, e.message, e.code); } catch { /* não atrapalha o envio */ }
  }
}

export function friendlyWaError(raw: unknown, status?: number): WhatsAppError {
  const e = (raw as { error?: { message?: string; code?: number; error_data?: { details?: string } } })?.error;
  const code = typeof e?.code === 'number' ? e.code : null;
  const msg = (code !== null && ERRORS[code]) || e?.error_data?.details || e?.message || `HTTP ${status ?? '?'}`;
  return new WhatsAppError(msg, code);
}

/**
 * Cada instância contratada é um número: sem assinatura ativa, os números param de enviar
 * (o que os clientes mandam continua chegando no Chats ao vivo). Guarda a resposta por 3 s para envios em sequência.
 */
const allowCache = new Map<string, { at: number; ok: boolean }>();
async function sendingAllowed(phoneNumberId: string): Promise<boolean> {
  const hit = allowCache.get(phoneNumberId);
  if (hit && Date.now() - hit.at < 3000) return hit.ok;
  const r = await db.execute(sql`
    select s.status from connections c left join subscriptions s on s.account_id = c.account_id
    where c.phone_number_id = ${phoneNumberId} limit 1`);
  const row = r.rows[0] as { status?: string | null } | undefined;
  // número que ainda não é uma conexão salva (ex.: teste durante o cadastro): não há assinatura para conferir
  const ok = !row || row.status === 'active';
  allowCache.set(phoneNumberId, { at: Date.now(), ok });
  return ok;
}

const graph = (path: string) => `${config.whatsapp.graphBase}/${config.whatsapp.graphVersion}/${path.replace(/^\/+/, '')}`;

/**
 * Envia uma mensagem via WhatsApp Cloud API (Graph API da Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 * Obs.: mensagens livres (texto, mídia, botões) só podem ser enviadas até 24h
 * depois da última mensagem do cliente; fora disso, só modelos aprovados.
 */
async function post(conn: WaConnection, payload: Record<string, unknown>): Promise<SendResult> {
  if (!conn.phoneNumberId || !conn.accessToken) {
    throw new WhatsAppError('Conexão sem número/token configurados. Verifique em Conexões.');
  }
  if (!(await sendingAllowed(conn.phoneNumberId))) {
    throw new WhatsAppError('A assinatura da conta não está ativa: os números não enviam mensagens até ela ser regularizada em Cobranças e assinaturas. As mensagens recebidas continuam chegando.');
  }
  let resp: Response;
  try {
    resp = await fetch(graph(`${conn.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new WhatsAppError(`Sem conexão com o WhatsApp (${(err as Error).message}). Tente de novo.`);
  }
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) { const e = friendlyWaError(raw, resp.status); reportIssue(conn, e); throw e; }
  const r = raw as { messages?: Array<{ id: string }>; contacts?: Array<{ wa_id?: string }> };
  const waMessageId = r?.messages?.[0]?.id ?? null;
  const waId = r?.contacts?.[0]?.wa_id ? String(r.contacts[0].wa_id).replace(/\D/g, '') || null : null;
  return { waMessageId, waId, raw };
}

/** `contextId`: wamid da mensagem citada (aparece como "resposta" no WhatsApp do cliente). */
const ctx = (contextId?: string | null) => (contextId ? { context: { message_id: contextId } } : {});

export function sendText(conn: WaConnection, to: string, body: string, contextId?: string | null): Promise<SendResult> {
  return post(conn, { to, type: 'text', text: { preview_url: true, body }, ...ctx(contextId) });
}

export function sendMedia(conn: WaConnection, to: string, kind: MediaKind, link: string, caption?: string, filename?: string): Promise<SendResult> {
  const media: Record<string, unknown> = { link };
  if (caption && kind !== 'audio') media.caption = caption;
  if (kind === 'document' && filename) media.filename = filename;
  return post(conn, { to, type: kind, [kind]: media });
}

/** Até 3 botões de resposta rápida (título até 20 caracteres). */
export function sendButtons(conn: WaConnection, to: string, body: string, buttons: { id: string; title: string }[]): Promise<SendResult> {
  return post(conn, {
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) || 'Escolha uma opção:' },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
      },
    },
  });
}

/** Lista com até 10 opções (título até 24 caracteres). */
export function sendList(
  conn: WaConnection, to: string, body: string, buttonLabel: string,
  rows: { id: string; title: string; description?: string }[],
): Promise<SendResult> {
  return post(conn, {
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body.slice(0, 4096) || 'Escolha uma opção:' },
      action: {
        button: (buttonLabel || 'Ver opções').slice(0, 20),
        sections: [{
          title: 'Opções',
          rows: rows.slice(0, 10).map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, 24),
            ...(r.description ? { description: r.description.slice(0, 72) } : {}),
          })),
        }],
      },
    },
  });
}

/** Envia mídia já hospedada na Meta (ID retornado pelo upload). `voice`: áudio Ogg/Opus vira mensagem de voz. */
export function sendMediaId(
  conn: WaConnection, to: string, kind: MediaKind, mediaId: string, caption?: string, filename?: string,
  opts: { voice?: boolean; contextId?: string | null } = {},
): Promise<SendResult> {
  const media: Record<string, unknown> = { id: mediaId };
  if (caption && kind !== 'audio') media.caption = caption;
  if (kind === 'document' && filename) media.filename = filename;
  if (kind === 'audio' && opts.voice) media.voice = true;
  return post(conn, { to, type: kind, [kind]: media, ...ctx(opts.contextId) });
}

/** Figurinha (WEBP 512×512) já enviada para a Meta. */
export function sendSticker(conn: WaConnection, to: string, mediaId: string): Promise<SendResult> {
  return post(conn, { to, type: 'sticker', sticker: { id: mediaId } });
}

/** Sobe um arquivo para a Meta e devolve o ID da mídia (válido por ~30 dias). */
export async function uploadMedia(conn: WaConnection, data: Buffer, mime: string, filename: string): Promise<string> {
  if (!conn.phoneNumberId || !conn.accessToken) throw new WhatsAppError('Conexão sem número/token configurados.');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([data], { type: mime }), filename);
  let resp: Response;
  try {
    resp = await fetch(graph(`${conn.phoneNumberId}/media`), {
      method: 'POST', headers: { Authorization: `Bearer ${conn.accessToken}` }, body: form, signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new WhatsAppError(`Sem conexão com o WhatsApp (${(err as Error).message}).`);
  }
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) { const e = friendlyWaError(raw, resp.status); reportIssue(conn, e); throw e; }
  const id = (raw as { id?: string }).id;
  if (!id) throw new WhatsAppError('O WhatsApp não devolveu o ID do arquivo.');
  return id;
}

/** Baixa uma mídia (recebida ou enviada) pelo ID. */
export async function downloadMedia(accessToken: string, mediaId: string): Promise<{ data: Buffer; mime: string }> {
  const meta = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  const info = await meta.json().catch(() => ({})) as { url?: string; mime_type?: string };
  if (!meta.ok || !info.url) throw friendlyWaError(info, meta.status);
  const file = await fetch(info.url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(60_000) });
  if (!file.ok) throw new WhatsAppError(`Não foi possível baixar a mídia (HTTP ${file.status}).`);
  return { data: Buffer.from(await file.arrayBuffer()), mime: info.mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Valores para enviar um modelo aprovado (cabeçalho, corpo e botões com variáveis). */
export interface TemplateSend {
  name: string;
  language: string;
  /** variáveis do corpo, na ordem; `name` só para modelos com variáveis nomeadas ({{nome_cliente}}) */
  body?: { name?: string; value: string }[];
  header?: { type: 'text'; name?: string; value: string } | { type: 'image' | 'video' | 'document'; link: string; filename?: string };
  /** botões com parte variável: final do link (url) ou código do cupom (copy_code) */
  buttons?: { index: number; subType: 'url' | 'copy_code'; value: string }[];
}

export function templateComponents(t: TemplateSend): Record<string, unknown>[] {
  const comps: Record<string, unknown>[] = [];
  const h = t.header;
  if (h?.type === 'text') {
    comps.push({ type: 'header', parameters: [{ type: 'text', text: h.value, ...(h.name ? { parameter_name: h.name } : {}) }] });
  } else if (h) {
    const media: Record<string, unknown> = { link: h.link };
    if (h.type === 'document' && h.filename) media.filename = h.filename;
    comps.push({ type: 'header', parameters: [{ type: h.type, [h.type]: media }] });
  }
  if (t.body?.length) {
    comps.push({ type: 'body', parameters: t.body.map((p) => ({ type: 'text', text: p.value, ...(p.name ? { parameter_name: p.name } : {}) })) });
  }
  for (const b of t.buttons ?? []) {
    comps.push({
      type: 'button', sub_type: b.subType, index: String(b.index),
      parameters: [b.subType === 'copy_code' ? { type: 'coupon_code', coupon_code: b.value } : { type: 'text', text: b.value }],
    });
  }
  return comps;
}

/** Modelo de mensagem aprovado (necessário para falar fora da janela de 24h e para iniciar conversas). */
export function sendTemplate(conn: WaConnection, to: string, t: TemplateSend): Promise<SendResult> {
  const components = templateComponents(t);
  return post(conn, {
    to,
    type: 'template',
    template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
  });
}

/** Marca a mensagem do cliente como lida (tique azul no WhatsApp dele). */
export async function markRead(conn: WaConnection, waMessageId: string): Promise<void> {
  if (!conn.phoneNumberId || !conn.accessToken) return;
  await fetch(graph(`${conn.phoneNumberId}/messages`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => undefined);
}

export interface TemplateButton { type: string; text: string; url: string | null; hasVar: boolean; example: string | null }
export interface TemplateInfo {
  name: string; language: string; category: string; status: string;
  /** "positional" = {{1}}, {{2}}…; "named" = {{nome_cliente}} */
  paramFormat: 'positional' | 'named';
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string | null; vars: string[]; example: string | null } | null;
  body: string; bodyVars: string[]; bodyExamples: string[];
  footer: string | null;
  buttons: TemplateButton[];
}

/** Variáveis na ordem em que aparecem ({{1}} {{2}} ou {{nome}}), sem repetir. */
export function templateVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out.every((v) => /^\d+$/.test(v)) ? out.sort((a, b) => Number(a) - Number(b)) : out;
}

export function parseTemplate(t: any): TemplateInfo {
  const comp = (type: string) => (t.components ?? []).find((c: any) => String(c.type).toUpperCase() === type);
  const bodyC = comp('BODY');
  const body = String(bodyC?.text ?? '');
  const bodyVars = templateVars(body);
  const named = t.parameter_format === 'NAMED' || bodyVars.some((v) => !/^\d+$/.test(v));
  const ex = bodyC?.example ?? {};
  const bodyExamples: string[] = named
    ? bodyVars.map((v) => String((ex.body_text_named_params ?? []).find((p: any) => p.param_name === v)?.example ?? ''))
    : (ex.body_text?.[0] ?? []).map((x: unknown) => String(x));
  const h = comp('HEADER');
  const format = h ? String(h.format ?? 'TEXT').toUpperCase() as NonNullable<TemplateInfo['header']>['format'] : null;
  const header = h && format ? {
    format,
    text: format === 'TEXT' ? String(h.text ?? '') : null,
    vars: format === 'TEXT' ? templateVars(String(h.text ?? '')) : [],
    example: format === 'TEXT'
      ? (h.example?.header_text?.[0] ?? h.example?.header_text_named_params?.[0]?.example ?? null)
      : (h.example?.header_handle?.[0] ?? null),
  } : null;
  const buttons: TemplateButton[] = (comp('BUTTONS')?.buttons ?? []).map((b: any) => {
    const type = String(b.type ?? '').toUpperCase();
    const url = b.url ? String(b.url) : null;
    return {
      type, text: String(b.text ?? (type === 'COPY_CODE' ? 'Copiar código' : '')), url,
      hasVar: (type === 'URL' && !!url && /\{\{/.test(url)) || type === 'COPY_CODE',
      example: Array.isArray(b.example) ? String(b.example[0] ?? '') : b.example ? String(b.example) : null,
    };
  });
  return {
    name: String(t.name), language: String(t.language), category: String(t.category ?? ''), status: String(t.status),
    paramFormat: named ? 'named' : 'positional', header, body, bodyVars, bodyExamples,
    footer: comp('FOOTER')?.text ? String(comp('FOOTER').text) : null, buttons,
  };
}

/** Todos os modelos da WABA (aprovados, em análise, recusados, pausados…), para a tela de Templates. */
export interface ManagedTemplate extends TemplateInfo { id: string; rejectedReason: string | null; quality: string | null }
export async function listAllTemplates(accessToken: string, wabaId: string): Promise<ManagedTemplate[]> {
  let url: string | null = graph(`${wabaId}/message_templates?fields=id,name,language,status,category,components,parameter_format,rejected_reason,quality_score&limit=200`);
  const all: any[] = [];
  for (let page = 0; url && page < 10; page++) {
    const resp: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const raw = await resp.json().catch(() => ({})) as { data?: any[]; paging?: { next?: string } };
    if (!resp.ok) throw friendlyWaError(raw, resp.status);
    all.push(...(raw.data ?? []));
    url = raw.paging?.next ?? null;
  }
  return all.map((t) => ({
    ...parseTemplate(t), id: String(t.id ?? ''),
    rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null,
    quality: t.quality_score?.score ? String(t.quality_score.score) : null,
  })).sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

/** Manda um modelo novo para a Meta analisar (volta como PENDING, APPROVED ou REJECTED). */
export async function createTemplate(accessToken: string, wabaId: string, payload: Record<string, unknown>) {
  const resp = await fetch(graph(`${wabaId}/message_templates`), {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
  }).catch((err) => { throw new WhatsAppError(`Sem conexão com a Meta (${(err as Error).message}).`); });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) throw templateError(raw, resp.status);
  return raw as { id: string; status: string; category: string };
}

export async function deleteTemplate(accessToken: string, wabaId: string, name: string, id?: string | null) {
  const q = new URLSearchParams({ name, ...(id ? { hsm_id: id } : {}) });
  const resp = await fetch(graph(`${wabaId}/message_templates?${q}`), {
    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
  }).catch((err) => { throw new WhatsAppError(`Sem conexão com a Meta (${(err as Error).message}).`); });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) throw templateError(raw, resp.status);
}

/** Erro da Meta ao criar/apagar modelo, com o detalhe que ela mandou (o motivo costuma estar em error_user_msg). */
function templateError(raw: unknown, status: number) {
  const e = (raw as { error?: { message?: string; error_user_msg?: string; error_user_title?: string; code?: number } })?.error;
  const msg = e?.error_user_msg || e?.error_user_title || e?.message || `HTTP ${status}`;
  return new WhatsAppError(`A Meta recusou: ${msg}`, typeof e?.code === 'number' ? e.code : null);
}

/** ID do app dono do token (o upload de amostra de mídia dos modelos é feito pelo app). */
export async function appIdOf(accessToken: string): Promise<string | null> {
  try {
    const resp = await fetch(graph('app'), { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    const raw = await resp.json().catch(() => ({})) as { id?: string };
    return resp.ok && raw.id ? String(raw.id) : null;
  } catch {
    return null;
  }
}

/** Upload retomável da Meta: devolve o "handle" usado como exemplo do cabeçalho de mídia do modelo. */
export async function uploadTemplateSample(accessToken: string, appId: string, data: Buffer, mime: string, fileName: string): Promise<string> {
  const q = new URLSearchParams({ file_name: fileName, file_length: String(data.length), file_type: mime });
  const start = await fetch(graph(`${appId}/uploads?${q}`), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) })
    .catch((err) => { throw new WhatsAppError(`Sem conexão com a Meta (${(err as Error).message}).`); });
  const s1 = await start.json().catch(() => ({})) as { id?: string };
  if (!start.ok || !s1.id) throw templateError(s1, start.status);
  const up = await fetch(graph(s1.id), {
    method: 'POST', headers: { Authorization: `OAuth ${accessToken}`, file_offset: '0' }, body: new Uint8Array(data), signal: AbortSignal.timeout(60_000),
  }).catch((err) => { throw new WhatsAppError(`Sem conexão com a Meta (${(err as Error).message}).`); });
  const s2 = await up.json().catch(() => ({})) as { h?: string };
  if (!up.ok || !s2.h) throw templateError(s2, up.status);
  return s2.h;
}

/** Modelos aprovados da conta do WhatsApp Business (WABA), seguindo a paginação. */
export async function listTemplates(accessToken: string, wabaId: string): Promise<TemplateInfo[]> {
  let url: string | null = graph(`${wabaId}/message_templates?fields=name,language,status,category,components,parameter_format&limit=200`);
  const all: any[] = [];
  for (let page = 0; url && page < 10; page++) {
    const resp: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const raw = await resp.json().catch(() => ({})) as { data?: any[]; paging?: { next?: string } };
    if (!resp.ok) throw friendlyWaError(raw, resp.status);
    all.push(...(raw.data ?? []));
    url = raw.paging?.next ?? null;
  }
  return all.filter((t) => t.status === 'APPROVED').map(parseTemplate)
    .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}
