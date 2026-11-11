export interface LoginConfig { configured: boolean; appId: string; configId: string | null; graphVersion: string }

export interface AdAccount {
  id: string; actId: string; name: string; currency: string; timezone: string | null; business: string | null;
  status: { ok: boolean; label: string }; selected: boolean; available: boolean;
  lastSyncAt: string | null; lastError: string | null; selectedElsewhere: string | null;
}
export interface MetaProfile {
  id: string; fbUserId: string; name: string; picture: string | null; status: 'connected' | 'expired' | 'error';
  lastError: string | null; tokenExpiresAt: string | null; createdAt: string; updatedAt: string; adAccounts: AdAccount[];
}
export interface Overview { login: LoginConfig; profiles: MetaProfile[]; selectedCount: number; canEdit: boolean }

export type Level = 'campaign' | 'adset' | 'ad';
export interface Metrics { spend: number; impressions: number; clicks: number; linkClicks: number; conversations: number; leads: number; purchases: number; purchaseValue: number }
export interface Derived { ctr: number; cpc: number; cpm: number; costPerConversation: number; costPerLead: number }
export interface Converza { leads: number; sales: number; revenue: number; roas: number }
export interface ManagerRow {
  id: string; level: Level; name: string; actId: string; accountName: string; currency: string;
  campaignId: string | null; adsetId: string | null;
  status: { key: 'active' | 'paused' | 'review' | 'issue' | 'off'; label: string };
  objective: string | null; optimization: string | null; budget: { amount: number; kind: 'daily' | 'lifetime' } | null; thumbnail: string | null;
  metrics: Metrics; derived: Derived; converza: Converza;
}
export interface ManagerData {
  level: Level; period: string; from: string; to: string; days: string[];
  accounts: { id: string; actId: string; name: string; currency: string; profileName: string; profileStatus: string; lastSyncAt: string | null }[];
  rows: ManagerRow[]; total: number;
  totals: Record<string, { metrics: Metrics; derived: Derived; converza: Converza }>;
  daily: Record<string, { date: string; spend: number; conversations: number; linkClicks: number }[]>;
  errors: { actId: string; name: string; message: string; expired: boolean }[];
  updatedAt: string | null; unmatched: { leads: number; sales: number };
}

export type Platform = 'meta' | 'meta_whatsapp' | 'tiktok';
export type Trigger = 'lead' | 'sale' | 'stage';
export interface PixelRule { id: string; trigger: Trigger; scope?: 'ad' | 'whatsapp' | 'all'; boardId?: string | null; columnId?: string | null; event: string }
export interface Pixel {
  id: string; name: string; platform: Platform; platformLabel: string; pixelId: string; remoteName: string | null;
  tokenHint: string | null; usesConnectionToken: boolean; connectionId: string | null; connectionName: string | null; wabaId: string | null; pageId?: string | null;
  rules: PixelRule[]; status: 'active' | 'paused' | 'error'; lastError: string | null; lastEventAt: string | null;
  createdAt: string; updatedAt: string; stats: { sent: number; failed: number; skipped: number; queued: number };
}
export interface PlatformInfo { id: Platform; label: string; events: string[] }
export interface PixelEvent {
  id: string; pixelId: string; trigger: Trigger | 'test'; eventName: string; status: 'queued' | 'sent' | 'failed' | 'skipped'; error: string | null;
  contactId: string | null; contactName: string | null; saleId: string | null; value: number | null; currency: string | null; attempts: number;
  response: unknown; payload: unknown; eventTime: string; sentAt: string | null; createdAt: string;
}

/** Nomes dos eventos em português (o nome técnico vai entre parênteses na tela). */
export const EVENT_LABEL: Record<string, string> = {
  Lead: 'Lead', LeadSubmitted: 'Lead enviado', QualifiedLead: 'Lead qualificado', Purchase: 'Compra', Contact: 'Contato',
  CompleteRegistration: 'Cadastro concluído', Schedule: 'Agendamento', SubmitApplication: 'Inscrição enviada',
  InitiateCheckout: 'Início do pagamento', AddToCart: 'Adicionou ao carrinho', ViewContent: 'Viu o conteúdo', Subscribe: 'Assinatura',
  StartTrial: 'Início do teste grátis', ApplicationApproval: 'Inscrição aprovada', OrderCreated: 'Pedido criado', OrderShipped: 'Pedido enviado',
  OrderDelivered: 'Pedido entregue', OrderCanceled: 'Pedido cancelado', OrderReturned: 'Pedido devolvido',
};
export const eventLabel = (e: string) => (EVENT_LABEL[e] ? `${EVENT_LABEL[e]} (${e})` : e);

export const EVENT_STATUS: Record<PixelEvent['status'], [string, string]> = {
  queued: ['Na fila', 'blue'], sent: ['Enviado', 'green'], failed: ['Falhou', 'red'], skipped: ['Não enviado', ''],
};

export function money(v: number, currency: string) {
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency }); } catch { return `${currency} ${v.toFixed(2)}`; }
}
export const num = (v: number) => v.toLocaleString('pt-BR');
export const pctTxt = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
