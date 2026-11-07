import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { gunzipSync, gzipSync } from 'zlib';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db';
import { asyncHandler, AppError, isUuid } from '../utils/http';
import { isEmail, normalizePhone } from '../utils/phone';
import { toCsv } from '../utils/csv';
import { upsertContactCard } from './kanbanStore';
import { findContactByPhone, findContactsByPhones, type ContactRow } from './contactStore';
import { applyCustom, cleanCustom, cleanTags, mergeImportRows, readImport, type FieldDef, type ImportRow } from './contactImport';

export { readImport, type ImportRow };

/**
 * Contatos (CRM): lista com busca, status (ativos/leads/clientes), origem e filtros avançados
 * (datas, campo personalizado, etiquetas, etapas do Kanban), cadastro e edição, ações em massa,
 * campos personalizados, importação e exportação em CSV (as 3 últimas ficam guardadas).
 */
export const contactsRouter = Router();

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];
const iso = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

export const STAGES = ['new', 'in_service', 'negotiating', 'won', 'lost'] as const;
export const STAGE_LABEL: Record<string, string> = { new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido' };
export const ORIGINS = ['whatsapp', 'ad', 'import', 'manual', 'webhook'] as const;
export const ORIGIN_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', ad: 'Anúncio (Meta)', import: 'Importação CSV', manual: 'Cadastro manual', webhook: 'Integração' };
const FIELD_TYPES = ['text', 'number', 'date', 'select'] as const;
const MAX_EXPORT = 50_000;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const arr = (v: unknown) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).map(String).filter(Boolean));

/* ------------------------------------------------------------------ filtros */

export const filtersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'lead', 'customer']).optional().or(z.literal('')),
  origin: z.enum(ORIGINS).optional().or(z.literal('')),
  from: ymd.optional().or(z.literal('')),
  to: ymd.optional().or(z.literal('')),
  field: z.string().trim().max(60).optional().or(z.literal('')),
  fieldValue: z.string().trim().max(200).optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  columns: z.array(z.string().uuid()).max(200).optional(),
  stages: z.array(z.enum(STAGES)).max(5).optional(),
  ids: z.array(z.string().uuid()).max(10_000).optional(),
});
export type ContactFilters = z.infer<typeof filtersSchema>;

const filtersFromQuery = (q: Request['query']) => filtersSchema.parse({
  ...q, tags: arr(q.tags), columns: arr(q.columns), stages: arr(q.stages), ids: arr(q.ids),
});

async function accountTz(accountId: string) {
  const [a] = await db.select({ tz: schema.accounts.timezone }).from(schema.accounts).where(eq(schema.accounts.id, accountId)).limit(1);
  return a?.tz || 'America/Sao_Paulo';
}

/** Lista como UM parâmetro de array do Postgres. (Dentro de sql`` o drizzle expandiria um array JS em ($1, $2, …).) */
const pgArray = (values: readonly string[], type: 'text' | 'uuid') => sql`${sql.param([...values])}::${sql.raw(type)}[]`;

/** Condição SQL (alias c) dos filtros da tela de Contatos — também usada no público dos disparos. */
export async function contactsWhere(accountId: string, f: ContactFilters): Promise<SQL> { return whereOf(accountId, f); }

async function whereOf(accountId: string, f: ContactFilters): Promise<SQL> {
  const parts: SQL[] = [sql`c.account_id = ${accountId}`];
  if (f.q) {
    const like = `%${f.q}%`;
    const digits = f.q.replace(/\D/g, '');
    parts.push(sql`(c.name ilike ${like} or coalesce(c.email, '') ilike ${like}
      ${digits.length >= 3 ? sql`or c.phone like ${`%${digits}%`}` : sql``})`);
  }
  if (f.status === 'active') parts.push(sql`c.last_contact_at >= now() - interval '30 days'`);
  if (f.status === 'inactive') parts.push(sql`(c.last_contact_at is null or c.last_contact_at < now() - interval '30 days')`);
  if (f.status === 'lead') parts.push(sql`not exists (select 1 from sales s where s.contact_id = c.id and s.status = 'approved')`);
  if (f.status === 'customer') parts.push(sql`exists (select 1 from sales s where s.contact_id = c.id and s.status = 'approved')`);
  if (f.origin) parts.push(sql`c.origin = ${f.origin}`);
  if (f.from || f.to) {
    const tz = await accountTz(accountId);
    if (f.from) parts.push(sql`c.created_at >= (${f.from}::date::timestamp at time zone ${tz})`);
    if (f.to) parts.push(sql`c.created_at < ((${f.to}::date + 1)::timestamp at time zone ${tz})`);
  }
  if (f.field) {
    if (f.fieldValue) parts.push(sql`(c.custom ->> ${f.field}) ilike ${`%${f.fieldValue}%`}`);
    else parts.push(sql`coalesce(c.custom ->> ${f.field}, '') <> ''`);
  }
  if (f.tags?.length) parts.push(sql`c.tags && ${pgArray(f.tags, 'text')}`);
  if (f.columns?.length) parts.push(sql`exists (select 1 from kanban_cards k where k.contact_id = c.id and k.column_id = any(${pgArray(f.columns, 'uuid')}))`);
  if (f.stages?.length) parts.push(sql`c.stage::text = any(${pgArray(f.stages, 'text')})`);
  if (f.ids?.length) parts.push(sql`c.id = any(${pgArray(f.ids, 'uuid')})`);
  return sql.join(parts, sql` and `);
}

const SORTS: Record<string, SQL> = {
  created_desc: sql`c.created_at desc, c.id`,
  created_asc: sql`c.created_at asc, c.id`,
  name_asc: sql`lower(c.name) asc, c.id`,
  name_desc: sql`lower(c.name) desc, c.id`,
  last_desc: sql`c.last_contact_at desc nulls last, c.id`,
  last_asc: sql`c.last_contact_at asc nulls first, c.id`,
  value_desc: sql`c.value desc, c.id`,
};

const LIST_SELECT = sql`
  c.id, c.name, c.phone, c.email, c.tags, c.stage, c.value, c.origin, c.custom, c.notes, c.source_url as "sourceUrl",
  ${iso('c.created_at')} as "createdAt", ${iso('c.last_contact_at')} as "lastContactAt",
  v.id as "conversationId", coalesce(v.unread_count, 0) as "unreadCount",
  coalesce((select json_agg(json_build_object('cardId', k.id, 'boardId', b.id, 'boardName', b.name, 'columnId', col.id,
      'columnName', col.name, 'color', col.color, 'kind', col.kind) order by b.created_at)
    from kanban_cards k join kanban_boards b on b.id = k.board_id join kanban_columns col on col.id = k.column_id
    where k.contact_id = c.id), '[]'::json) as kanban,
  (select count(*) from sales s where s.contact_id = c.id and s.status = 'approved') as purchases`;
const LIST_FROM = sql`contacts c left join lateral (
    select id, unread_count from conversations where contact_id = c.id order by last_message_at desc limit 1
  ) v on true`;

const mapRow = (r: Record<string, any>) => ({
  ...r, value: Number(r.value), unreadCount: Number(r.unreadCount), purchases: Number(r.purchases), tags: r.tags ?? [], custom: r.custom ?? {},
});

/** Contagens do topo (conta inteira): total, ativos (falaram nos últimos 30 dias) e leads (sem compra aprovada). */
async function headCounts(accountId: string) {
  const [r] = await rows<{ total: string; active: string; leads: string }>(sql`
    select count(*) as total,
      count(*) filter (where c.last_contact_at >= now() - interval '30 days') as active,
      count(*) filter (where not exists (select 1 from sales s where s.contact_id = c.id and s.status = 'approved')) as leads
    from contacts c where c.account_id = ${accountId}`);
  return { total: Number(r?.total ?? 0), active: Number(r?.active ?? 0), leads: Number(r?.leads ?? 0) };
}

contactsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const f = filtersFromQuery(req.query);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const sort = SORTS[String(req.query.sort ?? '')] ?? SORTS.created_desc;
  const where = await whereOf(accountId, f);
  const [list, [{ n }], counts] = await Promise.all([
    rows(sql`select ${LIST_SELECT} from ${LIST_FROM} where ${where} order by ${sort} limit ${limit} offset ${(page - 1) * limit}`),
    rows<{ n: string }>(sql`select count(*) as n from contacts c where ${where}`),
    headCounts(accountId),
  ]);
  const total = Number(n);
  res.json({ contacts: list.map(mapRow), total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, counts });
}));

/* ----------------------------------------------------- campos personalizados */

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'campo';

async function fieldsOf(accountId: string) {
  return db.select().from(schema.contactFields).where(eq(schema.contactFields.accountId, accountId))
    .orderBy(asc(schema.contactFields.position), asc(schema.contactFields.createdAt));
}

const fieldBody = z.object({
  label: z.string().trim().min(1, 'Dê um nome ao campo').max(60),
  type: z.enum(FIELD_TYPES).default('text'),
  options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
});

contactsRouter.get('/fields', asyncHandler(async (req, res) => {
  res.json({ fields: await fieldsOf(req.accountId!) });
}));

contactsRouter.post('/fields', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = fieldBody.parse(req.body);
  if (d.type === 'select' && !d.options.length) throw new AppError(400, 'Informe as opções da lista');
  const existing = await fieldsOf(accountId);
  if (existing.length >= 50) throw new AppError(400, 'Limite de 50 campos personalizados');
  if (existing.some((f) => f.label.toLowerCase() === d.label.toLowerCase())) throw new AppError(409, `Já existe o campo “${d.label}”`);
  const base = slug(d.label);
  let key = base; let i = 2;
  while (existing.some((f) => f.key === key) || ['nome', 'telefone', 'email', 'etiquetas', 'etapa', 'valor', 'anotacoes'].includes(key)) key = `${base}_${i++}`;
  const [row] = await db.insert(schema.contactFields).values({
    accountId, key, label: d.label, type: d.type, options: d.type === 'select' ? d.options : [], position: existing.length,
  }).returning();
  res.status(201).json({ field: row });
}));

contactsRouter.patch('/fields/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  if (!isUuid(req.params.id)) throw new AppError(404, 'Campo não encontrado');
  const d = fieldBody.partial().parse(req.body);
  const list = await fieldsOf(accountId);
  const cur = list.find((f) => f.id === req.params.id);
  if (!cur) throw new AppError(404, 'Campo não encontrado');
  if (d.label && list.some((f) => f.id !== cur.id && f.label.toLowerCase() === d.label!.toLowerCase())) throw new AppError(409, `Já existe o campo “${d.label}”`);
  const type = d.type ?? cur.type;
  const options = type === 'select' ? (d.options ?? cur.options) : [];
  if (type === 'select' && !options.length) throw new AppError(400, 'Informe as opções da lista');
  const [row] = await db.update(schema.contactFields).set({ ...(d.label ? { label: d.label } : {}), type, options })
    .where(eq(schema.contactFields.id, cur.id)).returning();
  res.json({ field: row });
}));

contactsRouter.put('/fields/order', asyncHandler(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().uuid()).max(50) }).parse(req.body);
  const list = await fieldsOf(req.accountId!);
  if (ids.length !== list.length || !ids.every((id) => list.some((f) => f.id === id))) throw new AppError(400, 'A lista de campos não confere');
  await Promise.all(ids.map((id, i) => db.update(schema.contactFields).set({ position: i }).where(eq(schema.contactFields.id, id))));
  res.json({ ok: true });
}));

/** Exclui o campo e apaga o valor dele em todos os contatos. */
contactsRouter.delete('/fields/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores excluem campos');
  if (!isUuid(req.params.id)) throw new AppError(404, 'Campo não encontrado');
  const [f] = await db.delete(schema.contactFields)
    .where(and(eq(schema.contactFields.id, req.params.id), eq(schema.contactFields.accountId, accountId))).returning();
  if (!f) throw new AppError(404, 'Campo não encontrado');
  await db.execute(sql`update contacts set custom = custom - ${f.key} where account_id = ${accountId} and custom ? ${f.key}`);
  res.status(204).end();
}));


 
/** Etiquetas usadas no contato também aparecem na lista de etiquetas da conta. */
async function ensureTags(accountId: string, tags: string[]) {
  const uniq = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (uniq.length) await db.insert(schema.tags).values(uniq.map((name) => ({ accountId, name }))).onConflictDoNothing();
}

/* --------------------------------------------------------------- exportar */

async function buildCsv(accountId: string, f: ContactFilters) {
  const fields = await fieldsOf(accountId);
  const where = await whereOf(accountId, f);
  const list = await rows(sql`select ${LIST_SELECT} from ${LIST_FROM} where ${where} order by ${SORTS.created_desc} limit ${MAX_EXPORT}`);
  const tz = await accountTz(accountId);
  const br = (s: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: tz }) : '');
  const header = ['nome', 'telefone', 'email', 'etiquetas', 'etapa', 'valor', 'anotacoes', ...fields.map((x) => x.label),
    'origem', 'kanban', 'compras', 'criado_em', 'ultima_conversa'];
  const data = list.map((r) => [
    r.name, r.phone, r.email ?? '', (r.tags ?? []).join(', '), STAGE_LABEL[r.stage] ?? r.stage,
    Number(r.value) ? Number(r.value).toFixed(2).replace('.', ',') : '', r.notes ?? '',
    ...fields.map((x) => {
      const v = (r.custom ?? {})[x.key];
      if (v == null) return '';
      if (x.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) { const [y, m, d] = String(v).split('-'); return `${d}/${m}/${y}`; }
      if (x.type === 'number') return String(v).replace('.', ',');
      return String(v);
    }),
    ORIGIN_LABEL[r.origin] ?? r.origin,
    (r.kanban ?? []).map((k: any) => `${k.boardName} › ${k.columnName}`).join('; '),
    Number(r.purchases) || '', br(r.createdAt), br(r.lastContactAt),
  ]);
  return { csv: toCsv(header, data), count: list.length };
}

contactsRouter.get('/exports', asyncHandler(async (req, res) => {
  const list = await db.select({
    id: schema.contactExports.id, filename: schema.contactExports.filename, label: schema.contactExports.label,
    rows: schema.contactExports.rows, createdAt: schema.contactExports.createdAt, userName: schema.users.name,
  }).from(schema.contactExports).leftJoin(schema.users, eq(schema.users.id, schema.contactExports.userId))
    .where(eq(schema.contactExports.accountId, req.accountId!)).orderBy(desc(schema.contactExports.createdAt)).limit(3);
  res.json({ exports: list });
}));

/** Gera o CSV (filtros atuais ou contatos selecionados) e guarda nas "Exportações recentes" (as 3 últimas). */
contactsRouter.post('/exports', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = z.object({ filters: filtersSchema.default({}), label: z.string().trim().max(200).default('') }).parse(req.body);
  const { csv, count } = await buildCsv(accountId, d.filters);
  if (!count) throw new AppError(400, 'Nenhum contato para exportar com esses filtros');
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: await accountTz(accountId) }).slice(0, 16).replace(/[-: ]/g, (m) => (m === ' ' ? '_' : m === ':' ? 'h' : '-'));
  const [row] = await db.insert(schema.contactExports).values({
    accountId, userId: req.user!.id, filename: `contatos_${stamp}.csv`, label: d.label || 'Todos os contatos', rows: count,
    content: gzipSync(Buffer.from(csv, 'utf8')).toString('base64'),
  }).returning({ id: schema.contactExports.id, filename: schema.contactExports.filename, label: schema.contactExports.label, rows: schema.contactExports.rows, createdAt: schema.contactExports.createdAt });
  // só as 3 mais recentes ficam guardadas
  await db.execute(sql`delete from contact_exports where account_id = ${accountId} and id not in (
    select id from contact_exports where account_id = ${accountId} order by created_at desc limit 3)`);
  res.status(201).json({ export: row });
}));

contactsRouter.get('/exports/:id/download', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) throw new AppError(404, 'Exportação não encontrada');
  const [e] = await db.select().from(schema.contactExports)
    .where(and(eq(schema.contactExports.id, req.params.id), eq(schema.contactExports.accountId, req.accountId!))).limit(1);
  if (!e) throw new AppError(404, 'Essa exportação não está mais disponível (guardamos só as 3 mais recentes)');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${e.filename}"`);
  res.send(gunzipSync(Buffer.from(e.content, 'base64')));
}));

/* --------------------------------------------------------------- importar */

contactsRouter.get('/import/template', asyncHandler(async (req, res) => {
  const fields = await fieldsOf(req.accountId!);
  const ex = (f: FieldDef, i: number) => (f.type === 'number' ? (i ? '' : '10') : f.type === 'date' ? (i ? '' : '25/12/1990') : f.type === 'select' ? (f.options[i] ?? '') : (i ? '' : 'exemplo'));
  const csv = toCsv(
    ['nome', 'telefone', 'email', 'etiquetas', 'etapa', 'valor', 'anotacoes', ...fields.map((f) => f.label)],
    [
      ['Maria Souza', '(11) 98888-7777', 'maria@email.com', 'Instagram, VIP', 'Novo', '1.500,00', 'Prefere contato à tarde', ...fields.map((f) => ex(f, 0))],
      ['João Lima', '+55 21 97777-6666', '', 'Indicação', 'Negociação', '', '', ...fields.map((f) => ex(f, 1))],
    ],
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo_contatos.csv"');
  res.send(csv);
}));




/** Importa o CSV (corpo = texto do arquivo). `?tags=["VIP"]` = etiquetas padrão para linhas sem etiqueta. */
contactsRouter.post('/import', express.text({ type: () => true, limit: '10mb' }), asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) throw new AppError(400, 'O arquivo está vazio');
  let defaultTags: string[] = [];
  try { defaultTags = z.array(z.string().max(60)).max(30).parse(JSON.parse(String(req.query.tags ?? '[]'))); } catch { defaultTags = []; }
  const fields = await fieldsOf(accountId);
  const { rows: list, errors, total } = readImport(text, fields, defaultTags);
  let created = 0; let updated = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    // já existe quem tem esse telefone (ou o wa_id, ou a forma com/sem o 9)?
    const found = await findContactsByPhones(accountId, chunk.map((r) => r.phone));
    const fresh = chunk.filter((r) => !found.has(r.phone));
    if (fresh.length) {
      const ins = await db.insert(schema.contacts).values(fresh.map((r) => ({
        accountId, name: r.name || r.phone, phone: r.phone, waId: r.phone, email: r.email, tags: r.tags,
        stage: (r.stage ?? 'new') as ContactRow['stage'], value: (r.value ?? 0).toFixed(2), notes: r.notes, custom: r.custom, origin: 'import',
      }))).onConflictDoNothing().returning({ id: schema.contacts.id });
      created += ins.length;
    }
    const byId = new Map<string, ImportRow>();
    for (const r of chunk) {
      const c = found.get(r.phone);
      if (c) { const prev = byId.get(c.id); byId.set(c.id, prev ? mergeImportRows(prev, r) : r); }
    }
    if (byId.size) {
      // só muda o que veio preenchido; etiquetas e campos personalizados são somados
      const values = sql.join([...byId].map(([id, r]) => sql`(${id}::uuid, ${r.name}, ${r.email}, ${r.stage}, ${r.value}, ${r.notes}, ${pgArray(r.tags, 'text')}, ${JSON.stringify(r.custom)}::jsonb)`), sql`, `);
      const upd = await db.execute(sql`
        update contacts c set
          name = coalesce(v.name, c.name),
          email = coalesce(v.email, c.email),
          stage = coalesce(v.stage::contact_stage, c.stage),
          value = coalesce(v.value::numeric, c.value),
          notes = coalesce(v.notes, c.notes),
          tags = (select coalesce(array_agg(distinct t), '{}') from unnest(c.tags || v.tags) t),
          custom = c.custom || v.custom
        from (values ${values}) as v(id, name, email, stage, value, notes, tags, custom)
        where c.account_id = ${accountId} and c.id = v.id`);
      updated += upd.rowCount ?? byId.size;
    }
  }
  await ensureTags(accountId, list.flatMap((r) => r.tags));
  res.json({ total, created, updated, skipped: errors.length, errors: errors.slice(0, 100) });
}));

/* ----------------------------------------------------------- ações em massa */

contactsRouter.post('/bulk', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = z.object({
    filters: filtersSchema.default({}),
    action: z.enum(['add_tags', 'remove_tags', 'set_stage', 'kanban', 'delete']),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    stage: z.enum(STAGES).optional(),
    boardId: z.string().uuid().optional(),
    columnId: z.string().uuid().optional(),
  }).parse(req.body);
  if (d.action === 'delete' && req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores excluem contatos');
  const where = await whereOf(accountId, d.filters);
  const target = (await rows<{ id: string }>(sql`select c.id from contacts c where ${where} limit 10001`)).map((r) => r.id);
  if (target.length > 10_000) throw new AppError(400, 'Selecione no máximo 10.000 contatos por vez');
  if (!target.length) { res.json({ affected: 0 }); return; }
  const ids = target;
  let affected = ids.length;
  if (d.action === 'add_tags' || d.action === 'remove_tags') {
    const tags = cleanTags(d.tags) ?? [];
    if (!tags.length) throw new AppError(400, 'Escolha as etiquetas');
    if (d.action === 'add_tags') {
      await db.execute(sql`update contacts c set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(c.tags || ${pgArray(tags, 'text')}) t)
        where c.account_id = ${accountId} and c.id = any(${pgArray(ids, 'uuid')})`);
      await ensureTags(accountId, tags);
    } else {
      const lower = tags.map((t) => t.toLowerCase());
      await db.execute(sql`update contacts c set tags = coalesce((select array_agg(t) from unnest(c.tags) t where lower(t) <> all(${pgArray(lower, 'text')})), '{}')
        where c.account_id = ${accountId} and c.id = any(${pgArray(ids, 'uuid')})`);
    }
  } else if (d.action === 'set_stage') {
    if (!d.stage) throw new AppError(400, 'Escolha a etapa');
    await db.update(schema.contacts).set({ stage: d.stage }).where(and(eq(schema.contacts.accountId, accountId), inArray(schema.contacts.id, ids)));
  } else if (d.action === 'kanban') {
    if (!d.boardId || !d.columnId) throw new AppError(400, 'Escolha o quadro e a coluna');
    if (ids.length > 2000) throw new AppError(400, 'Coloque no Kanban no máximo 2.000 contatos por vez');
    affected = 0;
    for (const id of ids) {
      const r = await upsertContactCard(accountId, id, d.boardId, d.columnId);
      if ('error' in r) throw new AppError(404, r.error ?? 'Quadro ou coluna não encontrados');
      if (r.created || r.moved) affected += 1;
    }
  } else if (d.action === 'delete') {
    await db.delete(schema.contacts).where(and(eq(schema.contacts.accountId, accountId), inArray(schema.contacts.id, ids)));
  }
  res.json({ affected });
}));

/* ------------------------------------------------------- contato (CRUD) */

const contactBody = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(120),
  phone: z.string().trim().min(5, 'Informe o telefone').max(40),
  email: z.string().trim().max(160).optional().nullable(),
  stage: z.enum(STAGES).optional(),
  tags: z.array(z.string()).max(30).optional(),
  value: z.number().nonnegative().max(100_000_000).optional(),
  notes: z.string().max(5000).optional().nullable(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

async function ownContact(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Contato não encontrado');
  const [c] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, id), eq(schema.contacts.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Contato não encontrado');
  return c;
}

const publicContact = (c: ContactRow) => ({ ...c, value: Number(c.value) });

contactsRouter.post('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const d = contactBody.parse(req.body);
  const phone = normalizePhone(d.phone);
  if (!phone) throw new AppError(400, 'Telefone inválido: use DDD + número (ex.: 11 98888-7777) ou o número com DDI');
  const email = d.email?.trim() || null;
  if (email && !isEmail(email)) throw new AppError(400, 'E-mail inválido');
  const dup = await findContactByPhone(accountId, phone);
  if (dup) { res.status(409).json({ error: `Já existe um contato com esse telefone: ${dup.name}`, contactId: dup.id, contactName: dup.name }); return; }
  const fields = await fieldsOf(accountId);
  const custom = applyCustom({}, cleanCustom(fields, d.custom, true));
  const tags = cleanTags(d.tags) ?? [];
  const [row] = await db.insert(schema.contacts).values({
    accountId, name: d.name, phone, waId: phone, email, stage: d.stage, tags, value: (d.value ?? 0).toFixed(2),
    notes: d.notes?.trim() ? d.notes : null, custom, origin: 'manual',
  }).returning();
  await ensureTags(accountId, tags);
  res.status(201).json({ contact: publicContact(row) });
}));

/** Detalhe: contato + conversa + vendas + resumo de compras. */
contactsRouter.get('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const c = await ownContact(accountId, req.params.id);
  const [[conv], sales, [conn]] = await Promise.all([
    rows(sql`select v.id, v.status, v.unread_count as "unreadCount", ${iso('v.last_message_at')} as "lastMessageAt", u.name as "assignedName"
      from conversations v left join users u on u.id = v.assigned_user_id where v.contact_id = ${c.id} order by v.last_message_at desc limit 1`),
    db.select({
      id: schema.sales.id, amount: schema.sales.amount, currency: schema.sales.currency, status: schema.sales.status,
      productName: schema.sales.productName, createdAt: schema.sales.createdAt,
    }).from(schema.sales).where(and(eq(schema.sales.accountId, accountId), eq(schema.sales.contactId, c.id))).orderBy(desc(schema.sales.createdAt)).limit(30),
    c.firstConnectionId
      ? db.select({ name: schema.connections.name }).from(schema.connections).where(eq(schema.connections.id, c.firstConnectionId)).limit(1)
      : Promise.resolve([] as { name: string }[]),
  ]);
  const approved = sales.filter((s) => s.status === 'approved');
  res.json({
    contact: publicContact(c),
    conversation: conv ? { ...conv, unreadCount: Number(conv.unreadCount) } : null,
    sales: sales.map((s) => ({ ...s, amount: Number(s.amount) })),
    purchases: approved.length,
    revenue: Math.round(approved.reduce((a, s) => a + Number(s.amount), 0) * 100) / 100,
    connectionName: conn?.name ?? null,
  });
}));

contactsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const c = await ownContact(accountId, req.params.id);
  const d = contactBody.partial().parse(req.body);
  const patch: Partial<typeof schema.contacts.$inferInsert> = {};
  if (d.name) patch.name = d.name;
  if (d.phone !== undefined) {
    const phone = normalizePhone(d.phone);
    if (!phone) throw new AppError(400, 'Telefone inválido');
    if (phone !== c.phone) {
      const dup = await findContactByPhone(accountId, phone, c.id);
      if (dup) { res.status(409).json({ error: `Já existe um contato com esse telefone: ${dup.name}`, contactId: dup.id }); return; }
      patch.phone = phone; patch.waId = phone;
    }
  }
  if (d.email !== undefined) {
    const email = d.email?.trim() || null;
    if (email && !isEmail(email)) throw new AppError(400, 'E-mail inválido');
    patch.email = email;
  }
  if (d.stage) patch.stage = d.stage;
  if (d.tags) { patch.tags = cleanTags(d.tags); await ensureTags(accountId, patch.tags ?? []); }
  if (d.value !== undefined) patch.value = d.value.toFixed(2);
  if (d.notes !== undefined) patch.notes = d.notes?.trim() ? d.notes : null;
  if (d.custom) patch.custom = applyCustom((c.custom ?? {}) as Record<string, unknown>, cleanCustom(await fieldsOf(accountId), d.custom, true));
  // voltar a receber disparos em massa (ou tirar à mão)
  const opt = (req.body ?? {}).optedOut;
  if (opt === false && c.optedOutAt) patch.optedOutAt = null;
  if (opt === true && !c.optedOutAt) patch.optedOutAt = new Date();
  if (!Object.keys(patch).length) { res.json({ contact: publicContact(c) }); return; }
  const [row] = await db.update(schema.contacts).set(patch).where(eq(schema.contacts.id, c.id)).returning();
  res.json({ contact: publicContact(row) });
}));

/** Exclui o contato (e as conversas dele). As vendas continuam no histórico, sem o vínculo. */
contactsRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores excluem contatos');
  const c = await ownContact(req.accountId!, req.params.id);
  await db.delete(schema.contacts).where(eq(schema.contacts.id, c.id));
  res.status(204).end();
}));
