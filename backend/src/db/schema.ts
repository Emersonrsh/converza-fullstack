import {
  pgTable, pgEnum, uuid, text, integer, numeric, boolean,
  timestamp, jsonb, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

/* ---------- enums ---------- */
export const roleEnum = pgEnum('role', ['owner', 'admin', 'agent']);
export const connStatusEnum = pgEnum('connection_status', ['connected', 'disconnected', 'pending']);
export const contactStageEnum = pgEnum('contact_stage', ['new', 'in_service', 'negotiating', 'won', 'lost']);
export const convStatusEnum = pgEnum('conversation_status', ['open', 'pending', 'resolved']);
export const directionEnum = pgEnum('message_direction', ['in', 'out']);
export const msgTypeEnum = pgEnum('message_type', ['text', 'image', 'audio', 'video', 'document', 'template']);
export const msgStatusEnum = pgEnum('message_status', ['queued', 'sent', 'delivered', 'read', 'failed']);
export const flowStatusEnum = pgEnum('flow_status', ['draft', 'active', 'paused']);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'scheduled', 'sending', 'done', 'canceled']);
export const saleStatusEnum = pgEnum('sale_status', ['pending', 'approved', 'refused', 'refunded']);
export const subStatusEnum = pgEnum('subscription_status', ['inactive', 'active', 'past_due', 'canceled']);

/* ---------- tenancy ---------- */
export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  subscriptionStatus: subStatusEnum('subscription_status').notNull().default('inactive'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable('memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  role: roleEnum('role').notNull().default('agent'),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('contacts_account_idx').on(t.accountId),
  phoneByAccount: uniqueIndex('contacts_account_phone_uq').on(t.accountId, t.phone),
}));

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  status: convStatusEnum('status').notNull().default('open'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
  unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('conversations_account_idx').on(t.accountId),
  byContact: index('conversations_contact_idx').on(t.contactId),
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
  status: msgStatusEnum('status').notNull().default('sent'),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byConversation: index('messages_conversation_idx').on(t.conversationId),
  byWaMessageId: index('messages_wa_message_id_idx').on(t.waMessageId),
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
export const flows = pgTable('flows', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: flowStatusEnum('status').notNull().default('draft'),
  trigger: jsonb('trigger').notNull().default({}),
  graph: jsonb('graph').notNull().default({ nodes: [], edges: [] }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('flows_account_idx').on(t.accountId),
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
}));

export const agents = pgTable('agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  model: text('model').notNull().default('gpt-4o-mini'),
  enabled: boolean('enabled').notNull().default(false),
  systemPrompt: text('system_prompt').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('agents_account_idx').on(t.accountId),
}));

export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  audience: jsonb('audience').notNull().default({}),
  message: text('message').notNull().default(''),
  status: campaignStatusEnum('status').notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  sentCount: integer('sent_count').notNull().default(0),
  totalCount: integer('total_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('campaigns_account_idx').on(t.accountId),
}));

export const webhooks = pgTable('webhooks', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token: text('token').notNull().unique(),
  events: text('events').array().notNull().default([]),
  hits: integer('hits').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('webhooks_account_idx').on(t.accountId),
}));

/* ---------- commerce ---------- */
export const products = pgTable('products', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
}, (t) => ({
  byAccount: index('products_account_idx').on(t.accountId),
}));

export const sales = pgTable('sales', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull().default('0'),
  status: saleStatusEnum('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byAccount: index('sales_account_idx').on(t.accountId),
  byCreatedAt: index('sales_created_at_idx').on(t.createdAt),
}));

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }).unique(),
  plan: text('plan').notNull().default('starter'),
  status: subStatusEnum('status').notNull().default('inactive'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  aiTokensAllowance: integer('ai_tokens_allowance').notNull().default(0),
  aiTokensBalance: integer('ai_tokens_balance').notNull().default(0),
});

export const schema = {
  accounts, users, memberships, connections, contacts, conversations, messages,
  tags, flows, flowRuns, agents, campaigns, webhooks, products, sales, subscriptions,
};
