/**
 * Respostas rápidas: atalho ("/preco") → uma ou mais ações enviadas em ordem (texto, imagem, vídeo, áudio,
 * documento, figurinha). No Chats ao vivo, só texto vira rascunho para editar; com anexos, envia tudo.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { FILE_RULES, saveFile, signedFilePath, type FileKind } from './storedFiles';

export const quickRepliesRouter = Router();

export const ACTION_TYPES = ['text', 'image', 'video', 'audio', 'document', 'sticker'] as const;
export type QuickAction = { type: (typeof ACTION_TYPES)[number]; text?: string; fileId?: string; caption?: string };

const shortcut = z.string().trim().transform((v) => v.replace(/^[/#]+/, '').toLowerCase().replace(/\s+/g, '-'))
  .pipe(z.string().regex(/^[a-z0-9à-ú_-]{1,30}$/i, 'Atalho: até 30 letras, números, hífens e underscores'));

const action = z.object({
  type: z.enum(ACTION_TYPES),
  text: z.string().max(4096, 'Texto muito longo (até 4.096 letras)').optional(),
  fileId: z.string().uuid().optional(),
  caption: z.string().max(1024, 'Legenda muito longa (até 1.024 letras)').optional(),
});
const body = z.object({
  shortcut,
  actions: z.array(action).min(1, 'Adicione pelo menos uma ação').max(10, 'No máximo 10 ações por resposta'),
});

/** Confere as ações (texto não vazio, anexo da empresa) e devolve o texto para a busca. */
async function checkActions(accountId: string, actions: QuickAction[]) {
  const fileIds = actions.filter((a) => a.type !== 'text').map((a) => a.fileId).filter((x): x is string => !!x);
  for (const [i, a] of actions.entries()) {
    if (a.type === 'text' && !a.text?.trim()) throw new AppError(422, `A ação ${i + 1} (texto) está vazia.`);
    if (a.type !== 'text' && !a.fileId) throw new AppError(422, `Escolha o arquivo da ação ${i + 1}.`);
  }
  if (fileIds.length) {
    const found = await db.select({ id: schema.storedFiles.id }).from(schema.storedFiles)
      .where(and(eq(schema.storedFiles.accountId, accountId), inArray(schema.storedFiles.id, fileIds)));
    if (found.length !== new Set(fileIds).size) throw new AppError(422, 'Um dos arquivos não foi encontrado. Envie de novo.');
  }
  const clean = actions.map((a) => (a.type === 'text'
    ? { type: 'text' as const, text: a.text!.trim() }
    : { type: a.type, fileId: a.fileId!, ...(a.caption?.trim() && a.type !== 'audio' && a.type !== 'sticker' ? { caption: a.caption.trim() } : {}) }));
  const text = clean.map((a) => ('text' in a ? a.text : a.caption ?? '')).filter(Boolean).join('\n').slice(0, 4096);
  return { actions: clean, text };
}

/** Ações com os dados do arquivo (nome, tipo, tamanho e link de prévia). */
async function withFiles(req: express.Request, rows: (typeof schema.quickReplies.$inferSelect)[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.actions as QuickAction[]).map((a) => a.fileId).filter((x): x is string => !!x)))];
  const files = ids.length
    ? await db.select({ id: schema.storedFiles.id, mime: schema.storedFiles.mime, fileName: schema.storedFiles.fileName, size: schema.storedFiles.size })
      .from(schema.storedFiles).where(inArray(schema.storedFiles.id, ids))
    : [];
  const base = publicBase(req, config.publicApiUrl);
  return rows.map((r) => ({
    id: r.id, shortcut: r.shortcut, text: r.text, createdAt: r.createdAt,
    actions: (r.actions as QuickAction[]).map((a) => {
      if (a.type === 'text') return a;
      const f = files.find((x) => x.id === a.fileId);
      return { ...a, file: f ? { ...f, url: `${base}${signedFilePath(f.id)}` } : null };
    }),
    types: [...new Set((r.actions as QuickAction[]).map((a) => a.type))],
  }));
}

quickRepliesRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const type = String(req.query.type ?? '');
  const like = q ? `%${q.replace(/^[/#]/, '')}%` : null;
  const rows = await db.select().from(schema.quickReplies).where(and(
    eq(schema.quickReplies.accountId, req.accountId!),
    ...(like ? [or(ilike(schema.quickReplies.shortcut, like), ilike(schema.quickReplies.text, like))!] : []),
    ...((ACTION_TYPES as readonly string[]).includes(type) ? [sql`exists (select 1 from jsonb_array_elements(${schema.quickReplies.actions}) a where a->>'type' = ${type})`] : []),
  )).orderBy(asc(schema.quickReplies.shortcut));
  res.json({ quickReplies: await withFiles(req, rows) });
}));

/** Envia um anexo (o corpo é o próprio arquivo; tipo em x-file-type, nome em ?filename=, uso em ?kind=). */
quickRepliesRouter.post('/files', express.raw({ type: () => true, limit: '17mb' }), asyncHandler(async (req, res) => {
  const kind = String(req.query.kind ?? '') as FileKind;
  if (!FILE_RULES[kind]) throw new AppError(422, 'Tipo de anexo inválido');
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'Arquivo vazio');
  const mime = String(req.headers['x-file-type'] ?? req.headers['content-type'] ?? '');
  const name = String(req.query.filename ?? 'arquivo').replace(/[\r\n"/\\]/g, '').slice(0, 140) || 'arquivo';
  const f = await saveFile(req.accountId!, kind, data, mime, name);
  res.status(201).json({ file: { ...f, url: `${publicBase(req, config.publicApiUrl)}${signedFilePath(f.id)}` } });
}));

quickRepliesRouter.post('/', asyncHandler(async (req, res) => {
  const p = body.safeParse({ ...req.body, actions: req.body?.actions ?? (req.body?.text ? [{ type: 'text', text: req.body.text }] : []) });
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const c = await checkActions(req.accountId!, p.data.actions);
  try {
    const [row] = await db.insert(schema.quickReplies).values({ accountId: req.accountId!, shortcut: p.data.shortcut, ...c }).returning();
    res.status(201).json({ quickReply: (await withFiles(req, [row]))[0] });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, `Já existe o atalho #${p.data.shortcut}`);
    throw err;
  }
}));

quickRepliesRouter.patch('/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Resposta não encontrada');
  const raw = { ...req.body, ...(req.body?.text && !req.body?.actions ? { actions: [{ type: 'text', text: req.body.text }] } : {}) };
  const p = body.partial().safeParse(raw);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const patch: Partial<typeof schema.quickReplies.$inferInsert> = {};
  if (p.data.shortcut) patch.shortcut = p.data.shortcut;
  if (p.data.actions) Object.assign(patch, await checkActions(req.accountId!, p.data.actions));
  try {
    const [row] = await db.update(schema.quickReplies).set(patch)
      .where(and(eq(schema.quickReplies.id, req.params.id), eq(schema.quickReplies.accountId, req.accountId!))).returning();
    if (!row) throw new AppError(404, 'Resposta não encontrada');
    await dropUnusedFiles(req.accountId!);
    res.json({ quickReply: (await withFiles(req, [row]))[0] });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'Já existe esse atalho');
    throw err;
  }
}));

quickRepliesRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Resposta não encontrada');
  await db.delete(schema.quickReplies)
    .where(and(eq(schema.quickReplies.id, req.params.id), eq(schema.quickReplies.accountId, req.accountId!)));
  await dropUnusedFiles(req.accountId!);
  res.status(204).end();
}));

/** Anexos que nenhuma resposta usa mais (e enviados há mais de 1 hora, para não pegar um que está sendo montado). */
async function dropUnusedFiles(accountId: string) {
  await db.execute(sql`delete from stored_files f where f.account_id = ${accountId} and f.purpose = 'quick_reply'
    and f.created_at < now() - interval '1 hour'
    and not exists (select 1 from quick_replies q, jsonb_array_elements(q.actions) a
      where q.account_id = ${accountId} and a->>'fileId' = f.id::text)`);
}

export async function quickReplyFor(accountId: string, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(schema.quickReplies)
    .where(and(eq(schema.quickReplies.id, id), eq(schema.quickReplies.accountId, accountId))).limit(1);
  return row ?? null;
}
