import { config } from '../config';

export interface WaConnection {
  phoneNumberId: string | null;
  accessToken: string | null;
}

export interface SendResult {
  waMessageId: string | null;
  raw: unknown;
}

/**
 * Envia uma mensagem de texto via WhatsApp Cloud API (Graph API da Meta).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export async function sendText(conn: WaConnection, toWaId: string, body: string): Promise<SendResult> {
  if (!conn.phoneNumberId || !conn.accessToken) {
    throw new Error('Conexão sem phoneNumberId/accessToken configurados');
  }
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${conn.phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'text',
      text: { preview_url: true, body },
    }),
  });

  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (raw as { error?: { message?: string } })?.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Falha ao enviar WhatsApp: ${msg}`);
  }
  const waMessageId = (raw as { messages?: Array<{ id: string }> })?.messages?.[0]?.id ?? null;
  return { waMessageId, raw };
}
