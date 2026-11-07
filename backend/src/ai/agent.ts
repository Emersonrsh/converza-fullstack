import { and, asc, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { aiEnabled, type ChatMsg } from './provider';
import { aiCallWithUsage } from './usage';
import {
  buildAgentPrompt, eligibleAgents, parseAgentReply, shouldSpeak, speakable, type ParsedReply,
} from './agentBrain';
import { chargeTokens, speak, sttTokens, transcribe, ttsTokens, voiceEnabled } from './voice';
import { downloadMedia, sendMediaId, sendText, uploadMedia, type WaConnection } from '../whatsapp/cloud-api';
import { emitToAccount } from '../realtime/io';
import { hasTokens } from '../modules/tokens';
import { systemNote } from '../modules/conversationStore';
import { startFlowForContact } from '../flows/runner';
import { enqueueAgentJob, type AgentJobData } from '../queue';
import { toOggOpus } from '../utils/audio';
import { signedMediaPath } from '../utils/mediaSign';

/**
 * Agente de IA no WhatsApp: espera o cliente terminar de escrever, entende áudios (transcrição),
 * responde em texto ou mensagem de voz, dispara o fluxo (ex.: checkout) e passa para a equipe.
 * Tudo o que gasta sai do saldo de tokens da conta e fica registrado em agent_runs.
 */

type Agent = typeof schema.agents.$inferSelect;
type Conv = typeof schema.conversations.$inferSelect;
type Contact = typeof schema.contacts.$inferSelect;
type Msg = typeof schema.messages.$inferSelect;

const HISTORY = 20;
const DAY_MS = 24 * 3600 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Qual agente atende esta conversa agora (ou null). */
async function pickAgent(accountId: string, conversationId: string) {
  const [conv] = await db.select().from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.accountId, accountId))).limit(1);
  if (!conv || conv.botPaused || !conv.connectionId) return null;
  const agents = await db.select().from(schema.agents)
    .where(and(eq(schema.agents.accountId, accountId), eq(schema.agents.enabled, true)));
  if (!agents.length) return null;
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1);
  if (!contact) return null;
  const [agent] = eligibleAgents(agents, { connectionId: conv.connectionId, tags: contact.tags ?? [], fromAd: !!contact.sourceId || contact.origin === 'ad' });
  return agent ? { agent, conv, contact } : null;
}

/** Chamado a cada mensagem recebida que nenhum fluxo tratou. true = um agente vai responder. */
export async function scheduleAgentReply(accountId: string, conversationId: string, messageId: string): Promise<boolean> {
  if (!aiEnabled()) return false; // operador não configurou a IA
  const pick = await pickAgent(accountId, conversationId);
  if (!pick) return false;
  const data: AgentJobData = { accountId, conversationId, messageId };
  const wait = Math.max(0, Math.min(60, pick.agent.waitSeconds)) * 1000;
  if (!wait) { await runAgentJob(data); return true; }
  try {
    await enqueueAgentJob(data, wait);
  } catch (err) {
    console.error('[agent] fila indisponível, respondendo agora:', (err as Error).message);
    await runAgentJob(data);
  }
  return true;
}

export async function runAgentJob(d: AgentJobData): Promise<void> {
  try {
    await respond(d);
  } catch (err) {
    console.error('[agent] falhou:', (err as Error).message);
  }
}

async function record(accountId: string, agentId: string, conversationId: string, outcome: string, detail: string | null, tokens = 0, audioChars = 0) {
  await db.insert(schema.agentRuns).values({ accountId, agentId, conversationId, outcome, detail: detail?.slice(0, 500) ?? null, tokens, audioChars });
}

async function addTag(accountId: string, contact: Contact, tag: string | null | undefined) {
  const t = String(tag ?? '').trim().slice(0, 40);
  if (!t || (contact.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase())) return;
  await db.update(schema.contacts).set({ tags: sql`array_append(${schema.contacts.tags}, ${t})` }).where(eq(schema.contacts.id, contact.id));
  await db.insert(schema.tags).values({ accountId, name: t }).onConflictDoNothing();
}

/** Passa para a equipe: para a automação e deixa em "Aguardando" (na fila do setor, se o agente tiver um). */
async function handoff(accountId: string, conv: Conv, note: string, departmentId?: string | null) {
  const [updated] = await db.update(schema.conversations)
    .set({ botPaused: true, status: 'pending', assignedUserId: null, ...(departmentId ? { departmentId } : {}) })
    .where(eq(schema.conversations.id, conv.id)).returning();
  if (updated) emitToAccount(accountId, 'conversation:updated', { conversation: updated });
  await systemNote(accountId, conv.id, note);
}

/** Linha do histórico como o modelo vai ler. */
const TRACK_CODE_G = /\s*#[A-HJ-NP-Z2-9]{6}(?![A-Za-z0-9])/g;

function historyLine(m: Msg): string | null {
  if (m.type === 'note') return null;
  const body = (m.body ?? '').trim();
  switch (m.type) {
    case 'audio': return m.direction === 'in' ? (m.transcript ? `[áudio] ${m.transcript}` : '[o cliente mandou um áudio que não deu para ouvir]') : (body || '[áudio]');
    case 'image': return `[imagem]${body ? ` ${body}` : ''}`;
    case 'video': return `[vídeo]${body ? ` ${body}` : ''}`;
    case 'document': return `[documento${m.fileName ? ` ${m.fileName}` : ''}]${body ? ` ${body}` : ''}`;
    case 'sticker': return '[figurinha]';
    case 'location': return body ? `[localização] ${body}` : '[localização]';
    case 'contacts': return '[cartão de contato]';
    case 'template': return body || '[modelo de mensagem]';
    // o código do link rastreável (#K7Q2MX) é só para a origem: o agente não precisa ver
    default: return (m.direction === 'in' ? body.replace(TRACK_CODE_G, '').trim() : body) || null;
  }
}

/** Transcreve os áudios do cliente que ainda não têm texto (só quando o agente vai responder). */
async function transcribePending(accountId: string, agent: Agent, conv: Conv, conn: WaConnection, recent: Msg[]): Promise<number> {
  if (!agent.transcribeAudio || !voiceEnabled() || !conn.accessToken) return 0;
  let tokens = 0;
  const pending = recent.filter((m) => m.direction === 'in' && m.type === 'audio' && !m.transcript && m.waMediaId).slice(-3);
  for (const m of pending) {
    try {
      const file = await downloadMedia(conn.accessToken, m.waMediaId!);
      const r = await transcribe({ data: file.data, mime: file.mime || 'audio/ogg', filename: 'audio.ogg' });
      const text = r.text || '(áudio sem fala)';
      m.transcript = text;
      await db.update(schema.messages).set({ transcript: text }).where(eq(schema.messages.id, m.id));
      emitToAccount(accountId, 'message:transcript', { conversationId: conv.id, id: m.id, transcript: text });
      const t = sttTokens(r.seconds);
      tokens += t;
      await chargeTokens(accountId, t, { kind: 'transcription', conversationId: conv.id, contactId: conv.contactId, agentId: agent.id, label: `Áudio do cliente (${Math.max(1, Math.round(r.seconds))}s)` });
    } catch (err) {
      console.error('[agent] transcrição falhou:', (err as Error).message);
    }
  }
  return tokens;
}

async function respond(d: AgentJobData): Promise<void> {
  const { accountId, conversationId } = d;
  const pick = await pickAgent(accountId, conversationId);
  if (!pick) return;
  const { agent, contact } = pick;
  let conv = pick.conv;

  // espera terminou: só responde se esta ainda for a última mensagem do cliente
  const [lastIn] = await db.select({ id: schema.messages.id, createdAt: schema.messages.createdAt }).from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'in')))
    .orderBy(desc(schema.messages.createdAt)).limit(1);
  if (!lastIn || lastIn.id !== d.messageId) return;
  // alguém (equipe ou o próprio agente) já respondeu depois dela?
  const [answered] = await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'out'), ne(schema.messages.type, 'note'),
      gte(schema.messages.createdAt, lastIn.createdAt), sql`(${schema.messages.senderUserId} is not null or ${schema.messages.agentId} is not null)`))
    .limit(1);
  if (answered) return;

  // limite de respostas por dia nesta conversa → passa para a equipe
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.agentId, agent.id), gte(schema.messages.createdAt, new Date(Date.now() - DAY_MS))));
  if (Number(n) >= agent.maxRepliesPerDay) {
    await handoff(accountId, conv, `🤖 ${agent.name} chegou ao limite de ${agent.maxRepliesPerDay} respostas por dia nesta conversa e passou para a equipe.`, agent.handoffDepartmentId);
    await record(accountId, agent.id, conv.id, 'limit', `limite de ${agent.maxRepliesPerDay} respostas/dia`);
    return;
  }

  // sem saldo: avisa a equipe (uma vez por dia por conversa) e não responde
  if (!(await hasTokens(accountId))) {
    const [warned] = await db.select({ id: schema.agentRuns.id }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.conversationId, conv.id), eq(schema.agentRuns.outcome, 'no_tokens'), gte(schema.agentRuns.createdAt, new Date(Date.now() - DAY_MS)))).limit(1);
    if (!warned) {
      await systemNote(accountId, conv.id, `🤖 ${agent.name} não respondeu: a conta está sem saldo de tokens de IA.`);
      await record(accountId, agent.id, conv.id, 'no_tokens', 'sem saldo de tokens');
    }
    return;
  }

  const [conn] = await db.select().from(schema.connections).where(eq(schema.connections.id, conv.connectionId!)).limit(1);
  if (!conn) return;
  const [account] = await db.select({ name: schema.accounts.name, timezone: schema.accounts.timezone }).from(schema.accounts)
    .where(eq(schema.accounts.id, accountId)).limit(1);

  const recent = (await db.select().from(schema.messages)
    .where(eq(schema.messages.conversationId, conv.id)).orderBy(desc(schema.messages.createdAt)).limit(HISTORY)).reverse();
  let tokens = await transcribePending(accountId, agent, conv, conn, recent);
  const lastInbound = [...recent].reverse().find((m) => m.direction === 'in');
  const customerSentAudio = lastInbound?.type === 'audio';

  // fluxo ligado (só se estiver ativo) e voz
  const [flow] = agent.flowId
    ? await db.select({ id: schema.flows.id, name: schema.flows.name }).from(schema.flows)
      .where(and(eq(schema.flows.id, agent.flowId), eq(schema.flows.status, 'active'), isNull(schema.flows.archivedAt))).limit(1)
    : [];
  const [voice] = agent.voiceId
    ? await db.select({ providerVoiceId: schema.voices.providerVoiceId }).from(schema.voices)
      .where(and(eq(schema.voices.id, agent.voiceId), eq(schema.voices.status, 'ready'))).limit(1)
    : [];
  const asAudio = shouldSpeak(agent.replyAudio, customerSentAudio, voiceEnabled());

  const fields = await db.select({ key: schema.contactFields.key, label: schema.contactFields.label }).from(schema.contactFields)
    .where(eq(schema.contactFields.accountId, accountId)).orderBy(asc(schema.contactFields.position));
  const custom = (contact.custom ?? {}) as Record<string, unknown>;
  const facts = {
    name: contact.name === contact.phone ? '' : contact.name,
    tags: contact.tags ?? [],
    fields: Object.fromEntries(fields.filter((f) => custom[f.key] != null && String(custom[f.key]).trim()).map((f) => [f.label, String(custom[f.key])])),
    fromAd: !!contact.sourceId || contact.origin === 'ad',
  };
  const system = buildAgentPrompt({
    name: agent.name, role: agent.role, tone: agent.tone, systemPrompt: agent.systemPrompt, knowledge: agent.knowledge,
    faq: agent.faq ?? [], rules: agent.rules, flowName: flow?.name ?? null, flowWhen: agent.flowWhen, handoffWhen: agent.handoffWhen,
  }, facts, { company: account?.name ?? '', now: new Date(), timeZone: account?.timezone || 'America/Sao_Paulo', speakAsAudio: asAudio, customerSentAudio });

  const chat: ChatMsg[] = [{ role: 'system', content: system }];
  for (const m of recent) {
    const line = historyLine(m);
    if (line) chat.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: line });
  }
  if (chat.length === 1 || chat[chat.length - 1].role !== 'user') return; // nada do cliente para responder

  let parsed: ParsedReply;
  try {
    const r = await aiCallWithUsage(accountId, chat, {
      model: agent.model, maxTokens: 700, temperature: 0.6,
      usage: { kind: 'agent_reply', conversationId: conv.id, contactId: contact.id, agentId: agent.id, label: `Resposta de ${agent.name}` },
    });
    tokens += r.tokens;
    parsed = parseAgentReply(r.text);
  } catch (err) {
    const msg = (err as Error).message;
    await systemNote(accountId, conv.id, `🤖 ${agent.name} não conseguiu responder agora (${msg.slice(0, 160)}).`);
    await record(accountId, agent.id, conv.id, 'error', msg, tokens);
    return;
  }

  let action = parsed.action;
  if (action === 'flow' && !flow) action = null; // sem fluxo ativo para disparar
  const texts = parsed.messages.length ? parsed.messages
    : action === 'handoff' && agent.handoffMessage.trim() ? [agent.handoffMessage.trim()] : [];
  if (!texts.length && !action) {
    await record(accountId, agent.id, conv.id, 'error', 'a IA devolveu uma resposta vazia', tokens);
    return;
  }

  // envia (texto ou mensagem de voz), na ordem, com um respiro entre elas
  const to = contact.waId ?? contact.phone.replace(/\D/g, '');
  const wa: WaConnection = { phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken };
  let audioChars = 0;
  for (let i = 0; i < texts.length; i++) {
    if (i) await sleep(900);
    const text = texts[i];
    let sent: { type: 'text' | 'audio'; waMessageId: string | null; waMediaId: string | null; status: 'sent' | 'failed'; error: string | null } | null = null;
    if (asAudio && speakable(text)) {
      try {
        const spoken = speakable(text);
        const ogg = await toOggOpus(await speak(spoken, voice?.providerVoiceId ?? null));
        const t = ttsTokens(spoken);
        tokens += t; audioChars += spoken.length;
        await chargeTokens(accountId, t, { kind: 'agent_voice', conversationId: conv.id, contactId: contact.id, agentId: agent.id, label: `Áudio de ${agent.name} (${spoken.length} letras)` });
        const mediaId = await uploadMedia(wa, ogg, 'audio/ogg', 'resposta.ogg');
        const r = await sendMediaId(wa, to, 'audio', mediaId, undefined, undefined, { voice: true });
        sent = { type: 'audio', waMessageId: r.waMessageId, waMediaId: mediaId, status: 'sent', error: null };
      } catch (err) {
        console.error('[agent] áudio falhou, indo em texto:', (err as Error).message);
      }
    }
    if (!sent) {
      try {
        const r = await sendText(wa, to, text);
        sent = { type: 'text', waMessageId: r.waMessageId, waMediaId: null, status: 'sent', error: null };
      } catch (err) {
        sent = { type: 'text', waMessageId: null, waMediaId: null, status: 'failed', error: (err as Error).message };
      }
    }
    const [msg] = await db.insert(schema.messages).values({
      accountId, conversationId: conv.id, direction: 'out', type: sent.type, body: text, status: sent.status,
      waMessageId: sent.waMessageId, waMediaId: sent.waMediaId, mimeType: sent.type === 'audio' ? 'audio/ogg' : null,
      error: sent.error, agentId: agent.id,
    }).returning();
    emitToAccount(accountId, 'message:new', {
      conversationId: conv.id,
      message: { ...msg, agentName: agent.name, mediaUrl: msg.waMediaId ? signedMediaPath(msg.id) : null },
    });
  }
  if (texts.length) {
    const [upd] = await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id)).returning();
    if (upd) conv = upd;
  }

  const why = parsed.reason ? ` Motivo: ${parsed.reason}` : '';
  if (action === 'flow' && flow) {
    const r = await startFlowForContact(accountId, flow.id, contact.id, { lastMessage: lastInbound?.transcript || lastInbound?.body || '', connectionId: conv.connectionId });
    await addTag(accountId, contact, agent.flowTag);
    const status = r === 'started' ? `disparou o fluxo “${flow.name}”.` : r === 'running' ? `pediu o fluxo “${flow.name}”, que já está em andamento para este contato.` : `tentou disparar o fluxo “${flow.name}”, mas ele não está ativo.`;
    await systemNote(accountId, conv.id, `🤖 ${agent.name} ${status}${why}`);
    await record(accountId, agent.id, conv.id, 'flow', parsed.reason || flow.name, tokens, audioChars);
  } else if (action === 'handoff') {
    await addTag(accountId, contact, agent.handoffTag);
    await handoff(accountId, conv, `🤖 ${agent.name} passou a conversa para a equipe.${why}`, agent.handoffDepartmentId);
    await record(accountId, agent.id, conv.id, 'handoff', parsed.reason || null, tokens, audioChars);
  } else {
    await record(accountId, agent.id, conv.id, 'replied', null, tokens, audioChars);
  }
}
