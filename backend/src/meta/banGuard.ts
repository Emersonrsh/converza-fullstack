/**
 * Proteção de número banido (regra automática embutida): quando um número de WhatsApp é banido,
 * pausa na Meta as campanhas (ou só os conjuntos) que mandam pessoas para ele — anúncio
 * mandando lead para número banido é dinheiro jogado fora.
 *
 * Como achamos o que é "ligado ao número":
 *  1. conjuntos de anúncios ativos cujo promoted_object.whatsapp_phone_number é o número;
 *  2. conjuntos de clique para o WhatsApp sem número informado, de campanhas que trouxeram
 *     leads para essa conexão nos últimos 30 dias (origem do lead = anúncio).
 * Se todos os conjuntos ativos da campanha são do número, pausa a campanha; senão, só os conjuntos.
 */
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { redis } from '../redis';
import { emitToAccount } from '../realtime/io';
import { graphAdsAll, MetaApiError } from './graphAds';
import { setObjectStatus } from './adsWrite';

type Conn = typeof schema.connections.$inferSelect;
export const BAN_GUARD_NAME = 'Proteção: número banido';

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
/** Mesmo número, tolerando o 9 extra dos celulares do Brasil (5511 9xxxx-xxxx × 5511 xxxx-xxxx). */
export function samePhone(a: unknown, b: unknown): boolean {
  const x = digits(a); const y = digits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const br = (d: string) => (d.startsWith('55') && d.length === 13 && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d);
  return br(x) === br(y);
}

export async function banGuardEnabled(accountId: string): Promise<boolean> {
  const [a] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const g = ((a?.settings ?? {}) as { banGuard?: { enabled?: boolean } }).banGuard;
  return g?.enabled !== false; // ligada por padrão
}

export async function setBanGuard(accountId: string, enabled: boolean) {
  const [a] = await db.select({ settings: schema.accounts.settings }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const s = (a?.settings ?? {}) as Record<string, unknown>;
  await db.update(schema.accounts).set({ settings: { ...s, banGuard: { enabled } } }).where(eq(schema.accounts.id, accountId));
}

interface RemoteAdset { id: string; name?: string; campaign_id?: string; status?: string; effective_status?: string; destination_type?: string; promoted_object?: { whatsapp_phone_number?: string } }
interface RemoteCampaign { id: string; name?: string; status?: string; effective_status?: string }
interface RemoteAd { id: string; campaign_id?: string }
const running = (o: { status?: string; effective_status?: string }) => String(o.status ?? '').toUpperCase() === 'ACTIVE'
  && !['DELETED', 'ARCHIVED', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].includes(String(o.effective_status ?? '').toUpperCase());
const toWhatsApp = (a: RemoteAdset) => /WHATSAPP/i.test(String(a.destination_type ?? '')) || !!a.promoted_object?.whatsapp_phone_number;

export interface GuardResult { paused: { level: 'campaign' | 'adset'; name: string }[]; errors: string[]; skipped?: string }

async function log(accountId: string, objectId: string, objectName: string, level: string, status: 'applied' | 'error', detail: string) {
  await db.insert(schema.adRuleLogs).values({ accountId, ruleId: null, ruleName: BAN_GUARD_NAME, objectId, objectName, level, action: 'Pausar', status, detail: detail.slice(0, 500), values: {} })
    .catch(() => undefined);
}

/** Pausa o que manda leads para o número banido. Roda no máximo uma vez a cada 6 horas por número. */
export async function pauseCampaignsForBannedNumber(conn: Conn): Promise<GuardResult> {
  const out: GuardResult = { paused: [], errors: [] };
  if (!(await banGuardEnabled(conn.accountId))) return { ...out, skipped: 'disabled' };
  const phone = digits(conn.displayPhone);
  if (!phone) return { ...out, skipped: 'no_phone' };
  const claimed = await redis.set(`ban-guard:${conn.id}`, '1', 'EX', 6 * 3600, 'NX').catch(() => 'OK');
  if (claimed !== 'OK') return { ...out, skipped: 'recent' };

  const accs = await db.select({ actId: schema.metaAdAccounts.actId, token: schema.metaProfiles.accessToken, status: schema.metaProfiles.status, scopes: schema.metaProfiles.scopes })
    .from(schema.metaAdAccounts).innerJoin(schema.metaProfiles, eq(schema.metaProfiles.id, schema.metaAdAccounts.profileId))
    .where(and(eq(schema.metaAdAccounts.accountId, conn.accountId), eq(schema.metaAdAccounts.selected, true)));
  if (!accs.length) return { ...out, skipped: 'no_ads' };

  // anúncios que trouxeram leads para esta conexão nos últimos 30 dias
  const leadAds = new Set((await db.select({ sourceId: schema.contacts.sourceId }).from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, conn.accountId), eq(schema.contacts.firstConnectionId, conn.id), isNotNull(schema.contacts.sourceId),
      gt(schema.contacts.createdAt, new Date(Date.now() - 30 * 86400_000))))).map((r) => String(r.sourceId)));

  for (const a of accs) {
    const label = a.actId;
    if (a.status !== 'connected') { out.errors.push(`${label}: o login do perfil do Facebook venceu`); continue; }
    const scopes = Array.isArray(a.scopes) ? (a.scopes as unknown[]).map(String) : [];
    if (scopes.length && !scopes.includes('ads_management')) { out.errors.push(`${label}: o perfil do Facebook não tem permissão para pausar anúncios`); continue; }
    try {
      const [adsets, campaigns] = await Promise.all([
        graphAdsAll<RemoteAdset>(`${a.actId}/adsets`, a.token, { fields: 'id,name,campaign_id,status,effective_status,destination_type,promoted_object' }, 2000),
        graphAdsAll<RemoteCampaign>(`${a.actId}/campaigns`, a.token, { fields: 'id,name,status,effective_status' }, 2000),
      ]);
      const live = adsets.filter(running);
      const campLive = new Map(campaigns.filter(running).map((c) => [c.id, c]));
      let leadCamps = new Set<string>();
      if (leadAds.size && live.some((s) => toWhatsApp(s) && !s.promoted_object?.whatsapp_phone_number)) {
        const ads = await graphAdsAll<RemoteAd>(`${a.actId}/ads`, a.token, { fields: 'id,campaign_id' }, 5000);
        leadCamps = new Set(ads.filter((x) => leadAds.has(x.id)).map((x) => String(x.campaign_id)));
      }
      const linked = live.filter((s) => campLive.has(String(s.campaign_id)) && (s.promoted_object?.whatsapp_phone_number
        ? samePhone(s.promoted_object.whatsapp_phone_number, phone)
        : toWhatsApp(s) && leadCamps.has(String(s.campaign_id))));
      const byCamp = new Map<string, RemoteAdset[]>();
      for (const s of linked) byCamp.set(String(s.campaign_id), [...(byCamp.get(String(s.campaign_id)) ?? []), s]);
      for (const [cid, sets] of byCamp) {
        const camp = campLive.get(cid)!;
        const all = live.filter((s) => String(s.campaign_id) === cid);
        const targets: { id: string; name: string; level: 'campaign' | 'adset' }[] = sets.length === all.length
          ? [{ id: cid, name: camp.name ?? cid, level: 'campaign' }]
          : sets.map((s) => ({ id: s.id, name: s.name ?? s.id, level: 'adset' as const }));
        for (const t of targets) {
          const what = t.level === 'campaign' ? 'campanha' : `conjunto (da campanha “${camp.name ?? cid}”)`;
          try {
            await setObjectStatus(t.id, 'PAUSED', a.token);
            out.paused.push({ level: t.level, name: t.name });
            await log(conn.accountId, t.id, t.name, t.level, 'applied', `Pausou ${what} “${t.name}”: o número ${conn.displayPhone} foi banido`);
          } catch (err) {
            const msg = err instanceof MetaApiError ? err.message : (err as Error).message;
            out.errors.push(`${t.name}: ${msg}`);
            await log(conn.accountId, t.id, t.name, t.level, 'error', `Não consegui pausar ${what} “${t.name}”: ${msg}`);
          }
        }
      }
    } catch (err) {
      out.errors.push(`${label}: ${(err as Error).message}`);
    }
  }
  if (out.paused.length || out.errors.length) emitToAccount(conn.accountId, 'meta:rules', { banGuard: conn.id });
  return out;
}
