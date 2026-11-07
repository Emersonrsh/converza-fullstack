import type { Agent, AgentDraft, AgentRole, Audience, ReplyAudio } from './types';

export const ROLE_LABEL: Record<AgentRole, string> = { sales: 'Vendas', support: 'Suporte', recovery: 'Recuperação', custom: 'Personalizado' };
export const ROLES: [AgentRole, string][] = Object.entries(ROLE_LABEL) as [AgentRole, string][];

export const AUDIENCE_LABEL: Record<Audience, string> = {
  all: 'Todos os contatos', ads: 'Quem chegou por anúncio', tags: 'Contatos com etiqueta',
};
export const REPLY_AUDIO_LABEL: Record<ReplyAudio, string> = {
  never: 'Sempre em texto', when_audio: 'Em áudio quando o cliente mandar áudio', always: 'Sempre em áudio',
};

export const OUTCOME_LABEL: Record<string, string> = {
  replied: 'Respondeu', flow: 'Disparou o fluxo', handoff: 'Passou para a equipe', limit: 'Atingiu o limite do dia',
  error: 'Erro', no_tokens: 'Sem saldo de tokens',
};

export function emptyDraft(defaultModel: string): AgentDraft {
  return {
    name: 'Novo agente', description: '', avatar: 'teal', role: 'custom', model: defaultModel, enabled: false,
    tone: '', systemPrompt: '', knowledge: '', faq: [], rules: '',
    flowId: null, flowWhen: '', flowTag: null, handoffWhen: '', handoffMessage: '', handoffTag: null, handoffDepartmentId: null,
    connectionIds: [], audience: 'all', audienceTags: [], replyAudio: 'never', voiceId: null, transcribeAudio: true,
    waitSeconds: 5, maxRepliesPerDay: 40,
  };
}

const KEYS = Object.keys(emptyDraft('')) as (keyof AgentDraft)[];
export function toDraft(a: Agent | AgentDraft): AgentDraft {
  return Object.fromEntries(KEYS.map((k) => [k, structuredClone((a as AgentDraft)[k])])) as unknown as AgentDraft;
}
export const sameDraft = (a: AgentDraft | null, b: AgentDraft | null) => JSON.stringify(a) === JSON.stringify(b);

export const fmtN = (n: number) => n.toLocaleString('pt-BR');

/** "há 3 minutos" */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
}

/** Áudio gravado no navegador: o melhor formato disponível. */
export const REC_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
