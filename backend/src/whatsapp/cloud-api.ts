import { config } from '../config';

export interface WaConnection {
  phoneNumberId: string | null;
  accessToken: string | null;
}

export interface SendResult {
  waMessageId: string | null;
  raw: unknown;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/**
 * Envia uma mensagem via WhatsApp Cloud API (Graph API da Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 * Obs.: mensagens livres (texto, mídia, botões) só podem ser enviadas até 24h
 * depois da última mensagem do cliente.
 */
async function post(conn: WaConnection, payload: Record<string, unknown>): Promise<SendResult> {
  if (!conn.phoneNumberId || !conn.accessToken) {
    throw new Error('Conexão sem phoneNumberId/accessToken configurados');
  }
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${conn.phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (raw as { error?: { message?: string } })?.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Falha ao enviar WhatsApp: ${msg}`);
  }
  const waMessageId = (raw as { messages?: Array<{ id: string }> })?.messages?.[0]?.id ?? null;
  return { waMessageId, raw };
}

export function sendText(conn: WaConnection, to: string, body: string): Promise<SendResult> {
  return post(conn, { to, type: 'text', text: { preview_url: true, body } });
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
