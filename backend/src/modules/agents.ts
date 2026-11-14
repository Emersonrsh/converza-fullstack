import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { aiEnabled } from '../ai/provider';
import { aiCallWithUsage } from '../ai/usage';
import {
  AGENT_TEMPLATES, BUILD_SYSTEM, LANGUAGES, MAX_CUSTOM_AUTOMATIONS, SYSTEM_TRIGGERS, automationFor, buildAgentPrompt, finalTexts, htmlToText,
  parseAgentReply, parseBuiltAgent, resolveAutomations, speakable, type AgentAutomation,
} from '../ai/agentBrain';
import { SECTORS } from '../ai/agentSectors';
import { loadPersona, signed } from '../ai/agentPersona';
import { basesText, checkBaseIds } from './knowledge';
import {
  asHttp, chargeTokens, cloneVoice, deleteVoice, requireVoiceBudget, speak, sttTokens, transcribe, ttsTokens, voiceEnabled,
  VOICE_OFF, VoiceError,
} from '../ai/voice';
import { audioSeconds, FfmpegMissingError, toMp3 } from '../utils/audio';
import { agentLimitFor, AGENTS_PER_CONNECTION } from './plans';
import { getTokenState } from './tokens';
import { safeFetchPage } from '../flows/http';
import { normalizeGraph } from '../flows/types';

/**
 * Agentes de IA: lista com indicadores, limite do plano (2 por conexão), modelos prontos, editor,
 * conversa de teste, compartilhar/importar por código, montar com IA e vozes clonadas.
 */
export const agentsRouter = Router();

type AgentRow = typeof schema.agents.$inferSelect;

export const AVATARS = ['teal', 'indigo', 'amber', 'rose', 'emerald', 'sky', 'violet', 'slate'] as const;
const ALL_MODELS = [
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini — rápido e econômico (recomendado)' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini — o mais barato' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash — rápido, ótimo em português' },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1 — respostas mais caprichadas (gasta mais)' },
];
const models = () => (config.ai.baseUrl.includes('api.openai.com') ? ALL_MODELS.filter((m) => m.id.startsWith('openai/')) : ALL_MODELS);

const LANGS: Record<string, { label: string; preview: string }> = {
  pt: { label: 'Português', preview: 'Oi! Tudo bem? Essa é a minha voz no WhatsApp. Posso te ajudar com o que precisar.' },
  en: { label: 'English', preview: 'Hi! This is my voice on WhatsApp. How can I help you today?' },
  es: { label: 'Español', preview: '¡Hola! Esta es mi voz en WhatsApp. ¿En qué puedo ayudarte hoy?' },
  fr: { label: 'Français', preview: "Bonjour ! C'est ma voix sur WhatsApp. Comment puis-je vous aider ?" },
  it: { label: 'Italiano', preview: 'Ciao! Questa è la mia voce su WhatsApp. Come posso aiutarti?' },
  de: { label: 'Deutsch', preview: 'Hallo! Das ist meine Stimme auf WhatsApp. Wie kann ich helfen?' },
};

const AUDIO_TYPES = /^(audio\/(mpeg|mp3|wav|x-wav|wave|ogg|opus|mp4|m4a|x-m4a|aac|webm|flac|x-flac)|video\/webm|application\/ogg)$/;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|mp4|aac|webm|flac)$/i;
const MAX_SAMPLE_MB = 15;

const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores configuram os agentes de IA');
}

/** Valida com zod e devolve a primeira mensagem em português (em vez de "Dados inválidos"). */
function parse<T extends z.ZodTypeAny>(schemaDef: T, body: unknown): z.infer<T> {
  const r = schemaDef.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    const custom = i?.message && !/^(Expected|Invalid|String must|Number must|Array must|Required)/.test(i.message);
    throw new AppError(422, custom ? i.message : `Campo inválido: ${i?.path.join('.') || 'dados'}`);
  }
  return r.data;
}

/* ------------------------------------------------------------- limite */

async function limitInfo(accountId: string) {
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const active = sub?.status === 'active';
  const instances = sub?.instances ?? 0;
  // redução agendada para a próxima renovação: o limite já segue a quantidade nova
  const scheduled = active && sub?.pendingInstances != null && sub.pendingInstances < instances ? sub.pendingInstances : null;
  const max = agentLimitFor(scheduled ?? instances, active);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.agents).where(eq(schema.agents.accountId, accountId));
  return { used: Number(n), max, instances, scheduledInstances: scheduled, active, perConnection: AGENTS_PER_CONNECTION };
}

async function assertRoom(accountId: string, count = 1) {
  const info = await limitInfo(accountId);
  if (info.max !== null && info.used + count > info.max) {
    const msg = !info.active
      ? 'Assine para criar agentes de IA. Cada instância contratada libera 2 agentes.'
      : `Cada instância contratada libera ${AGENTS_PER_CONNECTION} agentes — você já tem ${info.used} de ${info.max}. Contrate mais instâncias para criar mais.`;
    throw new AppError(403, msg, { code: 'agent_limit', limit: info });
  }
  return info;
}

/* ----------------------------------------------------------- formato */

const FAQ = z.array(z.object({ q: z.string().trim().max(300), a: z.string().trim().max(1000) })).max(40, 'No máximo 40 perguntas frequentes');
const fieldsSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome ao agente').max(60, 'Nome muito longo (até 60 letras)'),
  description: z.string().trim().max(240, 'Descrição muito longa (até 240 letras)'),
  avatar: z.enum(AVATARS),
  role: z.enum(['sales', 'support', 'recovery', 'custom']),
  model: z.string().trim().min(3).max(100),
  enabled: z.boolean(),
  tone: z.string().max(1000, 'Jeito de falar muito longo (até 1.000 letras)'),
  systemPrompt: z.string().max(8000, 'Instruções muito longas (até 8.000 letras)'),
  knowledge: z.string().max(30000, 'Conhecimento muito longo (até 30.000 letras)'),
  faq: FAQ,
  rules: z.string().max(3000, 'Regras muito longas (até 3.000 letras)'),
  flowId: z.string().uuid().nullable(),
  flowWhen: z.string().max(500),
  flowTag: z.string().trim().max(40).nullable(),
  handoffWhen: z.string().max(500),
  handoffMessage: z.string().max(500),
  handoffTag: z.string().trim().max(40).nullable(),
  handoffDepartmentId: z.string().uuid().nullable(),
  connectionIds: z.array(z.string().uuid()).max(50),
  audience: z.enum(['all', 'ads', 'tags']),
  audienceTags: z.array(z.string().trim().min(1).max(40)).max(30),
  replyAudio: z.enum(['never', 'when_audio', 'always']),
  voiceId: z.string().uuid().nullable(),
  transcribeAudio: z.boolean(),
  waitSeconds: z.number().int().min(0, 'A espera vai de 0 a 60 segundos').max(60, 'A espera vai de 0 a 60 segundos'),
  maxRepliesPerDay: z.number().int().min(1, 'Limite diário entre 1 e 500').max(500, 'Limite diário entre 1 e 500'),
  sector: z.string().trim().max(40),
  language: z.string().refine((v) => v in LANGUAGES, 'Idioma inválido'),
  signMessages: z.boolean(),
  identity: z.enum(['human', 'ai']),
  pace: z.enum(['dynamic', 'natural', 'balanced', 'detailed', 'analytic']),
  formality: z.enum(['formal', 'professional', 'casual', 'relaxed']),
  emoji: z.enum(['none', 'discreet', 'natural', 'expressive']),
  knowledgeBaseIds: z.array(z.string().uuid()).max(10, 'No máximo 10 bases por agente'),
  automations: z.array(z.object({
    key: z.string().trim().min(1).max(40),
    trigger: z.enum(['invalid_media', 'reply_limit', 'finish', 'handoff', 'intent']),
    when: z.string().trim().max(400, 'Gatilho muito longo (até 400 letras)').optional(),
    action: z.enum(['handoff', 'flow', 'close', 'reply', 'tag']),
    flowId: z.string().uuid().nullable().optional(),
    tag: z.string().trim().max(40).nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    message: z.string().max(1000, 'Mensagem muito longa (até 1.000 letras)').optional(),
  })).max(SYSTEM_TRIGGERS.length + MAX_CUSTOM_AUTOMATIONS, `No máximo ${MAX_CUSTOM_AUTOMATIONS} automações personalizadas`),
  stages: z.array(z.object({
    name: z.string().trim().min(1, 'Dê um nome para cada etapa').max(60, 'Nome da etapa muito longo (até 60 letras)'),
    goal: z.string().trim().max(600, 'Objetivo da etapa muito longo (até 600 letras)'),
    advanceWhen: z.string().trim().max(300).optional(),
  })).max(12, 'No máximo 12 etapas'),
}).partial();
type Fields = z.infer<typeof fieldsSchema>;

/** Confere se fluxo, voz e conexões são da conta e limpa listas. */
async function checkRefs(accountId: string, f: Fields) {
  if (f.flowId) {
    const [x] = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.id, f.flowId), eq(schema.flows.accountId, accountId))).limit(1);
    if (!x) throw new AppError(422, 'Fluxo não encontrado');
  }
  if (f.handoffDepartmentId) {
    const [x] = await db.select({ id: schema.departments.id }).from(schema.departments)
      .where(and(eq(schema.departments.id, f.handoffDepartmentId), eq(schema.departments.accountId, accountId))).limit(1);
    if (!x) throw new AppError(422, 'Setor não encontrado');
  }
  if (f.voiceId) {
    const [x] = await db.select({ status: schema.voices.status }).from(schema.voices).where(and(eq(schema.voices.id, f.voiceId), eq(schema.voices.accountId, accountId))).limit(1);
    if (!x) throw new AppError(422, 'Voz não encontrada');
    if (x.status !== 'ready') throw new AppError(422, 'Essa voz ainda não foi aceita — ouça a prévia na aba Vozes e aceite');
  }
  if (f.connectionIds?.length) {
    f.connectionIds = [...new Set(f.connectionIds)];
    const ok = await db.select({ id: schema.connections.id }).from(schema.connections)
      .where(and(eq(schema.connections.accountId, accountId), inArray(schema.connections.id, f.connectionIds)));
    if (ok.length !== f.connectionIds.length) throw new AppError(422, 'Conexão não encontrada');
  }
  if (f.knowledgeBaseIds) f.knowledgeBaseIds = await checkBaseIds(accountId, f.knowledgeBaseIds);
  if (f.automations) {
    const list = f.automations as AgentAutomation[];
    const intents = list.filter((x) => x.trigger === 'intent');
    if (intents.length > MAX_CUSTOM_AUTOMATIONS) throw new AppError(422, `No máximo ${MAX_CUSTOM_AUTOMATIONS} automações personalizadas`);
    for (const x of intents) if (!x.when?.trim()) throw new AppError(422, 'Diga quando cada automação personalizada deve acontecer');
    for (const x of list) {
      if (x.action === 'flow' && !x.flowId) throw new AppError(422, 'Escolha o fluxo de cada automação que dispara um fluxo');
      if (x.action === 'tag' && !x.tag?.trim()) throw new AppError(422, 'Escolha a etiqueta de cada automação que marca etiqueta');
      if (x.action === 'reply' && !x.message?.trim()) throw new AppError(422, 'Escreva a mensagem de cada automação que responde com mensagem pronta');
    }
    const flowIds = [...new Set(list.map((x) => (x.action === 'flow' ? x.flowId : null)).filter((x): x is string => !!x))];
    if (flowIds.length) {
      const ok = await db.select({ id: schema.flows.id }).from(schema.flows).where(and(eq(schema.flows.accountId, accountId), inArray(schema.flows.id, flowIds)));
      if (ok.length !== flowIds.length) throw new AppError(422, 'Fluxo não encontrado');
    }
    const deptIds = [...new Set(list.map((x) => (x.action === 'handoff' ? x.departmentId : null)).filter((x): x is string => !!x))];
    if (deptIds.length) {
      const ok = await db.select({ id: schema.departments.id }).from(schema.departments).where(and(eq(schema.departments.accountId, accountId), inArray(schema.departments.id, deptIds)));
      if (ok.length !== deptIds.length) throw new AppError(422, 'Setor não encontrado');
    }
    // campos antigos espelhados (lista de agentes e quem ainda lê o jeito antigo)
    const flowAuto = intents.find((x) => x.action === 'flow');
    f.flowId = flowAuto?.flowId ?? null;
    f.flowWhen = flowAuto?.when ?? '';
    f.flowTag = null;
    const h = list.find((x) => x.trigger === 'handoff');
    if (h) { f.handoffMessage = h.message ?? ''; f.handoffTag = h.tag?.trim() || null; f.handoffDepartmentId = h.action === 'handoff' ? h.departmentId ?? null : null; }
    f.automations = list.map((x) => ({
      key: x.key, trigger: x.trigger, action: x.action, ...(x.trigger === 'intent' ? { when: x.when?.trim() } : {}),
      flowId: x.action === 'flow' ? x.flowId ?? null : null, tag: x.tag?.trim() || null,
      departmentId: x.action === 'handoff' ? x.departmentId ?? null : null, message: x.message?.trim() ?? '',
    }));
  }
  if (f.stages) f.stages = f.stages.map((x) => ({ name: x.name, goal: x.goal, ...(x.advanceWhen ? { advanceWhen: x.advanceWhen } : {}) }));
  if (f.audienceTags) f.audienceTags = [...new Map(f.audienceTags.map((t) => [t.toLowerCase(), t])).values()];
  if (f.faq) f.faq = f.faq.filter((x) => x.q && x.a);
  if (f.flowTag !== undefined) f.flowTag = f.flowTag?.trim() || null;
  if (f.handoffTag !== undefined) f.handoffTag = f.handoffTag?.trim() || null;
}

function assertReady(a: Pick<AgentRow, 'enabled' | 'audience' | 'audienceTags'>) {
  if (a.enabled && a.audience === 'tags' && !a.audienceTags.length) throw new AppError(422, 'Escolha ao menos uma etiqueta em “Quem ele atende”, ou mude para todos os contatos');
}

async function uniqueName(accountId: string, base: string, exceptId?: string) {
  const names = new Set((await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.accountId, accountId)))
    .filter((a) => a.id !== exceptId).map((a) => a.name.toLowerCase()));
  const name = base.trim().slice(0, 52) || 'Agente';
  if (!names.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) if (!names.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
  return `${name} ${randomBytes(2).toString('hex')}`;
}

async function stats(accountId: string, ids?: string[]) {
  const filter = ids?.length ? sql`and agent_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})` : sql``;
  const [runs, msgs] = await Promise.all([
    rows<{ agentId: string; conversations: string; flows: string; handoffs: string; tokens: string; lastAt: string | null }>(sql`
      select agent_id as "agentId", count(distinct conversation_id) as conversations,
        count(*) filter (where outcome = 'flow') as flows, count(*) filter (where outcome = 'handoff') as handoffs,
        coalesce(sum(tokens), 0) as tokens, to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastAt"
      from agent_runs where account_id = ${accountId} and created_at >= now() - interval '30 days' ${filter} group by agent_id`),
    rows<{ agentId: string; replies: string }>(sql`
      select agent_id as "agentId", count(*) as replies from messages
      where account_id = ${accountId} and agent_id is not null and created_at >= now() - interval '30 days' ${filter} group by agent_id`),
  ]);
  const out = new Map<string, { conversations: number; replies: number; flows: number; handoffs: number; tokens: number; lastAt: string | null }>();
  for (const r of runs) out.set(r.agentId, { conversations: Number(r.conversations), replies: 0, flows: Number(r.flows), handoffs: Number(r.handoffs), tokens: Number(r.tokens), lastAt: r.lastAt });
  for (const m of msgs) {
    const cur = out.get(m.agentId) ?? { conversations: 0, replies: 0, flows: 0, handoffs: 0, tokens: 0, lastAt: null };
    cur.replies = Number(m.replies);
    out.set(m.agentId, cur);
  }
  return out;
}

const EMPTY_STATS = { conversations: 0, replies: 0, flows: 0, handoffs: 0, tokens: 0, lastAt: null };

async function present(accountId: string, list: AgentRow[]) {
  const flowIds = [...new Set(list.map((a) => a.flowId).filter((x): x is string => !!x))];
  const voiceIds = [...new Set(list.map((a) => a.voiceId).filter((x): x is string => !!x))];
  const [flows, voices, st] = await Promise.all([
    flowIds.length ? db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status, archivedAt: schema.flows.archivedAt }).from(schema.flows).where(inArray(schema.flows.id, flowIds)) : [],
    voiceIds.length ? db.select({ id: schema.voices.id, name: schema.voices.name }).from(schema.voices).where(inArray(schema.voices.id, voiceIds)) : [],
    stats(accountId, list.map((a) => a.id)),
  ]);
  return list.map((a) => {
    const f = flows.find((x) => x.id === a.flowId);
    return {
      ...a,
      automations: resolveAutomations(a as Parameters<typeof resolveAutomations>[0]),
      flowName: f?.name ?? null,
      flowActive: !!f && f.status === 'active' && !f.archivedAt,
      voiceName: voices.find((v) => v.id === a.voiceId)?.name ?? null,
      stats: st.get(a.id) ?? EMPTY_STATS,
    };
  });
}

async function ownAgent(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Agente não encontrado');
  const [a] = await db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId))).limit(1);
  if (!a) throw new AppError(404, 'Agente não encontrado');
  return a;
}

async function insertAgent(accountId: string, f: Fields) {
  await checkRefs(accountId, f);
  const values = {
    accountId, name: await uniqueName(accountId, f.name ?? 'Novo agente'), model: f.model || config.ai.defaultModel,
    ...Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== undefined && k !== 'name' && k !== 'model')),
  } as typeof schema.agents.$inferInsert;
  assertReady({ enabled: !!values.enabled, audience: values.audience ?? 'all', audienceTags: values.audienceTags ?? [] });
  const [row] = await db.insert(schema.agents).values(values).returning();
  return row;
}

/* =============================================================== rotas */

agentsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const list = await db.select().from(schema.agents).where(eq(schema.agents.accountId, accountId)).orderBy(asc(schema.agents.createdAt));
  const [agents, limit, tokens] = await Promise.all([present(accountId, list), limitInfo(accountId), getTokenState(accountId)]);
  res.json({ agents, limit, aiEnabled: aiEnabled(), voiceEnabled: voiceEnabled(), balance: tokens.balance, house: tokens.house });
}));

/** Tudo o que o editor precisa escolher: fluxos, conexões, vozes aceitas, etiquetas e modelos. */
agentsRouter.get('/options', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [flows, connections, voices, tags, tokens, departments] = await Promise.all([
    db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status }).from(schema.flows)
      .where(and(eq(schema.flows.accountId, accountId), isNull(schema.flows.archivedAt))).orderBy(asc(schema.flows.name)),
    db.select({ id: schema.connections.id, name: schema.connections.name, displayPhone: schema.connections.displayPhone, status: schema.connections.status })
      .from(schema.connections).where(eq(schema.connections.accountId, accountId)).orderBy(asc(schema.connections.createdAt)),
    db.select({ id: schema.voices.id, name: schema.voices.name, language: schema.voices.language }).from(schema.voices)
      .where(and(eq(schema.voices.accountId, accountId), eq(schema.voices.status, 'ready'))).orderBy(asc(schema.voices.createdAt)),
    db.select({ name: schema.tags.name, color: schema.tags.color }).from(schema.tags).where(eq(schema.tags.accountId, accountId)).orderBy(asc(schema.tags.name)),
    getTokenState(accountId),
    db.select({ id: schema.departments.id, name: schema.departments.name, color: schema.departments.color }).from(schema.departments)
      .where(eq(schema.departments.accountId, accountId)).orderBy(asc(schema.departments.name)),
  ]);
  res.json({
    flows, connections, voices, tags, departments, models: models(), defaultModel: config.ai.defaultModel,
    aiEnabled: aiEnabled(), voiceEnabled: voiceEnabled(), balance: tokens.balance, house: tokens.house,
    voiceCost: { perChar: config.voice.tokensPerChar, perMinute: config.voice.tokensPerMinute },
    languages: Object.entries(LANGS).map(([id, l]) => ({ id, label: l.label })),
  });
}));

agentsRouter.get('/templates', (_req, res) => { res.json({ templates: AGENT_TEMPLATES, sectors: SECTORS }); });

agentsRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  await assertRoom(accountId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tpl = typeof body.templateId === 'string' ? AGENT_TEMPLATES.find((t) => t.id === body.templateId) : null;
  const { templateId: _t, ...rest } = body;
  const f = parse(fieldsSchema, rest);
  const base: Fields = tpl ? {
    name: tpl.name, description: tpl.description, role: tpl.role, avatar: tpl.avatar as Fields['avatar'], tone: tpl.tone,
    systemPrompt: tpl.systemPrompt, rules: tpl.rules, flowWhen: tpl.flowWhen, handoffWhen: tpl.handoffWhen, handoffMessage: tpl.handoffMessage,
  } : {};
  const row = await insertAgent(accountId, { ...base, ...f });
  res.status(201).json({ agent: (await present(accountId, [row]))[0] });
}));

/* ------------------------------------------------- importar por código */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % 32]).join('');

agentsRouter.post('/import', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const body = parse(z.object({ codes: z.union([z.string(), z.array(z.string())]) }), req.body);
  const raw = Array.isArray(body.codes) ? body.codes.join(',') : body.codes;
  const codes = [...new Set(raw.split(/[\s,;]+/).map((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 20);
  if (!codes.length) throw new AppError(422, 'Cole ao menos um código');
  const info = await limitInfo(accountId);
  let room = info.max === null ? Infinity : Math.max(0, info.max - info.used);
  if (room <= 0) await assertRoom(accountId);
  const imported: { id: string; name: string }[] = [];
  const notFound: string[] = [];
  const limited: string[] = [];
  for (const code of codes) {
    const [src] = code.length === 8 ? await db.select().from(schema.agents).where(eq(schema.agents.shareCode, code)).limit(1) : [];
    if (!src) { notFound.push(code); continue; }
    if (room <= 0) { limited.push(code); continue; }
    const same = src.accountId === accountId;
    // bases de outra conta não vêm junto: o texto delas entra no conhecimento do agente
    const bases = same ? '' : await basesText(src.accountId, src.knowledgeBaseIds);
    const autos = (src.automations ?? []).map((x) => (same ? x : { ...x, flowId: null, departmentId: null, action: x.action === 'flow' ? 'handoff' as const : x.action }));
    const [row] = await db.insert(schema.agents).values({
      accountId, name: await uniqueName(accountId, src.name), model: src.model, enabled: false, systemPrompt: src.systemPrompt,
      avatar: src.avatar, role: src.role, description: src.description, tone: src.tone, knowledge: src.knowledge, faq: src.faq, rules: src.rules,
      // fluxo, voz e números são da outra conta: ficam para você escolher
      flowId: same ? src.flowId : null, flowWhen: src.flowWhen, flowTag: src.flowTag,
      handoffWhen: src.handoffWhen, handoffMessage: src.handoffMessage, handoffTag: src.handoffTag, handoffDepartmentId: same ? src.handoffDepartmentId : null,
      connectionIds: same ? src.connectionIds : [], audience: src.audience, audienceTags: src.audienceTags,
      replyAudio: src.replyAudio, voiceId: same ? src.voiceId : null, transcribeAudio: src.transcribeAudio,
      waitSeconds: src.waitSeconds, maxRepliesPerDay: src.maxRepliesPerDay,
      sector: src.sector, language: src.language, signMessages: src.signMessages, identity: src.identity, pace: src.pace, formality: src.formality, emoji: src.emoji,
      stages: src.stages, automations: autos, knowledgeBaseIds: same ? src.knowledgeBaseIds : [],
      ...(bases ? { knowledge: `${src.knowledge}\n\n${bases}`.trim().slice(0, 30000) } : {}),
    }).returning();
    imported.push({ id: row.id, name: row.name });
    room -= 1;
  }
  res.status(imported.length ? 201 : 404).json({ imported, notFound, limited });
}));

/* ------------------------------------------------------- montar com IA */

/** Textos do fluxo (mensagens, menus, perguntas, produto do pagamento) para a IA entender a oferta. */
async function flowMaterial(accountId: string, flowId: string): Promise<string> {
  const [flow] = await db.select().from(schema.flows).where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, accountId))).limit(1);
  if (!flow) throw new AppError(422, 'Fluxo não encontrado');
  const g = normalizeGraph(flow.graph);
  const lines: string[] = [];
  const productIds = g.nodes.filter((n) => n.type === 'payment' && isUuid(n.data?.productId)).map((n) => String(n.data.productId));
  const products = productIds.length
    ? await db.select().from(schema.products).where(and(eq(schema.products.accountId, accountId), inArray(schema.products.id, productIds))) : [];
  for (const n of g.nodes) {
    const d = n.data ?? {};
    if (n.type === 'message' && d.text) lines.push(`Mensagem: ${d.text}`);
    if (n.type === 'menu') lines.push(`Menu: ${d.text ?? ''} Opções: ${(Array.isArray(d.options) ? d.options : []).map((o: any) => o?.title).filter(Boolean).join(' | ')}`);
    if (n.type === 'ask' && d.text) lines.push(`Pergunta: ${d.text}`);
    if (n.type === 'media' && d.caption) lines.push(`Legenda: ${d.caption}`);
    if (n.type === 'handoff' && d.message) lines.push(`Ao transferir: ${d.message}`);
    if ((n.type === 'ai_reply' || n.type === 'ai_classify') && d.prompt) lines.push(`Instrução de IA: ${d.prompt}`);
    if (n.type === 'payment') {
      const p = products.find((x) => x.id === d.productId);
      lines.push(`Pagamento: ${p ? `${p.name} por R$ ${Number(p.price).toFixed(2).replace('.', ',')}` : 'link de pagamento'}${d.text ? ` — ${d.text}` : ''}`);
    }
  }
  return `FLUXO DA OFERTA (“${flow.name}”)\n${lines.join('\n').slice(0, 6000) || '(fluxo sem textos)'}`;
}

/** Conversas recentes de quem tem a etiqueta (ex.: "pago"): mostram dúvidas reais e respostas que funcionaram. */
async function tagMaterial(accountId: string, tag: string): Promise<string> {
  const convs = await rows<{ id: string; name: string }>(sql`
    select v.id, c.name from conversations v join contacts c on c.id = v.contact_id
    where v.account_id = ${accountId} and exists (select 1 from unnest(c.tags) t where lower(t) = lower(${tag}))
    order by v.last_message_at desc nulls last limit 12`);
  if (!convs.length) return `CONVERSAS COM A ETIQUETA “${tag}”\n(nenhuma conversa com essa etiqueta ainda)`;
  const blocks: string[] = [];
  let total = 0;
  for (const c of convs) {
    const msgs = (await db.select({ direction: schema.messages.direction, type: schema.messages.type, body: schema.messages.body, transcript: schema.messages.transcript })
      .from(schema.messages).where(and(eq(schema.messages.conversationId, c.id), ne(schema.messages.type, 'note')))
      .orderBy(desc(schema.messages.createdAt)).limit(24)).reverse();
    const text = msgs.map((m) => {
      const t = (m.type === 'audio' ? m.transcript : m.body)?.trim();
      return t ? `${m.direction === 'in' ? 'Cliente' : 'Empresa'}: ${t.slice(0, 400)}` : null;
    }).filter(Boolean).join('\n');
    if (!text) continue;
    blocks.push(`--- conversa ---\n${text}`);
    total += text.length;
    if (total > 7000) break;
  }
  return `CONVERSAS RECENTES COM A ETIQUETA “${tag}”\n${blocks.join('\n').slice(0, 8000)}`;
}

async function siteMaterial(url: string): Promise<string> {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { throw new AppError(422, 'Link do site inválido'); }
  const page = await safeFetchPage(u.toString());
  if (page.error) throw new AppError(422, `Não consegui abrir o site: ${page.error}`);
  if (!page.ok) throw new AppError(422, `Não consegui abrir o site (HTTP ${page.status})`);
  const text = /html|xml/i.test(page.contentType) || /<html|<body/i.test(page.text.slice(0, 2000)) ? htmlToText(page.text) : page.text.slice(0, 10000);
  if (text.replace(/\s/g, '').length < 80) throw new AppError(422, 'O site quase não tem texto para ler (pode ser montado só com JavaScript). Descreva a oferta no campo de observações.');
  return `SITE (${page.url})\n${text}`;
}

const buildSchema = z.object({
  source: z.enum(['internal', 'site']),
  flowId: z.string().uuid().nullable().optional(),
  tag: z.string().trim().max(40).nullable().optional(),
  url: z.string().trim().max(500).nullable().optional(),
  notes: z.string().max(3000, 'Observações muito longas (até 3.000 letras)').nullable().optional(),
  voiceId: z.string().uuid().nullable().optional(),
});

agentsRouter.post('/build', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const d = parse(buildSchema, req.body);
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
  await assertRoom(accountId);
  const material: string[] = [];
  if (d.source === 'internal') {
    if (!d.flowId && !d.tag && !d.notes?.trim()) throw new AppError(422, 'Escolha um fluxo, uma etiqueta ou escreva o que ele precisa saber');
    if (d.flowId) material.push(await flowMaterial(accountId, d.flowId));
    if (d.tag) material.push(await tagMaterial(accountId, d.tag));
  } else {
    if (!d.url?.trim()) throw new AppError(422, 'Cole o link do site');
    material.push(await siteMaterial(d.url));
  }
  if (d.notes?.trim()) material.push(`OBSERVAÇÕES DO DONO DO NEGÓCIO\n${d.notes.trim()}`);
  const [account] = await db.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const r = await aiCallWithUsage(accountId, [
    { role: 'system', content: BUILD_SYSTEM },
    { role: 'user', content: `EMPRESA: ${account?.name ?? ''}\n\n${material.join('\n\n')}` },
  ], { maxTokens: 2500, temperature: 0.4, usage: { kind: 'agent_create', label: d.source === 'internal' ? 'Criar agente (dados da conta)' : 'Criar agente (site)' } });
  let built;
  try { built = parseBuiltAgent(r.text); } catch { throw new AppError(502, 'A IA não devolveu uma configuração válida. Tente de novo.'); }
  const avatar = ({ sales: 'teal', support: 'indigo', recovery: 'amber', custom: 'violet' } as const)[built.role];
  const row = await insertAgent(accountId, {
    ...built, avatar, flowId: d.flowId ?? null, voiceId: d.voiceId ?? null,
    replyAudio: d.voiceId ? 'when_audio' : 'never',
  });
  res.status(201).json({ agent: (await present(accountId, [row]))[0], tokens: r.tokens });
}));

/* ------------------------------------------------------ conversa de teste */

const testSchema = z.object({
  agentId: z.string().uuid().nullable().optional(),
  draft: fieldsSchema.optional(),
  messages: z.array(z.object({ from: z.enum(['client', 'agent']), text: z.string().trim().min(1).max(2000) })).min(1).max(40),
});

/** Conversa com o agente sem enviar nada no WhatsApp (usa a versão que está no editor, mesmo sem salvar). Gasta tokens. */
agentsRouter.post('/test', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = parse(testSchema, req.body);
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
  if (d.messages[d.messages.length - 1].from !== 'client') throw new AppError(422, 'A última mensagem precisa ser do cliente');
  const saved = d.agentId ? await ownAgent(accountId, d.agentId) : null;
  const a = { ...(saved ?? {}), ...(d.draft ?? {}) } as Partial<AgentRow>;
  if (!a.name) a.name = 'Agente';
  const [account] = await db.select({ name: schema.accounts.name, timezone: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const { persona, automations, flows } = await loadPersona(accountId, a);
  const system = buildAgentPrompt(persona, { name: 'Cliente teste', tags: [], fields: {} }, {
    company: account?.name ?? '', now: new Date(), timeZone: account?.timezone || 'America/Sao_Paulo', speakAsAudio: false, customerSentAudio: false,
  });
  const r = await aiCallWithUsage(accountId, [
    { role: 'system', content: system },
    ...d.messages.map((m) => ({ role: m.from === 'client' ? 'user' as const : 'assistant' as const, content: m.text })),
  ], { model: a.model || config.ai.defaultModel, maxTokens: 700, temperature: 0.6, usage: { kind: 'agent_test', agentId: saved?.id ?? null, label: `Teste: ${a.name}` } });
  const p = parseAgentReply(r.text);
  const auto = automationFor(automations, p.action);
  const flow = auto?.action === 'flow' && auto.flowId ? flows[auto.flowId] ?? null : null;
  const usable = auto && !(auto.action === 'flow' && !flow?.active) ? auto : null;
  const kind = usable ? (usable.action === 'flow' ? 'flow' : usable.action === 'handoff' ? 'handoff' : usable.action) : null;
  const messages = finalTexts(p.messages, usable).map((m) => signed(a.name ?? '', m, a.signMessages));
  const label = !usable ? null : usable.action === 'flow' ? `Disparou o fluxo “${flow?.name ?? ''}”` : usable.action === 'handoff' ? 'Passou para a equipe'
    : usable.action === 'close' ? 'Encerrou o atendimento' : usable.action === 'tag' ? `Marcou a etiqueta “${usable.tag}”` : 'Enviou a mensagem pronta';
  res.json({ messages, action: kind, actionLabel: label, reason: p.reason, flowName: flow?.name ?? null, flowActive: !!flow?.active, tokens: r.tokens });
}));

/* ---------------------------------------------- microfone (transcrição) */

async function readAudio(req: Request): Promise<{ data: Buffer; mime: string; filename: string }> {
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'Áudio vazio');
  const mime = String(req.headers['x-file-type'] ?? req.headers['content-type'] ?? 'audio/webm').split(';')[0].trim().toLowerCase();
  return { data, mime, filename: `audio.${mime.split('/')[1]?.replace('mpeg', 'mp3') || 'webm'}` };
}

/** Fala no microfone → texto (campo "Algo a mais que ele precisa saber"). Gasta tokens. */
agentsRouter.post('/transcribe', express.raw({ type: () => true, limit: '20mb' }), asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const file = await readAudio(req);
  await requireVoiceBudget(accountId);
  let r;
  try { r = await transcribe(file, String(req.query.language ?? 'pt').slice(0, 3)); } catch (err) { asHttp(err); }
  const tokens = sttTokens(r!.seconds);
  await chargeTokens(accountId, tokens, { kind: 'dictation', label: `Ditado pelo microfone (${Math.max(1, Math.round(r!.seconds))}s)` });
  res.json({ text: r!.text, tokens });
}));

/* ================================================================ vozes */

const publicVoice = (v: typeof schema.voices.$inferSelect) => ({
  id: v.id, name: v.name, language: v.language, status: v.status, samples: v.samples, previewText: v.previewText,
  hasPreview: !!v.previewAudio, createdAt: v.createdAt,
});

async function ownVoice(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Voz não encontrada');
  const [v] = await db.select().from(schema.voices).where(and(eq(schema.voices.id, id), eq(schema.voices.accountId, accountId))).limit(1);
  if (!v) throw new AppError(404, 'Voz não encontrada');
  return v;
}

agentsRouter.get('/voices', asyncHandler(async (req, res) => {
  const list = await db.select().from(schema.voices).where(eq(schema.voices.accountId, req.accountId!)).orderBy(desc(schema.voices.createdAt));
  const used = await db.select({ voiceId: schema.agents.voiceId, name: schema.agents.name }).from(schema.agents)
    .where(and(eq(schema.agents.accountId, req.accountId!), sql`${schema.agents.voiceId} is not null`));
  res.json({
    voices: list.map((v) => ({ ...publicVoice(v), agents: used.filter((u) => u.voiceId === v.id).map((u) => u.name) })),
    voiceEnabled: voiceEnabled(),
    languages: Object.entries(LANGS).map(([id, l]) => ({ id, label: l.label })),
  });
}));

/** Cria a voz: 1 a 3 amostras (multipart: name, language, files). Fica "pendente" até a pessoa ouvir e aceitar. */
agentsRouter.post('/voices', express.raw({ type: (r) => String(r.headers['content-type'] ?? '').startsWith('multipart/form-data'), limit: '50mb' }), asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  if (!voiceEnabled()) throw new AppError(503, VOICE_OFF);
  if (!Buffer.isBuffer(req.body)) throw new AppError(400, 'Envie os áudios como formulário (multipart)');
  let form: FormData;
  try { form = await new Response(req.body, { headers: { 'content-type': String(req.headers['content-type']) } }).formData(); } catch { throw new AppError(400, 'Não consegui ler o envio dos áudios'); }
  const name = String(form.get('name') ?? '').trim().slice(0, 60);
  const language = String(form.get('language') ?? 'pt');
  if (!name) throw new AppError(422, 'Dê um nome para a voz');
  if (!LANGS[language]) throw new AppError(422, 'Idioma inválido');
  type Upload = { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
  const files = form.getAll('files').filter((f) => typeof f !== 'string') as unknown as Upload[];
  if (!files.length) throw new AppError(422, 'Grave ou anexe pelo menos 1 áudio da voz');
  if (files.length > 3) throw new AppError(422, 'No máximo 3 áudios por voz');
  const samples: { data: Buffer; mime: string; filename: string }[] = [];
  let total = 0;
  for (const [i, f] of files.entries()) {
    const type = (f.type || '').toLowerCase();
    if (!AUDIO_TYPES.test(type) && !AUDIO_EXT.test(f.name || '')) throw new AppError(422, `“${f.name || `áudio ${i + 1}`}” não é um áudio aceito (MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC)`);
    if (f.size > MAX_SAMPLE_MB * 1024 * 1024) throw new AppError(413, `“${f.name}” passa de ${MAX_SAMPLE_MB} MB`);
    const raw = Buffer.from(await f.arrayBuffer());
    let seconds = 0; let mp3: Buffer;
    try {
      seconds = await audioSeconds(raw);
      mp3 = await toMp3(raw);
    } catch (err) {
      if (err instanceof FfmpegMissingError) throw new AppError(500, err.message);
      throw new AppError(422, `Não consegui ler “${f.name || `áudio ${i + 1}`}”: o arquivo parece corrompido ou não é áudio`);
    }
    if (seconds < 2) throw new AppError(422, `“${f.name || `áudio ${i + 1}`}” é curto demais — grave pelo menos alguns segundos falando`);
    total += seconds;
    samples.push({ data: mp3, mime: 'audio/mpeg', filename: `amostra-${i + 1}.mp3` });
  }
  if (total < 8) throw new AppError(422, 'Os áudios somam menos de 8 segundos. Para a voz ficar parecida, grave de 30 segundos a 2 minutos no total.');
  await requireVoiceBudget(accountId);
  let providerVoiceId: string;
  try { providerVoiceId = await cloneVoice(name, language, samples); } catch (err) { asHttp(err); }
  const previewText = LANGS[language].preview;
  let previewAudio: string | null = null;
  try {
    previewAudio = (await speak(previewText, providerVoiceId!)).toString('base64');
    await chargeTokens(accountId, ttsTokens(previewText), { kind: 'voice_preview', label: `Prévia da voz ${name}` });
  } catch (err) {
    if (!(err instanceof VoiceError)) throw err;
    console.error('[voz] prévia falhou:', err.message);
  }
  const [row] = await db.insert(schema.voices).values({
    accountId, name, language, providerVoiceId: providerVoiceId!, status: 'pending', samples: samples.length,
    previewText, previewAudio, createdBy: req.user?.id ?? null,
  }).returning();
  res.status(201).json({ voice: { ...publicVoice(row), agents: [] }, seconds: Math.round(total) });
}));

/** Áudio da prévia (MP3). */
agentsRouter.get('/voices/:id/preview', asyncHandler(async (req, res) => {
  const v = await ownVoice(req.accountId!, req.params.id);
  if (!v.previewAudio) throw new AppError(404, 'Essa voz ainda não tem prévia — gere de novo');
  const audio = Buffer.from(v.previewAudio, 'base64');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(audio.length));
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(audio);
}));

/** Gera a prévia de novo (texto opcional). Gasta tokens. */
agentsRouter.post('/voices/:id/preview', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const v = await ownVoice(accountId, req.params.id);
  const { text } = parse(z.object({ text: z.string().trim().max(300, 'Frase muito longa (até 300 letras)').optional() }), req.body);
  const phrase = text || LANGS[v.language]?.preview || LANGS.pt.preview;
  await requireVoiceBudget(accountId);
  let audio: Buffer;
  try { audio = await speak(phrase, v.providerVoiceId); } catch (err) { asHttp(err); }
  await chargeTokens(accountId, ttsTokens(phrase), { kind: 'voice_preview', label: `Prévia da voz ${v.name}` });
  const [row] = await db.update(schema.voices).set({ previewAudio: audio!.toString('base64'), previewText: phrase }).where(eq(schema.voices.id, v.id)).returning();
  res.json({ voice: publicVoice(row) });
}));

agentsRouter.post('/voices/:id/accept', asyncHandler(async (req, res) => {
  managerOnly(req);
  const v = await ownVoice(req.accountId!, req.params.id);
  const [row] = await db.update(schema.voices).set({ status: 'ready' }).where(eq(schema.voices.id, v.id)).returning();
  res.json({ voice: publicVoice(row) });
}));

agentsRouter.delete('/voices/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const v = await ownVoice(req.accountId!, req.params.id);
  let warning: string | null = null;
  try { await deleteVoice(v.providerVoiceId); } catch (err) { warning = (err as Error).message; console.error('[voz] exclusão na ElevenLabs:', warning); }
  // agentes que usavam a voz voltam para a voz padrão
  await db.update(schema.agents).set({ voiceId: null }).where(eq(schema.agents.voiceId, v.id));
  await db.delete(schema.voices).where(eq(schema.voices.id, v.id));
  res.json({ ok: true, warning });
}));

/* ============================================================ por agente */

agentsRouter.get('/:id', asyncHandler(async (req, res) => {
  const a = await ownAgent(req.accountId!, req.params.id);
  const recent = await rows(sql`
    select r.outcome, r.detail, r.tokens, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      r.conversation_id as "conversationId", c.name as "contactName"
    from agent_runs r join conversations v on v.id = r.conversation_id join contacts c on c.id = v.contact_id
    where r.agent_id = ${a.id} order by r.created_at desc limit 15`);
  res.json({ agent: (await present(req.accountId!, [a]))[0], recent });
}));

agentsRouter.put('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const cur = await ownAgent(accountId, req.params.id);
  const f = parse(fieldsSchema, req.body);
  await checkRefs(accountId, f);
  if (f.name) f.name = await uniqueName(accountId, f.name, cur.id);
  const next = { ...cur, ...f } as AgentRow;
  assertReady(next);
  const [row] = await db.update(schema.agents).set({ ...f, updatedAt: new Date() }).where(eq(schema.agents.id, cur.id)).returning();
  res.json({ agent: (await present(accountId, [row]))[0] });
}));

agentsRouter.post('/:id/duplicate', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const src = await ownAgent(accountId, req.params.id);
  await assertRoom(accountId);
  const { id: _id, createdAt: _c, updatedAt: _u, shareCode: _s, accountId: _a, ...copy } = src;
  const [row] = await db.insert(schema.agents).values({ ...copy, accountId, name: await uniqueName(accountId, `${src.name} (cópia)`), enabled: false }).returning();
  res.status(201).json({ agent: (await present(accountId, [row]))[0] });
}));

agentsRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const a = await ownAgent(req.accountId!, req.params.id);
  await db.delete(schema.agents).where(eq(schema.agents.id, a.id));
  res.status(204).end();
}));

/** Código para outra conta importar uma cópia (sem fluxo, voz e números). */
agentsRouter.post('/:id/share', asyncHandler(async (req, res) => {
  managerOnly(req);
  const a = await ownAgent(req.accountId!, req.params.id);
  if (a.shareCode && req.query.novo !== '1') { res.json({ shareCode: a.shareCode }); return; }
  for (let i = 0; i < 6; i++) {
    try {
      const [row] = await db.update(schema.agents).set({ shareCode: newCode() }).where(eq(schema.agents.id, a.id)).returning({ shareCode: schema.agents.shareCode });
      res.json({ shareCode: row.shareCode }); return;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new AppError(500, 'Não foi possível gerar o código');
}));

agentsRouter.delete('/:id/share', asyncHandler(async (req, res) => {
  managerOnly(req);
  const a = await ownAgent(req.accountId!, req.params.id);
  await db.update(schema.agents).set({ shareCode: null }).where(eq(schema.agents.id, a.id));
  res.json({ shareCode: null });
}));

/** Ouvir uma frase na voz do agente (MP3). Gasta tokens. */
agentsRouter.post('/:id/speak', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const a = await ownAgent(accountId, req.params.id);
  const { text, voiceId } = parse(z.object({ text: z.string().trim().min(1, 'Nada para falar').max(600, 'Texto muito longo para ouvir (até 600 letras)'), voiceId: z.string().uuid().nullable().optional() }), req.body);
  const vid = voiceId === undefined ? a.voiceId : voiceId;
  const [voice] = vid ? await db.select().from(schema.voices).where(and(eq(schema.voices.id, vid), eq(schema.voices.accountId, accountId))).limit(1) : [];
  await requireVoiceBudget(accountId);
  const spoken = speakable(text);
  let audio: Buffer;
  try { audio = await speak(spoken, voice?.providerVoiceId ?? null); } catch (err) { asHttp(err); }
  await chargeTokens(accountId, ttsTokens(spoken), { kind: 'voice_preview', agentId: a.id, label: `Ouvir frase na voz de ${a.name}` });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(audio!);
}));
