/**
 * Webhooks de entrada — execução: cota do plano, registro de cada evento e as ações
 * (contato, etiquetas, Kanban, venda, modelo de mensagem e fluxo), com o resultado de cada uma.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { isUuid } from '../utils/http';
import { findContactByPhone } from './contactStore';
import { recordSale } from './salesStore';
import { upsertContactCard } from './kanbanStore';
import { firePixels } from '../pixels/sender';
import { ensureConversation } from './conversationStore';
import { webhookQuotaFor } from './plans';
import { onPaymentApproved, startFlowForContact, triggerFlowsForInbound } from '../flows/runner';
import { sendTemplate, sendText } from '../whatsapp/cloud-api';
import {
  brl, buildTemplate, conditionText, conditionsMatch, detectMapping, flowVars, resolve, SALE_STATUS_LABEL,
  type Resolved, type WebhookActions, type WebhookCondition, type WebhookMapping,
} from './webhookEngine';

export type WebhookRow = typeof schema.webhooks.$inferSelect;
export type WebhookEventRow = typeof schema.webhookEvents.$inferSelect;
type ContactRow = typeof schema.contacts.$inferSelect;

export interface ActionResult {
  kind: 'condition' | 'contact' | 'tags' | 'kanban' | 'sale' | 'template' | 'flow' | 'flows' | 'quota' | 'error';
  ok: boolean;
  /** deu certo, mas com um porém (ex.: fluxo fora da janela de 24h) */
  warn?: boolean;
  text: string;
}

const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];
const PENDING_DAYS = 7;
const KEEP_EVENTS = 300;

/* -------------------------------------------------------------- consumo */

export interface Usage { used: number; limit: number; month: string; active: boolean; instances: number }

async function monthKey(accountId: string): Promise<string> {
  const [r] = await rows<{ m: string }>(sql`
    select to_char(now() at time zone coalesce((select timezone from accounts where id = ${accountId}), 'America/Sao_Paulo'), 'YYYY-MM') as m`);
  return r?.m ?? new Date().toISOString().slice(0, 7);
}

/** Eventos processados no mês (fuso da conta) e o limite do plano. */
export async function usageOf(accountId: string): Promise<Usage> {
  const [sub] = await db.select({ instances: schema.subscriptions.instances, status: schema.subscriptions.status }).from(schema.subscriptions)
    .where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const active = sub?.status === 'active';
  const month = await monthKey(accountId);
  const [u] = await db.select({ count: schema.webhookUsage.count }).from(schema.webhookUsage)
    .where(and(eq(schema.webhookUsage.accountId, accountId), eq(schema.webhookUsage.month, month))).limit(1);
  return { used: u?.count ?? 0, limit: webhookQuotaFor(sub?.instances, active), month, active, instances: sub?.instances ?? 0 };
}

async function bumpUsage(accountId: string, month: string) {
  await db.insert(schema.webhookUsage).values({ accountId, month, count: 1 })
    .onConflictDoUpdate({ target: [schema.webhookUsage.accountId, schema.webhookUsage.month], set: { count: sql`${schema.webhookUsage.count} + 1` } });
}

/* ------------------------------------------------------------ formato */

export function publicEvent(e: WebhookEventRow & { contactName?: string | null }, withPayload = false) {
  return {
    id: e.id, webhookId: e.webhookId, status: e.status, summary: e.summary, results: e.results as ActionResult[],
    contactId: e.contactId, contactName: e.contactName ?? null, createdAt: e.createdAt, processedAt: e.processedAt,
    ...(withPayload ? { payload: e.payload } : {}),
  };
}

function emitEvent(e: WebhookEventRow, contactName: string | null = null) {
  emitToAccount(e.accountId, 'webhook:event', { webhookId: e.webhookId, event: publicEvent({ ...e, contactName }) });
}

async function finish(e: WebhookEventRow, patch: Partial<typeof schema.webhookEvents.$inferInsert>, contactName: string | null = null) {
  const [row] = await db.update(schema.webhookEvents).set({ ...patch, processedAt: new Date() })
    .where(eq(schema.webhookEvents.id, e.id)).returning();
  const out = row ?? e;
  await db.update(schema.webhooks).set({ lastEventAt: out.createdAt, lastStatus: out.status })
    .where(eq(schema.webhooks.id, out.webhookId));
  emitEvent(out, contactName);
  return out;
}

/** Guarda só os eventos mais recentes de cada webhook. */
async function prune(webhookId: string) {
  if (Math.random() > 0.05) return;
  await db.execute(sql`
    delete from webhook_events where webhook_id = ${webhookId} and id not in (
      select id from webhook_events where webhook_id = ${webhookId} order by created_at desc limit ${KEEP_EVENTS})`);
}

/* -------------------------------------------------------------- recebimento */

/** Registra a chamada recebida (o processamento vem depois, na fila). */
export async function recordIncoming(w: WebhookRow, payload: Record<string, unknown>, opts: { emptyReason?: string } = {}) {
  const empty = !Object.keys(payload).length;
  const status = !w.enabled ? 'paused' : empty ? 'error' : 'queued';
  const summary = !w.enabled ? 'Recebido com o webhook pausado — nada foi feito.'
    : empty ? opts.emptyReason ?? 'Chegou uma chamada sem dados (nem corpo, nem parâmetros na URL).' : null;
  const [e] = await db.insert(schema.webhookEvents).values({
    accountId: w.accountId, webhookId: w.id, status, payload, summary, ...(status !== 'queued' ? { processedAt: new Date() } : {}),
  }).returning();
  await db.update(schema.webhooks).set({
    hits: sql`${schema.webhooks.hits} + 1`, lastEventAt: e.createdAt, lastStatus: status,
    // o primeiro evento vira o exemplo do mapeamento
    ...(!w.sample && !empty ? { sample: payload, sampleAt: new Date() } : {}),
  }).where(eq(schema.webhooks.id, w.id));
  emitEvent(e);
  void prune(w.id).catch(() => {});
  return e;
}

export async function markWebhookEventFailed(eventId: string, message: string) {
  const [e] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, eventId)).limit(1);
  if (!e || !['queued'].includes(e.status)) return;
  await finish(e, { status: 'error', summary: `Erro ao processar: ${message}`, results: [{ kind: 'error', ok: false, text: message }] });
}

/* ---------------------------------------------------------------- ações */

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const fmtPhone = (p: string) => (p.startsWith('55') && p.length >= 12 ? `+55 ${p.slice(2, 4)} ${p.slice(4, -4)}-${p.slice(-4)}` : `+${p}`);

/** Conexão por QR Code: não há janela de 24h (dá para escrever a qualquer momento). */
async function isWebConnection(connectionId: string | null | undefined) {
  if (!connectionId || !isUuid(connectionId)) return false;
  const [c] = await db.select({ provider: schema.connections.provider }).from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
  return c?.provider === 'web';
}

async function windowOpen(contactId: string) {
  const [r] = await rows<{ at: Date | null }>(sql`
    select max(m.created_at) as at from messages m join conversations v on v.id = m.conversation_id
    where v.contact_id = ${contactId} and m.direction = 'in'`);
  return !!r?.at && Date.now() - new Date(r.at).getTime() < 24 * 3600_000;
}

/** Campos personalizados que existem na conta (os outros são ignorados). */
async function validFields(accountId: string, fields: Record<string, string>) {
  const keys = Object.keys(fields);
  if (!keys.length) return {};
  const ok = await db.select({ key: schema.contactFields.key }).from(schema.contactFields)
    .where(and(eq(schema.contactFields.accountId, accountId), inArray(schema.contactFields.key, keys)));
  return Object.fromEntries(ok.map((f) => [f.key, fields[f.key]]));
}

async function upsertContact(w: WebhookRow, r: Resolved, overwrite: boolean): Promise<{ contact: ContactRow; created: boolean; changed: string[] }> {
  const phone = r.phone!;
  const fields = await validFields(w.accountId, r.fields);
  const known = await findContactByPhone(w.accountId, phone);
  if (known) {
    const patch: Partial<typeof schema.contacts.$inferInsert> = {};
    const changed: string[] = [];
    const placeholder = !known.name || known.name === known.phone || known.name === 'Cliente';
    if (r.name && r.name !== known.name && (overwrite || placeholder)) { patch.name = r.name; changed.push('nome'); }
    if (r.email && r.email !== known.email && (overwrite || !known.email)) { patch.email = r.email; changed.push('e-mail'); }
    const custom = { ...((known.custom ?? {}) as Record<string, unknown>) };
    let customChanged = false;
    for (const [k, v] of Object.entries(fields)) {
      if (custom[k] === v || (!overwrite && custom[k] != null && custom[k] !== '')) continue;
      custom[k] = v; customChanged = true;
    }
    if (customChanged) { patch.custom = custom; changed.push('campos'); }
    if (!Object.keys(patch).length) return { contact: known, created: false, changed };
    const [u] = await db.update(schema.contacts).set(patch).where(eq(schema.contacts.id, known.id)).returning();
    return { contact: u ?? known, created: false, changed };
  }
  const [c] = await db.insert(schema.contacts).values({
    accountId: w.accountId, name: r.name || phone, phone, waId: phone, email: r.email, origin: 'webhook',
    custom: fields, firstConnectionId: w.connectionId,
  }).onConflictDoUpdate({
    target: [schema.contacts.accountId, schema.contacts.phone],
    set: { email: sql`coalesce(${schema.contacts.email}, excluded.email)` },
  }).returning();
  return { contact: c, created: true, changed: [] };
}

async function applyTags(contact: ContactRow, add: string[], remove: string[]) {
  let tags = [...contact.tags];
  const added: string[] = [];
  for (const t of add.map((x) => x.trim()).filter(Boolean)) {
    if (!tags.some((x) => norm(x) === norm(t))) { tags.push(t.slice(0, 40)); added.push(t); }
  }
  const before = tags.length;
  tags = tags.filter((x) => !remove.some((r) => norm(r) === norm(x)));
  const removed = before - tags.length;
  if (added.length || removed) {
    const [u] = await db.update(schema.contacts).set({ tags }).where(eq(schema.contacts.id, contact.id)).returning();
    if (u) contact.tags = u.tags;
    // etiqueta nova entra no catálogo da conta (sem duplicar "Cliente" e "cliente")
    for (const name of added) {
      await db.execute(sql`
        insert into tags (account_id, name) select ${contact.accountId}, ${name.slice(0, 40)}
        where not exists (select 1 from tags where account_id = ${contact.accountId} and lower(name) = lower(${name.slice(0, 40)}))
        on conflict do nothing`).catch(() => {});
    }
  }
  return { added, removed };
}

async function sendTemplateAction(w: WebhookRow, contact: ContactRow, a: NonNullable<WebhookActions['template']>, payload: unknown, r: Resolved): Promise<ActionResult> {
  if (!w.connectionId) return { kind: 'template', ok: false, text: 'Modelo não enviado: escolha a conexão de WhatsApp do webhook.' };
  const [conn] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.id, w.connectionId), eq(schema.connections.accountId, w.accountId))).limit(1);
  if (!conn) return { kind: 'template', ok: false, text: 'Modelo não enviado: a conexão do webhook não existe mais.' };
  const plan = buildTemplate(a, payload, r, contact.name !== contact.phone ? contact.name : r.name);
  let conv = await ensureConversation(w.accountId, contact.id, conn.id);
  if (conv.connectionId !== conn.id) {
    const [u] = await db.update(schema.conversations).set({ connectionId: conn.id }).where(eq(schema.conversations.id, conv.id)).returning();
    if (u) conv = u;
  }
  let status: 'sent' | 'failed' = 'sent';
  let waMessageId: string | null = null;
  let error: string | null = null;
  // QR Code não tem modelos da Meta: o texto do modelo (com as variáveis) vai como mensagem normal
  const web = conn.provider === 'web';
  try {
    const wa = { phoneNumberId: conn.phoneNumberId, accessToken: conn.accessToken };
    const res = web
      ? await sendText(wa, contact.waId ?? contact.phone, plan.preview)
      : await sendTemplate(wa, contact.waId ?? contact.phone, {
        name: plan.name, language: plan.language, body: plan.body, header: plan.header, buttons: plan.buttons,
      });
    waMessageId = res.waMessageId;
    if (res.waId && res.waId !== contact.waId) await db.update(schema.contacts).set({ waId: res.waId }).where(eq(schema.contacts.id, contact.id));
  } catch (err) {
    status = 'failed';
    error = (err as Error).message;
  }
  const media = !web && plan.header && plan.header.type !== 'text' ? plan.header : null;
  const [msg] = await db.insert(schema.messages).values({
    accountId: w.accountId, conversationId: conv.id, direction: 'out', type: web ? 'text' : 'template', body: plan.preview,
    mediaUrl: media?.link ?? null, mimeType: media ? `${media.type}/*` : null, status, waMessageId, error,
  }).returning();
  await db.update(schema.conversations).set({ lastMessageAt: new Date() }).where(eq(schema.conversations.id, conv.id));
  emitToAccount(w.accountId, 'message:new', { conversationId: conv.id, message: msg });
  const empty = plan.empty.length ? ` (vazio: ${plan.empty.join(', ')})` : '';
  return status === 'sent'
    ? { kind: 'template', ok: true, warn: !!plan.empty.length, text: `Modelo “${a.name}” enviado${empty}.` }
    : { kind: 'template', ok: false, text: `Modelo “${a.name}” não enviado: ${error}` };
}

async function flowAction(w: WebhookRow, contact: ContactRow, flowId: string, r: Resolved, templateSent: boolean): Promise<ActionResult> {
  const [flow] = isUuid(flowId) ? await db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status, archivedAt: schema.flows.archivedAt })
    .from(schema.flows).where(and(eq(schema.flows.id, flowId), eq(schema.flows.accountId, w.accountId))).limit(1) : [];
  if (!flow) return { kind: 'flow', ok: false, text: 'Fluxo não iniciado: o fluxo escolhido não existe mais.' };
  if (flow.status !== 'active' || flow.archivedAt) return { kind: 'flow', ok: false, text: `Fluxo “${flow.name}” não iniciado: ele está pausado.` };
  const vars = flowVars(r);
  const open = (await isWebConnection(w.connectionId)) || await windowOpen(contact.id);
  if (!open && templateSent) {
    // fora da janela: o fluxo começa quando o cliente responder o modelo
    await db.insert(schema.flowPending).values({
      contactId: contact.id, accountId: w.accountId, flowId: flow.id, connectionId: w.connectionId, webhookId: w.id, vars,
      expiresAt: new Date(Date.now() + PENDING_DAYS * 86400_000),
    }).onConflictDoUpdate({
      target: schema.flowPending.contactId,
      set: { flowId: flow.id, connectionId: w.connectionId, webhookId: w.id, vars, expiresAt: new Date(Date.now() + PENDING_DAYS * 86400_000), createdAt: new Date() },
    });
    return { kind: 'flow', ok: true, text: `Fluxo “${flow.name}” começa quando o cliente responder o modelo (até ${PENDING_DAYS} dias).` };
  }
  const res = await startFlowForContact(w.accountId, flow.id, contact.id, { lastMessage: r.event ?? 'webhook', connectionId: w.connectionId, vars });
  if (res === 'inactive') return { kind: 'flow', ok: false, text: `Fluxo “${flow.name}” não iniciado: ele está pausado.` };
  if (res === 'running') return { kind: 'flow', ok: true, warn: true, text: `Fluxo “${flow.name}” já estava em andamento para este contato.` };
  return open
    ? { kind: 'flow', ok: true, text: `Fluxo “${flow.name}” iniciado.` }
    : { kind: 'flow', ok: true, warn: true, text: `Fluxo “${flow.name}” iniciado, mas o cliente não falou com você nas últimas 24h: as mensagens de texto do fluxo só chegam se ele responder. Use um modelo de mensagem para abrir a conversa.` };
}

/* ------------------------------------------------------------ processamento */

interface ProcessOpts { reprocess?: boolean }

/** Processa um evento recebido: condições → contato → etiquetas → Kanban → venda → modelo → fluxo. */
export async function processWebhookEvent(eventId: string, opts: ProcessOpts = {}): Promise<WebhookEventRow | null> {
  const [e] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, eventId)).limit(1);
  if (!e) return null;
  if (!opts.reprocess && e.status !== 'queued') return e; // já processado (job repetido)
  const [w] = await db.select().from(schema.webhooks).where(eq(schema.webhooks.id, e.webhookId)).limit(1);
  if (!w) return null;
  if (opts.reprocess) await db.update(schema.webhookEvents).set({ status: 'queued' }).where(eq(schema.webhookEvents.id, e.id));

  const payload = (e.payload ?? {}) as Record<string, unknown>;
  let mapping = (w.mapping ?? {}) as WebhookMapping;
  // webhook ainda sem mapeamento: usa (e guarda) o que foi detectado neste evento
  if (!Object.keys(mapping).length) {
    mapping = detectMapping(payload);
    if (Object.keys(mapping).length) await db.update(schema.webhooks).set({ mapping }).where(eq(schema.webhooks.id, w.id));
  }
  const r = resolve(payload, mapping);

  // a plataforma reenviou o mesmo pedido com o mesmo status (Kiwify, Hotmart… reenviam): não repete as ações
  const dedupeKey = r.transaction && r.statusRaw ? `${r.transaction}|${norm(r.statusRaw)}`.slice(0, 300) : null;
  if (dedupeKey && !opts.reprocess) {
    const [dup] = await db.select({ id: schema.webhookEvents.id }).from(schema.webhookEvents).where(and(
      eq(schema.webhookEvents.webhookId, w.id), eq(schema.webhookEvents.dedupeKey, dedupeKey),
      inArray(schema.webhookEvents.status, ['processed', 'partial']), sql`${schema.webhookEvents.id} <> ${e.id}`,
      sql`${schema.webhookEvents.createdAt} > now() - interval '7 days'`,
    )).limit(1);
    if (dup) {
      return finish(e, {
        status: 'skipped', dedupeKey,
        summary: `Repetido: o pedido ${r.transaction} com este status já foi processado (a plataforma reenviou).`,
        results: [{ kind: 'condition', ok: true, text: 'Evento repetido — nada foi feito de novo. Use “Reprocessar” se quiser executar mesmo assim.' }],
      });
    }
  }

  const usage = await usageOf(w.accountId);
  if (usage.used >= usage.limit) {
    return finish(e, {
      status: 'blocked',
      summary: !usage.active ? 'Não processado: a assinatura está inativa.' : `Não processado: o limite de ${usage.limit.toLocaleString('pt-BR')} eventos do mês acabou.`,
      results: [{ kind: 'quota', ok: false, text: 'Contrate mais instâncias e use “Reprocessar” para executar este evento.' }],
    });
  }
  await bumpUsage(w.accountId, usage.month);

  const actions = (w.actions ?? {}) as WebhookActions;
  const results: ActionResult[] = [];
  try {
    const cond = conditionsMatch((w.conditions ?? []) as WebhookCondition[], payload, r);
    if (!cond.ok) {
      return finish(e, {
        status: 'skipped', summary: `Ignorado pela condição ${conditionText(cond.failed)} (veio “${cond.got || 'vazio'}”).`,
        results: [{ kind: 'condition', ok: true, text: `Condição não atendida: ${conditionText(cond.failed)}.` }],
      });
    }
    if (!r.phone) {
      return finish(e, {
        status: 'error',
        summary: r.rawPhone ? `O telefone “${r.rawPhone}” não é válido.` : 'Não achei o telefone do lead neste evento. Escolha o campo do telefone no mapeamento.',
        results: [{ kind: 'contact', ok: false, text: 'Sem telefone, nenhuma ação foi executada.' }],
      });
    }

    const { contact, created, changed } = await upsertContact(w, r, !!actions.overwrite);
    if (created) void firePixels(w.accountId, 'lead', { contactId: contact.id, isNew: true, fromAd: false, channel: 'webhook' });
    results.push({
      kind: 'contact', ok: true,
      text: `${created ? 'Contato criado' : changed.length ? `Contato atualizado (${changed.join(', ')})` : 'Contato já existia'}: ${contact.name} · ${fmtPhone(contact.phone)}${r.detected.length ? ' · dados achados automaticamente' : ''}`,
    });

    if (actions.tags?.length || actions.removeTags?.length) {
      const t = await applyTags(contact, actions.tags ?? [], actions.removeTags ?? []);
      results.push({ kind: 'tags', ok: true, text: t.added.length || t.removed ? `Etiquetas: ${[...t.added.map((x) => `+${x}`), ...(t.removed ? [`−${t.removed}`] : [])].join(' ')}` : 'Etiquetas: o contato já tinha.' });
    }

    if (actions.kanban?.boardId && actions.kanban.columnId) {
      const k = await upsertContactCard(w.accountId, contact.id, actions.kanban.boardId, actions.kanban.columnId);
      if ('error' in k) results.push({ kind: 'kanban', ok: false, text: `Kanban: ${k.error}.` });
      else {
        const [col] = await db.select({ name: schema.kanbanColumns.name, board: schema.kanbanBoards.name }).from(schema.kanbanColumns)
          .innerJoin(schema.kanbanBoards, eq(schema.kanbanBoards.id, schema.kanbanColumns.boardId))
          .where(eq(schema.kanbanColumns.id, actions.kanban.columnId)).limit(1);
        const where = col ? `${col.board} › ${col.name}` : 'Kanban';
        results.push({ kind: 'kanban', ok: true, text: k.created ? `Card criado em ${where}.` : k.moved ? `Card movido para ${where}.` : `Card já estava em ${where}.` });
      }
    }

    if (actions.sale !== false && r.amount > 0) {
      await recordSale({
        accountId: w.accountId, contactId: contact.id, amount: r.amount, status: r.status, currency: r.currency,
        productName: r.product, externalId: r.transaction, state: r.state, connectionId: w.connectionId,
        webhookId: w.id, origin: 'webhook', customerName: contact.name, customerPhone: contact.phone,
      });
      results.push({ kind: 'sale', ok: true, text: `Venda registrada: R$ ${brl(r.amount)}${r.product ? ` · ${r.product}` : ''} (${SALE_STATUS_LABEL[r.status]}).` });
      if (r.status === 'approved') await onPaymentApproved(w.accountId, contact.id);
    }

    let templateSent = false;
    if (actions.template?.name) {
      const t = await sendTemplateAction(w, contact, actions.template, payload, r);
      templateSent = t.ok;
      results.push(t);
    }

    if (actions.flowId) results.push(await flowAction(w, contact, actions.flowId, r, templateSent));

    // fluxos com o gatilho "Webhook recebido" (deste webhook ou de qualquer um)
    const started = await triggerFlowsForInbound({
      accountId: w.accountId, contactId: contact.id, text: r.event || 'webhook', source: 'webhook', webhookId: w.id,
      connectionId: w.connectionId, vars: flowVars(r), excludeFlowIds: actions.flowId ? [actions.flowId] : [],
    });
    if (started) results.push({ kind: 'flows', ok: true, text: 'Fluxos com o gatilho “Webhook recebido” iniciados.' });

    emitToAccount(w.accountId, 'contacts:changed', { contactId: contact.id });
    const failed = results.filter((x) => !x.ok).length;
    const parts = results.filter((x) => x.kind !== 'contact' && x.ok).map((x) => ({ tags: 'etiquetas', kanban: 'Kanban', sale: 'venda', template: 'modelo', flow: 'fluxo', flows: 'fluxos' } as Record<string, string>)[x.kind]).filter(Boolean);
    return finish(e, {
      status: failed ? 'partial' : 'processed', contactId: contact.id, results, dedupeKey,
      summary: `${contact.name} · ${fmtPhone(contact.phone)}${created ? ' (novo)' : ''}${parts.length ? ` — ${parts.join(', ')}` : ''}${failed ? ` · ${failed} ${failed === 1 ? 'ação falhou' : 'ações falharam'}` : ''}`,
    }, contact.name);
  } catch (err) {
    console.error('[webhooks] evento', e.id, (err as Error).message);
    results.push({ kind: 'error', ok: false, text: (err as Error).message });
    return finish(e, { status: 'error', summary: `Erro ao processar: ${(err as Error).message}`, results });
  }
}

/* ---------------------------------------------------------------- simulação */

export interface DryRunStep { kind: ActionResult['kind']; ok: boolean; warn?: boolean; text: string }

/** O que aconteceria com este evento (sem executar nada). */
export async function dryRun(w: WebhookRow, payload: Record<string, unknown>, cfg: { mapping: WebhookMapping; conditions: WebhookCondition[]; actions: WebhookActions; connectionId: string | null }) {
  const mapping = Object.keys(cfg.mapping).length ? cfg.mapping : detectMapping(payload);
  const r = resolve(payload, mapping);
  const steps: DryRunStep[] = [];
  const cond = conditionsMatch(cfg.conditions, payload, r);
  if (!cond.ok) {
    steps.push({ kind: 'condition', ok: false, text: `Seria ignorado: ${conditionText(cond.failed)} — neste evento veio “${cond.got || 'vazio'}”.` });
    return { resolved: r, steps, matched: false };
  }
  if (!r.phone) {
    steps.push({ kind: 'contact', ok: false, text: r.rawPhone ? `O telefone “${r.rawPhone}” não é válido.` : 'Não achei o telefone do lead: escolha o campo do telefone.' });
    return { resolved: r, steps, matched: true };
  }
  const known = await findContactByPhone(w.accountId, r.phone);
  steps.push({ kind: 'contact', ok: true, text: known ? `Atualizar o contato ${known.name} (${fmtPhone(r.phone)})` : `Criar o contato ${r.name || r.phone} (${fmtPhone(r.phone)})` });
  const a = cfg.actions;
  if (a.tags?.length) steps.push({ kind: 'tags', ok: true, text: `Adicionar as etiquetas ${a.tags.join(', ')}` });
  if (a.removeTags?.length) steps.push({ kind: 'tags', ok: true, text: `Tirar as etiquetas ${a.removeTags.join(', ')}` });
  if (a.kanban?.boardId && a.kanban.columnId) {
    const [col] = await db.select({ name: schema.kanbanColumns.name, board: schema.kanbanBoards.name }).from(schema.kanbanColumns)
      .innerJoin(schema.kanbanBoards, eq(schema.kanbanBoards.id, schema.kanbanColumns.boardId))
      .where(and(eq(schema.kanbanColumns.id, a.kanban.columnId), eq(schema.kanbanColumns.accountId, w.accountId))).limit(1);
    steps.push(col ? { kind: 'kanban', ok: true, text: `Colocar no Kanban ${col.board} › ${col.name}` } : { kind: 'kanban', ok: false, text: 'A coluna do Kanban escolhida não existe mais' });
  }
  if (a.sale !== false && r.amount > 0) steps.push({ kind: 'sale', ok: true, text: `Registrar venda de R$ ${brl(r.amount)}${r.product ? ` · ${r.product}` : ''} (${SALE_STATUS_LABEL[r.status]})` });
  if (a.template?.name) {
    if (!cfg.connectionId) steps.push({ kind: 'template', ok: false, text: 'Mandar o modelo: escolha a conexão de WhatsApp do webhook' });
    else {
      const plan = buildTemplate(a.template, payload, r, known && known.name !== known.phone ? known.name : r.name);
      steps.push({ kind: 'template', ok: true, warn: !!plan.empty.length, text: `Mandar o modelo “${a.template.name}”: ${plan.preview}${plan.empty.length ? ` (vazio: ${plan.empty.join(', ')})` : ''}` });
    }
  }
  if (a.flowId) {
    const [flow] = isUuid(a.flowId) ? await db.select({ name: schema.flows.name, status: schema.flows.status })
      .from(schema.flows).where(and(eq(schema.flows.id, a.flowId), eq(schema.flows.accountId, w.accountId))).limit(1) : [];
    if (!flow) steps.push({ kind: 'flow', ok: false, text: 'O fluxo escolhido não existe mais' });
    else if (flow.status !== 'active') steps.push({ kind: 'flow', ok: false, text: `O fluxo “${flow.name}” está pausado` });
    else {
      const open = (await isWebConnection(cfg.connectionId)) || (known ? await windowOpen(known.id) : false);
      steps.push(open ? { kind: 'flow', ok: true, text: `Iniciar o fluxo “${flow.name}” agora` }
        : a.template?.name && cfg.connectionId ? { kind: 'flow', ok: true, text: `Iniciar o fluxo “${flow.name}” quando o cliente responder o modelo` }
          : { kind: 'flow', ok: true, warn: true, text: `Iniciar o fluxo “${flow.name}” — sem conversa nas últimas 24h, as mensagens de texto só chegam se o cliente responder` });
    }
  }
  return { resolved: r, steps, matched: true };
}

/** Eventos de um webhook (mais recentes primeiro), com o nome do contato. */
export async function listEvents(webhookId: string, opts: { status?: string | null; before?: string | null; limit?: number }) {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const conds = [eq(schema.webhookEvents.webhookId, webhookId)];
  if (opts.status === 'failed') conds.push(inArray(schema.webhookEvents.status, ['error', 'partial', 'blocked']));
  else if (opts.status) conds.push(eq(schema.webhookEvents.status, opts.status));
  if (opts.before && !Number.isNaN(Date.parse(opts.before))) conds.push(sql`${schema.webhookEvents.createdAt} < ${new Date(opts.before)}`);
  const list = await db.select({ e: schema.webhookEvents, contactName: schema.contacts.name }).from(schema.webhookEvents)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.webhookEvents.contactId))
    .where(and(...conds)).orderBy(desc(schema.webhookEvents.createdAt)).limit(limit + 1);
  return { events: list.slice(0, limit).map((x) => publicEvent({ ...x.e, contactName: x.contactName })), hasMore: list.length > limit };
}
