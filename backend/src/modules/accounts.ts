/** Criar outra empresa (conta) — quem cria vira o proprietário. Cada empresa tem a sua assinatura. */
import { config } from '../config';
import { syncHouseAccounts } from '../billing/house';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError } from '../utils/http';
import { slugifyName } from '../auth/routes';
import { slugOk } from './settings';
import { myTeamInvites } from './invites';

export const accountsRouter = Router();

accountsRouter.post('/', asyncHandler(async (req, res) => {
  const p = z.object({
    name: z.string().trim().min(2, 'Dê um nome com pelo menos 2 letras').max(80),
    description: z.string().trim().max(300).optional(),
    slug: z.string().trim().toLowerCase().max(60).optional().or(z.literal('')),
  }).safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  let slug = p.data.slug || '';
  if (slug) {
    if (!slugOk(slug)) throw new AppError(422, 'O slug usa só letras minúsculas, números e hífens (3 a 60).');
    const [taken] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.slug, slug)).limit(1);
    if (taken) throw new AppError(409, 'Esse slug já é usado por outra empresa.');
  } else {
    slug = `${slugifyName(p.data.name)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const account = await db.transaction(async (tx) => {
    const [acc] = await tx.insert(schema.accounts).values({ name: p.data.name, description: p.data.description ?? '', slug }).returning();
    await tx.insert(schema.memberships).values({ userId: req.user!.id, accountId: acc.id, role: 'owner' });
    await tx.insert(schema.subscriptions).values({ accountId: acc.id, status: 'inactive' });
    return acc;
  });
  // dono que está em HOUSE_EMAILS: a empresa nova já nasce como conta da casa
  if (config.house.emails.includes(String(req.user!.email ?? '').toLowerCase())) {
    await syncHouseAccounts().catch((err) => console.error('[conta da casa]', (err as Error).message));
  }
  res.status(201).json({ account: { id: account.id, name: account.name, slug: account.slug, role: 'owner' } });
}));

/** Convites de equipe esperando a minha resposta. */
accountsRouter.get('/invites', asyncHandler(async (req, res) => {
  res.json({ invites: await myTeamInvites(req.user!.email) });
}));
