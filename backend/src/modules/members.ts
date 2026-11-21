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
import { deleteObject, putObject, signedUrl, storeDriver } from '../storage/objects';
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
export async function issueMemberLink(memberId: string, slug: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await db.insert(schema.memberTokens).values({
    memberId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
  });
  return `${appBase()}/m/${slug}/entrar?t=${token}`;
}

/**
 * Manda o link de acesso pelo WhatsApp (na última conversa do contato, dentro da janela da Meta) e por e-mail.
 * Devolve por onde saiu.
 */
export async function sendMemberAccess(accountId: string, memberId: string, opts: { courseTitles?: string[]; reason: 'sale' | 'resend' | 'forgot' }): Promise<{ whatsapp: boolean; email: boolean; error?: string }> {
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.id, memberId), eq(schema.memberUsers.accountId, accountId))).limit(1);
  if (!m) return { whatsapp: false, email: false, error: 'Membro não encontrado' };
  const slug = await ensureSlug(accountId);
  const look = await membersLook(accountId);
  const link = await issueMemberLink(memberId, slug);
  const first = (m.name ?? '').trim().split(/\s+/)[0] || '';
  const courses = opts.courseTitles?.length ? opts.courseTitles.map((t) => `“${t}”`).join(', ') : '';
  const intro = opts.reason === 'forgot'
    ? 'Aqui está o link para entrar na área de membros e criar uma nova senha'
    : opts.reason === 'sale' && courses ? `Seu acesso a ${courses} está liberado` : 'Seu acesso à área de membros está liberado';
  const text = `${first ? `Olá, ${first}! ` : ''}${intro} 🎉\n\nEntre por este link (vale 7 dias) e crie sua senha:\n${link}\n\nDepois é só acessar ${appBase()}/m/${slug}`;
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
    const paras = [first ? `Olá, ${escapeHtml(first)}!` : 'Olá!', `${escapeHtml(intro)}${courses ? '' : ''} em <b>${escapeHtml(look.title)}</b>.`, 'Clique no botão para entrar e criar sua senha. O link vale 7 dias.'];
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
    if (!sale || sale.status !== 'approved' || !sale.productId) return;
    const courses = await db.select({ id: schema.memberCourses.id, title: schema.memberCourses.title }).from(schema.memberCourses)
      .where(and(eq(schema.memberCourses.accountId, sale.accountId), eq(schema.memberCourses.productId, sale.productId)));
    if (!courses.length) return;
    const [c] = sale.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, sale.contactId)).limit(1) : [];
    const email = normEmail(c?.email);
    const phone = normPhone(c?.waId ?? c?.phone ?? sale.customerPhone);
    const name = (c?.name ?? sale.customerName ?? '').trim() || null;
    if (!email && !phone) { console.warn(`[membros] venda ${sale.id} sem e-mail nem telefone: acesso não liberado`); return; }
    const member = await upsertMember(sale.accountId, { email, phone, name, contactId: c?.id ?? null });
    const fresh: string[] = [];
    for (const course of courses) {
      const [row] = await db.insert(schema.memberAccess).values({ accountId: sale.accountId, memberId: member.id, courseId: course.id, source: 'sale', saleId: sale.id })
        .onConflictDoUpdate({ target: [schema.memberAccess.memberId, schema.memberAccess.courseId], set: { revokedAt: null, saleId: sale.id }, setWhere: sql`${schema.memberAccess.revokedAt} is not null` })
        .returning({ id: schema.memberAccess.id });
      if (row) fresh.push(course.title);
    }
    if (fresh.length) {
      const r = await sendMemberAccess(sale.accountId, member.id, { courseTitles: fresh, reason: 'sale' });
      if (!r.whatsapp && !r.email) console.warn(`[membros] acesso liberado para ${member.id}, mas o aviso não saiu: ${r.error ?? 'sem WhatsApp nem e-mail'}`);
    }
  } catch (err) { console.error('[membros] liberar acesso pela venda:', (err as Error).message); }
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
  res.json({
    course: { ...c, coverKey: undefined, coverUrl: await coverUrl(c.coverKey, req), members },
    modules: await Promise.all(modules.map(async (m) => ({
      id: m.id, title: m.title, sort: m.sort, coverUrl: await coverUrl(m.coverKey, req),
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
  res.json({ course: { ...row, coverKey: undefined, coverUrl: await coverUrl(row.coverKey, req) } });
}));

membersRouter.delete('/courses/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownCourse(req, req.params.id);
  const files = await db.select({ f: schema.memberLessons.fileKey }).from(schema.memberLessons).where(eq(schema.memberLessons.courseId, c.id));
  const covers = await db.select({ f: schema.memberModules.coverKey }).from(schema.memberModules).where(eq(schema.memberModules.courseId, c.id));
  await db.delete(schema.memberCourses).where(eq(schema.memberCourses.id, c.id));
  for (const k of [c.coverKey, ...files.map((x) => x.f), ...covers.map((x) => x.f)]) await deleteObject(k);
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
  const [m] = await db.insert(schema.memberModules).values({ accountId: req.accountId!, courseId: c.id, title: p.data.title, sort: n }).returning();
  res.status(201).json({ module: { id: m.id, title: m.title, sort: m.sort, coverUrl: null, lessons: [] } });
}));

membersRouter.patch('/modules/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const m = await ownModule(req, req.params.id);
  const p = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Dê um nome ao módulo');
  await db.update(schema.memberModules).set({ title: p.data.title }).where(eq(schema.memberModules.id, m.id));
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

