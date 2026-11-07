import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { normalizePhone } from '../utils/phone';
import { findContactByPhone } from './contactStore';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';
import { onPaymentApproved } from '../flows/runner';
import { normCurrency, normState, recordSale } from './salesStore';
import { firePixels } from '../pixels/sender';

/** Vendas lançadas à mão, edição, nota fiscal e exclusão (Histórico de vendas do dashboard). */
export const salesRouter = Router();

const status = z.enum(['pending', 'approved', 'refused', 'refunded']);
const opt = (max: number) => z.string().trim().max(max).optional().nullable();

const saleSchema = z.object({
  contactId: z.string().uuid().optional().nullable(),
  customerName: opt(120),
  customerPhone: opt(40),
  productId: z.string().uuid().optional().nullable(),
  productName: opt(160),
  amount: z.number().min(0).max(100_000_000),
  currency: opt(3),
  status: status.default('approved'),
  date: z.string().datetime({ offset: true }).optional().nullable(),
  connectionId: z.string().uuid().optional().nullable(),
  sourceId: opt(120),
  state: opt(2),
  externalId: opt(120),
  notes: opt(1000),
});

async function ownSale(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Venda não encontrada');
  const [row] = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.accountId, accountId))).limit(1);
  if (!row) throw new AppError(404, 'Venda não encontrada');
  return row;
}

async function ownConnection(accountId: string, id: string | null | undefined) {
  if (!id) return null;
  const [c] = await db.select({ id: schema.connections.id }).from(schema.connections)
    .where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(400, 'Conexão não encontrada');
  return c.id;
}

/** Acha (ou cria) o contato pelo telefone, para a venda manual aparecer no CRM. */
async function contactFor(accountId: string, contactId?: string | null, name?: string | null, phone?: string | null) {
  if (contactId) {
    const [c] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
    if (!c) throw new AppError(400, 'Contato não encontrado');
    return c;
  }
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const known = await findContactByPhone(accountId, norm);
  if (known) return known;
  const [c] = await db.insert(schema.contacts).values({
    accountId, name: name?.trim() || norm, phone: norm, waId: norm,
  }).onConflictDoUpdate({ target: [schema.contacts.accountId, schema.contacts.phone], set: { phone: norm } }).returning();
  return c;
}

salesRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = saleSchema.parse(req.body);
  const contact = await contactFor(accountId, d.contactId, d.customerName, d.customerPhone);
  if (!contact && !d.customerName?.trim()) throw new AppError(400, 'Informe o cliente (nome e telefone)');
  const sale = await recordSale({
    accountId, contactId: contact?.id ?? null, amount: d.amount, status: d.status, currency: d.currency,
    productId: d.productId, productName: d.productName, externalId: d.externalId, sourceId: d.sourceId, state: d.state,
    connectionId: await ownConnection(accountId, d.connectionId), origin: 'manual', notes: d.notes,
    createdAt: d.date ? new Date(d.date) : null,
    customerName: d.customerName ?? contact?.name ?? null,
    customerPhone: contact?.phone ?? (d.customerPhone?.replace(/\D/g, '') || null),
  });
  // venda aprovada libera fluxos que esperavam o pagamento deste contato
  if (sale.status === 'approved' && sale.contactId) await onPaymentApproved(accountId, sale.contactId);
  res.status(201).json({ sale });
}));

salesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const sale = await ownSale(accountId, req.params.id);
  const d = saleSchema.partial().parse(req.body);
  const patch: Partial<typeof schema.sales.$inferInsert> = { updatedAt: new Date() };
  if (d.amount !== undefined) patch.amount = d.amount.toFixed(2);
  if (d.status) patch.status = d.status;
  if (d.currency !== undefined) patch.currency = normCurrency(d.currency);
  if (d.date) patch.createdAt = new Date(d.date);
  if (d.sourceId !== undefined) patch.sourceId = d.sourceId || null;
  if (d.state !== undefined) patch.state = normState(d.state);
  if (d.externalId !== undefined) patch.externalId = d.externalId || null;
  if (d.notes !== undefined) patch.notes = d.notes || null;
  if (d.customerName !== undefined) patch.customerName = d.customerName || null;
  if (d.connectionId !== undefined) patch.connectionId = await ownConnection(accountId, d.connectionId);
  if (d.productId !== undefined || d.productName !== undefined) {
    const [p] = d.productId
      ? await db.select().from(schema.products).where(and(eq(schema.products.id, d.productId), eq(schema.products.accountId, accountId))).limit(1)
      : [undefined];
    patch.productId = p?.id ?? null;
    patch.productName = p?.name ?? (d.productName?.trim() || null);
    patch.cost = p ? Number(p.cost).toFixed(2) : '0';
  }
  try {
    const [row] = await db.update(schema.sales).set(patch).where(eq(schema.sales.id, sale.id)).returning();
    if (row.status === 'approved' && sale.status !== 'approved' && row.contactId) await onPaymentApproved(accountId, row.contactId);
    if (row.status === 'approved' && sale.status !== 'approved') void firePixels(accountId, 'sale', { saleId: row.id, contactId: row.contactId });
    emitToAccount(accountId, 'sale:changed', { id: row.id });
    res.json({ sale: row });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'Já existe uma venda com esse ID de transação');
    throw err;
  }
}));

/** Nota fiscal: guarda número/link e marca como emitida (auditoria). */
salesRouter.patch('/:id/invoice', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const sale = await ownSale(accountId, req.params.id);
  const d = z.object({
    invoiceNumber: opt(60),
    invoiceUrl: z.string().trim().max(1000).refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'O link precisa começar com https://').optional().nullable(),
    issued: z.boolean(),
  }).parse(req.body);
  const [row] = await db.update(schema.sales).set({
    invoiceNumber: d.invoiceNumber || null,
    invoiceUrl: d.invoiceUrl || null,
    invoiceIssuedAt: d.issued ? (sale.invoiceIssuedAt ?? new Date()) : null,
    updatedAt: new Date(),
  }).where(eq(schema.sales.id, sale.id)).returning();
  emitToAccount(accountId, 'sale:changed', { id: row.id });
  res.json({ sale: row });
}));

salesRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores excluem vendas');
  const sale = await ownSale(req.accountId!, req.params.id);
  await db.delete(schema.sales).where(eq(schema.sales.id, sale.id));
  emitToAccount(req.accountId!, 'sale:changed', { id: sale.id });
  res.status(204).end();
}));
