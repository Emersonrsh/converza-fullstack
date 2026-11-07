/**
 * Saúde da conexão (puro, testável): transforma a resposta da Meta no status do Converza
 * e em avisos claros para a pessoa (qualidade, nome, webhooks, coexistência).
 */
import type { PhoneHealth } from './graph';

export type ConnStatus = 'connected' | 'disconnected' | 'pending';

const PHONE_STATUS_MSG: Record<string, string> = {
  PENDING: 'O número ainda não terminou o registro na Cloud API.',
  DISCONNECTED: 'A Meta informou que o número está desconectado da Cloud API.',
  BANNED: 'O número foi banido pelo WhatsApp.',
  DELETED: 'O número foi removido da conta do WhatsApp Business.',
  MIGRATED: 'O número foi migrado para outra conta do WhatsApp Business.',
  UNVERIFIED: 'O número ainda não foi verificado na Meta.',
};
const WORKING = new Set(['CONNECTED', 'FLAGGED', 'RESTRICTED', 'RATE_LIMITED']);

export interface HealthPatch {
  status: ConnStatus;
  lastError: string | null;
  displayPhone?: string;
  verifiedName: string | null;
  nameStatus: string | null;
  qualityRating: string | null;
  messagingLimit: string | null;
  phoneStatus: string | null;
  throughput: string | null;
  codeVerification: string | null;
  coexistence?: boolean;
}

/** Resposta da Meta → campos da conexão. */
export function healthPatch(h: PhoneHealth): HealthPatch {
  const ps = String(h.status ?? '').toUpperCase();
  const status: ConnStatus = !ps || WORKING.has(ps) ? 'connected' : ps === 'PENDING' ? 'pending' : 'disconnected';
  return {
    status,
    lastError: status === 'connected' ? null : PHONE_STATUS_MSG[ps] ?? `A Meta informou o status “${ps}”.`,
    ...(h.display_phone_number ? { displayPhone: h.display_phone_number } : {}),
    verifiedName: h.verified_name ?? null,
    nameStatus: h.name_status ?? null,
    qualityRating: h.quality_rating ?? null,
    messagingLimit: h.messaging_limit_tier ?? null,
    phoneStatus: ps || null,
    throughput: h.throughput?.level ?? null,
    codeVerification: h.code_verification_status ?? null,
    ...(typeof h.is_on_biz_app === 'boolean' ? { coexistence: h.is_on_biz_app } : {}),
  };
}

/** Erro ao consultar a Meta → o que muda na conexão (falta de internet não derruba o status). */
export function errorPatch(e: { code?: number | null; message: string }): { status?: ConnStatus; lastError: string } {
  const code = e.code ?? null;
  if (code === 190) return { status: 'disconnected', lastError: 'O token expirou ou foi revogado. Reconecte o número.' };
  if (code === 100) return { status: 'disconnected', lastError: 'O token não tem acesso a esse número (Phone Number ID errado ou sem permissão).' };
  if (code === 10 || code === 200) return { status: 'disconnected', lastError: 'O app não tem permissão para esta conta do WhatsApp.' };
  if (code === 368 || code === 131031) return { status: 'disconnected', lastError: e.message };
  if (code === 133010) return { status: 'pending', lastError: e.message };
  return { lastError: e.message };
}

/** Limite de conversas que a empresa pode INICIAR por dia (o cliente que escreve primeiro não conta). */
export const LIMIT_LABEL: Record<string, string> = {
  TIER_50: '50 conversas/dia', TIER_250: '250 conversas/dia', TIER_1K: '1.000 conversas/dia', TIER_2K: '2.000 conversas/dia',
  TIER_10K: '10.000 conversas/dia', TIER_100K: '100.000 conversas/dia', TIER_UNLIMITED: 'Conversas ilimitadas',
};
export const QUALITY_LABEL: Record<string, string> = { GREEN: 'Alta', YELLOW: 'Média', RED: 'Baixa', NA: 'Ainda sem nota', UNKNOWN: 'Ainda sem nota' };
export const NAME_STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Aprovado', AVAILABLE_WITHOUT_REVIEW: 'Liberado', PENDING_REVIEW: 'Em análise', DECLINED: 'Recusado', EXPIRED: 'Expirado', NONE: 'Não enviado',
};

export interface WarnInput {
  status: string; qualityRating: string | null; nameStatus: string | null; webhookSubscribed: boolean | null;
  coexistence: boolean; syncRequestedAt: Date | string | null; historyProgress: number | null; lastInboundAt: Date | string | null;
  /** quando foi conectado (ou reconectado pela Meta) */
  onboardedAt: Date | string;
}

/** Avisos para mostrar no card/detalhe da conexão. */
export function warningsOf(c: WarnInput, now = Date.now()): string[] {
  const w: string[] = [];
  if (c.status !== 'connected') return w; // o erro principal já aparece
  if (c.qualityRating === 'RED') w.push('Qualidade baixa: muitos clientes bloquearam ou denunciaram. Reduza envios em massa para não perder o número.');
  else if (c.qualityRating === 'YELLOW') w.push('Qualidade média: atenção às denúncias e bloqueios dos clientes.');
  if (c.nameStatus === 'DECLINED') w.push('O nome de exibição foi recusado pela Meta — ajuste no Gerenciador do WhatsApp.');
  if (c.nameStatus === 'PENDING_REVIEW') w.push('O nome de exibição está em análise na Meta.');
  if (c.webhookSubscribed === false) w.push('O app não está inscrito para receber as mensagens deste número. Clique em “Receber mensagens”.');
  const ageH = (now - new Date(c.onboardedAt).getTime()) / 3600_000;
  // a Meta só entrega contatos/histórico se o pedido for feito em até 24h depois de conectar
  if (c.coexistence && !c.syncRequestedAt && ageH <= 24) w.push('Falta pedir a sincronização dos contatos e do histórico do celular (prazo de 24h após conectar).');
  if (!c.lastInboundAt && ageH > 24) w.push('Nenhuma mensagem recebida ainda. Confira se o webhook está configurado na Meta.');
  return w;
}
