/**
 * Prévia do link da área de membros no WhatsApp (e em qualquer app que lê Open Graph).
 *
 * O app (converza.pro) é um site estático e não tem as tags por curso. Por isso o link de acesso enviado
 * aponta para a API: robôs de prévia (WhatsApp, Facebook, Telegram…) recebem uma página com título, descrição
 * e a capa do curso; pessoas são mandadas na hora para a área de membros no app (o token não é usado aqui).
 */
import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db, schema } from '../db';
import { readObjectBuffer } from '../storage/objects';
import { appBase, apiBase, membersLook } from './members';
import { isUuid } from '../utils/http';
import { config } from '../config';

export const membersPreviewRouter = Router();

const BOT = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|linkedinbot|discordbot|skypeuripreview|pinterest|embedly|redditbot|applebot|googlebot|bingbot|vkshare|preview/i;
const SLUG = /^[a-z0-9-]{1,60}$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface PreviewInfo { accountId: string; title: string; description: string; coverKey: string | null; courseId: string | null }

/** Curso do link: o do parâmetro c; sem ele, o mais recente liberado para o dono do token; sem isso, a área. */
export async function previewInfo(slug: string, courseId?: string | null, token?: string | null): Promise<PreviewInfo | null> {
  if (!SLUG.test(slug)) return null;
  const [acc] = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.membersSlug, slug)).limit(1);
  if (!acc) return null;
  let course: { id: string; title: string; description: string | null; coverKey: string | null; previewKey: string | null } | undefined;
  const pick = { id: schema.memberCourses.id, title: schema.memberCourses.title, description: schema.memberCourses.description, coverKey: schema.memberCourses.coverKey, previewKey: schema.memberCourses.previewKey };
  if (courseId && isUuid(courseId)) {
    [course] = await db.select(pick).from(schema.memberCourses)
      .where(and(eq(schema.memberCourses.id, courseId), eq(schema.memberCourses.accountId, acc.id), eq(schema.memberCourses.published, true))).limit(1);
  }
  if (!course && token && /^[A-Za-z0-9_-]{10,80}$/.test(token)) {
    // só lê: o token continua valendo para a pessoa entrar
    const [t] = await db.select({ memberId: schema.memberTokens.memberId, courseId: schema.memberTokens.courseId }).from(schema.memberTokens)
      .where(and(eq(schema.memberTokens.tokenHash, createHash('sha256').update(token).digest('hex')), gt(schema.memberTokens.expiresAt, new Date()))).limit(1);
    if (t?.courseId) {
      [course] = await db.select(pick).from(schema.memberCourses)
        .where(and(eq(schema.memberCourses.id, t.courseId), eq(schema.memberCourses.accountId, acc.id), eq(schema.memberCourses.published, true))).limit(1);
    }
    if (t && !course) {
      [course] = await db.select(pick).from(schema.memberAccess)
        .innerJoin(schema.memberCourses, eq(schema.memberCourses.id, schema.memberAccess.courseId))
        .where(and(eq(schema.memberAccess.memberId, t.memberId), eq(schema.memberAccess.accountId, acc.id), isNull(schema.memberAccess.revokedAt), eq(schema.memberCourses.published, true)))
        .orderBy(desc(schema.memberAccess.createdAt)).limit(1);
    }
  }
  const look = await membersLook(acc.id);
  if (course) {
    return {
      accountId: acc.id, courseId: course.id, title: course.title,
      description: (course.description ?? '').trim().slice(0, 200) || `Seu acesso está liberado. ${look.title}`,
      // a imagem da prévia (já em 1200×628) vem antes; sem ela, recorte da capa
      coverKey: course.previewKey ?? course.coverKey ?? look.bannerKey,
    };
  }
  return { accountId: acc.id, courseId: null, title: look.title, description: look.subtitle, coverKey: look.bannerKey };
}

/** Capa em JPEG (1200×630 para a prévia grande; menor para a miniatura do WhatsApp Web). */
const coverCache = new Map<string, { at: number; buf: Buffer }>();
export async function coverJpeg(key: string, width = 1200): Promise<Buffer | null> {
  const ck = `${key}|${width}`;
  const hit = coverCache.get(ck);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.buf;
  try {
    const raw = await readObjectBuffer(key);
    const buf = await sharp(raw).rotate().resize(width, Math.round((width * 628) / 1200), { fit: 'cover' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    if (coverCache.size > 200) coverCache.clear();
    coverCache.set(ck, { at: Date.now(), buf });
    return buf;
  } catch (err) {
    console.error('[membros] capa da prévia:', (err as Error).message);
    return null;
  }
}

const q1 = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '');

function page(req: Request, info: PreviewInfo | null, appUrl: string, slug?: string) {
  const self = `${apiBase(req)}${req.originalUrl.split('?')[0]}`;
  const img = info?.coverKey ? `${apiBase(req)}/m/${esc(slug ?? String(req.params.slug ?? ''))}/capa${info.courseId ? `?c=${info.courseId}` : ''}` : null;
  const title = esc(info?.title ?? 'Área de membros');
  const desc = esc(info?.description ?? 'Seus cursos e materiais em um só lugar.');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Converza Members">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${esc(self)}">
${img ? `<meta property="og:image" content="${img}">
<meta property="og:image:secure_url" content="${img}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="628">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${img}">` : '<meta name="twitter:card" content="summary">'}
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${esc(appUrl)}">
</head><body><a href="${esc(appUrl)}">Entrar na área de membros</a><script>location.replace(${JSON.stringify(appUrl)})</script></body></html>`;
}

async function serve(req: Request, res: import('express').Response, entrar: boolean) {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const token = q1(req.query.t);
  const appUrl = `${appBase()}/m/${encodeURIComponent(slug)}${entrar ? `/entrar${token ? `?t=${encodeURIComponent(token)}` : ''}` : ''}`;
  // pessoas: direto para a área de membros
  if (!BOT.test(String(req.get('user-agent') ?? ''))) return res.redirect(302, appUrl);
  const info = await previewInfo(slug, q1(req.query.c) || null, token || null).catch(() => null);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(page(req, info, appUrl));
}

membersPreviewRouter.get('/:slug/entrar', (req, res, next) => { serve(req, res, true).catch(next); });

/**
 * Link de acesso no endereço do app (converza.pro/entrar/<área>?t=…). O site encaminha /entrar/* para cá
 * (regra de reescrita) para o WhatsApp ler a prévia; sem a regra, o próprio app leva para a área de membros.
 */
export const membersEnterRouter = Router();
membersEnterRouter.get('/:slug', (req, res, next) => { serve(req, res, true).catch(next); });
membersPreviewRouter.get('/:slug', (req, res, next) => { serve(req, res, false).catch(next); });

/** Área de membros do link curto (o código é o próprio token). */
export async function shortLinkSlug(code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9]{10,20}$/.test(code)) return null;
  const r = await db.execute(sql`select a.members_slug as slug from member_tokens t join member_users u on u.id = t.member_id
    join accounts a on a.id = u.account_id where t.token_hash = ${createHash('sha256').update(code).digest('hex')} and t.expires_at > now() limit 1`);
  return ((r.rows[0] as { slug?: string } | undefined)?.slug) ?? null;
}

/** converza.pro/e/<código>: o robô do WhatsApp lê a prévia com a capa; a pessoa vai para a área de membros. */
export const membersShortRouter = Router();
membersShortRouter.get('/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code ?? '');
    const slug = await shortLinkSlug(code);
    if (!slug) return res.redirect(302, appBase());
    const appUrl = `${appBase()}/m/${encodeURIComponent(slug)}/entrar?t=${encodeURIComponent(code)}`;
    if (!BOT.test(String(req.get('user-agent') ?? ''))) return res.redirect(302, appUrl);
    const info = await previewInfo(slug, null, code).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(page(req, info, appUrl, slug));
  } catch (err) { next(err); }
});

/** Capa pública (é a vitrine do curso, a mesma que aparece na prévia). */
membersPreviewRouter.get('/:slug/capa', async (req, res, next) => {
  try {
    const info = await previewInfo(String(req.params.slug ?? '').toLowerCase(), q1(req.query.c) || null, null);
    const buf = info?.coverKey ? await coverJpeg(info.coverKey) : null;
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (err) { next(err); }
});

/** Link de acesso que gera prévia: na API quando ela tem endereço público próprio; senão, o do app. */
export function previewBase(): string {
  return config.publicApiUrl || appBase();
}

/** Link de acesso que vai para o cliente: sempre no endereço do app. */
export function memberEnterUrl(slug: string, token: string, courseId?: string | null): string {
  return `${appBase()}/entrar/${slug}?t=${token}${courseId ? `&c=${courseId}` : ''}`;
}

const esc2 = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * WhatsApp por QR Code: o próprio Converza monta a prévia do link da área de membros (título, descrição e capa),
 * sem buscar páginas de fora. Devolve null quando o texto não tem um link de área de membros.
 */
export async function memberLinkPreview(text: string, thumb: (img: Buffer) => Promise<{ jpegThumbnail?: Buffer; highQualityThumbnail?: any }>): Promise<Record<string, any> | null> {
  const hosts = [...new Set([previewBase(), appBase()])].map(esc2).join('|');
  const m = new RegExp(`(?:${hosts})/(?:m/([a-z0-9-]{1,60})(?:/entrar)?|entrar/([a-z0-9-]{1,60})|e/([A-Za-z0-9]{10,20}))(?:\\?[^\\s]*)?`, 'i').exec(text);
  if (!m) return null;
  const url = m[0];
  let params: URLSearchParams;
  try { params = new URL(url).searchParams; } catch { return null; }
  const shortSlug = m[3] ? await shortLinkSlug(m[3]) : null;
  if (m[3] && !shortSlug) return null;
  const info = m[3] ? await previewInfo(shortSlug!, null, m[3]) : await previewInfo((m[1] ?? m[2]).toLowerCase(), params.get('c'), params.get('t'));
  if (!info) return null;
  const out: Record<string, any> = { 'canonical-url': url, 'matched-text': url, title: info.title, description: info.description };
  if (info.coverKey) {
    const img = await coverJpeg(info.coverKey, 1200);
    if (img) {
      try { Object.assign(out, await thumb(img)); }
      catch (err) {
        console.error('[membros] prévia (upload):', (err as Error).message);
        const small = await coverJpeg(info.coverKey, 320);
        if (small) out.jpegThumbnail = small;
      }
    }
  }
  return out;
}
