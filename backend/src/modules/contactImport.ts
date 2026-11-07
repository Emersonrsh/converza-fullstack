import { AppError } from '../utils/http';
import { normHeader, parseCsv, parseMoney } from '../utils/csv';
import { isEmail, normalizePhone, phoneVariants } from '../utils/phone';

/**
 * Parte "pura" dos contatos (sem banco): validação dos campos personalizados, etiquetas
 * e a leitura do CSV de importação — fica separada para ser testada sozinha.
 */

export const MAX_IMPORT_ROWS = 20_000;

/** Definição de campo personalizado (linha de contact_fields). */
export interface FieldDef { key: string; label: string; type: string; options: string[] }

/** Valida e normaliza os valores dos campos personalizados (só chaves que existem). */
export function cleanCustom(fields: FieldDef[], input: Record<string, unknown> | undefined, strict: boolean) {
  const out: Record<string, string | null> = {};
  if (!input) return out;
  for (const [key, raw] of Object.entries(input)) {
    const f = fields.find((x) => x.key === key);
    if (!f) { if (strict) throw new AppError(400, `Campo “${key}” não existe`); continue; }
    const v = raw == null ? '' : String(raw).trim();
    if (!v) { out[key] = null; continue; }
    if (f.type === 'number') {
      const n = parseMoney(v);
      if (Number.isNaN(n)) { if (strict) throw new AppError(400, `${f.label}: número inválido`); continue; }
      out[key] = String(n);
    } else if (f.type === 'date') {
      const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
      const val = br ? `${br[3]}-${br[2]}-${br[1]}` : v;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(val) || Number.isNaN(Date.parse(val))) { if (strict) throw new AppError(400, `${f.label}: data inválida`); continue; }
      out[key] = val;
    } else if (f.type === 'select') {
      const opt = f.options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!opt) { if (strict) throw new AppError(400, `${f.label}: escolha uma das opções`); continue; }
      out[key] = opt;
    } else out[key] = v.slice(0, 500);
  }
  return out;
}

export const applyCustom = (cur: Record<string, unknown>, patch: Record<string, string | null>) => {
  const next: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
};

export const cleanTags = (tags: string[] | undefined) => {
  if (!tags) return undefined;
  const seen = new Set<string>(); const out: string[] = [];
  for (const t of tags.map((x) => x.trim().slice(0, 40)).filter(Boolean)) {
    if (!seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out.slice(0, 30);
};

const HEADER_ALIASES: Record<string, string> = {
  nome: 'name', name: 'name', nomecompleto: 'name', cliente: 'name', contato: 'name',
  telefone: 'phone', phone: 'phone', whatsapp: 'phone', celular: 'phone', fone: 'phone', numero: 'phone', telefonewhatsapp: 'phone', mobile: 'phone',
  email: 'email', emailaddress: 'email', correioeletronico: 'email',
  etiquetas: 'tags', etiqueta: 'tags', tags: 'tags', tag: 'tags',
  etapa: 'stage', etapadofunil: 'stage', stage: 'stage', funil: 'stage',
  valor: 'value', value: 'value', valordanegociacao: 'value',
  anotacoes: 'notes', anotacao: 'notes', notas: 'notes', observacoes: 'notes', observacao: 'notes', obs: 'notes', notes: 'notes',
};
const STAGE_ALIASES: Record<string, string> = {
  novo: 'new', new: 'new', ematendimento: 'in_service', atendimento: 'in_service', inservice: 'in_service',
  negociacao: 'negotiating', negotiating: 'negotiating', ganho: 'won', won: 'won', perdido: 'lost', lost: 'lost',
};

export interface ImportRow { line: number; phone: string; name: string | null; email: string | null; tags: string[]; stage: string | null; value: number | null; notes: string | null; custom: Record<string, string>; }

/** Junta duas linhas do mesmo contato: o que veio preenchido na segunda vence; etiquetas e campos somam. */
export function mergeImportRows(prev: ImportRow, row: ImportRow): ImportRow {
  return {
    ...prev, ...Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== null && v !== '' && k !== 'line' && k !== 'phone')),
    tags: cleanTags([...prev.tags, ...row.tags]) ?? [], custom: { ...prev.custom, ...row.custom },
  } as ImportRow;
}

/** Lê o CSV e devolve as linhas prontas + os erros por linha. */
export function readImport(text: string, fields: FieldDef[], defaultTags: string[]) {
  const table = parseCsv(text);
  if (!table.length) throw new AppError(400, 'O arquivo está vazio');
  const head = table[0].map((h) => normHeader(h));
  const col: Record<string, number> = {};
  const customCol: Record<string, number> = {};
  head.forEach((h, i) => {
    const std = HEADER_ALIASES[h];
    if (std && col[std] === undefined) { col[std] = i; return; }
    const f = fields.find((x) => normHeader(x.label) === h || normHeader(x.key) === h);
    if (f && customCol[f.key] === undefined) customCol[f.key] = i;
  });
  if (col.phone === undefined) throw new AppError(400, 'Não achei a coluna de telefone. Use a planilha modelo (coluna “telefone”).');
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS) throw new AppError(400, `Máximo de ${MAX_IMPORT_ROWS.toLocaleString('pt-BR')} contatos por arquivo`);
  const errors: { line: number; reason: string }[] = [];
  const byPhone = new Map<string, ImportRow>();
  body.forEach((r, i) => {
    const line = i + 2;
    const get = (k: string) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
    const phone = normalizePhone(get('phone'));
    if (!phone) {
      const raw = get('phone');
      errors.push({
        line, reason: !raw ? 'sem telefone'
          : /^\d+([.,]\d+)?e\+?\d+$/i.test(raw) ? `telefone em notação científica (“${raw}”): o Excel converteu o número — formate a coluna “telefone” como Texto e digite de novo`
            : `telefone inválido (“${raw}”)`,
      });
      return;
    }
    const email = get('email');
    if (email && !isEmail(email)) { errors.push({ line, reason: `e-mail inválido (“${email}”)` }); return; }
    const stageRaw = normHeader(get('stage'));
    const stage = stageRaw ? STAGE_ALIASES[stageRaw] ?? null : null;
    if (stageRaw && !stage) { errors.push({ line, reason: `etapa desconhecida (“${get('stage')}”)` }); return; }
    const valueRaw = get('value');
    const value = valueRaw ? parseMoney(valueRaw) : null;
    if (valueRaw && Number.isNaN(value)) { errors.push({ line, reason: `valor inválido (“${valueRaw}”)` }); return; }
    const tagsRow = get('tags') ? get('tags').split(/[,|]/).map((t) => t.trim()).filter(Boolean) : [];
    const rawCustom: Record<string, string> = {};
    for (const [key, idx] of Object.entries(customCol)) { const v = String(r[idx] ?? '').trim(); if (v) rawCustom[key] = v; }
    let custom: Record<string, string> = {};
    try {
      custom = Object.fromEntries(Object.entries(cleanCustom(fields, rawCustom, true)).filter(([, v]) => v !== null)) as Record<string, string>;
    } catch (e) { errors.push({ line, reason: (e as Error).message }); return; }
    const row: ImportRow = {
      line, phone, name: get('name') || null, email: email || null,
      tags: cleanTags(tagsRow.length ? tagsRow : defaultTags) ?? [], stage, value: value as number | null, notes: get('notes') || null, custom,
    };
    // mesmo telefone repetido no arquivo (inclusive com e sem o 9): junta as linhas
    const key = phoneVariants(phone).sort().join('|');
    const prev = byPhone.get(key);
    byPhone.set(key, prev ? mergeImportRows(prev, row) : row);
  });
  return { rows: [...byPhone.values()], errors, total: body.length };
}
