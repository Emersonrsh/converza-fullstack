import { Router } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler } from '../utils/http';
import { resolveAudienceContacts, type Audience } from './audience';
import { enqueueCampaign } from '../queue';

export const dispatchRouter = Router();

dispatchRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await db.select().from(schema.campaigns)
    .where(eq(schema.campaigns.accountId, req.accountId!)).orderBy(desc(schema.campaigns.createdAt));
  res.json({ campaigns: rows });
}));

const createSchema = z.object({
  name: z.string().min(1),
  connectionId: z.string().uuid().optional(),
  message: z.string().min(1),
  audience: z.object({
    all: z.boolean().optional(),
    stage: z.enum(['new', 'in_service', 'negotiating', 'won', 'lost']).optional(),
    contactIds: z.array(z.string().uuid()).optional(),
  }).default({ all: true }),
  scheduledAt: z.string().datetime().optional(),
});

dispatchRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const data = createSchema.parse(req.body);
  const contacts = await resolveAudienceContacts(accountId, data.audience as Audience);
  const runAt = data.scheduledAt ? new Date(data.scheduledAt) : null;

  const [campaign] = await db.insert(schema.campaigns).values({
    accountId, name: data.name, connectionId: data.connectionId ?? null,
    message: data.message, audience: data.audience,
    status: runAt ? 'scheduled' : 'sending', scheduledAt: runAt, totalCount: contacts.length,
  }).returning();

  await enqueueCampaign({ campaignId: campaign.id, accountId }, runAt);
  res.status(201).json({ campaign });
}));
