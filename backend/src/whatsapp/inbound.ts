/** Conteúdo de uma mensagem recebida da Cloud API (sem dependências: usado nos testes). */
export type InType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location' | 'contacts' | 'unsupported';

export interface Extracted {
  body: string | null; replyId: string | null; mediaType: InType;
  media?: { id: string; mime: string | null; filename: string | null } | null; silent?: boolean;
}

export function extractContent(m: any): Extracted {
  const type = String(m.type ?? 'text');
  switch (type) {
    case 'text': return { body: m.text?.body ?? null, replyId: null, mediaType: 'text' };
    case 'button': return { body: m.button?.text ?? null, replyId: m.button?.payload ?? null, mediaType: 'text' };
    case 'interactive': {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply ?? null;
      return { body: r?.title ?? null, replyId: r?.id ?? null, mediaType: 'text' };
    }
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': {
      const x = m[type] ?? {};
      return {
        body: x.caption ?? null, replyId: null, mediaType: type,
        media: x.id ? { id: String(x.id), mime: x.mime_type ?? null, filename: x.filename ?? null } : null,
      };
    }
    case 'location': {
      const l = m.location ?? {};
      const label = [l.name, l.address].filter(Boolean).join(' — ');
      return { body: `${label ? `${label}\n` : ''}https://maps.google.com/?q=${l.latitude},${l.longitude}`, replyId: null, mediaType: 'location' };
    }
    case 'contacts': {
      const list = (m.contacts ?? []).map((c: any) => `${c.name?.formatted_name ?? 'Contato'}${c.phones?.[0]?.phone ? ` · ${c.phones[0].phone}` : ''}`);
      return { body: list.join('\n') || 'Contato compartilhado', replyId: null, mediaType: 'contacts' };
    }
    case 'reaction':
      return { body: m.reaction?.emoji ? `Reagiu com ${m.reaction.emoji}` : 'Removeu a reação', replyId: null, mediaType: 'text', silent: true };
    default:
      return { body: 'Mensagem não suportada pelo WhatsApp Cloud API (ex.: enquete ou mensagem de visualização única).', replyId: null, mediaType: 'unsupported', silent: true };
  }
}
