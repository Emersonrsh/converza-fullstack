/**
 * Templates WhatsApp: os modelos oficiais da Meta de cada WABA (conta do WhatsApp Business) — listar com o
 * status da análise, sincronizar, criar (vai para a Meta aprovar) e excluir.
 */
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import {
  WhatsAppError, appIdOf, createTemplate, deleteTemplate, listAllTemplates, templateVars, uploadTemplateSample, type ManagedTemplate,
} from '../whatsapp/cloud-api';

export const templatesRouter = Router();

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores criam e excluem modelos.');
}

const cache = new Map<string, { at: number; list: ManagedTemplate[] }>();

async function wabaConnection(accountId: string, connectionId: unknown) {
  const id = String(connectionId ?? '');
  if (!isUuid(id)) throw new AppError(422, 'Escolha a conta do WhatsApp (WABA).');
  const [c] = await db.select().from(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Conexão não encontrada');
  if (!c.wabaId || !c.accessToken) throw new AppError(422, 'Esta conexão não tem a conta do WhatsApp Business (WABA) configurada.');
  return c as typeof c & { wabaId: string; accessToken: string };
}

const meta = <T>(fn: () => Promise<T>) => fn().catch((err) => {
  if (err instanceof WhatsAppError) throw new AppError(502, err.message, { code: 'meta_error' });
  throw err;
});

/** Conexões com WABA (uma WABA pode ter vários números: aparece uma vez). */
templatesRouter.get('/wabas', asyncHandler(async (req, res) => {
  const conns = await db.select({ id: schema.connections.id, name: schema.connections.name, wabaId: schema.connections.wabaId, displayPhone: schema.connections.displayPhone })
    .from(schema.connections).where(and(eq(schema.connections.accountId, req.accountId!), isNotNull(schema.connections.wabaId)))
    .orderBy(asc(schema.connections.createdAt));
  const seen = new Set<string>();
  res.json({ wabas: conns.filter((c) => (seen.has(c.wabaId!) ? false : (seen.add(c.wabaId!), true))), canEdit: req.role !== 'agent' });
}));

templatesRouter.get('/', asyncHandler(async (req, res) => {
  const c = await wabaConnection(req.accountId!, req.query.connectionId);
  const key = `${c.wabaId}`;
  const hit = cache.get(key);
  let list: ManagedTemplate[];
  if (hit && req.query.fresh !== '1' && Date.now() - hit.at < 60_000) list = hit.list;
  else {
    list = await meta(() => listAllTemplates(c.accessToken, c.wabaId));
    cache.set(key, { at: Date.now(), list });
  }
  const status = String(req.query.status ?? 'all').toUpperCase();
  const counts: Record<string, number> = {};
  for (const t of list) counts[t.status] = (counts[t.status] ?? 0) + 1;
  res.json({ templates: status === 'ALL' ? list : list.filter((t) => t.status === status), counts, syncedAt: new Date(cache.get(key)!.at) });
}));

/** Amostra do cabeçalho de mídia (a Meta exige um exemplo para analisar o modelo). */
templatesRouter.post('/sample', express.raw({ type: () => true, limit: '17mb' }), asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await wabaConnection(req.accountId!, req.query.connectionId);
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'Arquivo vazio');
  const mime = String(req.headers['x-file-type'] ?? '').split(';')[0].trim().toLowerCase();
  const format = String(req.query.format ?? '').toUpperCase();
  const ok = format === 'IMAGE' ? /^image\/(jpeg|png)$/.test(mime) : format === 'VIDEO' ? /^video\/mp4$/.test(mime) : format === 'DOCUMENT' ? mime === 'application/pdf' : false;
  if (!ok) throw new AppError(422, format === 'IMAGE' ? 'Use uma imagem JPG ou PNG.' : format === 'VIDEO' ? 'Use um vídeo MP4.' : 'Use um PDF.');
  const appId = (await appIdOf(c.accessToken)) ?? config.whatsapp.appId;
  if (!appId) throw new AppError(422, 'Não deu para descobrir o app da Meta deste token (o upload da amostra é feito pelo app).');
  const name = String(req.query.filename ?? 'amostra').replace(/[\r\n"/\\]/g, '').slice(0, 100) || 'amostra';
  const handle = await meta(() => uploadTemplateSample(c.accessToken, appId, data, mime, name));
  res.status(201).json({ handle });
}));

const LANGS = ['pt_BR', 'pt_PT', 'en_US', 'en_GB', 'es', 'es_ES', 'es_MX', 'es_AR', 'fr', 'it', 'de'];
const button = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: z.string().trim().min(1).max(25, 'Botão de resposta: até 25 letras') }),
  z.object({
    type: z.literal('URL'), text: z.string().trim().min(1).max(25, 'Botão de link: até 25 letras'),
    url: z.string().trim().url('Link do botão inválido').max(2000), example: z.string().trim().max(2000).optional(),
  }),
  z.object({ type: z.literal('PHONE_NUMBER'), text: z.string().trim().min(1).max(25, 'Botão de ligar: até 25 letras'), phone: z.string().trim().regex(/^\+?\d{8,15}$/, 'Telefone do botão inválido (com DDI, só números)') }),
]);
const createSchema = z.object({
  connectionId: z.string().uuid(),
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,512}$/, 'Nome: só letras minúsculas, números e _ (ex.: pedido_enviado)'),
  // autenticação (código de verificação) tem um formato próprio da Meta: não entra aqui
  category: z.enum(['MARKETING', 'UTILITY'], { errorMap: () => ({ message: 'Escolha a categoria: Marketing ou Utilidade' }) }),
  language: z.enum(LANGS as [string, ...string[]]),
  header: z.discriminatedUnion('format', [
    z.object({ format: z.literal('NONE') }),
    z.object({ format: z.literal('TEXT'), text: z.string().trim().min(1).max(60, 'Cabeçalho: até 60 letras'), example: z.string().trim().max(200).optional() }),
    z.object({ format: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']), handle: z.string().min(1, 'Envie a amostra do cabeçalho') }),
  ]).default({ format: 'NONE' }),
  body: z.string().trim().min(1, 'Escreva o corpo da mensagem').max(1024, 'Corpo: até 1.024 letras'),
  bodyExamples: z.array(z.string().trim().max(200)).max(20).default([]),
  footer: z.string().trim().max(60, 'Rodapé: até 60 letras').optional(),
  buttons: z.array(button).max(10, 'No máximo 10 botões').default([]),
});

/** Monta o pedido da Meta conferindo as regras (variáveis {{1}} em ordem, exemplos, botões). */
export function buildTemplatePayload(d: z.infer<typeof createSchema>) {
  const vars = templateVars(d.body);
  if (vars.some((v) => !/^\d+$/.test(v))) throw new AppError(422, 'Use variáveis numeradas: {{1}}, {{2}}…');
  vars.forEach((v, i) => { if (Number(v) !== i + 1) throw new AppError(422, 'As variáveis precisam seguir a ordem {{1}}, {{2}}, {{3}}…'); });
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(d.body) || /\{\{\s*\d+\s*\}\}\s*[.!?]?\s*$/.test(d.body)) {
    throw new AppError(422, 'A Meta não aceita variável no começo ou no fim do texto: coloque palavras antes e depois.');
  }
  if (vars.length && d.bodyExamples.filter(Boolean).length < vars.length) throw new AppError(422, `Preencha o exemplo de cada variável (${vars.length}).`);
  const components: Record<string, unknown>[] = [];
  if (d.header.format === 'TEXT') {
    const hv = templateVars(d.header.text);
    if (hv.length > 1) throw new AppError(422, 'O cabeçalho aceita no máximo uma variável ({{1}}).');
    if (hv.length && !d.header.example) throw new AppError(422, 'Preencha o exemplo da variável do cabeçalho.');
    components.push({ type: 'HEADER', format: 'TEXT', text: d.header.text, ...(hv.length ? { example: { header_text: [d.header.example] } } : {}) });
  } else if (d.header.format !== 'NONE') {
    components.push({ type: 'HEADER', format: d.header.format, example: { header_handle: [d.header.handle] } });
  }
  components.push({ type: 'BODY', text: d.body, ...(vars.length ? { example: { body_text: [d.bodyExamples.slice(0, vars.length)] } } : {}) });
  if (d.footer) components.push({ type: 'FOOTER', text: d.footer });
  if (d.buttons.length) {
    if (d.buttons.filter((b) => b.type === 'URL').length > 2) throw new AppError(422, 'No máximo 2 botões de link.');
    if (d.buttons.filter((b) => b.type === 'PHONE_NUMBER').length > 1) throw new AppError(422, 'No máximo 1 botão de ligar.');
    components.push({
      type: 'BUTTONS',
      buttons: d.buttons.map((b) => {
        if (b.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text: b.text };
        if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone.startsWith('+') ? b.phone : `+${b.phone}` };
        const hasVar = /\{\{\s*1\s*\}\}$/.test(b.url);
        if (/\{\{/.test(b.url) && !hasVar) throw new AppError(422, 'No link do botão, a variável só pode ser {{1}} no final.');
        if (hasVar && !b.example) throw new AppError(422, `Preencha o exemplo do link do botão “${b.text}”.`);
        return { type: 'URL', text: b.text, url: b.url, ...(hasVar ? { example: [b.example] } : {}) };
      }),
    });
  }
  return { name: d.name, language: d.language, category: d.category, parameter_format: 'POSITIONAL', components };
}

templatesRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const p = createSchema.safeParse(req.body);
  if (!p.success) throw new AppError(422, p.error.issues[0]?.message ?? 'Dados inválidos');
  const c = await wabaConnection(req.accountId!, p.data.connectionId);
  const payload = buildTemplatePayload(p.data);
  const r = await meta(() => createTemplate(c.accessToken, c.wabaId, payload));
  cache.delete(c.wabaId);
  res.status(201).json({ template: { id: r.id, name: p.data.name, language: p.data.language, status: r.status, category: r.category } });
}));

templatesRouter.delete('/:name', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await wabaConnection(req.accountId!, req.query.connectionId);
  const name = String(req.params.name);
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw new AppError(422, 'Nome inválido');
  const id = typeof req.query.id === 'string' && /^\d+$/.test(req.query.id) ? req.query.id : null;
  await meta(() => deleteTemplate(c.accessToken, c.wabaId, name, id));
  cache.delete(c.wabaId);
  res.status(204).end();
}));
