import express, { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { config } from '../config';
import { flowExtras, globalsOf } from '../flows/globals';
import { FILE_RULES, saveFile, signedFilePath, type FileKind } from './storedFiles';
import { aiEnabled, byokBaseUrl, chatCompleteWith, listModels, type ChatMsg } from '../ai/provider';
import { toChatParts } from '../flows/aiBlock';
import type { ChatPart } from '../ai/provider';
import { normalizeGraph, triggerOf, blockCount, type FlowGraph } from '../flows/types';
import { simulate, type SimHistoryItem } from '../flows/simulate';
import { safeHttpRequest } from '../flows/http';
import { aiCall } from '../ai/usage';
import { uniqueFlowName as uniqueName } from './flowNames';
import { TRANSLATE_LANGS, translateFlow, translationEstimate } from './translations';
import {
  GENERATE_FROM_IMAGES, GENERATE_SYSTEM, extractJson, sanitizeGeneratedGraph, stripForImport,
} from '../flows/aiTools';

export const flowsRouter = Router();

const MAX_NODES = 400;
const ACTIVE = ['running', 'waiting', 'waiting_input', 'waiting_payment'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sem ambíguos

type FlowRow = typeof schema.flows.$inferSelect;

function defaultGraph(): FlowGraph {
  return {
    nodes: [{ id: 'trigger', type: 'trigger', position: { x: 120, y: 220 }, data: { type: 'any_message', reentry: 'always' } }],
    edges: [],
  };
}

/** Garante um bloco de Início e limita o tamanho. */
function prepareGraph(raw: unknown): FlowGraph {
  const g = normalizeGraph(raw);
  if (!g.nodes.some((n) => n.type === 'trigger')) g.nodes.unshift(defaultGraph().nodes[0]);
  if (g.nodes.length > MAX_NODES) throw new AppError(400, `Limite de ${MAX_NODES} blocos por fluxo`);
  return g;
}

async function ownFlow(accountId: string, id: string): Promise<FlowRow> {
  if (!isUuid(id)) throw new AppError(404, 'Fluxo não encontrado');
  const [row] = await db.select().from(schema.flows)
    .where(and(eq(schema.flows.id, id), eq(schema.flows.accountId, accountId))).limit(1);
  if (!row) throw new AppError(404, 'Fluxo não encontrado');
  return row;
}


async function validFolder(accountId: string, folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null;
  if (!isUuid(folderId)) throw new AppError(400, 'Pasta inválida');
  const [f] = await db.select({ id: schema.flowFolders.id }).from(schema.flowFolders)
    .where(and(eq(schema.flowFolders.id, folderId), eq(schema.flowFolders.accountId, accountId))).limit(1);
  if (!f) throw new AppError(400, 'Pasta não encontrada');
  return f.id;
}

function newCode(): string {
  return Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % 32]).join('');
}

/**
 * Gera o código de compartilhamento. Com `onlyIfEmpty`, é atômico: se duas
 * requisições chegarem juntas, as duas recebem o mesmo código.
 */
async function assignShareCode(flowId: string, onlyIfEmpty = false): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    try {
      const rows = await db.update(schema.flows).set({ shareCode: code })
        .where(onlyIfEmpty ? and(eq(schema.flows.id, flowId), isNull(schema.flows.shareCode)) : eq(schema.flows.id, flowId))
        .returning({ shareCode: schema.flows.shareCode });
      if (rows.length) return code;
      const [cur] = await db.select({ shareCode: schema.flows.shareCode }).from(schema.flows).where(eq(schema.flows.id, flowId)).limit(1);
      if (cur?.shareCode) return cur.shareCode;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err; // colisão: tenta outro
    }
  }
  throw new AppError(500, 'Não foi possível gerar o código');
}

function toListItem(f: FlowRow, runs: number, activeRuns: number) {
  const graph = normalizeGraph(f.graph);
  return {
    id: f.id, name: f.name, status: f.status, folderId: f.folderId, archivedAt: f.archivedAt,
    createdAt: f.createdAt, updatedAt: f.updatedAt, shareCode: f.shareCode,
    trigger: triggerOf(f.trigger, graph), blocks: blockCount(graph), runs, activeRuns,
  };
}

/* ------------------------------------------------------------------ lista */

flowsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const rows = await db.select().from(schema.flows)
    .where(eq(schema.flows.accountId, accountId)).orderBy(desc(schema.flows.updatedAt));
  const counts = await db.select({
    flowId: schema.flowRuns.flowId,
    runs: sql<number>`count(*)`,
    active: sql<number>`count(*) filter (where ${schema.flowRuns.status} in ('running','waiting','waiting_input','waiting_payment'))`,
  }).from(schema.flowRuns).where(eq(schema.flowRuns.accountId, accountId)).groupBy(schema.flowRuns.flowId);
  const byFlow = new Map(counts.map((c) => [c.flowId, c]));
  res.json({
    flows: rows.map((f) => toListItem(f, Number(byFlow.get(f.id)?.runs ?? 0), Number(byFlow.get(f.id)?.active ?? 0))),
  });
}));

/* ------------------------------------------------- rotas sem :id (antes) */

const importSchema = z.object({
  codes: z.union([z.string(), z.array(z.string())]),
  folderId: z.string().uuid().nullable().optional(),
});

/** Importa cópias de fluxos compartilhados por código (de qualquer conta). */
flowsRouter.post('/import', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const body = importSchema.parse(req.body);
  const folderId = await validFolder(accountId, body.folderId);
  const raw = Array.isArray(body.codes) ? body.codes.join(',') : body.codes;
  const codes = [...new Set(raw.split(/[\s,;]+/).map((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 20);
  if (!codes.length) throw new AppError(400, 'Informe ao menos um código');

  const imported: { id: string; name: string }[] = [];
  const notFound: string[] = [];
  for (const code of codes) {
    const [src] = code.length === 8
      ? await db.select().from(schema.flows).where(eq(schema.flows.shareCode, code)).limit(1)
      : [undefined];
    if (!src) { notFound.push(code); continue; }
    const graph = src.accountId === accountId ? normalizeGraph(src.graph) : stripForImport(normalizeGraph(src.graph));
    const [row] = await db.insert(schema.flows).values({
      accountId, folderId, name: await uniqueName(accountId, src.name),
      status: 'draft', graph, trigger: triggerOf(src.trigger, graph),
    }).returning();
    imported.push({ id: row.id, name: row.name });
  }
  res.status(imported.length ? 201 : 404).json({ imported, notFound });
}));

/** Imagem enviada pelo navegador (já reduzida): data URL de PNG, JPEG, WEBP ou GIF. */
const imageDataUrl = z.string().max(4_000_000, 'Imagem grande demais').regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'Formato de imagem não aceito');

/** Assistente de IA: gera um fluxo a partir de uma descrição e/ou de imagens (print, fluxograma, rascunho, conversa). */
flowsRouter.post('/generate', asyncHandler(async (req, res) => {
  const body = z.object({
    description: z.string().trim().max(2000).optional().default(''),
    images: z.array(imageDataUrl).max(4, 'Até 4 imagens por vez').optional().default([]),
  }).parse(req.body);
  const { description, images } = body;
  if (!images.length && description.length < 5) throw new AppError(400, 'Descreva o fluxo (pelo menos 5 letras) ou envie uma imagem.');
  const userContent: string | ChatPart[] = images.length
    ? [
      { type: 'text', text: `${GENERATE_FROM_IMAGES}\n\n${description ? `Observações do usuário: ${description}` : 'Recrie o fluxo das imagens.'}` },
      ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ]
    : description;
  const text = await aiCall(req.accountId!, [
    { role: 'system', content: GENERATE_SYSTEM },
    { role: 'user', content: userContent },
  ], {
    maxTokens: images.length ? 6000 : 3500, temperature: images.length ? 0.2 : 0.4,
    usage: { kind: 'flow_generate', label: (description || `Fluxo a partir de ${images.length} ${images.length === 1 ? 'imagem' : 'imagens'}`).slice(0, 120) },
  });
  let raw: unknown;
  try { raw = extractJson(text); }
  catch { throw new AppError(502, images.length ? 'A IA não conseguiu ler um fluxo nessa imagem. Tente uma imagem mais nítida ou com menos coisas na tela.' : 'A IA não devolveu um fluxo válido. Tente descrever de outro jeito.'); }
  const graph = sanitizeGeneratedGraph(raw);
  if (graph.nodes.length < 2) throw new AppError(502, images.length ? 'A IA não encontrou blocos de fluxo na imagem. Envie um print do fluxo, um fluxograma ou um roteiro.' : 'A IA não gerou blocos. Tente detalhar mais o que o fluxo deve fazer.');
  res.json({ graph });
}));

const simSchema = z.object({
  graph: z.object({ nodes: z.array(z.any()).max(MAX_NODES), edges: z.array(z.any()).max(MAX_NODES * 4) }),
  state: z.any().optional(),
  input: z.union([
    z.object({ type: z.literal('start') }),
    z.object({ type: z.literal('message'), text: z.string().max(4000), replyId: z.string().max(256).nullable().optional() }),
    z.object({ type: z.literal('payment'), paid: z.boolean() }),
    z.object({ type: z.literal('timeout') }),
  ]),
  realHttp: z.boolean().optional(),
});

/** Simulador: roda o grafo atual (mesmo não salvo) sem enviar nada ao WhatsApp. */
flowsRouter.post('/simulate', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const body = simSchema.parse(req.body);
  const result = await simulate(body.graph, body.state ?? null, body.input, {
    realHttp: !!body.realHttp,
    http: (r) => safeHttpRequest(r),
    ai: (r, history: SimHistoryItem[]) => aiCall(accountId, [
      { role: 'system', content: r.system },
      ...(r.history ? history.slice(-12) : []),
      ...(r.user ? [{ role: 'user' as const, content: r.user }] : []),
    ], { model: r.model, maxTokens: r.maxTokens, usage: { kind: 'flow_simulate', label: 'Bloco de IA no simulador' } }),
    product: async (id) => {
      if (!isUuid(id)) return null;
      const [p] = await db.select().from(schema.products)
        .where(and(eq(schema.products.id, id), eq(schema.products.accountId, accountId))).limit(1);
      return p ? { id: p.id, name: p.name, price: Number(p.price), checkoutUrl: p.checkoutUrl } : null;
    },
    extras: () => flowExtras(accountId),
    departmentName: async (id) => {
      if (!isUuid(id)) return null;
      const [d] = await db.select({ name: schema.departments.name }).from(schema.departments)
        .where(and(eq(schema.departments.id, id), eq(schema.departments.accountId, accountId))).limit(1);
      return d?.name ?? null;
    },
    kanbanLabel: async (boardId, columnId) => {
      if (!isUuid(boardId) || !isUuid(columnId)) return null;
      const [r] = await db.select({ board: schema.kanbanBoards.name, column: schema.kanbanColumns.name }).from(schema.kanbanColumns)
        .innerJoin(schema.kanbanBoards, eq(schema.kanbanBoards.id, schema.kanbanColumns.boardId))
        .where(and(eq(schema.kanbanColumns.id, columnId), eq(schema.kanbanColumns.boardId, boardId), eq(schema.kanbanBoards.accountId, accountId))).limit(1);
      return r ? `${r.board} › ${r.column}` : null;
    },
    flowName: async (id) => {
      if (!isUuid(id)) return null;
      const [f] = await db.select({ name: schema.flows.name }).from(schema.flows)
        .where(and(eq(schema.flows.id, id), eq(schema.flows.accountId, accountId))).limit(1);
      return f?.name ?? null;
    },
    aiComplete: async (spec, history) => {
      const messages: ChatMsg[] = [
        { role: 'system', content: spec.system },
        ...(spec.history > 0 ? history.slice(-(spec.history * 2) - 1, -1) : []),
        { role: 'user', content: toChatParts(spec.user) },
      ];
      if (spec.provider === 'converza') {
        return aiCall(accountId, messages, { model: spec.model, maxTokens: spec.maxTokens, usage: { kind: 'flow_simulate', label: 'Bloco de IA no simulador' } });
      }
      return (await chatCompleteWith({ baseUrl: byokBaseUrl(spec.provider), apiKey: spec.apiKey ?? '' }, spec.model ?? '', messages, { maxTokens: spec.maxTokens })).text;
    },
    agentName: async (id) => {
      if (!isUuid(id)) return null;
      const [a] = await db.select({ name: schema.agents.name }).from(schema.agents)
        .where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId))).limit(1);
      return a?.name ?? null;
    },
    pixelName: async (id) => {
      if (!isUuid(id)) return null;
      const [px] = await db.select({ name: schema.pixels.name }).from(schema.pixels)
        .where(and(eq(schema.pixels.id, id), eq(schema.pixels.accountId, accountId))).limit(1);
      return px?.name ?? null;
    },
    memberName: async (id) => {
      if (!isUuid(id)) return null;
      const [u] = await db.select({ name: schema.users.name }).from(schema.users)
        .innerJoin(schema.memberships, eq(schema.memberships.userId, schema.users.id))
        .where(and(eq(schema.users.id, id), eq(schema.memberships.accountId, accountId))).limit(1);
      return u?.name ?? null;
    },
    fileUrl: async (id) => {
      if (!isUuid(id)) return null;
      const [f] = await db.select({ id: schema.storedFiles.id }).from(schema.storedFiles)
        .where(and(eq(schema.storedFiles.id, id), eq(schema.storedFiles.accountId, accountId))).limit(1);
      return f ? `${publicBase(req, config.publicApiUrl)}${signedFilePath(f.id)}` : null;
    },
    timezone: async () => {
      const [a] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
      return a?.tz || 'America/Sao_Paulo';
    },
  });
  res.json(result);
}));

/* ------------------------------------------------------------- arquivos, teste de integração e modelos de IA */

/** Arquivo dos blocos (Mensagem, Carrossel, Botão PIX): o corpo é o próprio arquivo; tipo em x-file-type, nome em ?filename=, uso em ?kind=. */
flowsRouter.post('/files', express.raw({ type: () => true, limit: '31mb' }), asyncHandler(async (req, res) => {
  const kind = String(req.query.kind ?? '') as FileKind;
  if (!FILE_RULES[kind]) throw new AppError(422, 'Tipo de arquivo inválido');
  const data = req.body as Buffer;
  if (!Buffer.isBuffer(data) || !data.length) throw new AppError(400, 'Arquivo vazio');
  const mime = String(req.headers['x-file-type'] ?? req.headers['content-type'] ?? '');
  const name = String(req.query.filename ?? 'arquivo').replace(/[\r\n"/\\]/g, '').slice(0, 140) || 'arquivo';
  const f = await saveFile(req.accountId!, kind, data, mime, name, 'flow');
  res.status(201).json({ file: { ...f, url: `${publicBase(req, config.publicApiUrl)}${signedFilePath(f.id)}` } });
}));

/** Links de prévia dos arquivos usados no fluxo (valem 12 h). */
flowsRouter.post('/files/sign', asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().uuid()).max(300) }).parse(req.body ?? {});
  if (!ids.length) return res.json({ files: {} });
  const rows = await db.select({ id: schema.storedFiles.id, fileName: schema.storedFiles.fileName, mime: schema.storedFiles.mime, size: schema.storedFiles.size })
    .from(schema.storedFiles).where(and(eq(schema.storedFiles.accountId, req.accountId!), inArray(schema.storedFiles.id, ids)));
  const base = publicBase(req, config.publicApiUrl);
  res.json({ files: Object.fromEntries(rows.map((r) => [r.id, { ...r, url: `${base}${signedFilePath(r.id)}` }])) });
}));

/** "Testar requisição" do bloco Integração (mesma proteção do fluxo no ar: nada de endereços internos). */
flowsRouter.post('/http-test', asyncHandler(async (req, res) => {
  const b = z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().trim().min(1, 'Informe a URL').max(2000),
    headers: z.record(z.string().max(4000)).optional(),
    body: z.string().max(100_000).optional(),
  }).parse(req.body ?? {});
  if (!/^https?:\/\//i.test(b.url)) throw new AppError(422, 'A URL precisa começar com http:// ou https://');
  const headers: Record<string, string> = { ...(b.headers ?? {}) };
  if (b.method !== 'GET' && b.body?.trim() && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  const result = await safeHttpRequest({ method: b.method, url: b.url, headers, body: b.method === 'GET' ? undefined : b.body });
  res.json({ result });
}));

/** Modelos que o provedor do Bloco de IA oferece (com a chave da conta ou a do servidor). */
flowsRouter.post('/ai-models', asyncHandler(async (req, res) => {
  const b = z.object({ provider: z.enum(['converza', 'openai', 'gemini', 'openrouter']), apiKey: z.string().max(500).optional() }).parse(req.body ?? {});
  try {
    if (b.provider === 'converza') {
      if (!aiEnabled()) throw new AppError(503, 'A IA não está configurada no servidor (OPENAI_API_KEY).');
      const models = await listModels({ baseUrl: config.ai.baseUrl, apiKey: config.ai.apiKey });
      return res.json({ models, defaultModel: config.ai.defaultModel });
    }
    let key = (b.apiKey ?? '').trim();
    const g = /^\{\{?\s*(g_[a-z0-9_]+)\s*\}?\}$/i.exec(key);
    if (g) key = (await globalsOf(req.accountId!))[g[1].toLowerCase()] ?? '';
    if (!key) throw new AppError(422, g ? `A variável global ${g[1]} está vazia ou não existe.` : 'Informe a chave da API (ou uma variável global com a chave).');
    res.json({ models: await listModels({ baseUrl: byokBaseUrl(b.provider), apiKey: key }) });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(422, (err as Error).message);
  }
}));

/* ------------------------------------------------------------- CRUD */

flowsRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const body = z.object({
    name: z.string().trim().max(120).optional(),
    folderId: z.string().uuid().nullable().optional(),
    graph: z.any().optional(),
  }).parse(req.body ?? {});
  const graph = body.graph ? prepareGraph(body.graph) : defaultGraph();
  const [row] = await db.insert(schema.flows).values({
    accountId,
    folderId: await validFolder(accountId, body.folderId),
    name: await uniqueName(accountId, body.name || 'Novo fluxo'),
    status: 'draft',
    graph,
    trigger: triggerOf(undefined, graph),
  }).returning();
  res.status(201).json({ flow: row });
}));

flowsRouter.get('/:id', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  res.json({ flow: { ...flow, graph: normalizeGraph(flow.graph) } });
}));

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  folderId: z.string().uuid().nullable().optional(),
  graph: z.object({ nodes: z.array(z.any()).max(MAX_NODES), edges: z.array(z.any()).max(MAX_NODES * 4) }).optional(),
});

flowsRouter.put('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const flow = await ownFlow(accountId, req.params.id);
  const data = updateSchema.parse(req.body);
  const patch: Partial<FlowRow> = { updatedAt: new Date() };

  let graph = normalizeGraph(flow.graph);
  if (data.graph) {
    graph = prepareGraph(data.graph);
    patch.graph = graph;
    patch.trigger = triggerOf(undefined, graph);
  }
  if (data.name) patch.name = data.name;
  if (data.folderId !== undefined) patch.folderId = await validFolder(accountId, data.folderId);
  if (data.status) {
    if (data.status === 'active') {
      if (flow.archivedAt) throw new AppError(400, 'Restaure o fluxo do arquivo antes de ativar');
      if (blockCount(graph) === 0) throw new AppError(400, 'Adicione pelo menos um bloco antes de ativar o fluxo');
    }
    patch.status = data.status;
  }
  const [row] = await db.update(schema.flows).set(patch).where(eq(schema.flows.id, flow.id)).returning();
  res.json({ flow: { ...row, graph: normalizeGraph(row.graph) } });
}));

flowsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  // disparo em massa ainda vivo usa este fluxo: excluir deixaria os contatos sem ter o que receber
  const live = await db.select({ name: schema.campaigns.name }).from(schema.campaigns)
    .where(and(eq(schema.campaigns.flowId, flow.id), inArray(schema.campaigns.status, ['scheduled', 'sending', 'paused']))).limit(3);
  if (live.length) {
    throw new AppError(409, `Este fluxo está no disparo em massa “${live.map((c) => c.name).join('”, “')}”. Termine ou cancele o disparo antes de excluir o fluxo.`, { code: 'flow_in_dispatch' });
  }
  await db.delete(schema.flows).where(eq(schema.flows.id, flow.id));
  res.status(204).end();
}));

flowsRouter.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const flow = await ownFlow(accountId, req.params.id);
  const graph = normalizeGraph(flow.graph);
  const [row] = await db.insert(schema.flows).values({
    accountId, folderId: flow.folderId, name: await uniqueName(accountId, `${flow.name} (cópia)`),
    status: 'draft', graph, trigger: triggerOf(flow.trigger, graph),
  }).returning();
  res.status(201).json({ flow: row });
}));

flowsRouter.post('/:id/archive', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  const [row] = await db.update(schema.flows)
    .set({ archivedAt: new Date(), status: flow.status === 'active' ? 'paused' : flow.status, updatedAt: new Date() })
    .where(eq(schema.flows.id, flow.id)).returning();
  // execuções em andamento deste fluxo são encerradas
  await db.update(schema.flowRuns).set({ status: 'canceled', finishedAt: new Date() })
    .where(and(eq(schema.flowRuns.flowId, flow.id), sql`${schema.flowRuns.status} in ('running','waiting','waiting_input','waiting_payment')`));
  res.json({ flow: row });
}));

flowsRouter.post('/:id/unarchive', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  const [row] = await db.update(schema.flows).set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(schema.flows.id, flow.id)).returning();
  res.json({ flow: row });
}));

/* ------------------------------------------------ compartilhar por código */

flowsRouter.post('/:id/share', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  const shareCode = flow.shareCode ?? await assignShareCode(flow.id, true);
  res.json({ shareCode });
}));

flowsRouter.post('/:id/share/regenerate', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  res.json({ shareCode: await assignShareCode(flow.id) });
}));

flowsRouter.delete('/:id/share', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  await db.update(schema.flows).set({ shareCode: null }).where(eq(schema.flows.id, flow.id));
  res.json({ shareCode: null });
}));

/* -------------------------------------------------------- estatísticas */

flowsRouter.get('/:id/stats', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  const rows = await db.select().from(schema.flowNodeStats).where(eq(schema.flowNodeStats.flowId, flow.id));
  const [totals] = await db.select({
    runs: sql<number>`count(*)`,
    active: sql<number>`count(*) filter (where ${schema.flowRuns.status} in ('running','waiting','waiting_input','waiting_payment'))`,
    done: sql<number>`count(*) filter (where ${schema.flowRuns.status} = 'done')`,
  }).from(schema.flowRuns).where(eq(schema.flowRuns.flowId, flow.id));
  const stats: Record<string, { entries: number; advances: number }> = {};
  for (const r of rows) stats[r.nodeId] = { entries: r.entries, advances: r.advances };
  res.json({ stats, totals: { runs: Number(totals?.runs ?? 0), active: Number(totals?.active ?? 0), done: Number(totals?.done ?? 0) } });
}));

flowsRouter.delete('/:id/stats', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  await db.delete(schema.flowNodeStats).where(eq(schema.flowNodeStats.flowId, flow.id));
  res.status(204).end();
}));

/* ------------------------------------------------------------ traduzir */

flowsRouter.post('/:id/translate', asyncHandler(async (req, res) => {
  const { language } = z.object({ language: z.enum(TRANSLATE_LANGS) }).parse(req.body);
  const flow = await ownFlow(req.accountId!, req.params.id);
  const out = await translateFlow(req.accountId!, req.user?.id ?? null, flow, language);
  res.status(201).json(out);
}));

flowsRouter.get('/:id/translate/estimate', asyncHandler(async (req, res) => {
  const flow = await ownFlow(req.accountId!, req.params.id);
  res.json(await translationEstimate(req.accountId!, flow));
}));

export { ACTIVE as ACTIVE_FLOW_RUN_STATUSES };
