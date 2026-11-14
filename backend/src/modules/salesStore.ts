import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { emitToAccount } from '../realtime/io';
import { ufFromPhone, UFS } from '../utils/ddd';
import { firePixels } from '../pixels/sender';
import { notifySaleApproved } from './push';

export type SaleStatus = 'pending' | 'approved' | 'refused' | 'refunded';

export interface SaleInput {
  accountId: string;
  contactId: string | null;
  amount: number;
  status: SaleStatus;
  currency?: string | null;
  productId?: string | null;
  productName?: string | null;
  externalId?: string | null;
  sourceId?: string | null;
  state?: string | null;
  connectionId?: string | null;
  webhookId?: string | null;
  origin: 'webhook' | 'manual' | 'flow';
  notes?: string | null;
  createdAt?: Date | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

export const normCurrency = (c: unknown) => {
  const v = String(c ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : 'BRL';
};

export function normState(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return UFS.includes(s) ? s : null;
}

/** Acha o produto da conta pelo ID ou pelo nome (sem diferenciar maiúsculas). */
async function findProduct(accountId: string, productId?: string | null, productName?: string | null) {
  if (productId) {
    const [p] = await db.select().from(schema.products)
      .where(and(eq(schema.products.id, productId), eq(schema.products.accountId, accountId))).limit(1);
    if (p) return p;
  }
  const name = String(productName ?? '').trim();
  if (name) {
    const [p] = await db.select().from(schema.products)
      .where(and(eq(schema.products.accountId, accountId), sql`lower(${schema.products.name}) = lower(${name})`)).limit(1);
    if (p) return p;
  }
  return null;
}

/**
 * Registra (ou atualiza, se o ID da transação já existir) uma venda, preenchendo
 * sozinho: conexão por onde o cliente conversou, anúncio de origem, estado pelo
 * DDD, nome do produto e custo (para o lucro do dashboard).
 */
export async function recordSale(input: SaleInput) {
  const contact = input.contactId
    ? (await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, input.contactId), eq(schema.contacts.accountId, input.accountId))).limit(1))[0]
    : undefined;

  let connectionId = input.connectionId ?? null;
  if (!connectionId && contact) {
    const [conv] = await db.select({ id: schema.conversations.connectionId }).from(schema.conversations)
      .where(and(eq(schema.conversations.contactId, contact.id), isNotNull(schema.conversations.connectionId)))
      .orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
    connectionId = conv?.id ?? contact.firstConnectionId ?? null;
  }

  const product = await findProduct(input.accountId, input.productId, input.productName);
  const customerPhone = input.customerPhone ?? contact?.phone ?? null;
  const values = {
    accountId: input.accountId,
    contactId: contact?.id ?? null,
    productId: product?.id ?? null,
    productName: product?.name ?? (input.productName?.trim() || null),
    connectionId,
    webhookId: input.webhookId ?? null,
    amount: Math.max(0, input.amount).toFixed(2),
    currency: normCurrency(input.currency),
    cost: product ? Number(product.cost).toFixed(2) : '0',
    status: input.status,
    externalId: input.externalId?.trim() ? input.externalId.trim().slice(0, 120) : null,
    sourceId: input.sourceId?.trim() || contact?.sourceId || null,
    state: normState(input.state) ?? ufFromPhone(customerPhone),
    customerName: input.customerName?.trim() || contact?.name || null,
    customerPhone,
    origin: input.origin,
    notes: input.notes ?? null,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    updatedAt: new Date(),
  };

  let row;
  if (values.externalId) {
    // reenvio do mesmo pedido (ex.: "aguardando" → "aprovado"): atualiza em vez de duplicar
    [row] = await db.insert(schema.sales).values(values)
      .onConflictDoUpdate({
        target: [schema.sales.accountId, schema.sales.externalId],
        targetWhere: sql`external_id is not null`,
        set: {
          status: values.status, amount: values.amount, currency: values.currency, updatedAt: new Date(),
          productId: sql`coalesce(excluded.product_id, ${schema.sales.productId})`,
          productName: sql`coalesce(excluded.product_name, ${schema.sales.productName})`,
          contactId: sql`coalesce(excluded.contact_id, ${schema.sales.contactId})`,
          connectionId: sql`coalesce(excluded.connection_id, ${schema.sales.connectionId})`,
          sourceId: sql`coalesce(excluded.source_id, ${schema.sales.sourceId})`,
          state: sql`coalesce(excluded.state, ${schema.sales.state})`,
          cost: values.cost,
        },
      }).returning();
  } else {
    [row] = await db.insert(schema.sales).values(values).returning();
  }

  emitToAccount(input.accountId, 'sale:changed', { id: row.id });
  // pixels: venda aprovada vira evento de compra (uma vez só por venda)
  if (row.status === 'approved') void firePixels(input.accountId, 'sale', { saleId: row.id, contactId: row.contactId });
  // celular: "Venda aprovada" (uma vez por venda)
  if (row.status === 'approved') void notifySaleApproved(row.id);
  return row;
}
