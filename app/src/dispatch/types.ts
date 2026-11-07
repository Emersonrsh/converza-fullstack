import type { ContactFiltersState } from '../contacts/types';
import type { TemplateAction } from '../webhooks/types';

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'done' | 'canceled' | 'paused' | 'failed';

/** Filtros salvos (o mesmo formato da tela de Contatos, só com o que foi preenchido). */
export type SavedFilters = Partial<Omit<ContactFiltersState, 'status' | 'origin'>> & { status?: string; origin?: string; ids?: string[] };

export interface Campaign {
  id: string; name: string; status: CampaignStatus; pauseReason: string | null; pauseText?: string | null; scheduledAt: string | null;
  connectionId: string | null; connectionName: string | null; flowId: string | null; flowName: string | null;
  template: { name: string; language: string } | null; speed: number;
  totalCount: number; processed: number; started: number; templates: number; failed: number; skipped: number; charged: number; chargedExtra: number;
  audience: { filters: SavedFilters; excludeRecentDays: number | null };
  legacyMessage: string | null;
  startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
  templateFull?: TemplateAction | null;
}

export interface DispatchQuota {
  active: boolean; instances: number; cycleLimit: number; usedInCycle: number; extra: number; remaining: number;
  cycleStart: string; cycleEnd: string; cycleKey: string;
}

export interface DispatchList {
  campaigns: Campaign[]; quota: DispatchQuota; counts: { running: number; done: number };
  packs: { id: string; quantity: number; price: number; priceUSD: number }[];
  purchase: { enabled: boolean; asaas: boolean; paddle: boolean; hasTaxId: boolean; message: string | null };
  canEdit: boolean;
}

export interface AudiencePreview { total: number; windowOpen: number; needTemplate: number; optedOut: number; recentExcluded: number }

export interface CampaignStats {
  queued: number; startedNow: number; templatesSent: number; failed: number; skipped: number;
  delivered: number; read: number; replied: number; flowStarted: number;
}

export interface Recipient {
  id: string; contactId: string; name: string; phone: string; status: string; error: string | null; messageStatus: string | null;
  charge: string | null; processedAt: string | null; replied: boolean; conversationId: string | null;
}

export const CAMPAIGN_STATUS: Record<CampaignStatus, [string, string]> = {
  draft: ['Rascunho', ''], scheduled: ['Agendado', 'amber'], sending: ['Enviando', 'teal'], done: ['Concluído', 'green'],
  canceled: ['Cancelado', ''], paused: ['Pausado', 'amber'], failed: ['Falhou', 'red'],
};

export const REC_STATUS: Record<string, [string, string]> = {
  queued: ['Na fila', ''], sending: ['Enviando', 'teal'], started: ['Fluxo iniciado', 'green'], sent: ['Modelo enviado', 'teal'],
  failed: ['Falhou', 'red'], skipped: ['Ficou de fora', ''],
};

/** Dados do contato que valem no modelo de mensagem do disparo. */
export const CONTACT_TOKENS: [string, string][] = [
  ['nome', 'Nome do contato'], ['primeiro_nome', 'Primeiro nome'], ['telefone', 'Telefone'], ['email', 'E-mail'],
  ['etapa', 'Etapa do funil'], ['disparo', 'Nome do disparo'],
];

/** Singular ou plural pela quantidade (o número vai separado, já formatado). */
export const pl = (n: number, one: string, many: string) => (n === 1 ? one : many);
