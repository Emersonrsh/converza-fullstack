/**
 * Ferramentas MCP: o que um assistente de IA (Claude, ChatGPT, Cursor, n8n...) pode fazer na conta
 * usando uma chave de API. Cada chave libera só as ferramentas marcadas em Configurações → Ferramentas MCP.
 */
import { z } from 'zod';
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { isUuid } from '../utils/http';
import { normalizePhone } from '../utils/phone';
import { findContactByPhone } from '../modules/contactStore';
import { STAGE_LABEL } from '../flows/types';

export type ToolGroup = 'contacts' | 'conversations' | 'messages' | 'tags' | 'flows' | 'sales';

export const GROUP_LABEL: Record<ToolGroup, string> = {
  contacts: 'Contatos', conversations: 'Conversas', messages: 'Enviar mensagens', tags: 'Etiquetas', flows: 'Fluxos', sales: 'Vendas e produtos',
};

export interface ToolCtx { accountId: string; keyId: string }
export interface ToolOut { result: Record<string, unknown>; summary: string }

/** Erro que vira resposta "isError" para o assistente (explica o que fazer). */
export class ToolError extends Error {}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  write: boolean;
  inputSchema: Record<string, unknown>;
  args: z.ZodTypeAny;
  run: (ctx: ToolCtx, args: any) => Promise<ToolOut>;
}

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
const WINDOW_MS = 24 * 3600_000;

const maskPhone = (p: string | null | undefined) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length > 6 ? `${d.slice(0, 4)}…${d.slice(-2)}` : '…';
};

const uuidArg = (label: string) => z.string({ required_error: `Informe ${label}` }).uuid(`${label} inválido`);

async function contactByRef(accountId: string, a: { contact_id?: string; phone?: string }) {
  if (a.contact_id) {
    if (!isUuid(a.contact_id)) throw new ToolError('contact_id inválido');
    const [c] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, a.contact_id), eq(schema.contacts.accountId, accountId))).limit(1);
    if (!c) throw new ToolError('Contato não encontrado nesta conta.');
    return c;
  }
  if (a.phone) {
    const p = normalizePhone(a.phone);
    if (!p) throw new ToolError('Telefone inválido. Use DDI + DDD + número (ex.: 5511988887777).');
    const c = await findContactByPhone(accountId, p);
    if (!c) throw new ToolError('Nenhum contato com esse telefone nesta conta.');
    return c;
  }
  throw new ToolError('Informe contact_id ou phone.');
}

const contactView = (c: typeof schema.contacts.$inferSelect) => ({
  id: c.id, name: c.name, phone: c.phone, email: c.email ?? null, tags: c.tags ?? [],
  stage: c.stage, stage_label: STAGE_LABEL[c.stage] ?? c.stage,
  created_at: c.createdAt, last_contact_at: c.lastContactAt ?? null,
});

/* ----------------------------------------------------------- catálogo */

export const TOOLS: ToolDef[] = [
  {
    name: 'list_contacts',
    title: 'Listar contatos',
    description: 'Lista contatos da conta (mais recentes primeiro). Filtra por texto (nome, telefone ou e-mail), etiqueta ou etapa do funil.',
    group: 'contacts', write: false,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Parte do nome, telefone ou e-mail' },
        tag: { type: 'string', description: 'Só contatos com esta etiqueta' },
        stage: { type: 'string', enum: ['new', 'in_service', 'negotiating', 'won', 'lost'], description: 'Etapa do funil' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
      additionalProperties: false,
    },
    args: z.object({
      search: z.string().trim().max(80).optional(), tag: z.string().trim().max(40).optional(),
      stage: z.enum(['new', 'in_service', 'negotiating', 'won', 'lost']).optional(),
      limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(100000).default(0),
    }),
    async run({ accountId }, a) {
      const conds: SQL[] = [eq(schema.contacts.accountId, accountId)];
      if (a.search) {
        const like = `%${a.search}%`;
        const digits = a.search.replace(/\D/g, '');
        conds.push(or(ilike(schema.contacts.name, like), ilike(schema.contacts.email, like), ...(digits.length >= 3 ? [ilike(schema.contacts.phone, `%${digits}%`)] : []))!);
      }
      if (a.tag) conds.push(sql`exists (select 1 from unnest(${schema.contacts.tags}) t where lower(t) = lower(${a.tag}))`);
      if (a.stage) conds.push(eq(schema.contacts.stage, a.stage));
      const list = await db.select().from(schema.contacts).where(and(...conds))
        .orderBy(desc(schema.contacts.createdAt)).limit(a.limit).offset(a.offset);
      return { result: { contacts: list.map(contactView), count: list.length, offset: a.offset }, summary: `${list.length} contato(s)` };
    },
  },
  {
    name: 'get_contact',
    title: 'Ver contato',
    description: 'Detalhes de um contato (por contact_id ou telefone): etiquetas, etapa, campos personalizados, origem, vendas e a conversa mais recente.',
    group: 'contacts', write: false,
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', format: 'uuid' },
        phone: { type: 'string', description: 'Telefone com DDI e DDD (ex.: 5511988887777)' },
      },
      additionalProperties: false,
    },
    args: z.object({ contact_id: z.string().optional(), phone: z.string().max(30).optional() }),
    async run({ accountId }, a) {
      const c = await contactByRef(accountId, a);
      const fields = await db.select({ key: schema.contactFields.key, label: schema.contactFields.label }).from(schema.contactFields)
        .where(eq(schema.contactFields.accountId, accountId)).orderBy(asc(schema.contactFields.position));
      const custom = (c.custom ?? {}) as Record<string, unknown>;
      const [conv] = await db.select({ id: schema.conversations.id, status: schema.conversations.status, lastMessageAt: schema.conversations.lastMessageAt })
        .from(schema.conversations).where(eq(schema.conversations.contactId, c.id)).orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
      const [s] = await rows<{ n: number; total: number }>(sql`select count(*)::int as n, coalesce(sum(amount), 0)::float as total
        from sales where contact_id = ${c.id} and status = 'approved'`);
      const [link] = c.trackingLinkId ? await db.select({ name: schema.trackingLinks.name }).from(schema.trackingLinks)
        .where(eq(schema.trackingLinks.id, c.trackingLinkId)).limit(1) : [];
      return {
        result: {
          contact: {
            ...contactView(c),
            fields: Object.fromEntries(fields.filter((f) => custom[f.key] != null && String(custom[f.key]).trim()).map((f) => [f.label, String(custom[f.key])])),
            origin: c.origin, from_ad: !!c.sourceId, tracking_link: link?.name ?? null,
            opted_out_of_broadcasts: !!c.optedOutAt,
          },
          sales: { approved: Number(s?.n ?? 0), total: Number(s?.total ?? 0) },
          last_conversation: conv ? { id: conv.id, status: conv.status, last_message_at: conv.lastMessageAt } : null,
        },
        summary: `contato ${maskPhone(c.phone)}`,
      };
    },
  },
  {
    name: 'list_conversations',
    title: 'Listar conversas',
    description: 'Conversas do WhatsApp, as mais recentes primeiro. Status: open (em atendimento), pending (aguardando), resolved (resolvidas).',
    group: 'conversations', write: false,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'pending', 'resolved'] },
        unread_only: { type: 'boolean', description: 'Só com mensagens não lidas' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    args: z.object({ status: z.enum(['open', 'pending', 'resolved']).optional(), unread_only: z.boolean().optional(), limit: z.number().int().min(1).max(50).default(20) }),
    async run({ accountId }, a) {
      const conds: SQL[] = [eq(schema.conversations.accountId, accountId)];
      if (a.status) conds.push(eq(schema.conversations.status, a.status));
      if (a.unread_only) conds.push(sql`${schema.conversations.unreadCount} > 0`);
      const list = await db.select({
        id: schema.conversations.id, status: schema.conversations.status, unread: schema.conversations.unreadCount,
        lastMessageAt: schema.conversations.lastMessageAt, botPaused: schema.conversations.botPaused,
        contactId: schema.contacts.id, name: schema.contacts.name, phone: schema.contacts.phone, assignee: schema.users.name,
      }).from(schema.conversations)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.conversations.contactId))
        .leftJoin(schema.users, eq(schema.users.id, schema.conversations.assignedUserId))
        .where(and(...conds)).orderBy(desc(schema.conversations.lastMessageAt)).limit(a.limit);
      return {
        result: {
          conversations: list.map((c) => ({
            id: c.id, status: c.status, unread: c.unread, last_message_at: c.lastMessageAt, automation_paused: c.botPaused,
            contact: { id: c.contactId, name: c.name, phone: c.phone }, assigned_to: c.assignee ?? null,
          })),
        },
        summary: `${list.length} conversa(s)`,
      };
    },
  },
  {
    name: 'get_messages',
    title: 'Ler mensagens',
    description: 'Mensagens de uma conversa (das mais antigas para as mais novas), com quem mandou. Diz também se a janela de 24h para responder está aberta.',
    group: 'conversations', write: false,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', format: 'uuid' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
      required: ['conversation_id'],
      additionalProperties: false,
    },
    args: z.object({ conversation_id: uuidArg('conversation_id'), limit: z.number().int().min(1).max(100).default(30) }),
    async run({ accountId }, a) {
      const [conv] = await db.select().from(schema.conversations)
        .where(and(eq(schema.conversations.id, a.conversation_id), eq(schema.conversations.accountId, accountId))).limit(1);
      if (!conv) throw new ToolError('Conversa não encontrada nesta conta.');
      const list = (await db.select({
        direction: schema.messages.direction, type: schema.messages.type, body: schema.messages.body, transcript: schema.messages.transcript,
        createdAt: schema.messages.createdAt, status: schema.messages.status, senderUserId: schema.messages.senderUserId, agentId: schema.messages.agentId,
        fileName: schema.messages.fileName,
      }).from(schema.messages).where(eq(schema.messages.conversationId, conv.id))
        .orderBy(desc(schema.messages.createdAt)).limit(a.limit)).reverse();
      const lastIn = [...list].reverse().find((m) => m.direction === 'in');
      const [li] = lastIn ? [lastIn] : await db.select({ createdAt: schema.messages.createdAt }).from(schema.messages)
        .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, 'in'))).orderBy(desc(schema.messages.createdAt)).limit(1);
      const [cn] = conv.connectionId ? await db.select({ provider: schema.connections.provider }).from(schema.connections)
        .where(eq(schema.connections.id, conv.connectionId)).limit(1) : [];
      return {
        result: {
          conversation_id: conv.id,
          // QR Code não tem a janela de 24h
          window_open: cn?.provider === 'web' || (!!li && Date.now() - new Date(li.createdAt).getTime() < WINDOW_MS),
          messages: list.map((m) => ({
            from: m.type === 'note' ? 'internal_note' : m.direction === 'in' ? 'customer' : m.agentId ? 'ai_agent' : m.senderUserId ? 'team' : 'automation',
            type: m.type,
            text: m.type === 'audio' && m.transcript ? `[áudio] ${m.transcript}` : m.body ?? (m.fileName ? `[${m.type}: ${m.fileName}]` : `[${m.type}]`),
            at: m.createdAt, status: m.direction === 'out' ? m.status : undefined,
          })),
        },
        summary: `${list.length} mensagem(ns)`,
      };
    },
  },
  {
    name: 'send_message',
    title: 'Enviar mensagem',
    description: 'Envia uma mensagem de texto no WhatsApp para um contato (por conversation_id, contact_id ou telefone). Só funciona dentro da janela de 24h (o cliente escreveu nas últimas 24 horas) — fora dela a Meta exige um modelo aprovado.',
    group: 'messages', write: true,
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', format: 'uuid' },
        contact_id: { type: 'string', format: 'uuid' },
        phone: { type: 'string' },
        text: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    args: z.object({
      conversation_id: z.string().optional(), contact_id: z.string().optional(), phone: z.string().max(30).optional(),
      text: z.string({ required_error: 'Informe o texto' }).trim().min(1, 'Texto vazio').max(4096),
    }),
    async run({ accountId }, a) {
      let conv: typeof schema.conversations.$inferSelect | undefined;
      if (a.conversation_id) {
        if (!isUuid(a.conversation_id)) throw new ToolError('conversation_id inválido');
        [conv] = await db.select().from(schema.conversations)
          .where(and(eq(schema.conversations.id, a.conversation_id), eq(schema.conversations.accountId, accountId))).limit(1);
        if (!conv) throw new ToolError('Conversa não encontrada nesta conta.');
      } else {
        const c = await contactByRef(accountId, a);
        [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.contactId, c.id))
          .orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
        if (!conv) throw new ToolError('Esse contato ainda não tem conversa no WhatsApp. A primeira mensagem precisa ser um modelo aprovado (use os Disparos).');
      }
      const { sendTextInConversation } = await import('./send');
      const r = await sendTextInConversation(accountId, conv, a.text);
      if (r.status === 'failed') throw new ToolError(`O WhatsApp não aceitou a mensagem: ${r.error}`);
      return { result: { sent: true, message_id: r.id, conversation_id: conv.id }, summary: `mensagem enviada (${a.text.length} letras)` };
    },
  },
  {
    name: 'list_tags',
    title: 'Listar etiquetas',
    description: 'Etiquetas da conta, com quantos contatos têm cada uma.',
    group: 'tags', write: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    args: z.object({}),
    async run({ accountId }) {
      const tags = await db.select({ name: schema.tags.name, color: schema.tags.color }).from(schema.tags)
        .where(eq(schema.tags.accountId, accountId)).orderBy(asc(schema.tags.name));
      const counts = await rows<{ name: string; n: number }>(sql`select lower(t) as name, count(*)::int as n from contacts, unnest(tags) as t where account_id = ${accountId} group by lower(t)`);
      const by = new Map(counts.map((c) => [c.name, Number(c.n)]));
      return { result: { tags: tags.map((t) => ({ name: t.name, contacts: by.get(t.name.toLowerCase()) ?? 0 })) }, summary: `${tags.length} etiqueta(s)` };
    },
  },
  {
    name: 'add_tag',
    title: 'Pôr etiqueta',
    description: 'Põe uma etiqueta (que já existe na conta) em um contato.',
    group: 'tags', write: true,
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string', format: 'uuid' }, phone: { type: 'string' }, tag: { type: 'string' } },
      required: ['tag'], additionalProperties: false,
    },
    args: z.object({ contact_id: z.string().optional(), phone: z.string().max(30).optional(), tag: z.string({ required_error: 'Informe a etiqueta' }).trim().min(1).max(40) }),
    async run({ accountId }, a) {
      const c = await contactByRef(accountId, a);
      const [tag] = await db.select({ name: schema.tags.name }).from(schema.tags)
        .where(and(eq(schema.tags.accountId, accountId), sql`lower(${schema.tags.name}) = lower(${a.tag})`)).limit(1);
      if (!tag) throw new ToolError(`A etiqueta “${a.tag}” não existe nesta conta. Use list_tags para ver as que existem.`);
      const has = (c.tags ?? []).some((t) => t.toLowerCase() === tag.name.toLowerCase());
      if (!has) {
        await db.update(schema.contacts).set({ tags: [...(c.tags ?? []), tag.name] }).where(eq(schema.contacts.id, c.id));
        const { emitToAccount } = await import('../realtime/io');
        emitToAccount(accountId, 'contacts:changed', { contactId: c.id });
      }
      return { result: { contact_id: c.id, tag: tag.name, already_had: has }, summary: `etiqueta ${tag.name}` };
    },
  },
  {
    name: 'remove_tag',
    title: 'Tirar etiqueta',
    description: 'Tira uma etiqueta de um contato.',
    group: 'tags', write: true,
    inputSchema: {
      type: 'object',
      properties: { contact_id: { type: 'string', format: 'uuid' }, phone: { type: 'string' }, tag: { type: 'string' } },
      required: ['tag'], additionalProperties: false,
    },
    args: z.object({ contact_id: z.string().optional(), phone: z.string().max(30).optional(), tag: z.string({ required_error: 'Informe a etiqueta' }).trim().min(1).max(40) }),
    async run({ accountId }, a) {
      const c = await contactByRef(accountId, a);
      const next = (c.tags ?? []).filter((t) => t.toLowerCase() !== a.tag.toLowerCase());
      const removed = next.length !== (c.tags ?? []).length;
      if (removed) {
        await db.update(schema.contacts).set({ tags: next }).where(eq(schema.contacts.id, c.id));
        const { emitToAccount } = await import('../realtime/io');
        emitToAccount(accountId, 'contacts:changed', { contactId: c.id });
      }
      return { result: { contact_id: c.id, removed }, summary: `etiqueta ${a.tag}` };
    },
  },
  {
    name: 'list_flows',
    title: 'Listar fluxos',
    description: 'Fluxos de automação da conta (nome, status e gatilho). Só fluxos ativos podem ser iniciados com start_flow.',
    group: 'flows', write: false,
    inputSchema: { type: 'object', properties: { active_only: { type: 'boolean', default: true } }, additionalProperties: false },
    args: z.object({ active_only: z.boolean().default(true) }),
    async run({ accountId }, a) {
      const list = await db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status, trigger: schema.flows.trigger })
        .from(schema.flows)
        .where(and(eq(schema.flows.accountId, accountId), isNull(schema.flows.archivedAt), ...(a.active_only ? [eq(schema.flows.status, 'active')] : [])))
        .orderBy(asc(schema.flows.name)).limit(200);
      return {
        result: { flows: list.map((f) => ({ id: f.id, name: f.name, status: f.status, trigger: (f.trigger as { type?: string } | null)?.type ?? 'any_message' })) },
        summary: `${list.length} fluxo(s)`,
      };
    },
  },
  {
    name: 'start_flow',
    title: 'Iniciar fluxo',
    description: 'Começa um fluxo ativo para um contato agora. As mensagens do fluxo seguem as regras do WhatsApp (fora da janela de 24h, só modelos aprovados chegam).',
    group: 'flows', write: true,
    inputSchema: {
      type: 'object',
      properties: { flow_id: { type: 'string', format: 'uuid' }, contact_id: { type: 'string', format: 'uuid' }, phone: { type: 'string' } },
      required: ['flow_id'], additionalProperties: false,
    },
    args: z.object({ flow_id: uuidArg('flow_id'), contact_id: z.string().optional(), phone: z.string().max(30).optional() }),
    async run({ accountId }, a) {
      const c = await contactByRef(accountId, a);
      const { startFlowForContact } = await import('../flows/runner');
      const r = await startFlowForContact(accountId, a.flow_id, c.id, {});
      if (r === 'inactive') throw new ToolError('Esse fluxo não existe, está pausado ou em rascunho. Use list_flows para ver os ativos.');
      return { result: { started: r === 'started', already_running: r === 'running', contact_id: c.id }, summary: r === 'started' ? 'fluxo iniciado' : 'fluxo já estava rodando' };
    },
  },
  {
    name: 'sales_summary',
    title: 'Resumo de vendas',
    description: 'Vendas dos últimos N dias: aprovadas, faturamento, pendentes, reembolsos e os produtos que mais venderam.',
    group: 'sales', write: false,
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }, additionalProperties: false },
    args: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    async run({ accountId }, a) {
      const from = new Date(Date.now() - a.days * 86_400_000);
      const byStatus = await rows<{ status: string; currency: string; n: number; total: number }>(sql`
        select status, currency, count(*)::int as n, coalesce(sum(amount), 0)::float as total
          from sales where account_id = ${accountId} and created_at >= ${from} group by status, currency`);
      const top = await rows<{ product: string; n: number; total: number }>(sql`
        select coalesce(product_name, 'Sem produto') as product, count(*)::int as n, coalesce(sum(amount), 0)::float as total
          from sales where account_id = ${accountId} and created_at >= ${from} and status = 'approved'
         group by 1 order by 3 desc limit 10`);
      const pick = (st: string) => byStatus.filter((r) => r.status === st);
      const sum = (list: typeof byStatus) => ({ count: list.reduce((x, r) => x + Number(r.n), 0), by_currency: list.map((r) => ({ currency: r.currency, total: Number(r.total) })) });
      return {
        result: { days: a.days, approved: sum(pick('approved')), pending: sum(pick('pending')), refunded: sum(pick('refunded')), refused: sum(pick('refused')), top_products: top },
        summary: `vendas de ${a.days} dia(s)`,
      };
    },
  },
  {
    name: 'list_products',
    title: 'Listar produtos',
    description: 'Produtos cadastrados (nome, preço e link de pagamento).',
    group: 'sales', write: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    args: z.object({}),
    async run({ accountId }) {
      const list = await db.select().from(schema.products).where(eq(schema.products.accountId, accountId)).orderBy(asc(schema.products.name)).limit(300);
      return {
        result: { products: list.map((p) => ({ id: p.id, name: p.name, price: Number(p.price), checkout_url: p.checkoutUrl ?? null })) },
        summary: `${list.length} produto(s)`,
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

/** Catálogo para a tela (sem os esquemas). */
export function toolCatalog() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, group: t.group, groupLabel: GROUP_LABEL[t.group], write: t.write }));
}

/** Formato do tools/list do MCP. */
export function mcpToolList(allowed: string[]) {
  return TOOLS.filter((t) => allowed.includes(t.name)).map((t) => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: false, idempotentHint: !t.write || t.name.endsWith('_tag'), openWorldHint: t.name === 'send_message' || t.name === 'start_flow' },
  }));
}
