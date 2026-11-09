import { schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { LIMIT_LABEL, NAME_STATUS_LABEL, QUALITY_LABEL, warningsOf } from '../whatsapp/health';

/** Formato público da conexão (nunca expõe o token, a chave secreta nem o PIN). */
export type ConnRow = typeof schema.connections.$inferSelect;

export function publicConnection(c: ConnRow) {
  return {
    id: c.id, name: c.name, displayPhone: c.displayPhone, phoneNumberId: c.phoneNumberId, wabaId: c.wabaId,
    status: c.status, source: c.source, verifiedName: c.verifiedName, nameStatus: c.nameStatus, qualityRating: c.qualityRating,
    messagingLimit: c.messagingLimit, phoneStatus: c.phoneStatus, throughput: c.throughput, codeVerification: c.codeVerification,
    coexistence: c.coexistence, webhookSubscribed: c.webhookSubscribed, lastCheckedAt: c.lastCheckedAt, lastError: c.lastError,
    lastInboundAt: c.lastInboundAt, syncRequestedAt: c.syncRequestedAt, historyProgress: c.historyProgress, createdAt: c.createdAt, onboardedAt: c.onboardedAt,
    hasToken: !!c.accessToken, hasAppSecret: !!c.appSecret, hasPin: !!c.pin,
    /** cloud = API oficial da Meta | web = QR Code (API não oficial) */
    provider: c.provider, webState: c.webState,
    warnings: warningsOf(c),
    labels: {
      quality: c.qualityRating ? QUALITY_LABEL[c.qualityRating] ?? c.qualityRating : null,
      limit: c.messagingLimit ? LIMIT_LABEL[c.messagingLimit] ?? c.messagingLimit : null,
      name: c.nameStatus ? NAME_STATUS_LABEL[c.nameStatus] ?? c.nameStatus : null,
    },
  };
}

/** Avisa as telas abertas da conta (página Conexões) que a conexão mudou. */
export function emitConnection(c: ConnRow) {
  emitToAccount(c.accountId, 'connection:updated', { connection: publicConnection(c) });
}
