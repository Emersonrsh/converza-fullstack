import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { aiEnabled } from '../ai/provider';
import { aiCallWithUsage } from '../ai/usage';
import { extractJson } from '../flows/aiTools';
import { htmlToText } from '../ai/agentBrain';
import { safeFetchPage } from '../flows/http';

/**
 * Bases de conhecimento: sites, documentos e perguntas e respostas que um ou mais agentes consultam.
 * O texto fica guardado já extraído; o agente lê as bases ligadas a ele a cada resposta.
 */
export const knowledgeRouter = Router();

type Base = typeof schema.knowledgeBases.$inferSelect;

const MAX_BASES = 50;
const MAX_SITES = 20;
const MAX_DOCS = 20;
const MAX_FAQ = 200;
const MAX_ITEM_CHARS = 40_000;
/** quanto das bases entra em cada resposta do agente */
export const MAX_PROMPT_BASES_CHARS = 40_000;

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só administradores e gestores mexem nas bases de conhecimento');
}

function parse<T extends z.ZodTypeAny>(def: T, body: unknown): z.infer<T> {
  const r = def.safeParse(body);
  if (!r.success) throw new AppError(422, r.error.issues[0]?.message ?? 'Dados inválidos');
  return r.data;
}

const summary = (b: Base) => ({
  id: b.id, name: b.name, sites: b.sites.length, documents: b.documents.length, faq: b.faq.length,
  chars: b.sites.reduce((n, s) => n + s.text.length, 0) + b.documents.reduce((n, d) => n + d.text.length, 0) + b.faq.reduce((n, f) => n + f.q.length + f.a.length, 0),
  updatedAt: b.updatedAt,
});
/** Na edição o texto completo não vai para a tela: só um trecho para conferir. */
const full = (b: Base) => ({
  ...summary(b),
  siteList: b.sites.map((s) => ({ url: s.url, title: s.title, chars: s.text.length, preview: s.text.slice(0, 280) })),
  documentList: b.documents.map((d) => ({ name: d.name, chars: d.text.length, preview: d.text.slice(0, 280) })),
  faqList: b.faq,
});

async function ownBase(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Base não encontrada');
  const [b] = await db.select().from(schema.knowledgeBases).where(and(eq(schema.knowledgeBases.id, id), eq(schema.knowledgeBases.accountId, accountId))).limit(1);
  if (!b) throw new AppError(404, 'Base não encontrada');
  return b;
}

/** Texto das bases para as instruções do agente (na ordem em que foram ligadas). */
export async function basesText(accountId: string, ids: string[] | null | undefined): Promise<string> {
  const list = (ids ?? []).filter(isUuid);
  if (!list.length) return '';
  const rows = await db.select().from(schema.knowledgeBases).where(and(eq(schema.knowledgeBases.accountId, accountId), inArray(schema.knowledgeBases.id, list)));
  const ordered = list.map((id) => rows.find((r) => r.id === id)).filter((x): x is Base => !!x);
  const parts: string[] = [];
  for (const b of ordered) {
    const faq = b.faq.length ? `Perguntas e respostas:\n${b.faq.map((f) => `- P: ${f.q}\n  R: ${f.a}`).join('\n')}` : '';
    const docs = b.documents.map((d) => `Documento “${d.name}”:\n${d.text}`);
    const sites = b.sites.map((s) => `Site ${s.url}${s.title ? ` (${s.title})` : ''}:\n${s.text}`);
    // perguntas primeiro: são as respostas mais diretas
    parts.push([`### Base “${b.name}”`, faq, ...docs, ...sites].filter(Boolean).join('\n\n'));
  }
  const text = parts.join('\n\n');
  return text.length > MAX_PROMPT_BASES_CHARS ? `${text.slice(0, MAX_PROMPT_BASES_CHARS)}\n(…o restante das bases foi cortado por tamanho)` : text;
}

/** Confere que as bases são da conta (sem repetir). */
export async function checkBaseIds(accountId: string, ids: string[]): Promise<string[]> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return [];
  const ok = await db.select({ id: schema.knowledgeBases.id }).from(schema.knowledgeBases)
    .where(and(eq(schema.knowledgeBases.accountId, accountId), inArray(schema.knowledgeBases.id, uniq)));
  if (ok.length !== uniq.length) throw new AppError(422, 'Base de conhecimento não encontrada');
  return uniq;
}

/* ------------------------------------------------------- extrair texto */

const tidy = (s: string) => s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

export async function documentText(data: Buffer, filename: string, mime: string): Promise<string> {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return tidy(String(text));
  }
  if (ext === 'docx' || mime.includes('wordprocessingml')) {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: data });
    return tidy(r.value);
  }
  if (['txt', 'md', 'csv', 'tsv', 'json'].includes(ext) || mime.startsWith('text/')) return tidy(data.toString('utf8'));
  if (['html', 'htm'].includes(ext)) return tidy(htmlToText(data.toString('utf8'), MAX_ITEM_CHARS));
  throw new AppError(415, 'Formato não suportado. Envie PDF, Word (.docx), TXT, CSV ou Markdown.');
}

/** Perguntas e respostas de uma planilha CSV/TXT: "pergunta;resposta" (ou vírgula / tab) por linha. */
export function parseFaqCsv(text: string): { q: string; a: string }[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = [';', '\t', ','].sort((x, y) => lines[0].split(y).length - lines[0].split(x).length)[0];
  const cell = (s: string) => s.trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim();
  const out: { q: string; a: string }[] = [];
  for (const [i, l] of lines.entries()) {
    const at = l.indexOf(sep);
    if (at < 0) continue;
    const q = cell(l.slice(0, at)); const a = cell(l.slice(at + 1));
    if (i === 0 && /^pergunta|^question/i.test(q)) continue; // cabeçalho
    if (q && a) out.push({ q: q.slice(0, 300), a: a.slice(0, 1000) });
  }
  return out.slice(0, MAX_FAQ);
}

/* ================================================================ rotas */

knowledgeRouter.get('/', asyncHandler(async (req, res) => {
  const list = await db.select().from(schema.knowledgeBases).where(eq(schema.knowledgeBases.accountId, req.accountId!)).orderBy(asc(schema.knowledgeBases.createdAt));
  const usage = await db.execute(sql`select unnest(knowledge_base_ids) as id, count(*)::int as n from agents where account_id = ${req.accountId!} group by 1`);
  const used = new Map((usage.rows as { id: string; n: number }[]).map((r) => [r.id, r.n]));
  res.json({ bases: list.map((b) => ({ ...summary(b), agents: used.get(b.id) ?? 0 })) });
}));

knowledgeRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json({ base: full(await ownBase(req.accountId!, req.params.id)) });
}));

const FAQ = z.array(z.object({ q: z.string().trim().min(1).max(300, 'Pergunta muito longa (até 300 letras)'), a: z.string().trim().min(1).max(1000, 'Resposta muito longa (até 1.000 letras)') }))
  .max(MAX_FAQ, `No máximo ${MAX_FAQ} perguntas por base`);
const baseSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a base').max(60, 'Nome muito longo (até 60 letras)'),
  faq: FAQ.optional(),
  /** sites e documentos mantidos (os que saíram da lista são apagados) */
  keepSites: z.array(z.string()).optional(),
  keepDocuments: z.array(z.string()).optional(),
});

knowledgeRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const d = parse(baseSchema, req.body);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.knowledgeBases).where(eq(schema.knowledgeBases.accountId, accountId));
  if (Number(n) >= MAX_BASES) throw new AppError(422, `No máximo ${MAX_BASES} bases por empresa`);
  const [row] = await db.insert(schema.knowledgeBases).values({ accountId, name: d.name, faq: d.faq ?? [] }).returning();
  res.status(201).json({ base: full(row) });
}));

knowledgeRouter.put('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const b = await ownBase(req.accountId!, req.params.id);
  const d = parse(baseSchema, req.body);
  const [row] = await db.update(schema.knowledgeBases).set({
    name: d.name,
    ...(d.faq ? { faq: d.faq } : {}),
    ...(d.keepSites ? { sites: b.sites.filter((s) => d.keepSites!.includes(s.url)) } : {}),
    ...(d.keepDocuments ? { documents: b.documents.filter((x) => d.keepDocuments!.includes(x.name)) } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.knowledgeBases.id, b.id)).returning();
  res.json({ base: full(row) });
}));

knowledgeRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const b = await ownBase(req.accountId!, req.params.id);
  await db.execute(sql`update agents set knowledge_base_ids = array_remove(knowledge_base_ids, ${b.id}::uuid) where account_id = ${req.accountId!}`);
  await db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, b.id));
  res.status(204).end();
}));

/** Lê um site e guarda o texto na base. */
knowledgeRouter.post('/:id/sites', asyncHandler(async (req, res) => {
  managerOnly(req);
  const b = await ownBase(req.accountId!, req.params.id);
  const { url } = parse(z.object({ url: z.string().trim().min(4, 'Cole o link do site').max(500) }), req.body);
  if (b.sites.length >= MAX_SITES) throw new AppError(422, `No máximo ${MAX_SITES} sites por base`);
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { throw new AppError(422, 'Link do site inválido'); }
  const page = await safeFetchPage(u.toString());
  if (page.error) throw new AppError(422, `Não consegui abrir o site: ${page.error}`);
  if (!page.ok) throw new AppError(422, `Não consegui abrir o site (HTTP ${page.status})`);
  const html = /html|xml/i.test(page.contentType) || /<html|<body/i.test(page.text.slice(0, 2000));
  const text = html ? htmlToText(page.text, MAX_ITEM_CHARS) : tidy(page.text).slice(0, MAX_ITEM_CHARS);
  if (text.replace(/\s/g, '').length < 80) throw new AppError(422, 'O site quase não tem texto para ler (pode ser montado só com JavaScript). Copie o texto para um documento ou para perguntas e respostas.');
  const title = /^Título: (.*)$/m.exec(text)?.[1]?.slice(0, 120) ?? '';
  const sites = [...b.sites.filter((s) => s.url !== page.url), { url: page.url, title, text, fetchedAt: new Date().toISOString() }];
  const [row] = await db.update(schema.knowledgeBases).set({ sites, updatedAt: new Date() }).where(eq(schema.knowledgeBases.id, b.id)).returning();
  res.json({ base: full(row) });
}));

/** Envia um documento (PDF, DOCX, TXT…) e guarda o texto. Corpo: o arquivo; nome em ?nome= */
knowledgeRouter.post('/:id/documents', express.raw({ type: () => true, limit: '15mb' }), asyncHandler(async (req, res) => {
  managerOnly(req);
  const b = await ownBase(req.accountId!, req.params.id);
  if (b.documents.length >= MAX_DOCS) throw new AppError(422, `No máximo ${MAX_DOCS} documentos por base`);
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) throw new AppError(422, 'Arquivo vazio');
  const name = String(req.query.nome ?? 'documento').replace(/[\\/]/g, '_').slice(0, 120) || 'documento';
  let text: string;
  try { text = await documentText(data, name, String(req.headers['content-type'] ?? '')); }
  catch (err) { if (err instanceof AppError) throw err; throw new AppError(422, 'Não consegui ler esse arquivo. Se for um PDF escaneado (imagem), copie o texto para perguntas e respostas.'); }
  if (text.replace(/\s/g, '').length < 20) throw new AppError(422, 'Não achei texto nesse arquivo. Se for um PDF escaneado (imagem), copie o texto para perguntas e respostas.');
  const cut = text.length > MAX_ITEM_CHARS;
  const documents = [...b.documents.filter((x) => x.name !== name), { name, text: text.slice(0, MAX_ITEM_CHARS), addedAt: new Date().toISOString() }];
  const [row] = await db.update(schema.knowledgeBases).set({ documents, updatedAt: new Date() }).where(eq(schema.knowledgeBases.id, b.id)).returning();
  res.json({ base: full(row), cut });
}));

/** Lê perguntas e respostas de um CSV/TXT (não salva: volta a lista para conferir). */
knowledgeRouter.post('/faq/import', express.raw({ type: () => true, limit: '5mb' }), asyncHandler(async (req, res) => {
  managerOnly(req);
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const faq = parseFaqCsv(data.toString('utf8'));
  if (!faq.length) throw new AppError(422, 'Não achei perguntas nesse arquivo. Use uma linha por pergunta: pergunta;resposta');
  res.json({ faq });
}));

/** A IA escreve perguntas e respostas a partir do que a base já tem (e de observações). Gasta tokens. */
knowledgeRouter.post('/:id/faq/generate', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const b = await ownBase(accountId, req.params.id);
  const { notes } = parse(z.object({ notes: z.string().max(4000, 'Texto muito longo (até 4.000 letras)').optional() }), req.body);
  if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor.');
  const material = [
    notes?.trim() && `OBSERVAÇÕES\n${notes.trim()}`,
    ...b.documents.map((d) => `DOCUMENTO ${d.name}\n${d.text.slice(0, 12000)}`),
    ...b.sites.map((s) => `SITE ${s.url}\n${s.text.slice(0, 12000)}`),
  ].filter(Boolean).join('\n\n').slice(0, 30000);
  if (material.replace(/\s/g, '').length < 40) throw new AppError(422, 'Adicione um site, um documento ou escreva sobre o negócio para a IA ter de onde tirar as perguntas.');
  const r = await aiCallWithUsage(accountId, [
    { role: 'system', content: 'Você escreve perguntas frequentes de clientes de WhatsApp para pequenas empresas brasileiras. Use só fatos do material, sem inventar preços, prazos ou links. Responda apenas com JSON: {"perguntas":[{"p":"...","r":"..."}]} com 8 a 20 itens, respostas curtas e completas.' },
    { role: 'user', content: material },
  ], { maxTokens: 2500, temperature: 0.3, usage: { kind: 'agent_create', label: `Gerar perguntas da base “${b.name}”` } });
  let faq: { q: string; a: string }[] = [];
  try {
    const j = extractJson(r.text);
    const list = Array.isArray(j?.perguntas) ? j.perguntas : Array.isArray(j) ? j : [];
    faq = list.map((x: any) => ({ q: String(x?.p ?? x?.q ?? '').trim().slice(0, 300), a: String(x?.r ?? x?.a ?? '').trim().slice(0, 1000) })).filter((x: { q: string; a: string }) => x.q && x.a);
  } catch { faq = []; }
  if (!faq.length) throw new AppError(502, 'A IA não devolveu perguntas válidas. Tente de novo.');
  res.json({ faq, tokens: r.tokens });
}));
