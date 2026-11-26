/**
 * Converza Members — painel da empresa (cursos, módulos, aulas em PDF, membros) e liberação de acesso.
 *
 * - Cada empresa tem uma área de membros própria em <app>/m/<slug>.
 * - Um curso pode ficar ligado a um produto: quando uma venda desse produto é aprovada no Converza,
 *   o comprador vira membro, ganha o curso e recebe o link de acesso pelo WhatsApp (e por e-mail, se houver).
 * - Os PDFs e as capas ficam no armazenamento de arquivos (Cloudflare R2), nunca no banco.
 */
import { Router, type Request } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { deleteObject, putBuffer, putObject, signedUrl, storeDriver } from '../storage/objects';
import sharp from 'sharp';
import { emailConfigured, escapeHtml, layout, plainText, sendMail } from '../email/mailer';

export const membersRouter = Router();

const MAX_PDF = 100 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/* ============================================================ utilidades compartilhadas */

export function apiBase(req?: Request) {
  if (config.publicApiUrl) return config.publicApiUrl;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://localhost:${config.port}`;
}
export const appBase = () => (config.appOrigins?.[0] ?? config.appOrigin).replace(/\/+$/, '');

/** Capa: link assinado de 12 h (as telas buscam de novo a cada carga). */
export async function coverUrl(key: string | null | undefined, req?: Request) {
  if (!key) return null;
  try { return await signedUrl(key, { seconds: 12 * 3600, apiBase: apiBase(req) }); } catch { return null; }
}

function slugify(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'membros';
}

/** Endereço da área de membros da empresa; cria um a partir do nome se ainda não houver. */
export async function ensureSlug(accountId: string): Promise<string> {
  const [a] = await db.select({ slug: schema.accounts.membersSlug, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  if (!a) throw new AppError(404, 'Empresa não encontrada');
  if (a.slug) return a.slug;
  const base = slugify(a.name);
  for (let i = 0; i < 20; i++) {
    const cand = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    try {
      const [r] = await db.update(schema.accounts).set({ membersSlug: cand }).where(and(eq(schema.accounts.id, accountId), isNull(schema.accounts.membersSlug))).returning({ slug: schema.accounts.membersSlug });
      if (r?.slug) return r.slug;
      const [again] = await db.select({ slug: schema.accounts.membersSlug }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
      if (again?.slug) return again.slug;
    } catch { /* endereço já usado por outra empresa: tenta outro */ }
  }
  throw new AppError(500, 'Não foi possível criar o endereço da área de membros');
}

export interface MembersLook { title: string; subtitle: string; bannerKey: string | null; color: string }
export async function membersLook(accountId: string): Promise<MembersLook> {
  const [a] = await db.select({ settings: schema.accounts.settings, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  const m = (((a?.settings ?? {}) as Record<string, any>).members ?? {}) as Partial<MembersLook>;
  return {
    title: String(m.title ?? '').trim() || `Área de membros ${a?.name ?? ''}`.trim(),
    subtitle: String(m.subtitle ?? '').trim() || 'Seus cursos e materiais em um só lugar.',
    bannerKey: m.bannerKey ?? null,
    color: /^#[0-9a-f]{6}$/i.test(String(m.color ?? '')) ? String(m.color) : '#0e9488',
  };
}

const normPhone = (p: unknown) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 8 ? d : null; };
const normEmail = (e: unknown) => { const s = String(e ?? '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
export { normPhone, normEmail };

/** Link de primeiro acesso / nova senha (vale 7 dias, uso único). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function shortCode(n: number): string {
  const b = randomBytes(n * 2);
  let out = '';
  for (let i = 0; out.length < n && i < b.length; i++) if (b[i] < 256 - (256 % ALPHABET.length)) out += ALPHABET[b[i] % ALPHABET.length];
  return out.length === n ? out : shortCode(n);
}

export async function issueMemberLink(memberId: string, slug: string, courseId?: string | null): Promise<string> {
  // código curto (10 letras e números, ~59 bits): o link fica converza.pro/e/<código>
  const token = shortCode(10);
  await db.insert(schema.memberTokens).values({
    memberId, tokenHash: createHash('sha256').update(token).digest('hex'), courseId: courseId && /^[0-9a-f-]{36}$/i.test(courseId) ? courseId : null, expiresAt: new Date(Date.now() + 10 * 365 * 24 * 3600_000), // o link é o único jeito de entrar: vale sempre
  });
  // no endereço do app: o WhatsApp mostra a prévia com a capa do curso (quem clica vai direto para a área)
  void slug;
  return `${appBase()}/e/${token}`;
}

/**
 * Manda o link de acesso pelo WhatsApp (na última conversa do contato, dentro da janela da Meta) e por e-mail.
 * Devolve por onde saiu.
 */
export async function sendMemberAccess(accountId: string, memberId: string, opts: { courseTitles?: string[]; moduleTitles?: string[]; reason: 'sale' | 'resend' | 'forgot' }): Promise<{ whatsapp: boolean; email: boolean; error?: string }> {
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.id, memberId), eq(schema.memberUsers.accountId, accountId))).limit(1);
  if (!m) return { whatsapp: false, email: false, error: 'Membro não encontrado' };
  const slug = await ensureSlug(accountId);
  const look = await membersLook(accountId);
  const link = await issueMemberLink(memberId, slug);
  const first = (m.name ?? '').trim().split(/\s+/)[0] || '';
  const courses = opts.courseTitles?.length ? opts.courseTitles.map((t) => `“${t}”`).join(', ') : '';
  const mods = opts.moduleTitles?.length ? opts.moduleTitles.map((t) => `“${t}”`).join(', ') : '';
  const intro = opts.reason === 'forgot'
    ? 'Aqui está o link para entrar na área de membros'
    : opts.reason === 'sale' && courses ? `Seu acesso a ${courses} está liberado${mods ? `, com ${mods}` : ''}`
      : opts.reason === 'sale' && mods ? `${opts.moduleTitles!.length > 1 ? 'Novos módulos liberados' : 'Novo módulo liberado'} na área de membros: ${mods}`
        : 'Seu acesso à área de membros está liberado';
  const text = `${first ? `Olá, ${first}! ` : ''}${intro} 🎉\n\nToque no link para entrar:\n${link}\n\nGuarde esta mensagem: é sempre por este link que você entra.`;
  let whatsapp = false;
  let email = false;
  let error: string | undefined;
  const contactId = m.contactId ?? (m.phone ? (await db.select({ id: schema.contacts.id }).from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, accountId), sql`regexp_replace(${schema.contacts.phone}, '\\D', '', 'g') = ${m.phone}`)).limit(1))[0]?.id : undefined);
  if (contactId) {
    const [conv] = await db.select().from(schema.conversations)
      .where(and(eq(schema.conversations.accountId, accountId), eq(schema.conversations.contactId, contactId)))
      .orderBy(desc(schema.conversations.lastMessageAt)).limit(1);
    if (conv) {
      try {
        const { sendTextInConversation } = await import('../mcp/send');
        const r = await sendTextInConversation(accountId, conv, text);
        whatsapp = r.status === 'sent';
        if (!whatsapp) error = r.error ?? 'Falha no envio pelo WhatsApp';
      } catch (err) { error = (err as Error).message; }
    }
  }
  if (m.email && emailConfigured()) {
    const title = opts.reason === 'forgot' ? 'Entrar na área de membros' : 'Seu acesso está liberado';
    const paras = [first ? `Olá, ${escapeHtml(first)}!` : 'Olá!', `${escapeHtml(intro)}${courses ? '' : ''} em <b>${escapeHtml(look.title)}</b>.`, 'Clique no botão para entrar. Guarde este e-mail: é sempre por este link que você entra.'];
    const r = await sendMail({ to: m.email, subject: `${title} · ${look.title}`, html: layout(title, paras, { label: 'Entrar na área de membros', url: link }), text: plainText(title, paras.map((p) => p.replace(/<[^>]+>/g, '')), { label: 'Entrar na área de membros', url: link }) });
    email = r.sent;
    if (!r.sent && !error) error = r.error;
  }
  return { whatsapp, email, ...(error && !whatsapp && !email ? { error } : {}) };
}

/**
 * Venda aprovada: se o produto está ligado a cursos, o comprador vira membro e ganha o acesso.
 * Chamada sem esperar pelo registro da venda; nunca derruba a venda.
 */
export async function grantFromSale(saleId: string): Promise<void> {
  try {
    const [sale] = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId)).limit(1);
    if (!sale || sale.status !== 'approved') return;
    const courses = sale.productId ? await db.select({ id: schema.memberCourses.id, title: schema.memberCourses.title }).from(schema.memberCourses)
      .where(and(eq(schema.memberCourses.accountId, sale.accountId), eq(schema.memberCourses.productId, sale.productId))) : [];
    const rules = sale.productId ? await rulesForProduct(sale.accountId, sale.productId) : [];
    // módulos que um bloco de fluxo deixou "liberar na venda aprovada"
    // faixas por valor: soma tudo o que o contato já pagou (do produto da pendência, ou de qualquer produto)
    const paidAll = sale.contactId ? await paidByContact(sale.accountId, sale.contactId, null) : Number(sale.amount);
    const paidProduct = sale.contactId && sale.productId ? await paidByContact(sale.accountId, sale.contactId, sale.productId) : Number(sale.amount);
    const saleWhere = sql`kind = 'sale' and ((product_id is null and (min_amount is null or min_amount <= ${paidAll + 0.001})) or (product_id = ${sale.productId ?? null}::uuid and (min_amount is null or min_amount <= ${paidProduct + 0.001})))`;
    const [{ n: waiting }] = (await db.execute(sql`select count(*)::int as n from member_pending_unlocks where account_id = ${sale.accountId} and ${saleWhere}`)).rows as { n: number }[];
    if (!courses.length && !rules.length && !waiting) return;
    const member = courses.length || rules.length ? await buyerOf(sale) : await existingBuyer(sale);
    if (!member) return;
    const fresh: string[] = [];
    for (const course of courses) if (await grantCourse(sale.accountId, member.id, course.id, sale.id)) fresh.push(course.title);
    const mods = await unlockByRules(sale.accountId, member.id, rules, sale.id);
    if (waiting) for (const t of await releasePending(member.id, saleWhere, sale.id)) if (!mods.includes(t)) mods.push(t);
    if (fresh.length || mods.length) {
      const r = await sendMemberAccess(sale.accountId, member.id, { courseTitles: fresh, moduleTitles: mods, reason: 'sale' });
      if (!r.whatsapp && !r.email) console.warn(`[membros] acesso liberado para ${member.id}, mas o aviso não saiu: ${r.error ?? 'sem WhatsApp nem e-mail'}`);
    }
  } catch (err) { console.error('[membros] liberar acesso pela venda:', (err as Error).message); }
}

/** Quem comprou, se já for membro (não cria). */
async function existingBuyer(sale: typeof schema.sales.$inferSelect) {
  const [c] = sale.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, sale.contactId)).limit(1) : [];
  const email = normEmail(c?.email);
  const phone = normPhone(c?.waId ?? c?.phone ?? sale.customerPhone);
  const cond = [...(phone ? [eq(schema.memberUsers.phone, phone)] : []), ...(email ? [sql`lower(${schema.memberUsers.email}) = ${email}`] : [])];
  if (!cond.length) return null;
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.accountId, sale.accountId), sql`(${sql.join(cond, sql` or `)})`)).limit(1);
  return m ?? null;
}

/**
 * Libera os módulos pendentes do aluno que batem com a condição (venda ou data vencida).
 * Escolha manual feita depois continua valendo. Retorna os nomes dos módulos liberados.
 */
async function releasePending(memberId: string, where: ReturnType<typeof sql>, saleId: string | null = null): Promise<string[]> {
  const rows = (await db.execute(sql`delete from member_pending_unlocks where member_id = ${memberId} and ${where} returning module_id as "moduleId", account_id as "accountId"`)).rows as { moduleId: string; accountId: string }[];
  const titles: string[] = [];
  for (const r of rows) {
    await db.execute(sql`delete from member_pending_unlocks where member_id = ${memberId} and module_id = ${r.moduleId}`);
    const [prev] = await db.select().from(schema.memberModuleOverrides).where(and(eq(schema.memberModuleOverrides.memberId, memberId), eq(schema.memberModuleOverrides.moduleId, r.moduleId))).limit(1);
    if (prev && prev.source !== 'flow') continue;
    if (prev?.state === 'unlocked') continue;
    await db.insert(schema.memberModuleOverrides).values({ memberId, moduleId: r.moduleId, accountId: r.accountId, state: 'unlocked', source: saleId ? 'sale' : 'flow', saleId })
      .onConflictDoUpdate({ target: [schema.memberModuleOverrides.memberId, schema.memberModuleOverrides.moduleId], set: { state: 'unlocked', source: saleId ? 'sale' : 'flow', saleId, createdAt: new Date() } });
    const [m] = await db.select({ title: schema.memberModules.title }).from(schema.memberModules).where(eq(schema.memberModules.id, r.moduleId)).limit(1);
    if (m && !titles.includes(m.title)) titles.push(m.title);
  }
  return titles;
}

/** Libera os módulos com data vencida de um aluno (ao abrir a área) ou de todos (verificação periódica, que avisa o aluno). */
export async function releaseDuePending(memberId?: string): Promise<number> {
  const members = memberId ? [{ memberId }] : (await db.execute(sql`select distinct member_id as "memberId" from member_pending_unlocks where kind = 'time' and unlock_at <= now() limit 500`)).rows as { memberId: string }[];
  let n = 0;
  for (const { memberId: mid } of members) {
    const titles = await releasePending(mid, sql`kind = 'time' and unlock_at <= now()`);
    n += titles.length;
    if (titles.length && !memberId) {
      const [m] = await db.select({ accountId: schema.memberUsers.accountId }).from(schema.memberUsers).where(eq(schema.memberUsers.id, mid)).limit(1);
      if (m) await sendMemberAccess(m.accountId, mid, { moduleTitles: titles, reason: 'sale' }).catch(() => undefined);
    }
  }
  return n;
}

export function startMembersSweep() {
  const tick = () => releaseDuePending().then((n) => { if (n) console.log(`[membros] ${n} módulo(s) liberado(s) pela data`); })
    .catch((err) => console.error('[membros] liberar módulos pela data:', (err as Error).message));
  setTimeout(tick, 50_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}

/** Quem comprou, como membro (cria se ainda não existir). */
async function buyerOf(sale: typeof schema.sales.$inferSelect) {
  const [c] = sale.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, sale.contactId)).limit(1) : [];
  const email = normEmail(c?.email);
  const phone = normPhone(c?.waId ?? c?.phone ?? sale.customerPhone);
  const name = (c?.name ?? sale.customerName ?? '').trim() || null;
  if (!email && !phone) { console.warn(`[membros] venda ${sale.id} sem e-mail nem telefone: acesso não liberado`); return null; }
  return upsertMember(sale.accountId, { email, phone, name, contactId: c?.id ?? null });
}

/** Dá acesso ao curso (ou devolve um acesso revogado). Retorna true se o acesso é novo. */
async function grantCourse(accountId: string, memberId: string, courseId: string, saleId: string | null, source?: string) {
  const [row] = await db.insert(schema.memberAccess).values({ accountId, memberId, courseId, source: source ?? (saleId ? 'sale' : 'manual'), saleId })
    .onConflictDoUpdate({ target: [schema.memberAccess.memberId, schema.memberAccess.courseId], set: { revokedAt: null, saleId }, setWhere: sql`${schema.memberAccess.revokedAt} is not null` })
    .returning({ id: schema.memberAccess.id });
  return !!row;
}

type Rule = { id: string; moduleId: string; moduleTitle: string; courseId: string };
async function rulesForProduct(accountId: string, productId: string): Promise<Rule[]> {
  return (await db.execute(sql`
    select r.id, r.module_id as "moduleId", m.title as "moduleTitle", m.course_id as "courseId" from member_unlock_rules r
    join member_modules m on m.id = r.module_id where r.account_id = ${accountId} and r.product_id = ${productId}`)).rows as Rule[];
}

/**
 * Libera os módulos das regras para o aluno. Se ele ainda não tem o curso do módulo, ganha o acesso ao curso também.
 * Uma escolha manual de "bloqueado" para o aluno é respeitada. Retorna os módulos que passaram a ficar liberados.
 */
async function unlockByRules(accountId: string, memberId: string, rules: Rule[], saleId: string | null, source = 'sale'): Promise<string[]> {
  const out: string[] = [];
  for (const r of rules) {
    await grantCourse(accountId, memberId, r.courseId, saleId, source);
    const [prev] = await db.select().from(schema.memberModuleOverrides)
      .where(and(eq(schema.memberModuleOverrides.memberId, memberId), eq(schema.memberModuleOverrides.moduleId, r.moduleId))).limit(1);
    if (prev?.state === 'unlocked') continue;
    if (prev?.state === 'locked' && prev.source === 'manual') continue;
    await db.insert(schema.memberModuleOverrides).values({ memberId, moduleId: r.moduleId, accountId, state: 'unlocked', source, saleId })
      .onConflictDoUpdate({ target: [schema.memberModuleOverrides.memberId, schema.memberModuleOverrides.moduleId], set: { state: 'unlocked', source, saleId, createdAt: new Date() } });
    out.push(r.moduleTitle);
  }
  return out;
}

/**
 * Bloco de fluxo "Área de membros": libera ou tira cursos (e módulos) do contato da conversa.
 * Liberar devolve um link de entrada direta (vale 7 dias, uma vez) para o fluxo mandar na conversa.
 */
/** Quanto o contato já pagou (vendas aprovadas), de um produto ou de todos. */
export async function paidByContact(accountId: string, contactId: string | null, productId: string | null): Promise<number> {
  if (!contactId) return 0;
  const r = await db.execute(sql`select coalesce(sum(amount), 0)::float as n from sales where account_id = ${accountId} and contact_id = ${contactId}
    and status = 'approved' ${productId && isUuid(productId) ? sql`and product_id = ${productId}` : sql``}`);
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Módulo → menor valor pago que o libera (cada faixa inclui as menores). */
function tierThresholds(list: { min: number; modules: string[] }[]): Map<string, number> {
  const t = new Map<string, number>();
  for (const tier of [...list].sort((a, b) => a.min - b.min)) for (const m of tier.modules) if (!t.has(m)) t.set(m, tier.min);
  return t;
}

export async function flowMembersAccess(accountId: string, contactId: string, p: { action: 'grant' | 'revoke'; courseIds: string[]; moduleIds: string[]; courseModules?: Record<string, string[]>; unlockRest?: { onSale: boolean; productId: string | null; afterDays: number | null }; tiers?: { productId: string | null; list: { min: number; modules: string[] }[] } }) {
  const empty = { link: '', area: '', courses: [] as string[], modules: [] as string[] };
  const [c] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.accountId, accountId))).limit(1);
  if (!c) return { ok: false, info: 'contato não encontrado', ...empty };
  const phone = normPhone(c.waId ?? c.phone);
  const email = normEmail(c.email);
  if (!phone && !email) return { ok: false, info: 'o contato não tem telefone nem e-mail', ...empty };
  const cIds = p.courseIds.filter(isUuid), mIds = p.moduleIds.filter(isUuid);
  const courses = cIds.length ? await db.select({ id: schema.memberCourses.id, title: schema.memberCourses.title }).from(schema.memberCourses)
    .where(and(eq(schema.memberCourses.accountId, accountId), sql`${schema.memberCourses.id} in (${sql.join(cIds.map((i) => sql`${i}`), sql`, `)})`)) : [];
  const mods = mIds.length ? (await db.execute(sql`select id as "moduleId", title as "moduleTitle", course_id as "courseId", id from member_modules
    where account_id = ${accountId} and id in (${sql.join(mIds.map((i) => sql`${i}`), sql`, `)})`)).rows as Rule[] : [];
  if (!courses.length && !mods.length) return { ok: false, info: 'os cursos escolhidos no bloco não existem mais', ...empty };
  const slug = await ensureSlug(accountId);
  const area = `${appBase()}/m/${slug}`;
  if (p.action === 'revoke') {
    const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.accountId, accountId),
      sql`(${sql.join([...(phone ? [eq(schema.memberUsers.phone, phone)] : []), ...(email ? [sql`lower(${schema.memberUsers.email}) = ${email}`] : [])], sql` or `)})`)).limit(1);
    if (m) {
      if (courses.length) await db.update(schema.memberAccess).set({ revokedAt: new Date() })
        .where(and(eq(schema.memberAccess.memberId, m.id), isNull(schema.memberAccess.revokedAt), sql`${schema.memberAccess.courseId} in (${sql.join(courses.map((x) => sql`${x.id}`), sql`, `)})`));
      await db.execute(sql`delete from member_pending_unlocks where member_id = ${m.id} and module_id in (select id from member_modules where ${courses.length ? sql`course_id in (${sql.join(courses.map((x) => sql`${x.id}`), sql`, `)})` : sql`false`} ${mods.length ? sql`or id in (${sql.join(mods.map((x) => sql`${x.moduleId}`), sql`, `)})` : sql``})`);
      for (const r of mods) await db.insert(schema.memberModuleOverrides).values({ memberId: m.id, moduleId: r.moduleId, accountId, state: 'locked', source: 'flow' })
        .onConflictDoUpdate({ target: [schema.memberModuleOverrides.memberId, schema.memberModuleOverrides.moduleId], set: { state: 'locked', source: 'flow', saleId: null, createdAt: new Date() } });
    }
    return { ok: true, link: '', area, courses: courses.map((x) => x.title), modules: mods.map((x) => x.moduleTitle) };
  }
  const member = await upsertMember(accountId, { email, phone, name: (c.name ?? '').trim() || null, contactId: c.id });
  for (const x of courses) await grantCourse(accountId, member.id, x.id, null, 'flow');
  await unlockByRules(accountId, member.id, mods, null, 'flow');
  // módulos escolhidos na entrega: os marcados ficam liberados, os outros bloqueados para este contato
  const liberated: string[] = mods.map((x) => x.moduleTitle);
  // faixas por valor pago: o que o contato já pagou libera na hora; o resto espera a venda com o valor da faixa
  const thresholds = p.tiers?.list.length ? tierThresholds(p.tiers.list) : new Map<string, number>();
  const tierProduct = p.tiers?.productId && isUuid(p.tiers.productId) ? p.tiers.productId : null;
  const paid = thresholds.size ? await paidByContact(accountId, contactId, tierProduct) : 0;
  for (const x of courses) {
    const base = p.courseModules?.[x.id];
    if (!base) continue;
    const pick = [...base, ...[...thresholds].filter(([, min]) => min <= paid + 0.001).map(([id]) => id).filter((id) => !base.includes(id))];
    const all = await db.select({ id: schema.memberModules.id, title: schema.memberModules.title }).from(schema.memberModules).where(eq(schema.memberModules.courseId, x.id));
    const on = all.filter((m) => pick.includes(m.id));
    await unlockByRules(accountId, member.id, on.map((m) => ({ id: m.id, moduleId: m.id, moduleTitle: m.title, courseId: x.id })), null, 'flow');
    for (const m of on) if (!liberated.includes(m.title)) liberated.push(m.title);
    for (const m of all.filter((y) => !pick.includes(y.id))) {
      const [prev] = await db.select().from(schema.memberModuleOverrides).where(and(eq(schema.memberModuleOverrides.memberId, member.id), eq(schema.memberModuleOverrides.moduleId, m.id))).limit(1);
      if (prev?.source === 'manual' || prev?.source === 'sale') continue; // escolha manual e venda de upsell continuam valendo
      await db.insert(schema.memberModuleOverrides).values({ memberId: member.id, moduleId: m.id, accountId, state: 'locked', source: 'flow' })
        .onConflictDoUpdate({ target: [schema.memberModuleOverrides.memberId, schema.memberModuleOverrides.moduleId], set: { state: 'locked', source: 'flow', saleId: null, createdAt: new Date() } });
      // o resto dos módulos libera depois: na venda aprovada e/ou depois de alguns dias (o que vier primeiro)
      await db.delete(schema.memberPendingUnlocks).where(and(eq(schema.memberPendingUnlocks.memberId, member.id), eq(schema.memberPendingUnlocks.moduleId, m.id)));
      const min = thresholds.get(m.id);
      if (min !== undefined) {
        // módulo de uma faixa: só libera quando o pago chegar no valor dela (não libera por tempo)
        await db.insert(schema.memberPendingUnlocks).values({ accountId, memberId: member.id, moduleId: m.id, kind: 'sale', productId: tierProduct, minAmount: min.toFixed(2) });
        continue;
      }
      const ur = p.unlockRest;
      if (ur?.onSale) await db.insert(schema.memberPendingUnlocks).values({ accountId, memberId: member.id, moduleId: m.id, kind: 'sale', productId: ur.productId && isUuid(ur.productId) ? ur.productId : null });
      if (ur?.afterDays && ur.afterDays > 0) await db.insert(schema.memberPendingUnlocks).values({ accountId, memberId: member.id, moduleId: m.id, kind: 'time', unlockAt: new Date(Date.now() + Math.min(3650, ur.afterDays) * 86_400_000) });
    }
    // módulos marcados não ficam mais pendentes
    for (const m of on) await db.delete(schema.memberPendingUnlocks).where(and(eq(schema.memberPendingUnlocks.memberId, member.id), eq(schema.memberPendingUnlocks.moduleId, m.id)));
  }
  const link = await issueMemberLink(member.id, slug, courses[0]?.id ?? mods[0]?.courseId ?? null);
  const all = courses.map((x) => x.title);
  for (const r of mods) if (!courses.some((x) => x.id === r.courseId)) {
    const [t] = await db.select({ title: schema.memberCourses.title }).from(schema.memberCourses).where(eq(schema.memberCourses.id, r.courseId)).limit(1);
    if (t && !all.includes(t.title)) all.push(t.title);
  }
  return { ok: true, link, area, courses: all, modules: liberated };
}

export async function upsertMember(accountId: string, d: { email: string | null; phone: string | null; name: string | null; contactId: string | null }) {
  const cond = [
    ...(d.email ? [sql`lower(${schema.memberUsers.email}) = ${d.email}`] : []),
    ...(d.phone ? [eq(schema.memberUsers.phone, d.phone)] : []),
  ];
  const [found] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.accountId, accountId), sql`(${sql.join(cond, sql` or `)})`)).limit(1);
  if (found) {
    const patch: Partial<typeof schema.memberUsers.$inferInsert> = {};
    if (!found.email && d.email) patch.email = d.email;
    if (!found.phone && d.phone) patch.phone = d.phone;
    if (!found.name && d.name) patch.name = d.name;
    if (!found.contactId && d.contactId) patch.contactId = d.contactId;
    if (Object.keys(patch).length) { try { await db.update(schema.memberUsers).set(patch).where(eq(schema.memberUsers.id, found.id)); } catch { /* e-mail/telefone já de outro membro */ } }
    return found;
  }
  const [row] = await db.insert(schema.memberUsers).values({ accountId, email: d.email, phone: d.phone, name: d.name, contactId: d.contactId }).returning();
  return row;
}

/* ============================================================ painel: permissões e posse */

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só administradores e gestores mexem na área de membros');
}
async function ownCourse(req: Request, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Curso não encontrado');
  const [c] = await db.select().from(schema.memberCourses).where(and(eq(schema.memberCourses.id, id), eq(schema.memberCourses.accountId, req.accountId!))).limit(1);
  if (!c) throw new AppError(404, 'Curso não encontrado');
  return c;
}
async function ownModule(req: Request, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Módulo não encontrado');
  const [m] = await db.select().from(schema.memberModules).where(and(eq(schema.memberModules.id, id), eq(schema.memberModules.accountId, req.accountId!))).limit(1);
  if (!m) throw new AppError(404, 'Módulo não encontrado');
  return m;
}
async function ownLesson(req: Request, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Aula não encontrada');
  const [l] = await db.select().from(schema.memberLessons).where(and(eq(schema.memberLessons.id, id), eq(schema.memberLessons.accountId, req.accountId!))).limit(1);
  if (!l) throw new AppError(404, 'Aula não encontrada');
  return l;
}
async function ownProduct(req: Request, id: string | null | undefined) {
  if (!id) return null;
  if (!isUuid(id)) throw new AppError(422, 'Produto inválido');
  const [p] = await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.id, id), eq(schema.products.accountId, req.accountId!))).limit(1);
  if (!p) throw new AppError(422, 'Produto não encontrado');
  return p.id;
}

/** Recebe uma imagem de capa no corpo da requisição e devolve a chave guardada. */
async function receiveImage(req: Request, folder: string) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new AppError(415, 'Use uma imagem JPG, PNG ou WebP.');
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_IMAGE) throw new AppError(413, 'Imagem grande demais: o limite é 5 MB.');
  const key = `m/${req.accountId}/${folder}/${randomUUID()}.${ext}`;
  await putObject(key, req, type, MAX_IMAGE);
  return key;
}

/* ============================================================ configuração da área */

const view = async (accountId: string, req: Request) => {
  const slug = await ensureSlug(accountId);
  const look = await membersLook(accountId);
  return { slug, url: `${appBase()}/m/${slug}`, title: look.title, subtitle: look.subtitle, color: look.color, bannerUrl: await coverUrl(look.bannerKey, req), storage: storeDriver() };
};

membersRouter.get('/settings', asyncHandler(async (req, res) => { res.json(await view(req.accountId!, req)); }));

membersRouter.put('/settings', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = z.object({
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Endereço: de 3 a 40 letras, números ou hífens').optional(),
    title: z.string().trim().max(80).optional(),
    subtitle: z.string().trim().max(160).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const d = p.data;
  if (d.slug) {
    const reserved = ['admin', 'api', 'app', 'login', 'entrar', 'converza', 'suporte'];
    if (reserved.includes(d.slug)) throw new AppError(422, 'Esse endereço é reservado. Escolha outro.');
    try { await db.update(schema.accounts).set({ membersSlug: d.slug }).where(eq(schema.accounts.id, req.accountId!)); }
    catch { throw new AppError(409, 'Esse endereço já é usado por outra empresa. Escolha outro.'); }
  }
  const patch: Record<string, string> = {};
  for (const k of ['title', 'subtitle', 'color'] as const) if (d[k] !== undefined) patch[k] = d[k]!;
  if (Object.keys(patch).length) {
    await db.execute(sql`update accounts set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{members}', coalesce(settings->'members','{}'::jsonb) || ${JSON.stringify(patch)}::jsonb) where id = ${req.accountId!}`);
  }
  res.json(await view(req.accountId!, req));
}));

membersRouter.post('/settings/banner', asyncHandler(async (req, res) => {
  managerOnly(req);
  const old = (await membersLook(req.accountId!)).bannerKey;
  const key = await receiveImage(req, 'banner');
  await db.execute(sql`update accounts set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{members}', coalesce(settings->'members','{}'::jsonb) || jsonb_build_object('bannerKey', ${key}::text)) where id = ${req.accountId!}`);
  await deleteObject(old);
  res.json(await view(req.accountId!, req));
}));

membersRouter.delete('/settings/banner', asyncHandler(async (req, res) => {
  managerOnly(req);
  const old = (await membersLook(req.accountId!)).bannerKey;
  await db.execute(sql`update accounts set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{members}', coalesce(settings->'members','{}'::jsonb) - 'bannerKey') where id = ${req.accountId!}`);
  await deleteObject(old);
  res.json(await view(req.accountId!, req));
}));

/* ============================================================ cursos */

membersRouter.get('/courses', asyncHandler(async (req, res) => {
  const rows = (await db.execute(sql`
    select c.id, c.title, c.description, c.cover_key as "coverKey", c.product_id as "productId", p.name as "productName", c.published, c.sort, c.created_at as "createdAt",
      (select count(*)::int from member_modules m where m.course_id = c.id) as modules,
      (select count(*)::int from member_lessons l where l.course_id = c.id) as lessons,
      (select count(*)::int from member_lessons l where l.course_id = c.id and l.file_key is not null) as "lessonsWithFile",
      (select count(*)::int from member_access a where a.course_id = c.id and a.revoked_at is null) as members
    from member_courses c left join products p on p.id = c.product_id
    where c.account_id = ${req.accountId!} order by c.sort, c.created_at`)).rows as any[];
  const courses = await Promise.all(rows.map(async (r) => ({ ...r, coverKey: undefined, coverUrl: await coverUrl(r.coverKey, req) })));
  res.json({ courses, storage: storeDriver() });
}));

const courseSchema = z.object({
  title: z.string().trim().min(1, 'Dê um nome ao curso').max(120),
  description: z.string().trim().max(2000).nullish(),
  productId: z.string().nullish(),
  published: z.boolean().optional(),
  sort: z.number().int().min(0).max(100_000).optional(),
});

membersRouter.post('/courses', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = courseSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const productId = await ownProduct(req, p.data.productId);
  const [{ n }] = (await db.execute(sql`select coalesce(max(sort), -1)::int + 1 as n from member_courses where account_id = ${req.accountId!}`)).rows as { n: number }[];
  const [c] = await db.insert(schema.memberCourses).values({ accountId: req.accountId!, title: p.data.title, description: p.data.description ?? null, productId, published: p.data.published ?? false, sort: n }).returning();
  await ensureSlug(req.accountId!);
  res.status(201).json({ course: c });
}));

membersRouter.get('/courses/:id', asyncHandler(async (req, res) => {
  const c = await ownCourse(req, req.params.id);
  const modules = await db.select().from(schema.memberModules).where(eq(schema.memberModules.courseId, c.id)).orderBy(asc(schema.memberModules.sort), asc(schema.memberModules.createdAt));
  const lessons = await db.select().from(schema.memberLessons).where(eq(schema.memberLessons.courseId, c.id)).orderBy(asc(schema.memberLessons.sort), asc(schema.memberLessons.createdAt));
  const [{ members }] = (await db.execute(sql`select count(*)::int as members from member_access where course_id = ${c.id} and revoked_at is null`)).rows as { members: number }[];
  const rules = (await db.execute(sql`
    select r.id, r.module_id as "moduleId", r.product_id as "productId", p.name as "productName" from member_unlock_rules r
    join member_modules m on m.id = r.module_id join products p on p.id = r.product_id
    where m.course_id = ${c.id} order by r.created_at`)).rows as { id: string; moduleId: string; productId: string; productName: string }[];
  res.json({
    course: { ...c, coverKey: undefined, previewKey: undefined, coverUrl: await coverUrl(c.coverKey, req), previewUrl: await coverUrl(c.previewKey, req), members },
    modules: await Promise.all(modules.map(async (m) => ({
      id: m.id, title: m.title, sort: m.sort, coverUrl: await coverUrl(m.coverKey, req), locked: m.locked, unlockAfterDays: m.unlockAfterDays, isBonus: m.isBonus, buyPrice: m.buyPrice != null ? Number(m.buyPrice) : null, buyUrl: m.buyUrl ?? null,
      unlockRules: rules.filter((r) => r.moduleId === m.id).map(({ moduleId: _m, ...r }) => r),
      lessons: lessons.filter((l) => l.moduleId === m.id).map((l) => ({ id: l.id, title: l.title, description: l.description, fileName: l.fileName, fileSize: l.fileSize, hasFile: !!l.fileKey, sort: l.sort })),
    }))),
  });
}));

membersRouter.patch('/courses/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const p = courseSchema.partial().safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const patch: Partial<typeof schema.memberCourses.$inferInsert> = {};
  if (p.data.title !== undefined) patch.title = p.data.title;
  if (p.data.description !== undefined) patch.description = p.data.description ?? null;
  if (p.data.productId !== undefined) patch.productId = await ownProduct(req, p.data.productId);
  if (p.data.published !== undefined) patch.published = p.data.published;
  if (p.data.sort !== undefined) patch.sort = p.data.sort;
  const [row] = Object.keys(patch).length ? await db.update(schema.memberCourses).set(patch).where(eq(schema.memberCourses.id, c.id)).returning() : [c];
  res.json({ course: { ...row, coverKey: undefined, previewKey: undefined, coverUrl: await coverUrl(row.coverKey, req), previewUrl: await coverUrl(row.previewKey, req) } });
}));

membersRouter.delete('/courses/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const files = await db.select({ f: schema.memberLessons.fileKey }).from(schema.memberLessons).where(eq(schema.memberLessons.courseId, c.id));
  const covers = await db.select({ f: schema.memberModules.coverKey }).from(schema.memberModules).where(eq(schema.memberModules.courseId, c.id));
  await db.delete(schema.memberCourses).where(eq(schema.memberCourses.id, c.id));
  for (const k of [c.coverKey, c.previewKey, ...files.map((x) => x.f), ...covers.map((x) => x.f)]) await deleteObject(k);
  res.status(204).end();
}));

/** Tamanho exato da prévia de link do WhatsApp/Facebook (1,91:1). */
export const PREVIEW_W = 1200, PREVIEW_H = 628;

/** Imagem da prévia do link: o app manda já recortada; aqui ela é gravada sempre em 1200×628 (JPEG). */
membersRouter.post('/courses/:id/preview', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES[type]) throw new AppError(415, 'Use uma imagem JPG, PNG ou WebP.');
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_IMAGE) throw new AppError(413, 'Imagem grande demais: o limite é 5 MB.');
    parts.push(chunk as Buffer);
  }
  let jpg: Buffer;
  try {
    jpg = await sharp(Buffer.concat(parts)).rotate().resize(PREVIEW_W, PREVIEW_H, { fit: 'cover', position: 'centre' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } catch { throw new AppError(415, 'Não foi possível ler essa imagem.'); }
  const key = `m/${req.accountId}/previews/${randomUUID()}.jpg`;
  await putBuffer(key, jpg, 'image/jpeg');
  await db.update(schema.memberCourses).set({ previewKey: key }).where(eq(schema.memberCourses.id, c.id));
  await deleteObject(c.previewKey);
  res.json({ previewUrl: await coverUrl(key, req) });
}));

membersRouter.delete('/courses/:id/preview', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  await db.update(schema.memberCourses).set({ previewKey: null }).where(eq(schema.memberCourses.id, c.id));
  await deleteObject(c.previewKey);
  res.status(204).end();
}));

membersRouter.post('/courses/:id/cover', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const key = await receiveImage(req, 'covers');
  await db.update(schema.memberCourses).set({ coverKey: key }).where(eq(schema.memberCourses.id, c.id));
  await deleteObject(c.coverKey);
  res.json({ coverUrl: await coverUrl(key, req) });
}));

/** Nova ordem dos módulos e das aulas de cada módulo (aula pode mudar de módulo). */
membersRouter.post('/courses/:id/order', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const p = z.object({ modules: z.array(z.object({ id: z.string(), lessons: z.array(z.string()) })).max(300) }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Ordem inválida');
  const mods = await db.select({ id: schema.memberModules.id }).from(schema.memberModules).where(eq(schema.memberModules.courseId, c.id));
  const les = await db.select({ id: schema.memberLessons.id }).from(schema.memberLessons).where(eq(schema.memberLessons.courseId, c.id));
  const modIds = new Set(mods.map((m) => m.id)); const lesIds = new Set(les.map((l) => l.id));
  await db.transaction(async (tx) => {
    for (const [i, m] of p.data.modules.entries()) {
      if (!modIds.has(m.id)) continue;
      await tx.update(schema.memberModules).set({ sort: i }).where(eq(schema.memberModules.id, m.id));
      for (const [j, lid] of m.lessons.entries()) if (lesIds.has(lid)) await tx.update(schema.memberLessons).set({ sort: j, moduleId: m.id }).where(eq(schema.memberLessons.id, lid));
    }
  });
  res.json({ ok: true });
}));

/* ============================================================ módulos */

membersRouter.post('/courses/:id/modules', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const p = z.object({ title: z.string().trim().min(1, 'Dê um nome ao módulo').max(120) }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const [{ n }] = (await db.execute(sql`select coalesce(max(sort), -1)::int + 1 as n from member_modules where course_id = ${c.id}`)).rows as { n: number }[];
  const [m] = await db.insert(schema.memberModules).values({ accountId: req.accountId!, courseId: c.id, title: p.data.title, sort: n, isBonus: /b[ôo]nus/i.test(p.data.title) }).returning();
  res.status(201).json({ module: { id: m.id, title: m.title, sort: m.sort, coverUrl: null, locked: false, unlockAfterDays: null, isBonus: m.isBonus, lessons: [] } });
}));

membersRouter.patch('/modules/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const p = z.object({
    title: z.string().trim().min(1, 'Dê um nome ao módulo').max(120).optional(),
    locked: z.boolean().optional(),
    unlockAfterDays: z.number().int().min(1, 'Mínimo de 1 dia').max(3650).nullable().optional(),
    isBonus: z.boolean().optional(),
    buyPrice: z.number().min(0).max(1_000_000).nullable().optional(),
    buyUrl: z.string().trim().max(500).url('Link de compra inválido').refine((u) => /^https:\/\//i.test(u), 'Use um link https://').or(z.literal('')).nullable().optional(),
  }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const patch: Partial<typeof schema.memberModules.$inferInsert> = {};
  if (p.data.title !== undefined) patch.title = p.data.title;
  if (p.data.locked !== undefined) patch.locked = p.data.locked;
  if (p.data.unlockAfterDays !== undefined) patch.unlockAfterDays = p.data.unlockAfterDays;
  if (patch.locked === false) patch.unlockAfterDays = null;
  if (p.data.isBonus !== undefined) patch.isBonus = p.data.isBonus;
  if (p.data.buyPrice !== undefined) patch.buyPrice = p.data.buyPrice && p.data.buyPrice > 0 ? p.data.buyPrice.toFixed(2) : null;
  if (p.data.buyUrl !== undefined) patch.buyUrl = p.data.buyUrl || null;
  if (Object.keys(patch).length) await db.update(schema.memberModules).set(patch).where(eq(schema.memberModules.id, m.id));
  res.json({ ok: true });
}));

membersRouter.delete('/modules/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const files = await db.select({ f: schema.memberLessons.fileKey }).from(schema.memberLessons).where(eq(schema.memberLessons.moduleId, m.id));
  await db.delete(schema.memberModules).where(eq(schema.memberModules.id, m.id));
  for (const k of [m.coverKey, ...files.map((x) => x.f)]) await deleteObject(k);
  res.status(204).end();
}));

membersRouter.post('/modules/:id/cover', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const key = await receiveImage(req, 'covers');
  await db.update(schema.memberModules).set({ coverKey: key }).where(eq(schema.memberModules.id, m.id));
  await deleteObject(m.coverKey);
  res.json({ coverUrl: await coverUrl(key, req) });
}));

/* ============================================================ aulas */

membersRouter.post('/modules/:id/lessons', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const p = z.object({ title: z.string().trim().min(1, 'Dê um nome à aula').max(160), description: z.string().trim().max(2000).nullish() }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const [{ n }] = (await db.execute(sql`select coalesce(max(sort), -1)::int + 1 as n from member_lessons where module_id = ${m.id}`)).rows as { n: number }[];
  const [l] = await db.insert(schema.memberLessons).values({ accountId: req.accountId!, courseId: m.courseId, moduleId: m.id, title: p.data.title, description: p.data.description ?? null, sort: n }).returning();
  res.status(201).json({ lesson: { id: l.id, title: l.title, description: l.description, fileName: null, fileSize: null, hasFile: false, sort: l.sort } });
}));

membersRouter.patch('/lessons/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const l = await ownLesson(req, req.params.id);
  const p = z.object({ title: z.string().trim().min(1).max(160).optional(), description: z.string().trim().max(2000).nullish() }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Dados inválidos');
  const patch: Partial<typeof schema.memberLessons.$inferInsert> = {};
  if (p.data.title !== undefined) patch.title = p.data.title;
  if (p.data.description !== undefined) patch.description = p.data.description ?? null;
  if (Object.keys(patch).length) await db.update(schema.memberLessons).set(patch).where(eq(schema.memberLessons.id, l.id));
  res.json({ ok: true });
}));

membersRouter.delete('/lessons/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const l = await ownLesson(req, req.params.id);
  await db.delete(schema.memberLessons).where(eq(schema.memberLessons.id, l.id));
  await deleteObject(l.fileKey);
  res.status(204).end();
}));

/** PDF da aula: o corpo da requisição é o arquivo (até 100 MB); o nome vem no cabeçalho x-file-name. */
membersRouter.post('/lessons/:id/file', asyncHandler(async (req, res) => {
  managerOnly(req);
  const l = await ownLesson(req, req.params.id);
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf') throw new AppError(415, 'Envie o material em PDF.');
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > MAX_PDF) throw new AppError(413, 'PDF grande demais: o limite é 100 MB por aula.');
  let name = 'material.pdf';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'material.pdf')).replace(/[\\/\r\n"]/g, '').trim().slice(0, 140) || 'material.pdf'; } catch { /* nome padrão */ }
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const key = `m/${req.accountId}/${l.courseId}/${randomUUID()}.pdf`;
  const size = await putObject(key, req, 'application/pdf', MAX_PDF);
  await db.update(schema.memberLessons).set({ fileKey: key, fileName: name, fileSize: size }).where(eq(schema.memberLessons.id, l.id));
  await deleteObject(l.fileKey);
  res.json({ lesson: { id: l.id, fileName: name, fileSize: size, hasFile: true } });
}));

/** Prévia do PDF para a empresa (link de 15 min). */
membersRouter.get('/lessons/:id/file', asyncHandler(async (req, res) => {
  const l = await ownLesson(req, req.params.id);
  if (!l.fileKey) throw new AppError(404, 'Esta aula ainda não tem PDF');
  res.json({ url: await signedUrl(l.fileKey, { seconds: 900, fileName: l.fileName, apiBase: apiBase(req) }) });
}));

/* ============================================================ membros */

membersRouter.get('/people', asyncHandler(async (req, res) => {
  const courseId = typeof req.query.courseId === 'string' && isUuid(req.query.courseId) ? req.query.courseId : null;
  const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 80);
  const rows = (await db.execute(sql`
    select u.id, u.name, u.email, u.phone, u.created_at as "createdAt", u.last_login_at as "lastLoginAt", (u.password_hash is not null) as "hasPassword",
      coalesce(json_agg(json_build_object('accessId', a.id, 'courseId', c.id, 'title', c.title, 'source', a.source, 'since', a.created_at,
        'done', (select count(*) from member_progress pr join member_lessons l on l.id = pr.lesson_id where pr.member_id = u.id and l.course_id = c.id and pr.completed_at is not null),
        'total', (select count(*) from member_lessons l where l.course_id = c.id)) order by a.created_at) filter (where a.id is not null), '[]') as courses
    from member_users u
    join member_access a on a.member_id = u.id and a.revoked_at is null ${courseId ? sql`and a.course_id = ${courseId}` : sql``}
    join member_courses c on c.id = a.course_id
    where u.account_id = ${req.accountId!}
      ${q ? sql`and (lower(coalesce(u.name,'')) like ${`%${q}%`} or lower(coalesce(u.email,'')) like ${`%${q}%`} or coalesce(u.phone,'') like ${`%${q.replace(/\D/g, '') || q}%`})` : sql``}
    group by u.id order by max(a.created_at) desc limit 300`)).rows;
  res.json({ members: rows });
}));

/** Cursos e módulos para o bloco de fluxo "Área de membros". */
membersRouter.get('/flow-options', asyncHandler(async (req, res) => {
  const courses = await db.select({ id: schema.memberCourses.id, title: schema.memberCourses.title, published: schema.memberCourses.published })
    .from(schema.memberCourses).where(eq(schema.memberCourses.accountId, req.accountId!)).orderBy(asc(schema.memberCourses.sort), asc(schema.memberCourses.createdAt));
  const mods = await db.select({ id: schema.memberModules.id, courseId: schema.memberModules.courseId, title: schema.memberModules.title, locked: schema.memberModules.locked, isBonus: schema.memberModules.isBonus })
    .from(schema.memberModules).where(eq(schema.memberModules.accountId, req.accountId!)).orderBy(asc(schema.memberModules.isBonus), asc(schema.memberModules.sort), asc(schema.memberModules.createdAt));
  res.json({ courses: courses.map((c) => ({ ...c, modules: mods.filter((m) => m.courseId === c.id).map(({ courseId: _c, ...m }) => m) })) });
}));

/* ---------- regras: venda aprovada libera módulo ---------- */

membersRouter.post('/modules/:id/rules', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const p = z.object({ productId: z.string(), applyPast: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Escolha o produto');
  const productId = await ownProduct(req, p.data.productId);
  if (!productId) throw new AppError(422, 'Escolha o produto');
  const [rule] = await db.insert(schema.memberUnlockRules).values({ accountId: req.accountId!, moduleId: m.id, productId }).onConflictDoNothing().returning();
  if (!rule) throw new AppError(409, 'Esse produto já libera este módulo');
  // quem já comprou o produto também ganha o módulo (sem mandar mensagem para todo mundo)
  let applied = 0;
  if (p.data.applyPast) {
    const sales = await db.select().from(schema.sales).where(and(eq(schema.sales.accountId, req.accountId!), eq(schema.sales.productId, productId), eq(schema.sales.status, 'approved')));
    const r: Rule[] = [{ id: rule.id, moduleId: m.id, moduleTitle: m.title, courseId: m.courseId }];
    for (const sale of sales) {
      const member = await buyerOf(sale);
      if (member && (await unlockByRules(req.accountId!, member.id, r, sale.id)).length) applied++;
    }
  }
  const [prod] = await db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  res.status(201).json({ rule: { id: rule.id, productId, productName: prod?.name ?? '' }, applied });
}));

membersRouter.delete('/rules/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Regra não encontrada');
  const [r] = await db.delete(schema.memberUnlockRules).where(and(eq(schema.memberUnlockRules.id, req.params.id), eq(schema.memberUnlockRules.accountId, req.accountId!))).returning();
  if (!r) throw new AppError(404, 'Regra não encontrada');
  // quem já recebeu o módulo por esta regra continua com ele
  res.json({ ok: true });
}));

/* ---------- módulos de um aluno ---------- */

async function ownMember(req: Request, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Membro não encontrado');
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.id, id), eq(schema.memberUsers.accountId, req.accountId!))).limit(1);
  if (!m) throw new AppError(404, 'Membro não encontrado');
  return m;
}

/** Cursos do aluno com cada módulo: a regra do módulo, a escolha para o aluno e como fica para ele. */
membersRouter.get('/people/:id/modules', asyncHandler(async (req, res) => {
  const mem = await ownMember(req, req.params.id);
  const rows = (await db.execute(sql`
    select c.id as "courseId", c.title as "courseTitle", a.created_at as since, m.id, m.title, m.locked, m.unlock_after_days as "unlockAfterDays", m.is_bonus as "isBonus",
      o.state as override, o.source as "overrideSource", p.name as "saleProduct",
      (select min(pu.unlock_at) from member_pending_unlocks pu where pu.member_id = a.member_id and pu.module_id = m.id and pu.kind = 'time') as "pendingAt",
      (select coalesce(max(pp.name), case when count(*) > 0 then '' end) from member_pending_unlocks pu left join products pp on pp.id = pu.product_id where pu.member_id = a.member_id and pu.module_id = m.id and pu.kind = 'sale') as "pendingSale"
    from member_access a join member_courses c on c.id = a.course_id
    join member_modules m on m.course_id = c.id
    left join member_module_overrides o on o.module_id = m.id and o.member_id = a.member_id
    left join sales s on s.id = o.sale_id left join products p on p.id = s.product_id
    where a.member_id = ${mem.id} and a.revoked_at is null
    order by c.sort, c.created_at, m.is_bonus, m.sort, m.created_at`)).rows as any[];
  await releaseDuePending(mem.id);
  const { moduleLock } = await import('./membersArea');
  const courses: { id: string; title: string; modules: unknown[] }[] = [];
  for (const r of rows) {
    let c = courses.find((x) => x.id === r.courseId);
    if (!c) { c = { id: r.courseId, title: r.courseTitle, modules: [] }; courses.push(c); }
    const base = moduleLock(r, r.since);
    const eff = moduleLock(r, r.since, Date.now(), r.override);
    c.modules.push({ id: r.id, title: r.title, isBonus: r.isBonus, defaultLocked: base.locked, defaultUnlockAt: base.unlockAt, ruleLocked: r.locked, unlockAfterDays: r.unlockAfterDays, override: r.override, overrideSource: r.overrideSource, saleProduct: r.saleProduct, locked: eff.locked, unlockAt: eff.locked && r.pendingAt ? new Date(r.pendingAt).toISOString() : eff.unlockAt, pendingSale: r.pendingSale, pendingAt: r.pendingAt });
  }
  res.json({ member: { id: mem.id, name: mem.name, phone: mem.phone, email: mem.email }, courses });
}));

/** Libera, bloqueia ou volta à regra do módulo (state null) só para este aluno. */
membersRouter.put('/people/:id/modules/:moduleId', asyncHandler(async (req, res) => {
  managerOnly(req);
  const mem = await ownMember(req, req.params.id);
  const mod = await ownModule(req, req.params.moduleId);
  const p = z.object({ state: z.enum(['unlocked', 'locked']).nullable() }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Estado inválido');
  const key = and(eq(schema.memberModuleOverrides.memberId, mem.id), eq(schema.memberModuleOverrides.moduleId, mod.id));
  await db.delete(schema.memberPendingUnlocks).where(and(eq(schema.memberPendingUnlocks.memberId, mem.id), eq(schema.memberPendingUnlocks.moduleId, mod.id)));
  if (p.data.state === null) await db.delete(schema.memberModuleOverrides).where(key);
  else await db.insert(schema.memberModuleOverrides).values({ memberId: mem.id, moduleId: mod.id, accountId: req.accountId!, state: p.data.state, source: 'manual' })
    .onConflictDoUpdate({ target: [schema.memberModuleOverrides.memberId, schema.memberModuleOverrides.moduleId], set: { state: p.data.state, source: 'manual', saleId: null, createdAt: new Date() } });
  res.json({ ok: true });
}));

/** Normaliza o número digitado pela empresa: sem código do país e com cara de brasileiro, ganha o 55. */
function fullPhone(raw: string): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return null;
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

/** Libera cursos para um número de WhatsApp (sem venda). Cria o membro se ainda não existir. */
membersRouter.post('/people', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = z.object({
    phone: z.string().trim().min(8, 'Informe o WhatsApp com DDD').max(30),
    name: z.string().trim().max(80).optional(),
    courseIds: z.array(z.string()).min(1, 'Escolha pelo menos um curso').max(100),
    notify: z.boolean().optional(),
  }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const phone = fullPhone(p.data.phone);
  if (!phone) throw new AppError(422, 'Número inválido. Use o DDD (e o código do país, se for de fora do Brasil).');
  const ids = p.data.courseIds.filter(isUuid);
  const courses = ids.length ? await db.select({ id: schema.memberCourses.id, title: schema.memberCourses.title }).from(schema.memberCourses)
    .where(and(eq(schema.memberCourses.accountId, req.accountId!), sql`${schema.memberCourses.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) : [];
  if (!courses.length) throw new AppError(422, 'Curso não encontrado');
  const { phoneVariants } = await import('./membersArea');
  const variants = phoneVariants(phone);
  const inList = sql.join(variants.map((v) => sql`${v}`), sql`, `);
  // mesmo número com outro formato (sem o 9, sem o 55): reaproveita o membro e o contato
  let [member] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.accountId, req.accountId!), sql`${schema.memberUsers.phone} in (${inList})`)).limit(1);
  const [contact] = await db.select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email }).from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, req.accountId!), sql`regexp_replace(coalesce(${schema.contacts.waId}, ${schema.contacts.phone}), '\\D', '', 'g') in (${inList})`)).limit(1);
  if (!member) {
    member = await upsertMember(req.accountId!, { email: normEmail(contact?.email), phone, name: p.data.name || contact?.name || null, contactId: contact?.id ?? null });
  } else if (p.data.name && !member.name) {
    await db.update(schema.memberUsers).set({ name: p.data.name }).where(eq(schema.memberUsers.id, member.id));
  }
  const granted: string[] = [];
  for (const c of courses) {
    const [row] = await db.insert(schema.memberAccess).values({ accountId: req.accountId!, memberId: member.id, courseId: c.id, source: 'manual' })
      .onConflictDoUpdate({ target: [schema.memberAccess.memberId, schema.memberAccess.courseId], set: { revokedAt: null, source: 'manual' }, setWhere: sql`${schema.memberAccess.revokedAt} is not null` })
      .returning({ id: schema.memberAccess.id });
    if (row) granted.push(c.title);
  }
  let notified: Awaited<ReturnType<typeof sendMemberAccess>> | null = null;
  if (p.data.notify && granted.length) notified = await sendMemberAccess(req.accountId!, member.id, { courseTitles: granted, reason: 'sale' });
  res.status(201).json({ memberId: member.id, granted, already: courses.length - granted.length, notified });
}));

/** Tira o acesso do membro a todos os cursos. */
membersRouter.delete('/people/:id/access', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Membro não encontrado');
  const rows = await db.update(schema.memberAccess).set({ revokedAt: new Date() })
    .where(and(eq(schema.memberAccess.memberId, req.params.id), eq(schema.memberAccess.accountId, req.accountId!), isNull(schema.memberAccess.revokedAt)))
    .returning({ id: schema.memberAccess.id });
  res.json({ revoked: rows.length });
}));

membersRouter.post('/people/:id/resend', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Membro não encontrado');
  const r = await sendMemberAccess(req.accountId!, req.params.id, { reason: 'resend' });
  if (!r.whatsapp && !r.email) throw new AppError(422, r.error ? `Não foi possível enviar: ${r.error}` : 'Este membro não tem WhatsApp em conversa recente nem e-mail para receber o link.');
  res.json(r);
}));

membersRouter.delete('/access/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  if (!isUuid(req.params.id)) throw new AppError(404, 'Acesso não encontrado');
  const [row] = await db.update(schema.memberAccess).set({ revokedAt: new Date() })
    .where(and(eq(schema.memberAccess.id, req.params.id), eq(schema.memberAccess.accountId, req.accountId!))).returning({ id: schema.memberAccess.id });
  if (!row) throw new AppError(404, 'Acesso não encontrado');
  res.status(204).end();
}));

