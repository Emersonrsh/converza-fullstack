/**
 * Converza Members — área do aluno (pública, por empresa): <app>/m/<slug>.
 *
 * Login próprio do membro (e-mail ou WhatsApp + senha), separado das contas do Converza:
 * o token é assinado com outra chave e nunca serve no painel. Primeiro acesso e "esqueci a senha"
 * entram por um link de uso único que chega pelo WhatsApp ou e-mail.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { signedUrl } from '../storage/objects';
import { assertUnderLimits, clientIp, countAttempt, clearAttempts } from '../auth/throttle';
import { apiBase, coverUrl, membersLook, normEmail, normPhone, sendMemberAccess } from './members';

export const membersAreaRouter = Router();

const SECRET = `${config.jwtSecret}:members-area`;
/** hash de uma senha qualquer: login com e-mail desconhecido leva o mesmo tempo */
const DUMMY = bcrypt.hashSync('converza-members-dummy', 10);

interface MemberReq extends Request { member?: typeof schema.memberUsers.$inferSelect; area?: { accountId: string; slug: string } }

async function areaOf(slug: string) {
  const s = String(slug ?? '').toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(s)) throw new AppError(404, 'Área de membros não encontrada');
  const [a] = await db.select({ id: schema.accounts.id, name: schema.accounts.name, suspendedAt: schema.accounts.suspendedAt }).from(schema.accounts).where(eq(schema.accounts.membersSlug, s)).limit(1);
  if (!a) throw new AppError(404, 'Área de membros não encontrada');
  return { accountId: a.id, name: a.name, slug: s, suspended: !!a.suspendedAt };
}

const sign = (m: { id: string; accountId: string; passwordChangedAt: Date | null }) =>
  jwt.sign({ mid: m.id, acc: m.accountId, pv: m.passwordChangedAt ? new Date(m.passwordChangedAt).getTime() : 0 }, SECRET, { expiresIn: '30d' });

/** Exige o login do membro desta área. */
const memberAuth = asyncHandler(async (req: MemberReq, _res: Response, next: NextFunction) => {
  const area = await areaOf(req.params.slug);
  const h = String(req.headers.authorization ?? '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  let p: { mid?: string; acc?: string; pv?: number };
  try { p = jwt.verify(token, SECRET) as typeof p; } catch { throw new AppError(401, 'Entre de novo na área de membros', { code: 'member_auth' }); }
  if (!p.mid || p.acc !== area.accountId) throw new AppError(401, 'Entre de novo na área de membros', { code: 'member_auth' });
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.id, p.mid), eq(schema.memberUsers.accountId, area.accountId))).limit(1);
  // senha trocada depois do login derruba as outras sessões
  if (!m || (m.passwordChangedAt ? new Date(m.passwordChangedAt).getTime() : 0) !== (p.pv ?? 0)) throw new AppError(401, 'Entre de novo na área de membros', { code: 'member_auth' });
  req.member = m;
  req.area = { accountId: area.accountId, slug: area.slug };
  next();
});

/** Módulo bloqueado para este aluno? Com prazo, libera N dias depois do acesso dele ao curso. */
export function moduleLock(m: { locked: boolean; unlockAfterDays: number | null }, since: Date | string, now = Date.now()): { locked: boolean; unlockAt: string | null } {
  if (!m.locked) return { locked: false, unlockAt: null };
  if (m.unlockAfterDays && m.unlockAfterDays > 0) {
    const at = new Date(since).getTime() + m.unlockAfterDays * 86_400_000;
    return now >= at ? { locked: false, unlockAt: null } : { locked: true, unlockAt: new Date(at).toISOString() };
  }
  return { locked: true, unlockAt: null };
}

const memberView = (m: typeof schema.memberUsers.$inferSelect) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, hasPassword: !!m.passwordHash });

/* ============================================================ público */

membersAreaRouter.get('/:slug/info', asyncHandler(async (req, res) => {
  const area = await areaOf(req.params.slug);
  const look = await membersLook(area.accountId);
  res.json({ title: look.title, subtitle: look.subtitle, color: look.color, company: area.name, bannerUrl: await coverUrl(look.bannerKey, req) });
}));

/** acha o membro pelo e-mail ou pelo número (com ou sem o 55 do Brasil) */
async function findByLogin(accountId: string, login: string) {
  const email = normEmail(login);
  const phone = email ? null : normPhone(login);
  if (!email && !phone) return null;
  const phones = phone ? [...new Set([phone, phone.startsWith('55') ? phone.slice(2) : `55${phone}`])] : [];
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.accountId, accountId),
    email ? sql`lower(${schema.memberUsers.email}) = ${email}` : sql`${schema.memberUsers.phone} in (${sql.join(phones.map((p) => sql`${p}`), sql`, `)})`)).limit(1);
  return m ?? null;
}

membersAreaRouter.post('/:slug/login', asyncHandler(async (req, res) => {
  const area = await areaOf(req.params.slug);
  const p = z.object({ login: z.string().trim().min(3).max(120), password: z.string().min(1).max(200) }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, 'Informe seu e-mail ou WhatsApp e a senha');
  const ip = clientIp(req);
  const limits = [{ key: `mlogin:${area.accountId}:${p.data.login.toLowerCase()}`, max: 8, windowSec: 900 }, { key: `mlogin-ip:${ip}`, max: 40, windowSec: 900 }];
  await assertUnderLimits(limits, 'login');
  const m = await findByLogin(area.accountId, p.data.login);
  const ok = await bcrypt.compare(p.data.password, m?.passwordHash ?? DUMMY);
  if (!m || !m.passwordHash || !ok) {
    await countAttempt(limits);
    throw new AppError(401, m && !m.passwordHash ? 'Você ainda não criou sua senha. Use o link de acesso que recebeu ou “Esqueci minha senha”.' : 'E-mail/WhatsApp ou senha incorretos');
  }
  await clearAttempts([limits[0].key]);
  await db.update(schema.memberUsers).set({ lastLoginAt: new Date() }).where(eq(schema.memberUsers.id, m.id));
  res.json({ token: sign(m), member: memberView(m) });
}));

/** Link de primeiro acesso / nova senha: entra e pede para criar a senha. */
membersAreaRouter.post('/:slug/magic', asyncHandler(async (req, res) => {
  const area = await areaOf(req.params.slug);
  const t = String(req.body?.token ?? '');
  if (t.length < 20) throw new AppError(422, 'Link inválido');
  const hash = createHash('sha256').update(t).digest('hex');
  const [row] = await db.update(schema.memberTokens).set({ usedAt: new Date() })
    .where(and(eq(schema.memberTokens.tokenHash, hash), isNull(schema.memberTokens.usedAt), gt(schema.memberTokens.expiresAt, new Date())))
    .returning({ memberId: schema.memberTokens.memberId });
  if (!row) throw new AppError(410, 'Este link já foi usado ou expirou. Peça um novo em “Esqueci minha senha”.');
  const [m] = await db.select().from(schema.memberUsers).where(and(eq(schema.memberUsers.id, row.memberId), eq(schema.memberUsers.accountId, area.accountId))).limit(1);
  if (!m) throw new AppError(410, 'Este link não é desta área de membros.');
  await db.update(schema.memberUsers).set({ lastLoginAt: new Date() }).where(eq(schema.memberUsers.id, m.id));
  res.json({ token: sign(m), member: memberView(m), needsPassword: true });
}));

membersAreaRouter.post('/:slug/forgot', asyncHandler(async (req, res) => {
  const area = await areaOf(req.params.slug);
  const login = String(req.body?.login ?? '').trim().slice(0, 120);
  const limits = [{ key: `mforgot:${area.accountId}:${login.toLowerCase()}`, max: 3, windowSec: 3600 }, { key: `mforgot-ip:${clientIp(req)}`, max: 10, windowSec: 3600 }];
  await assertUnderLimits(limits, 'recuperação de senha');
  await countAttempt(limits);
  const m = await findByLogin(area.accountId, login);
  // resposta igual exista ou não, para não revelar quem é membro
  if (m) await sendMemberAccess(area.accountId, m.id, { reason: 'forgot' }).catch(() => {});
  res.json({ ok: true });
}));

/* ============================================================ com login */

membersAreaRouter.get('/:slug/me', memberAuth, asyncHandler(async (req: MemberReq, res) => { res.json({ member: memberView(req.member!) }); }));

membersAreaRouter.post('/:slug/password', memberAuth, asyncHandler(async (req: MemberReq, res) => {
  const p = z.object({ password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres').max(200), name: z.string().trim().max(80).optional() }).safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Senha inválida');
  const now = new Date();
  const [m] = await db.update(schema.memberUsers).set({ passwordHash: await bcrypt.hash(p.data.password, 10), passwordChangedAt: now, ...(p.data.name ? { name: p.data.name } : {}) })
    .where(eq(schema.memberUsers.id, req.member!.id)).returning();
  res.json({ token: sign(m), member: memberView(m) });
}));

/** Cursos liberados para o membro, com módulos, aulas, progresso e a última aula aberta. */
membersAreaRouter.get('/:slug/catalog', memberAuth, asyncHandler(async (req: MemberReq, res) => {
  const { accountId } = req.area!;
  const mid = req.member!.id;
  const courses = (await db.execute(sql`
    select c.id, c.title, c.description, c.cover_key as "coverKey", a.created_at as since from member_courses c
    join member_access a on a.course_id = c.id and a.member_id = ${mid} and a.revoked_at is null
    where c.account_id = ${accountId} and c.published order by c.sort, c.created_at`)).rows as { id: string; title: string; description: string | null; coverKey: string | null; since: string }[];
  const ids = courses.map((c) => c.id);
  const modules = ids.length ? await db.select().from(schema.memberModules).where(sql`${schema.memberModules.courseId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).orderBy(asc(schema.memberModules.sort), asc(schema.memberModules.createdAt)) : [];
  const lessons = ids.length ? await db.select({ id: schema.memberLessons.id, moduleId: schema.memberLessons.moduleId, title: schema.memberLessons.title, hasFile: sql<boolean>`${schema.memberLessons.fileKey} is not null` })
    .from(schema.memberLessons).where(sql`${schema.memberLessons.courseId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`).orderBy(asc(schema.memberLessons.sort), asc(schema.memberLessons.createdAt)) : [];
  const prog = await db.select().from(schema.memberProgress).where(eq(schema.memberProgress.memberId, mid));
  const done = new Set(prog.filter((p) => p.completedAt).map((p) => p.lessonId));
  const sinceOf = new Map(courses.map((c) => [c.id, c.since]));
  const lockOf = new Map(modules.map((m) => [m.id, moduleLock(m, sinceOf.get(m.courseId) ?? new Date())]));
  const last = prog.sort((a, b) => +new Date(b.openedAt) - +new Date(a.openedAt))
    .find((p) => lessons.some((l) => l.id === p.lessonId && !lockOf.get(l.moduleId)?.locked));
  const out = await Promise.all(courses.map(async (c) => {
    const mods = await Promise.all(modules.filter((m) => m.courseId === c.id).map(async (m) => {
      const ls = lessons.filter((l) => l.moduleId === m.id).map((l) => ({ id: l.id, title: l.title, hasFile: l.hasFile, done: done.has(l.id) }));
      const lk = lockOf.get(m.id)!;
      return { id: m.id, title: m.title, coverUrl: await coverUrl(m.coverKey, req), locked: lk.locked, unlockAt: lk.unlockAt, lessons: ls, done: ls.filter((l) => l.done).length, total: ls.length };
    }));
    const total = mods.reduce((s, m) => s + m.total, 0);
    const dn = mods.reduce((s, m) => s + m.done, 0);
    return { id: c.id, title: c.title, description: c.description, coverUrl: await coverUrl(c.coverKey, req), modules: mods, done: dn, total };
  }));
  const lastLesson = last ? lessons.find((l) => l.id === last.lessonId) : null;
  const lastMod = lastLesson ? modules.find((m) => m.id === lastLesson.moduleId) : null;
  res.json({
    member: memberView(req.member!),
    courses: out,
    continue: lastLesson && lastMod ? { lessonId: lastLesson.id, title: lastLesson.title, moduleTitle: lastMod.title, courseId: lastMod.courseId } : null,
  });
}));

async function lessonFor(req: MemberReq, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Aula não encontrada');
  const rows = (await db.execute(sql`
    select l.*, m.title as module_title, m.locked as module_locked, m.unlock_after_days as module_days, a.created_at as since, c.title as course_title from member_lessons l
    join member_modules m on m.id = l.module_id
    join member_courses c on c.id = l.course_id and c.published
    join member_access a on a.course_id = c.id and a.member_id = ${req.member!.id} and a.revoked_at is null
    where l.id = ${id} and l.account_id = ${req.area!.accountId} limit 1`)).rows as any[];
  if (!rows[0]) throw new AppError(404, 'Aula não encontrada ou sem acesso');
  const lk = moduleLock({ locked: rows[0].module_locked, unlockAfterDays: rows[0].module_days }, rows[0].since);
  if (lk.locked) {
    const when = lk.unlockAt ? ` Ele libera em ${new Date(lk.unlockAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.` : '';
    throw new AppError(403, `O módulo “${rows[0].module_title}” está bloqueado.${when}`, { code: 'module_locked', unlockAt: lk.unlockAt });
  }
  return rows[0];
}

membersAreaRouter.get('/:slug/lessons/:id', memberAuth, asyncHandler(async (req: MemberReq, res) => {
  const l = await lessonFor(req, req.params.id);
  // ordem do curso inteiro (módulo, depois aula) para "anterior" e "próxima"
  // módulos bloqueados para este aluno ficam de fora da sequência
  const seq = ((await db.execute(sql`
    select l.id, m.locked, m.unlock_after_days as days from member_lessons l join member_modules m on m.id = l.module_id
    where l.course_id = ${l.course_id} order by m.sort, m.created_at, l.sort, l.created_at`)).rows as { id: string; locked: boolean; days: number | null }[])
    .filter((x) => !moduleLock({ locked: x.locked, unlockAfterDays: x.days }, l.since).locked);
  const i = seq.findIndex((s) => s.id === l.id);
  await db.insert(schema.memberProgress).values({ memberId: req.member!.id, lessonId: l.id })
    .onConflictDoUpdate({ target: [schema.memberProgress.memberId, schema.memberProgress.lessonId], set: { openedAt: new Date() } });
  const [p] = await db.select().from(schema.memberProgress).where(and(eq(schema.memberProgress.memberId, req.member!.id), eq(schema.memberProgress.lessonId, l.id))).limit(1);
  res.json({
    lesson: { id: l.id, title: l.title, description: l.description, fileName: l.file_name, fileSize: l.file_size, moduleTitle: l.module_title, courseTitle: l.course_title, courseId: l.course_id, done: !!p?.completedAt },
    pdfUrl: l.file_key ? await signedUrl(l.file_key, { seconds: 1800, fileName: l.file_name, apiBase: apiBase(req) }) : null,
    downloadUrl: l.file_key ? await signedUrl(l.file_key, { seconds: 1800, fileName: l.file_name, inline: false, apiBase: apiBase(req) }) : null,
    prevId: i > 0 ? seq[i - 1].id : null,
    nextId: i >= 0 && i < seq.length - 1 ? seq[i + 1].id : null,
  });
}));

membersAreaRouter.post('/:slug/lessons/:id/complete', memberAuth, asyncHandler(async (req: MemberReq, res) => {
  const l = await lessonFor(req, req.params.id);
  const done = req.body?.done !== false;
  await db.insert(schema.memberProgress).values({ memberId: req.member!.id, lessonId: l.id, completedAt: done ? new Date() : null })
    .onConflictDoUpdate({ target: [schema.memberProgress.memberId, schema.memberProgress.lessonId], set: { completedAt: done ? new Date() : null } });
  res.json({ done });
}));
