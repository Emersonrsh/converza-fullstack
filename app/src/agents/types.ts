export type AgentRole = 'sales' | 'support' | 'recovery' | 'custom';
export type Audience = 'all' | 'ads' | 'tags';
export type ReplyAudio = 'never' | 'when_audio' | 'always';

export interface FaqItem { q: string; a: string }

/** Campos editáveis do agente (o "rascunho" do editor). */
export interface AgentDraft {
  name: string;
  description: string;
  avatar: string;
  role: AgentRole;
  model: string;
  enabled: boolean;
  tone: string;
  systemPrompt: string;
  knowledge: string;
  faq: FaqItem[];
  rules: string;
  flowId: string | null;
  flowWhen: string;
  flowTag: string | null;
  handoffWhen: string;
  handoffMessage: string;
  handoffTag: string | null;
  handoffDepartmentId: string | null;
  connectionIds: string[];
  audience: Audience;
  audienceTags: string[];
  replyAudio: ReplyAudio;
  voiceId: string | null;
  transcribeAudio: boolean;
  waitSeconds: number;
  maxRepliesPerDay: number;
  sector: string;
  language: string;
  signMessages: boolean;
  identity: 'human' | 'ai';
  pace: Pace;
  formality: Formality;
  emoji: EmojiUse;
  knowledgeBaseIds: string[];
  automations: Automation[];
  stages: Stage[];
}

export type Pace = 'dynamic' | 'natural' | 'balanced' | 'detailed' | 'analytic';
export type Formality = 'formal' | 'professional' | 'casual' | 'relaxed';
export type EmojiUse = 'none' | 'discreet' | 'natural' | 'expressive';
export type AutoTrigger = 'invalid_media' | 'reply_limit' | 'finish' | 'handoff' | 'intent';
export type AutoAction = 'handoff' | 'flow' | 'close' | 'reply' | 'tag';
export interface Automation {
  key: string; trigger: AutoTrigger; when?: string; action: AutoAction;
  flowId?: string | null; tag?: string | null; departmentId?: string | null; message?: string;
}
export interface Stage { name: string; goal: string; advanceWhen?: string }

export interface SectorFunction {
  id: string; name: string; description: string; idealFor: string; popular?: boolean; role: AgentRole;
  systemPrompt: string; stages: Stage[]; automations: Automation[]; handoffWhen: string;
}
export interface Sector { id: string; name: string; functions: SectorFunction[] }

export interface KbSummary { id: string; name: string; sites: number; documents: number; faq: number; chars: number; updatedAt: string; agents?: number }
export interface KbFull extends KbSummary {
  siteList: { url: string; title: string; chars: number; preview: string }[];
  documentList: { name: string; chars: number; preview: string }[];
  faqList: FaqItem[];
}

export interface AgentStats { conversations: number; replies: number; flows: number; handoffs: number; tokens: number; lastAt: string | null }

export interface Agent extends AgentDraft {
  id: string;
  shareCode: string | null;
  createdAt: string;
  updatedAt: string;
  flowName: string | null;
  flowActive: boolean;
  voiceName: string | null;
  stats: AgentStats;
}

export interface AgentLimit { used: number; max: number | null; instances: number; scheduledInstances: number | null; active: boolean; perConnection: number }

export interface AgentListResp { agents: Agent[]; limit: AgentLimit; aiEnabled: boolean; voiceEnabled: boolean; balance: number; house?: boolean }

export interface AgentOptions {
  flows: { id: string; name: string; status: string }[];
  connections: { id: string; name: string; displayPhone: string | null; status: string }[];
  voices: { id: string; name: string; language: string }[];
  tags: { name: string; color: string }[];
  departments: { id: string; name: string; color: string }[];
  models: { id: string; label: string }[];
  defaultModel: string;
  aiEnabled: boolean;
  voiceEnabled: boolean;
  balance: number;
  voiceCost: { perChar: number; perMinute: number };
  languages: { id: string; label: string }[];
}

export interface AgentTemplate {
  id: string; name: string; role: AgentRole; avatar: string; description: string;
  tone: string; systemPrompt: string; rules: string; flowWhen: string; handoffWhen: string; handoffMessage: string;
}

export interface AgentRun { outcome: string; detail: string | null; tokens: number; createdAt: string; conversationId: string; contactName: string }

export interface Voice {
  id: string; name: string; language: string; status: 'pending' | 'ready'; samples: number; previewText: string;
  hasPreview: boolean; createdAt: string; agents: string[];
}

export interface TestTurn { from: 'client' | 'agent'; text: string; action?: string | null; reason?: string; note?: string }
export interface TestResp { messages: string[]; action: string | null; actionLabel?: string | null; reason: string; flowName: string | null; flowActive: boolean; tokens: number }
