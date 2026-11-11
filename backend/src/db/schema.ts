import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, integer, numeric, boolean, date, doublePrecision,
  timestamp, jsonb, index, uniqueIndex, primaryKey, serial, customType, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/** arquivo guardado no próprio banco (anexos das respostas rápidas) */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/* ---------- enums ---------- */
export const roleEnum = pgEnum('role', ['owner', 'admin', 'agent']);
export const connStatusEnum = pgEnum('connection_status', ['connected', 'disconnected', 'pending']);
export const contactStageEnum = pgEnum('contact_stage', ['new', 'in_service', 'negotiating', 'won', 'lost']);
export const convStatusEnum = pgEnum('conversation_status', ['open', 'pending', 'resolved']);
export const directionEnum = pgEnum('message_direction', ['in', 'out']);
export const msgTypeEnum = pgEnum('message_type', ['text', 'image', 'audio', 'video', 'document', 'template', 'note', 'location', 'sticker', 'contacts', 'unsupported']);
export const msgStatusEnum = pgEnum('message_status', ['queued', 'sent', 'delivered', 'read', 'failed']);
export const flowStatusEnum = pgEnum('flow_status', ['draft', 'active', 'paused']);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'scheduled', 'sending', 'done', 'canceled', 'paused', 'failed']);
export const saleStatusEnum = pgEnum('sale_status', ['pending', 'approved', 'refused', 'refunded']);
export const subStatusEnum = pgEnum('subscription_status', ['inactive', 'active', 'past_due', 'canceled']);
/** Colunas do Kanban: em andamento, ganho (conta como conversão) ou perdido. */
export const kanbanColumnKindEnum = pgEnum('kanban_column_kind', ['open', 'won', 'lost']);

/* ---------- tenancy ---------- */
export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  subscriptionStatus: subStatusEnum('subscription_status').notNull().default('inactive'),
  // preferências da conta (ex.: { dashboard: { gatewayFeePercent, taxPercent } })
  settings: jsonb('settings').notNull().default({}),
  // programa de parceiros: código de indicação desta conta e quem indicou
  referralCode: text('referral_code').unique(),
  referredBy: uuid('referred_by').references((): AnyPgColumn => accounts.id, { onDelete: 'set null' }),
  /** número curto da conta (para o suporte: "ID da conta 21572") */
  number: serial('number').notNull(),
  description: text('description').notNull().default(''),
  /** e-mail ao dono quando um número desconecta ou fica restrito */
  notifyInstanceEmail: boolean('notify_instance_email').notNull().default(true),
  /** suspensa pelo dono da plataforma (painel da plataforma): ninguém da empresa entra e os números não enviam */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedReason: text('suspended_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  /** aceite dos Termos de Uso e da Política de Privacidade no cadastro (e a versão aceita) */
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  termsVersion: text('terms_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull().default('agent'),
  /** setor do membro: as conversas mandadas para o setor ficam na fila dele */
  departmentId: uuid('department_id').references((): AnyPgColumn => departments.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userAccount: uniqueIndex('memberships_user_account_uq').on(t.userId, t.accountId),
  byAccount: index('memberships_account_idx').on(t.accountId),
}));

/* ---------- channels ---------- */
export const connections = pgTable('connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // WhatsApp Cloud API
  phoneNumberId: text('phone_number_id'),
  wabaId: text('waba_id'),
  displayPhone: text('display_phone'),
  accessToken: text('access_token'),
  status: connStatusEnum('status').notNull().default('pending'),
  // como foi conectada: manual (token próprio) | embedded (Meta em 1 clique) | coexistence (WhatsApp Business do celular) | web (QR Code)
  source: text('source').notNull().default('manual'),
  /** cloud = API oficial da Meta | web = QR Code (API não oficial, sessão do WhatsApp Web) */
  provider: text('provider').notNull().default('cloud'),
  /** QR Code: qr | connecting | open | closed | logged_out */
  webState: text('web_state'),
  // saúde do número (última verificação na Meta)
  verifiedName: text('verified_name'),
  nameStatus: text('name_status'),
  qualityRating: text('quality_rating'),
  messagingLimit: text('messaging_limit'),
  phoneStatus: text('phone_status'),
  throughput: text('throughput'),
  codeVerification: text('code_verification'),
  coexistence: boolean('coexistence').notNull().default(false),
  webhookSubscribed: boolean('webhook_subscribed'),
  // PIN de verificação em duas etapas definido ao registrar o número na Cloud API
  pin: text('pin'),
  // conexão manual com o app da Meta do próprio cliente: chave secreta para conferir a assinatura dos webhooks
  appSecret: text('app_secret'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  // coexistência: pedido de sincronização de contatos/histórico e progresso (0-100)
  syncRequestedAt: timestamp('sync_requested_at', { withTimezone: true }),
  /** quando o número foi conectado (ou reconectado pela Meta): conta o prazo de 24h da sincronização do celular */
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }).notNull().defaultNow(),
  historyProgress: integer('history_progress'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('connections_account_idx').on(t.accountId),
  byPhoneNumberId: index('connections_phone_number_id_idx').on(t.phoneNumberId),
}));

/* ---------- CRM ---------- */
export const contacts = pgTable('contacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  waId: text('wa_id'),
  stage: contactStageEnum('stage').notNull().default('new'),
  tags: text('tags').array().notNull().default([]),
  value: numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
  lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
  // origem do lead em anúncios "clique para o WhatsApp" (referral da Cloud API)
  sourceId: text('source_id'),
  sourceType: text('source_type'),
  sourceUrl: text('source_url'),
  ctwaClid: text('ctwa_clid'),
  // conexão (número) por onde o lead chegou pela primeira vez
  firstConnectionId: uuid('first_connection_id').references(() => connections.id, { onDelete: 'set null' }),
  notes: text('notes'),
  email: text('email'),
  // como o contato chegou: whatsapp (mensagem), ad (anúncio da Meta), import (CSV), manual, webhook (integração)
  origin: text('origin').notNull().default('manual'),
  // campos personalizados da conta: { chave: valor }
  custom: jsonb('custom').notNull().default({}),
  /** pediu para não receber disparos (respondeu SAIR/PARAR); fica fora dos disparos em massa */
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  /** link rastreável (Trackeamento) pelo qual o contato chegou */
  trackingLinkId: uuid('tracking_link_id').references((): AnyPgColumn => trackingLinks.id, { onDelete: 'set null' }),
  trackedAt: timestamp('tracked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('contacts_account_idx').on(t.accountId),
  byAccountCreated: index('contacts_account_created_idx').on(t.accountId, t.createdAt),
  phoneByAccount: uniqueIndex('contacts_account_phone_uq').on(t.accountId, t.phone),
}));

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  status: convStatusEnum('status').notNull().default('open'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  /** fila do setor: enquanto ninguém atende, só os membros do setor (e os gestores) veem em Aguardando */
  departmentId: uuid('department_id').references((): AnyPgColumn => departments.id, { onDelete: 'set null' }),
  // true = atendimento humano: fluxos e agentes de IA não respondem
  botPaused: boolean('bot_paused').notNull().default(false),
  /** agente de IA entregue pelo bloco "Agente de IA" do fluxo: ele atende esta conversa até ser removido */
  aiAgentId: uuid('ai_agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('conversations_account_idx').on(t.accountId),
  byContact: index('conversations_contact_idx').on(t.contactId),
  byAccountLast: index('conversations_account_last_idx').on(t.accountId, t.lastMessageAt),
}));

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  direction: directionEnum('direction').notNull(),
  type: msgTypeEnum('type').notNull().default('text'),
  body: text('body'),
  mediaUrl: text('media_url'),
  waMessageId: text('wa_message_id'),
  // mídia guardada na Meta (recebida ou enviada por upload): baixada sob demanda pelo proxy
  waMediaId: text('wa_media_id'),
  mimeType: text('mime_type'),
  fileName: text('file_name'),
  status: msgStatusEnum('status').notNull().default('sent'),
  // motivo da falha de envio (ex.: fora da janela de 24h)
  error: text('error'),
  // mensagem citada ("responder"): do cliente (context do WhatsApp) ou da equipe
  replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  // mensagem enviada por um agente de IA
  agentId: uuid('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
  // áudio: o que foi dito (transcrição)
  transcript: text('transcript'),
  // de onde veio a mensagem de saída: 'phone' = enviada pelo WhatsApp Business do celular; 'history' = importada do histórico
  via: text('via'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byConversation: index('messages_conversation_idx').on(t.conversationId),
  byConversationCreated: index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
  byWaMessageId: index('messages_wa_message_id_idx').on(t.waMessageId),
}));

/** Respostas rápidas do Chats ao vivo (digite "/" no campo de mensagem). */
export const quickReplies = pgTable('quick_replies', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  shortcut: text('shortcut').notNull(),
  /** texto das ações (para a busca e o atalho no chat) */
  text: text('text').notNull(),
  /** o que é enviado, em ordem: [{ type: text|image|video|audio|document|sticker, text?, fileId?, fileName?, caption? }] */
  actions: jsonb('actions').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  shortcutByAccount: uniqueIndex('quick_replies_account_shortcut_uq').on(t.accountId, t.shortcut),
}));

export const tags = pgTable('tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#0e9488'),
}, (t) => ({
  byAccount: index('tags_account_idx').on(t.accountId),
  nameByAccount: uniqueIndex('tags_account_name_uq').on(t.accountId, t.name),
}));

/* ---------- automation ---------- */
export const flowFolders = pgTable('flow_folders', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#2f73e0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('flow_folders_account_idx').on(t.accountId),
}));

export const flows = pgTable('flows', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  folderId: uuid('folder_id').references(() => flowFolders.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  status: flowStatusEnum('status').notNull().default('draft'),
  trigger: jsonb('trigger').notNull().default({}),
  graph: jsonb('graph').notNull().default({ nodes: [], edges: [] }),
  // código aleatório para outra conta importar uma cópia (null = não compartilhado)
  shareCode: text('share_code').unique(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('flows_account_idx').on(t.accountId),
  byFolder: index('flows_folder_idx').on(t.folderId),
}));

export const flowRuns = pgTable('flow_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('running'),
  currentNodeId: text('current_node_id'),
  context: jsonb('context').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  byFlow: index('flow_runs_flow_idx').on(t.flowId),
  byContactStatus: index('flow_runs_contact_status_idx').on(t.contactId, t.status),
  // no máximo UMA execução em andamento por fluxo e contato (evita duplicar em mensagens rápidas)
  activePerContact: uniqueIndex('flow_runs_active_uq').on(t.flowId, t.contactId)
    .where(sql`status in ('running','waiting','waiting_input','waiting_payment')`),
}));

/** Contadores por bloco: entradas (chegaram ao bloco) e avanços (seguiram adiante). */
export const flowNodeStats = pgTable('flow_node_stats', {
  flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  entries: integer('entries').notNull().default(0),
  advances: integer('advances').notNull().default(0),
  /** rodízio do bloco Distribuidor: quantos contatos já foram distribuídos */
  rr: integer('rr').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.flowId, t.nodeId] }),
}));

/** Distribuidor com "prevenir repetição": o contato volta sempre para a mesma saída. */
export const flowDistributions = pgTable('flow_distributions', {
  flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  outputId: text('output_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.flowId, t.nodeId, t.contactId] }),
}));

/** Vozes clonadas da conta (ElevenLabs): pendente até a pessoa ouvir a prévia e aceitar. */
export const voices = pgTable('voices', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  language: text('language').notNull().default('pt'),
  providerVoiceId: text('provider_voice_id').notNull(),
  status: text('status').notNull().default('pending'), // pending | ready
  samples: integer('samples').notNull().default(1),
  previewText: text('preview_text').notNull().default(''),
  previewAudio: text('preview_audio'), // mp3 em base64
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('voices_account_idx').on(t.accountId),
}));

export const agents = pgTable('agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  model: text('model').notNull().default('gpt-4o-mini'),
  enabled: boolean('enabled').notNull().default(false),
  /** instruções livres (o "como atender") */
  systemPrompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default('teal'),
  role: text('role').notNull().default('custom'), // sales | support | recovery | custom
  description: text('description').notNull().default(''),
  tone: text('tone').notNull().default(''),
  knowledge: text('knowledge').notNull().default(''),
  faq: jsonb('faq').$type<{ q: string; a: string }[]>().notNull().default([]),
  rules: text('rules').notNull().default(''),
  // fluxo que o agente dispara (ex.: checkout) e quando
  flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
  flowWhen: text('flow_when').notNull().default(''),
  flowTag: text('flow_tag'),
  // passar para a equipe
  handoffWhen: text('handoff_when').notNull().default(''),
  handoffMessage: text('handoff_message').notNull().default(''),
  handoffTag: text('handoff_tag'),
  /** setor para onde a conversa vai quando o agente passa para a equipe (fila do setor) */
  handoffDepartmentId: uuid('handoff_department_id').references((): AnyPgColumn => departments.id, { onDelete: 'set null' }),
  // onde atende: conexões (vazio = todas) e público
  connectionIds: uuid('connection_ids').array().notNull().default(sql`'{}'::uuid[]`),
  audience: text('audience').notNull().default('all'), // all | ads | tags
  audienceTags: text('audience_tags').array().notNull().default(sql`'{}'::text[]`),
  // áudio: responder em mensagem de voz e entender os áudios do cliente
  replyAudio: text('reply_audio').notNull().default('never'), // never | when_audio | always
  voiceId: uuid('voice_id').references(() => voices.id, { onDelete: 'set null' }),
  transcribeAudio: boolean('transcribe_audio').notNull().default(true),
  // espera o cliente terminar de mandar as mensagens antes de responder
  waitSeconds: integer('wait_seconds').notNull().default(5),
  maxRepliesPerDay: integer('max_replies_per_day').notNull().default(40),
  shareCode: text('share_code').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('agents_account_idx').on(t.accountId),
}));

/** Cada vez que um agente age numa conversa (resposta, fluxo, transferência, erro): indicadores e histórico. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  outcome: text('outcome').notNull(), // replied | flow | handoff | limit | error
  detail: text('detail'),
  tokens: integer('tokens').notNull().default(0),
  audioChars: integer('audio_chars').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAgent: index('agent_runs_agent_idx').on(t.agentId, t.createdAt),
  byConversation: index('agent_runs_conversation_idx').on(t.conversationId, t.createdAt),
}));

export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  audience: jsonb('audience').notNull().default({}),
  /** (legado) texto livre — os disparos novos mandam um fluxo */
  message: text('message').notNull().default(''),
  status: campaignStatusEnum('status').notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  /** contatos já processados (enviados + falhas + ignorados) */
  sentCount: integer('sent_count').notNull().default(0),
  totalCount: integer('total_count').notNull().default(0),
  /** fluxo enviado para cada contato */
  flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
  /** modelo de mensagem que abre a conversa com quem não falou nas últimas 24h */
  template: jsonb('template'),
  /** contatos por minuto */
  speed: integer('speed').notNull().default(30),
  /** quota | limit | connection | flow | manual */
  pauseReason: text('pause_reason'),
  startedCount: integer('started_count').notNull().default(0),
  templateCount: integer('template_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  chargedQuota: integer('charged_quota').notNull().default(0),
  chargedExtra: integer('charged_extra').notNull().default(0),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('campaigns_account_idx').on(t.accountId),
}));

/** Cada contato de um disparo em massa (sem repetir) e o que aconteceu com ele. */
export const campaignRecipients = pgTable('campaign_recipients', {
  id: uuid('id').defaultRandom().primaryKey(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  /** queued | sending | started (fluxo na hora) | sent (modelo enviado) | failed | skipped */
  status: text('status').notNull().default('queued'),
  error: text('error'),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  /** de onde saiu o disparo: cota do ciclo ou saldo extra */
  charge: text('charge'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => ({
  perCampaign: uniqueIndex('campaign_recipients_uq').on(t.campaignId, t.contactId),
  byStatus: index('campaign_recipients_status_idx').on(t.campaignId, t.status),
  byContact: index('campaign_recipients_contact_idx').on(t.contactId),
}));

/** Disparos usados da cota de cada ciclo da assinatura. */
export const dispatchUsage = pgTable('dispatch_usage', {
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** início do ciclo (AAAA-MM-DD) */
  cycle: text('cycle').notNull(),
  used: integer('used').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.cycle] }),
}));

export const webhooks = pgTable('webhooks', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token: text('token').notNull().unique(),
  /** (legado) não usado */
  events: text('events').array().notNull().default([]),
  /** eventos recebidos no total */
  hits: integer('hits').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  /** número de WhatsApp usado para mandar o modelo e disparar o fluxo */
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  /** de onde sai cada dado do lead no JSON recebido (caminhos como data.buyer.phone) */
  mapping: jsonb('mapping').notNull().default({}),
  /** só executa as ações quando todas as condições batem */
  conditions: jsonb('conditions').notNull().default([]),
  /** etiquetas, Kanban, venda, modelo de mensagem e fluxo */
  actions: jsonb('actions').notNull().default({}),
  /** evento de exemplo usado no mapeamento */
  sample: jsonb('sample'),
  sampleAt: timestamp('sample_at', { withTimezone: true }),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  lastStatus: text('last_status'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('webhooks_account_idx').on(t.accountId),
}));

/** Cada chamada recebida por um webhook de entrada (com o resultado de cada ação). */
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  /** queued | processed | partial | skipped | error | blocked | paused */
  status: text('status').notNull().default('queued'),
  payload: jsonb('payload').notNull().default({}),
  summary: text('summary'),
  results: jsonb('results').notNull().default([]),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  /** transação + status: o mesmo pedido reenviado pela plataforma não roda as ações de novo */
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (t) => ({
  byWebhook: index('webhook_events_webhook_idx').on(t.webhookId, t.createdAt),
  byDedupe: index('webhook_events_dedupe_idx').on(t.webhookId, t.dedupeKey),
  byAccount: index('webhook_events_account_idx').on(t.accountId, t.createdAt),
}));

/** Eventos de webhook processados por mês (consumo do plano). */
export const webhookUsage = pgTable('webhook_usage', {
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** AAAA-MM no fuso da conta */
  month: text('month').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.month] }),
}));

/* ---------- commerce ---------- */
export const products = pgTable('products', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  // link de pagamento/checkout usado pelo bloco "Pagamento" dos fluxos
  checkoutUrl: text('checkout_url'),
  // custo unitário (usado no cálculo de lucro do dashboard)
  cost: numeric('cost', { precision: 12, scale: 2 }).notNull().default('0'),
}, (t) => ({
  byAccount: index('products_account_idx').on(t.accountId),
}));

export const sales = pgTable('sales', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  webhookId: uuid('webhook_id').references(() => webhooks.id, { onDelete: 'set null' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull().default('BRL'),
  // custo dos produtos vendidos (snapshot no momento da venda)
  cost: numeric('cost', { precision: 12, scale: 2 }).notNull().default('0'),
  status: saleStatusEnum('status').notNull().default('pending'),
  // ID da transação na plataforma (Hotmart, Kiwify...) — evita duplicar em reenvios
  externalId: text('external_id'),
  // anúncio de origem (source_id do clique para o WhatsApp ou UTM)
  sourceId: text('source_id'),
  // UF do comprador (do checkout ou pelo DDD do telefone)
  state: text('state'),
  productName: text('product_name'),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  origin: text('origin').notNull().default('webhook'),
  notes: text('notes'),
  invoiceNumber: text('invoice_number'),
  invoiceUrl: text('invoice_url'),
  invoiceIssuedAt: timestamp('invoice_issued_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('sales_account_idx').on(t.accountId),
  byCreatedAt: index('sales_created_at_idx').on(t.createdAt),
  byAccountCreated: index('sales_account_created_idx').on(t.accountId, t.createdAt),
  externalByAccount: uniqueIndex('sales_account_external_uq').on(t.accountId, t.externalId)
    .where(sql`external_id is not null`),
}));

/** Investimento em anúncios por dia (lançado à mão ou sincronizado da Meta). */
export const adSpend = pgTable('ad_spend', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
  currency: text('currency').notNull().default('BRL'),
  platform: text('platform').notNull().default('meta'),
  campaignName: text('campaign_name'),
  campaignId: text('campaign_id'),
  adAccountId: text('ad_account_id'),
  origin: text('origin').notNull().default('manual'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccountDate: index('ad_spend_account_date_idx').on(t.accountId, t.date),
  // gasto puxado da conta de anúncios da Meta: um por conta de anúncios por dia (a sincronização atualiza)
  metaPerDay: uniqueIndex('ad_spend_meta_uq').on(t.accountId, t.adAccountId, t.date).where(sql`origin = 'meta'`),
}));

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  plan: text('plan').notNull().default('starter'),
  status: subStatusEnum('status').notNull().default('inactive'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  aiTokensAllowance: integer('ai_tokens_allowance').notNull().default(0),
  aiTokensBalance: integer('ai_tokens_balance').notNull().default(0),
  /** disparos extras comprados (não vencem; usados depois da cota do ciclo) */
  dispatchExtra: integer('dispatch_extra').notNull().default(0),
  /** instâncias pagas (cada uma = um número de WhatsApp) */
  instances: integer('instances').notNull().default(0),
  /** redução pedida: vale a partir da próxima renovação */
  pendingInstances: integer('pending_instances'),
  /** asaas | paddle */
  gateway: text('gateway'),
  gatewayCustomerId: text('gateway_customer_id'),
  gatewaySubscriptionId: text('gateway_subscription_id'),
  /** pix | card | boleto */
  paymentMethod: text('payment_method'),
  /** BR | INTL */
  billingCountry: text('billing_country').notNull().default('BR'),
  /** CPF/CNPJ (só dígitos) e nome do titular da cobrança */
  taxId: text('tax_id'),
  billingName: text('billing_name'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  canceledAt: timestamp('canceled_at', { withTimezone: true }),
  aiTokensUsed: integer('ai_tokens_used').notNull().default(0),
  /** conta da casa (HOUSE_EMAILS): tudo liberado, sem cobrança e sem desconto de tokens */
  house: boolean('house').notNull().default(false),
  lastTokenPurchaseAt: timestamp('last_token_purchase_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Faturas: assinatura (cada mês), instâncias a mais, tokens e disparos extras. */
export const invoices = pgTable('invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** número da fatura para o cliente (#1024) */
  number: serial('number').notNull(),
  /** asaas | paddle */
  gateway: text('gateway').notNull(),
  /** pay_… (Asaas) ou txn_… (Paddle) */
  gatewayPaymentId: text('gateway_payment_id'),
  /** subscription | instances | tokens | dispatch */
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency: text('currency').notNull().default('BRL'),
  /** pending | paid | overdue | refunded | canceled */
  status: text('status').notNull().default('pending'),
  /** pix | card | boleto */
  method: text('method'),
  dueDate: date('due_date'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  refundAmount: numeric('refund_amount', { precision: 12, scale: 2 }),
  /** página para pagar ou ver o comprovante */
  invoiceUrl: text('invoice_url'),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  /** { instances, tokens, packId, quantity } */
  meta: jsonb('meta').notNull().default({}),
  /** o que a fatura libera (instâncias, tokens, disparos) já foi aplicado */
  applied: boolean('applied').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('invoices_account_idx').on(t.accountId, t.createdAt),
  byPayment: uniqueIndex('invoices_gateway_payment_uq').on(t.gateway, t.gatewayPaymentId).where(sql`gateway_payment_id is not null`),
}));

/** Avisos recebidos dos gateways (a Asaas e a Paddle podem mandar o mesmo mais de uma vez). */
export const billingEvents = pgTable('billing_events', {
  /** gateway:id do evento */
  id: text('id').primaryKey(),
  gateway: text('gateway').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  error: text('error'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- contatos: campos personalizados e exportações ---------- */
export const contactFields = pgTable('contact_fields', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  label: text('label').notNull(),
  // text | number | date | select
  type: text('type').notNull().default('text'),
  options: text('options').array().notNull().default([]),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyByAccount: uniqueIndex('contact_fields_account_key_uq').on(t.accountId, t.key),
}));

/** Últimas exportações de contatos em CSV (guardamos as 3 mais recentes por conta, compactadas). */
export const contactExports = pgTable('contact_exports', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  filename: text('filename').notNull(),
  label: text('label').notNull().default(''),
  rows: integer('rows').notNull().default(0),
  content: text('content').notNull(), // CSV compactado (gzip, base64)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('contact_exports_account_idx').on(t.accountId, t.createdAt),
}));

/* ---------- kanban (quadros com colunas e cards) ---------- */
export const kanbanBoards = pgTable('kanban_boards', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('kanban_boards_account_idx').on(t.accountId),
}));

export const kanbanColumns = pgTable('kanban_columns', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  boardId: uuid('board_id').notNull().references(() => kanbanBoards.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#0e9488'),
  kind: kanbanColumnKindEnum('kind').notNull().default('open'),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byBoard: index('kanban_columns_board_idx').on(t.boardId, t.position),
}));

export const kanbanCards = pgTable('kanban_cards', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  boardId: uuid('board_id').notNull().references(() => kanbanBoards.id, { onDelete: 'cascade' }),
  columnId: uuid('column_id').notNull().references(() => kanbanColumns.id, { onDelete: 'cascade' }),
  // lead/cliente do card (um contato aparece no máximo uma vez por quadro)
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  value: numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  dueDate: date('due_date'),
  // ordem dentro da coluna (fracionária: mover não precisa renumerar tudo)
  position: doublePrecision('position').notNull().default(0),
  // quando entrou na coluna atual ("há 3 dias nesta etapa")
  movedAt: timestamp('moved_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byColumn: index('kanban_cards_column_idx').on(t.columnId, t.position),
  byBoard: index('kanban_cards_board_idx').on(t.boardId),
  byContact: index('kanban_cards_contact_idx').on(t.contactId),
  contactPerBoard: uniqueIndex('kanban_cards_board_contact_uq').on(t.boardId, t.contactId).where(sql`contact_id is not null`),
}));

/**
 * Fluxo esperando o cliente responder: o webhook mandou um modelo (fora da janela de 24h)
 * e o fluxo começa na próxima mensagem dele. Um por contato; vence em alguns dias.
 */
export const flowPending = pgTable('flow_pending', {
  contactId: uuid('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  flowId: uuid('flow_id').notNull().references(() => flows.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  webhookId: uuid('webhook_id').references(() => webhooks.id, { onDelete: 'set null' }),
  vars: jsonb('vars').notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ---------- Facebook: perfis da Meta, contas de anúncios e pixels ---------- */

/** Perfil do Facebook/Instagram conectado (um login por perfil) com acesso de leitura aos anúncios. */
export const metaProfiles = pgTable('meta_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  fbUserId: text('fb_user_id').notNull(),
  name: text('name').notNull(),
  pictureUrl: text('picture_url'),
  accessToken: text('access_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: jsonb('scopes').notNull().default([]),
  /** connected | expired | error */
  status: text('status').notNull().default('connected'),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perUser: uniqueIndex('meta_profiles_account_user_uq').on(t.accountId, t.fbUserId),
}));

/** Conta de anúncios que um perfil enxerga. selected = entra no Gerenciador e no gasto do Dashboard. */
export const metaAdAccounts = pgTable('meta_ad_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => metaProfiles.id, { onDelete: 'cascade' }),
  /** act_123 */
  actId: text('act_id').notNull(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('BRL'),
  timezone: text('timezone'),
  /** 1 ativa, 2 desativada, 3 pagamento pendente, 7/9 em análise, 101 fechada… */
  accountStatus: integer('account_status'),
  businessName: text('business_name'),
  selected: boolean('selected').notNull().default(false),
  /** o perfil ainda enxerga a conta (última atualização) */
  available: boolean('available').notNull().default(true),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perProfile: uniqueIndex('meta_ad_accounts_profile_act_uq').on(t.profileId, t.actId),
  byAccount: index('meta_ad_accounts_account_idx').on(t.accountId, t.selected),
}));

/** Pixel (ou conjunto de dados) que recebe os eventos de conversão: Meta, Meta pelo WhatsApp ou TikTok. */
export const pixels = pgTable('pixels', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** meta | meta_whatsapp | tiktok */
  platform: text('platform').notNull(),
  pixelId: text('pixel_id').notNull(),
  /** null em meta_whatsapp = usa o token da conexão do WhatsApp */
  accessToken: text('access_token'),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  wabaId: text('waba_id'),
  /** Página do Facebook ligada ao WhatsApp (anúncios de clique para o WhatsApp sem WABA, ex.: QR Code) */
  pageId: text('page_id'),
  /** nome do pixel na plataforma (quando ela informa) */
  remoteName: text('remote_name'),
  /** [{ id, trigger: lead|sale|stage, scope?, columnId?, event }] */
  rules: jsonb('rules').notNull().default([]),
  /** active | paused | error */
  status: text('status').notNull().default('active'),
  lastError: text('last_error'),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('pixels_account_idx').on(t.accountId),
}));

/** Cada evento mandado (ou tentado) para um pixel: histórico e trava contra mandar duas vezes. */
export const pixelEvents = pgTable('pixel_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  pixelId: uuid('pixel_id').notNull().references(() => pixels.id, { onDelete: 'cascade' }),
  /** ex.: sale:<id> — a mesma conversão não sai duas vezes para o mesmo pixel */
  key: text('key').notNull(),
  /** lead | sale | stage | test */
  trigger: text('trigger').notNull(),
  eventName: text('event_name').notNull(),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
  value: numeric('value', { precision: 12, scale: 2 }),
  currency: text('currency'),
  /** queued | sent | failed | skipped */
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  response: jsonb('response'),
  /** o que foi mandado (dados pessoais já criptografados) */
  payload: jsonb('payload'),
  eventTime: timestamp('event_time', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  perKey: uniqueIndex('pixel_events_pixel_key_uq').on(t.pixelId, t.key),
  byPixel: index('pixel_events_pixel_idx').on(t.pixelId, t.createdAt),
}));

/* ---------- configurações: empresa, equipe e acesso ---------- */

/** Setores de atendimento (Vendas, Suporte…): cada um com a sua fila em "Aguardando". */
export const departments = pgTable('departments', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#3b82f6'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameByAccount: uniqueIndex('departments_account_name_uq').on(t.accountId, t.name),
}));

/** Horário de atendimento de cada número (semana com até 3 intervalos por dia, no fuso da empresa). */
export const businessHours = pgTable('business_hours', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }).unique(),
  enabled: boolean('enabled').notNull().default(false),
  /** { "0": [{ "start": "09:00", "end": "18:00" }], … } — 0 = domingo */
  schedule: jsonb('schedule').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Fluxos padrões de cada número: boas-vindas, fora do horário e quando nada mais responde. */
export const defaultFlows = pgTable('default_flows', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }).unique(),
  welcomeFlowId: uuid('welcome_flow_id').references(() => flows.id, { onDelete: 'set null' }),
  offHoursFlowId: uuid('off_hours_flow_id').references(() => flows.id, { onDelete: 'set null' }),
  fallbackFlowId: uuid('fallback_flow_id').references(() => flows.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Convite para entrar na equipe de uma empresa (quem já tem cadastro aceita pelo link ou dentro do app). */
export const teamInvites = pgTable('team_invites', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: roleEnum('role').notNull().default('agent'),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  token: text('token').notNull().unique(),
  /** pending | accepted | declined | canceled */
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('team_invites_account_idx').on(t.accountId, t.status),
  byEmail: index('team_invites_email_idx').on(t.email),
}));

/** Convite para criar uma conta no Converza (entra como indicação de quem convidou). */
export const platformInvites = pgTable('platform_invites', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  token: text('token').notNull().unique(),
  /** pending | accepted | declined | canceled (expirado = pendente vencido) */
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('platform_invites_account_idx').on(t.accountId, t.createdAt),
  byEmail: index('platform_invites_email_idx').on(t.email),
}));

/** Acesso temporário da equipe de suporte do Converza (liberado pelo dono ou admin, com prazo). */
export const supportAccess = pgTable('support_access', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull().default(''),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastUsedBy: text('last_used_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('support_access_account_idx').on(t.accountId, t.expiresAt),
}));

/* ---------- configurações: automação ---------- */

/** Arquivo guardado no banco (imagem, vídeo, áudio, documento ou figurinha de uma resposta rápida). */
export const storedFiles = pgTable('stored_files', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull().default('quick_reply'),
  mime: text('mime').notNull(),
  fileName: text('file_name').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  /** arquivos antigos; os novos ficam em stored_file_chunks (pedaços de 1 MB) */
  data: bytea('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('stored_files_account_idx').on(t.accountId),
}));

export const storedFileChunks = pgTable('stored_file_chunks', {
  fileId: uuid('file_id').notNull().references(() => storedFiles.id, { onDelete: 'cascade' }),
  idx: integer('idx').notNull(),
  data: bytea('data').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.fileId, t.idx] }),
}));

/** Arquivo já mandado para a Meta por um número (a mídia vale 30 dias lá: reaproveita até perto disso). */
export const storedFileMedia = pgTable('stored_file_media', {
  fileId: uuid('file_id').notNull().references(() => storedFiles.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  waMediaId: text('wa_media_id').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.fileId, t.connectionId] }),
}));

/** QR Code (API não oficial): chaves da sessão do WhatsApp Web (credenciais e chaves de criptografia). */
export const waWebAuth = pgTable('wa_web_auth', {
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  keyId: text('key_id').notNull(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.connectionId, t.kind, t.keyId] }),
}));

/** QR Code: arquivos recebidos e enviados (o WhatsApp Web não guarda a mídia para baixar depois). Ficam 31 dias. */
export const waWebMedia = pgTable('wa_web_media', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  fileName: text('file_name'),
  size: integer('size').notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCreated: index('wa_web_media_created_idx').on(t.createdAt),
}));

/**
 * Registros de acesso (data, hora e IP de quem entrou no app): o Marco Civil da Internet (art. 15) exige guardar
 * por 6 meses. Ficam mesmo se o usuário for excluído (user_id vira nulo, o e-mail fica).
 */
export const accessLogs = pgTable('access_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  /** login | register | session (uso com login já feito, no máximo 1 registro a cada 6 h por IP) */
  event: text('event').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCreated: index('access_logs_created_idx').on(t.createdAt),
  byUser: index('access_logs_user_idx').on(t.userId),
}));

/** O que o dono da plataforma fez no painel da plataforma (suspender, reativar, cortesia…). */
export const platformAudit = pgTable('platform_audit', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorEmail: text('actor_email').notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  accountName: text('account_name').notNull().default(''),
  action: text('action').notNull(),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCreated: index('platform_audit_created_idx').on(t.createdAt),
  byAccount: index('platform_audit_account_idx').on(t.accountId, t.createdAt),
}));

/** Variáveis da conta usadas nos fluxos como {{g_nome}} (os fluxos também podem mudar o valor). */
export const globalVariables = pgTable('global_variables', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** sempre começa com g_ */
  key: text('key').notNull(),
  description: text('description').notNull().default(''),
  /** text | number */
  type: text('type').notNull().default('text'),
  value: text('value').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  keyByAccount: uniqueIndex('global_variables_account_key_uq').on(t.accountId, t.key),
}));

/* ---------- configurações: IA ---------- */

/** Tradução de fluxo: tokens reservados antes, usados de verdade e devolvidos no fim. */
export const flowTranslations = pgTable('flow_translations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  sourceFlowId: uuid('source_flow_id').references(() => flows.id, { onDelete: 'set null' }),
  sourceName: text('source_name').notNull(),
  copyFlowId: uuid('copy_flow_id').references(() => flows.id, { onDelete: 'set null' }),
  copyName: text('copy_name'),
  language: text('language').notNull(),
  /** running | done | failed */
  status: text('status').notNull().default('running'),
  reserved: integer('reserved').notNull().default(0),
  used: integer('used').notNull().default(0),
  refunded: integer('refunded').notNull().default(0),
  error: text('error'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  byAccount: index('flow_translations_account_idx').on(t.accountId, t.createdAt),
}));

/** Cada débito de tokens de IA (agentes, blocos de IA, voz, ferramentas), agrupável por conversa. */
export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  /** agent_reply | agent_voice | transcription | flow_ai | agent_test | agent_create | flow_generate | voice_preview | other */
  kind: text('kind').notNull(),
  /** conversa (conv:<id>) ou uso avulso (tool:<id>) */
  sessionKey: text('session_key').notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
  label: text('label').notNull().default(''),
  tokens: integer('tokens').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('ai_usage_account_idx').on(t.accountId, t.createdAt),
  bySession: index('ai_usage_session_idx').on(t.accountId, t.sessionKey),
}));

/* ---------- configurações: integrações ---------- */

/** Link rastreável: abre o WhatsApp com uma mensagem pronta e marca a origem de quem chega por ele. */
export const trackingLinks = pgTable('tracking_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** endereço curto público: /t/<slug> */
  slug: text('slug').notNull().unique(),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  message: text('message').notNull(),
  /** código que vai na mensagem (ex.: #ABX12) e liga a conversa ao link */
  code: text('code').notNull(),
  utmSource: text('utm_source'),
  utmMedium: text('utm_medium'),
  utmCampaign: text('utm_campaign'),
  utmContent: text('utm_content'),
  tags: text('tags').array().notNull().default([]),
  active: boolean('active').notNull().default(true),
  clicks: integer('clicks').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeByAccount: uniqueIndex('tracking_links_account_code_uq').on(t.accountId, t.code),
}));

export const trackingClicks = pgTable('tracking_clicks', {
  id: uuid('id').defaultRandom().primaryKey(),
  linkId: uuid('link_id').notNull().references(() => trackingLinks.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  referer: text('referer'),
  userAgent: text('user_agent'),
  /** IP com hash (não guardamos o IP de quem clicou) */
  ipHash: text('ip_hash'),
  query: jsonb('query').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byLink: index('tracking_clicks_link_idx').on(t.linkId, t.createdAt),
}));

/** Chave de API da conta (Ferramentas MCP): guardamos só o hash. */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** começo da chave, para reconhecer (cvz_ab12…) */
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  /** ferramentas liberadas para esta chave (vazio = nenhuma) */
  tools: text('tools').array().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('api_keys_account_idx').on(t.accountId),
}));

/** Histórico das ferramentas chamadas pelo MCP. */
export const mcpCalls = pgTable('mcp_calls', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
  tool: text('tool').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  /** resumo do pedido (sem dados sensíveis) */
  summary: text('summary').notNull().default(''),
  durationMs: integer('duration_ms').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('mcp_calls_account_idx').on(t.accountId, t.createdAt),
}));

export const schema = {
  accounts, users, memberships, connections, contacts, conversations, messages, quickReplies,
  tags, flowFolders, flows, flowRuns, flowNodeStats, voices, agents, agentRuns, campaigns, webhooks, products, sales, adSpend, subscriptions,
  kanbanBoards, kanbanColumns, kanbanCards, contactFields, contactExports, webhookEvents, webhookUsage, flowPending,
  campaignRecipients, dispatchUsage, metaProfiles, metaAdAccounts, pixels, pixelEvents, invoices, billingEvents,
  departments, businessHours, defaultFlows, teamInvites, platformInvites, supportAccess, platformAudit, storedFiles, storedFileChunks, storedFileMedia,
  globalVariables, flowTranslations, aiUsage, trackingLinks, trackingClicks, apiKeys, mcpCalls, flowDistributions,
  waWebAuth, waWebMedia, accessLogs,
};
