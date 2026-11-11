/**
 * Controle do celular simulado (só existe com WA_WEB_DRIVER=mock e fora de produção): os testes automáticos
 * "leem o QR", mandam mensagens como se fossem clientes, mudam status e derrubam a conexão.
 */
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { asyncHandler, AppError } from '../../utils/http';
import { mock } from './driver';

export const waMockRouter = Router();

const id = () => `MOCKIN${randomBytes(6).toString('hex').toUpperCase()}`;

waMockRouter.post('/reset', (_req, res) => {
  mock.rejectInteractive = false;
  mock.failSends = false;
  mock.sent.length = 0;
  mock.missing.clear();
  mock.media.clear();
  mock.autoDeliver = true;
  res.json({ ok: true });
});

waMockRouter.post('/missing', (req, res) => {
  const d = String(req.body?.phone ?? '').replace(/\D/g, '');
  if (d) mock.missing.add(d);
  res.json({ ok: true });
});

waMockRouter.post('/reject-interactive', (req, res) => {
  mock.rejectInteractive = !!req.body?.on;
  res.json({ ok: true });
});

waMockRouter.post('/fail-sends', (req, res) => {
  mock.failSends = !!req.body?.on;
  res.json({ ok: true });
});

waMockRouter.post('/auto-deliver', (req, res) => {
  mock.autoDeliver = req.body?.on !== false;
  res.json({ ok: true });
});

waMockRouter.get('/sent', (req, res) => {
  const cid = typeof req.query.connectionId === 'string' ? req.query.connectionId : null;
  res.json({ sent: mock.sent.filter((s) => !cid || s.connectionId === cid).map((s) => ({ ...s, content: summarize(s.content) })) });
});

/** Buffers viram só o tamanho (a resposta fica legível nos testes). */
function summarize(c: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(c)) out[k] = Buffer.isBuffer(v) ? { bytes: v.length } : v;
  return out;
}

waMockRouter.get('/sessions', (_req, res) => {
  res.json({ sessions: [...mock.sockets.entries()].map(([k, v]) => ({ connectionId: k, open: v.open, me: v.me, qrs: v.qrs })) });
});

waMockRouter.post('/:connectionId/scan', asyncHandler(async (req, res) => {
  const phone = String(req.body?.phone ?? '5511988887777');
  await mock.scan(req.params.connectionId, phone, String(req.body?.name ?? 'Loja Teste'));
  res.json({ ok: true });
}));

waMockRouter.post('/:connectionId/drop', (req, res) => {
  mock.drop(req.params.connectionId, Number(req.body?.code ?? 428));
  res.json({ ok: true });
});

waMockRouter.post('/:connectionId/status', (req, res) => {
  const b = req.body ?? {};
  mock.status(req.params.connectionId, String(b.id), `${String(b.to ?? '').replace(/\D/g, '')}@s.whatsapp.net`, Number(b.status ?? 4));
  res.json({ ok: true });
});

/**
 * Mensagem do cliente (ou do próprio celular, com fromMe). Campos: from, text, name, quotedId, lid (número oculto),
 * media: { type: image|audio|video|document|sticker, base64, mime, fileName, caption, ptt, size }, viewOnce, poll, pollVote { pollId, option }.
 */
waMockRouter.post('/:connectionId/inbound', asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const from = String(b.from ?? '').replace(/\D/g, '');
  if (!from && !b.lid) throw new AppError(422, 'from ou lid');
  const msgId = String(b.id ?? id());
  const key: Record<string, unknown> = b.lid
    ? { remoteJid: `${String(b.lid).replace(/\D/g, '')}@lid`, ...(from ? { remoteJidAlt: `${from}@s.whatsapp.net` } : {}), id: msgId, fromMe: !!b.fromMe }
    : { remoteJid: b.group ? `${from}-123@g.us` : `${from}@s.whatsapp.net`, id: msgId, fromMe: !!b.fromMe };
  const ctx = b.quotedId ? { contextInfo: { stanzaId: String(b.quotedId) } } : {};
  let message: Record<string, unknown>;
  if (b.media) {
    const m = b.media;
    const data = Buffer.from(String(m.base64 ?? ''), 'base64');
    mock.media.set(msgId, data);
    const field = `${m.type}Message`;
    message = { [field]: { mimetype: m.mime, caption: m.caption, fileName: m.fileName, ptt: !!m.ptt, fileLength: m.size ?? data.length, ...(b.viewOnce ? { viewOnce: true } : {}), ...ctx } };
  } else if (b.interactiveReply) {
    // cliente tocou num botão/linha do menu clicável
    const r = b.interactiveReply;
    message = { interactiveResponseMessage: { body: { text: String(r.title ?? '') }, nativeFlowResponseMessage: { name: r.list ? 'single_select' : 'quick_reply', paramsJson: JSON.stringify(r.list ? { selected_row_id: r.id } : { id: r.id }), version: 3 } } };
  } else if (b.pollVote) {
    // cliente votou numa enquete (menu): { pollId, option }
    message = { pollUpdateMessage: { pollCreationMessageKey: { id: String(b.pollVote.pollId), remoteJid: key.remoteJid, fromMe: true }, vote: { encPayload: String(b.pollVote.option ?? ''), encIv: '' }, senderTimestampMs: Date.now() } };
  } else if (b.poll) {
    message = { pollCreationMessage: { name: String(b.poll), options: [{ optionName: 'A' }, { optionName: 'B' }] } };
  } else if (b.reaction) {
    message = { reactionMessage: { key: { id: String(b.reaction.id) }, text: String(b.reaction.emoji ?? '') } };
  } else if (b.location) {
    message = { locationMessage: { degreesLatitude: b.location.lat, degreesLongitude: b.location.lng, name: b.location.name } };
  } else {
    message = b.quotedId ? { extendedTextMessage: { text: String(b.text ?? ''), ...ctx } } : { conversation: String(b.text ?? '') };
  }
  const ts = b.timestamp ? Number(b.timestamp) : Math.floor(Date.now() / 1000);
  mock.emit(req.params.connectionId, [{ key, message, messageTimestamp: ts, pushName: b.name ?? undefined }], b.offline ? 'append' : 'notify');
  res.json({ ok: true, id: msgId });
}));
