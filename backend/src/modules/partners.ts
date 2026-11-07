import { Router } from 'express';
import { randomBytes } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError } from '../utils/http';

/** Programa de parceiros: link de indicação de cada conta e quantos clientes vieram por ele. */
export const partnersRouter = Router();

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(randomBytes(7), (b) => ALPHABET[b % 32]).join('');

/** Código de indicação da conta (gerado na primeira vez, de forma atômica). */
async function referralCode(accountId: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const [cur] = await db.select({ code: schema.accounts.referralCode }).from(schema.accounts)
      .where(eq(schema.accounts.id, accountId)).limit(1);
    if (cur?.code) return cur.code;
    try {
      const code = newCode();
      const done = await db.update(schema.accounts).set({ referralCode: code })
        .where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.referralCode)))
        .returning({ code: schema.accounts.referralCode });
      if (done[0]?.code) return done[0].code;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new AppError(500, 'Não foi possível gerar o código de indicação');
}

partnersRouter.get('/me', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const p = config.partners;
  if (!p.enabled) return res.json({ enabled: false });
  const code = await referralCode(accountId);
  const [stats] = (await db.execute(sql`select count(*) as total,
      count(*) filter (where s.status = 'active') as active
    from accounts a left join subscriptions s on s.account_id = a.id
    where a.referred_by = ${accountId}`)).rows as { total: string; active: string }[];
  res.json({
    enabled: true,
    code,
    link: `${config.appOrigin.replace(/\/+$/, '')}/?ref=${code}`,
    commissionPercent: p.commissionPercent,
    contactUrl: p.contactUrl || null,
    referrals: Number(stats?.total ?? 0),
    activeReferrals: Number(stats?.active ?? 0),
  });
}));
