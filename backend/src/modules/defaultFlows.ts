/**
 * Fluxos padrões de cada número: boas-vindas (primeira mensagem de um contato novo), fora do horário de
 * atendimento e quando nada mais responde (nenhum fluxo, nenhum agente de IA).
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { emitToAccount } from '../realtime/io';

export const defaultFlowsRouter = Router();

export type DefaultFlowsRow = typeof schema.defaultFlows.$inferSelect;

export async function defaultFlowsFor(connectionId: string | null | undefined): Promise<DefaultFlowsRow | null> {
  if (!connectionId) return null;
  const [row] = await db.select().from(schema.defaultFlows).where(eq(schema.defaultFlows.connectionId, connectionId)).limit(1);
  return row ?? null;
}

defaultFlowsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const [conns, rows, flows, hours] = await Promise.all([
    db.select({ id: schema.connections.id, name: schema.connections.name, displayPhone: schema.connections.displayPhone, status: schema.connections.status })
      .from(schema.connections).where(eq(schema.connections.accountId, accountId)).orderBy(asc(schema.connections.createdAt)),
    db.select().from(schema.defaultFlows).where(eq(schema.defaultFlows.accountId, accountId)),
    db.select({ id: schema.flows.id, name: schema.flows.name, status: schema.flows.status }).from(schema.flows)
      .where(and(eq(schema.flows.accountId, accountId), isNull(schema.flows.archivedAt))).orderBy(asc(schema.flows.name)),
    db.select({ connectionId: schema.businessHours.connectionId, enabled: schema.businessHours.enabled }).from(schema.businessHours)
      .where(eq(schema.businessHours.accountId, accountId)),
  ]);
  res.json({
    connections: conns.map((c) => {
      const r = rows.find((x) => x.connectionId === c.id);
      return {
        ...c, welcomeFlowId: r?.welcomeFlowId ?? null, offHoursFlowId: r?.offHoursFlowId ?? null, fallbackFlowId: r?.fallbackFlowId ?? null,
        hoursEnabled: hours.find((h) => h.connectionId === c.id)?.enabled ?? false,
      };
    }),
    flows,
    canEdit: req.role !== 'agent',
  });
}));

const flowId = z.string().uuid().nullable();

defaultFlowsRouter.put('/:connectionId', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mudam os fluxos padrões.');
  const accountId = req.accountId!;
  const connectionId = String(req.params.connectionId);
  if (!isUuid(connectionId)) throw new AppError(404, 'Conexão não encontrada');
  const [conn] = await db.select({ id: schema.connections.id }).from(schema.connections)
    .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.accountId, accountId))).limit(1);
  if (!conn) throw new AppError(404, 'Conexão não encontrada');
  const p = z.object({ welcomeFlowId: flowId, offHoursFlowId: flowId, fallbackFlowId: flowId }).safeParse(req.body);
  if (!p.success) throw new AppError(422, 'Fluxo inválido');
  for (const id of Object.values(p.data)) {
    if (!id) continue;
    const [f] = await db.select({ id: schema.flows.id }).from(schema.flows)
      .where(and(eq(schema.flows.id, id), eq(schema.flows.accountId, accountId), isNull(schema.flows.archivedAt))).limit(1);
    if (!f) throw new AppError(422, 'Fluxo não encontrado (pode ter sido arquivado).');
  }
  const [row] = await db.insert(schema.defaultFlows).values({ accountId, connectionId, ...p.data })
    .onConflictDoUpdate({ target: schema.defaultFlows.connectionId, set: { ...p.data, updatedAt: new Date() } }).returning();
  emitToAccount(accountId, 'default-flows:changed', { connectionId });
  res.json({ defaults: row });
}));
