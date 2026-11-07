/** Horários de atendimento por número (conexão): liga/desliga e a semana, no fuso da empresa. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { DEFAULT_SCHEDULE, describeNow, isOpen, normalizeSchedule, type Schedule } from '../utils/hours';
import { emitToAccount } from '../realtime/io';

export const businessHoursRouter = Router();

async function tzOf(accountId: string) {
  const [a] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  return a?.tz || 'America/Sao_Paulo';
}

/** Está dentro do horário? (desligado = sempre "aberto": nada de fora do horário acontece) */
export async function openNow(accountId: string, connectionId: string | null | undefined, now = new Date()) {
  if (!connectionId) return { enabled: false, open: true };
  const [h] = await db.select().from(schema.businessHours).where(eq(schema.businessHours.connectionId, connectionId)).limit(1);
  if (!h || !h.enabled || h.accountId !== accountId) return { enabled: false, open: true };
  return { enabled: true, open: isOpen(h.schedule as Schedule, await tzOf(accountId), now) };
}

businessHoursRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const tz = await tzOf(accountId);
  const conns = await db.select({ id: schema.connections.id, name: schema.connections.name, displayPhone: schema.connections.displayPhone, status: schema.connections.status })
    .from(schema.connections).where(eq(schema.connections.accountId, accountId)).orderBy(asc(schema.connections.createdAt));
  const rows = await db.select().from(schema.businessHours).where(eq(schema.businessHours.accountId, accountId));
  res.json({
    timezone: tz,
    connections: conns.map((c) => {
      const h = rows.find((r) => r.connectionId === c.id);
      const schedule = (h?.schedule && Object.keys(h.schedule as object).length ? h.schedule : DEFAULT_SCHEDULE) as Schedule;
      return { ...c, enabled: h?.enabled ?? false, schedule, saved: !!h, now: describeNow(schedule, tz) };
    }),
    canEdit: req.role !== 'agent',
  });
}));

businessHoursRouter.put('/:connectionId', asyncHandler(async (req: Request, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores mudam os horários.');
  const accountId = req.accountId!;
  const connectionId = String(req.params.connectionId);
  if (!isUuid(connectionId)) throw new AppError(404, 'Conexão não encontrada');
  const [conn] = await db.select({ id: schema.connections.id }).from(schema.connections)
    .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.accountId, accountId))).limit(1);
  if (!conn) throw new AppError(404, 'Conexão não encontrada');
  const p = z.object({ enabled: z.boolean(), schedule: z.unknown() }).safeParse(req.body);
  if (!p.success) throw new AppError(422, 'Dados inválidos');
  let schedule: Schedule;
  try { schedule = normalizeSchedule(p.data.schedule); } catch (err) { throw new AppError(422, (err as Error).message); }
  if (p.data.enabled && !Object.values(schedule).some((d) => d.length)) {
    throw new AppError(422, 'Cadastre pelo menos um horário antes de ligar.');
  }
  const [row] = await db.insert(schema.businessHours).values({ accountId, connectionId, enabled: p.data.enabled, schedule })
    .onConflictDoUpdate({ target: schema.businessHours.connectionId, set: { enabled: p.data.enabled, schedule, updatedAt: new Date() } }).returning();
  emitToAccount(accountId, 'hours:changed', { connectionId });
  res.json({ hours: row, now: describeNow(schedule, await tzOf(accountId)) });
}));
