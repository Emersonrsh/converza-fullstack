export type ConnStatus = 'connected' | 'disconnected' | 'pending';
export type ConnSource = 'manual' | 'embedded' | 'coexistence' | 'web';
/** QR Code: estado da sessão do WhatsApp Web */
export type WebState = 'starting' | 'qr' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'qr_expired' | 'replaced';

export interface ConnectionFull {
  id: string; name: string; displayPhone: string | null; phoneNumberId: string | null; wabaId: string | null;
  status: ConnStatus; source: ConnSource; verifiedName: string | null; nameStatus: string | null; qualityRating: string | null;
  messagingLimit: string | null; phoneStatus: string | null; throughput: string | null; codeVerification: string | null;
  coexistence: boolean; webhookSubscribed: boolean | null; lastCheckedAt: string | null; lastError: string | null;
  lastInboundAt: string | null; syncRequestedAt: string | null; historyProgress: number | null; createdAt: string; onboardedAt: string;
  hasToken: boolean; hasAppSecret: boolean; hasPin: boolean;
  /** cloud = API oficial da Meta | web = QR Code (API não oficial) */
  provider: 'cloud' | 'web'; webState: WebState | null;
  warnings: string[];
  labels: { quality: string | null; limit: string | null; name: string | null };
  conversations?: number;
  pin?: string | null;
}

export interface ConnPlan { active: boolean; status: string; instances: number; scheduledInstances: number | null; max: number | null; used: number }
export interface SignupConfig { configured: boolean; appId: string; configId: string; graphVersion: string }
export interface WebhookInfo { url: string; verifyToken: string; signatureCheck: boolean }

export interface QrCodeInfo {
  enabled: boolean; simulator: boolean;
  dispatch: { minGapSec: number; maxGapSec: number; dailyLimit: number };
}

export interface ConnListResp {
  connections: ConnectionFull[];
  counts: { connected: number; disconnected: number };
  plan: ConnPlan;
  signup: SignupConfig;
  webhook: WebhookInfo | null;
  qrCode?: QrCodeInfo;
}

/** GET /connections/:id/web */
export interface WebStatusResp {
  connection: ConnectionFull;
  running: boolean; qr: string | null; pairingCode: string | null; qrState: WebState | null; attempt: number; maxAttempts: number;
}

export const WEB_STATE_LABEL: Record<WebState, string> = {
  starting: 'Preparando…', qr: 'Esperando a leitura do QR Code', connecting: 'Conectando…', open: 'Conectado',
  closed: 'Sem conexão com o WhatsApp', logged_out: 'Desconectado', qr_expired: 'QR Code expirado', replaced: 'Aberto em outro lugar',
};

export interface ConnDetailResp {
  connection: ConnectionFull;
  stats: { conversations: number; inbound30: number; outbound30: number };
  agents: { id: string; name: string; enabled: boolean; exclusive: boolean }[];
}

export interface BusinessProfile {
  about?: string; address?: string; description?: string; email?: string; websites?: string[]; vertical?: string; profile_picture_url?: string;
}

export const STATUS_LABEL: Record<ConnStatus, string> = { connected: 'Conectada', disconnected: 'Desconectada', pending: 'Aguardando' };
export const STATUS_TONE: Record<ConnStatus, string> = { connected: 'green', disconnected: 'red', pending: 'amber' };
export const SOURCE_LABEL: Record<ConnSource, string> = { manual: 'Manual', embedded: 'Meta em 1 clique', coexistence: 'WhatsApp Business do celular', web: 'QR Code' };
export const QUALITY_TONE: Record<string, string> = { GREEN: 'green', YELLOW: 'amber', RED: 'red' };
export const VERTICAL_LABEL: Record<string, string> = {
  UNDEFINED: 'Não definido', OTHER: 'Outro', AUTO: 'Automotivo', BEAUTY: 'Beleza, estética e cuidados pessoais', APPAREL: 'Roupas e acessórios',
  EDU: 'Educação', ENTERTAIN: 'Entretenimento', EVENT_PLAN: 'Eventos', FINANCE: 'Finanças e bancos', GROCERY: 'Mercado',
  GOVT: 'Serviço público', HOTEL: 'Hotel e hospedagem', HEALTH: 'Saúde', NONPROFIT: 'Sem fins lucrativos', PROF_SERVICES: 'Serviços profissionais',
  RETAIL: 'Varejo', TRAVEL: 'Viagens e transporte', RESTAURANT: 'Restaurante', NOT_A_BIZ: 'Não é empresa',
};
