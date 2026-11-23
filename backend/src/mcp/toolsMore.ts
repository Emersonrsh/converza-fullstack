/**
 * Ferramentas MCP de configuração: Converza Members, criar e editar fluxos, agentes de IA e campanhas da Meta.
 * Todas passam pelas mesmas rotas das telas (callRoute), então valem as mesmas regras e limites.
 */
import { z } from 'zod';
import { membersRouter } from '../modules/members';
import { flowsRouter } from '../modules/flows';
import { agentsRouter } from '../modules/agents';
import { metaRouter } from '../modules/meta';
import { autoLayout } from '../flows/aiTools';
import { BLOCK_TYPES, outputsOf } from '../flows/types';
import { settingsRouter } from '../modules/settings';
import { kanbanRouter } from '../modules/kanban';
import { departmentsRouter } from '../modules/departments';
import { pixelsRouter } from '../modules/pixels';
import { connectionsRouter } from '../modules/connections';
import { globalsRouter } from '../modules/globals';
import { contactsRouter } from '../modules/contacts';
import { safeDownload } from '../flows/http';
import { callRoute } from './internal';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { ToolError, type ToolDef } from './tools';

const uuid = (label: string) => z.string({ required_error: `Informe ${label}` }).uuid(`${label} inválido`);
const metaId = (label: string) => z.string({ required_error: `Informe ${label}` }).regex(/^\d{6,30}$/, `${label} inválido (só números)`);
const actId = z.string({ required_error: 'Informe act_id' }).regex(/^act_\d{1,30}$/, 'act_id no formato act_123…');
const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });
const int = (description: string, min?: number, max?: number) => ({ type: 'integer', description, ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) });
const ids = (description: string) => ({ type: 'array', items: { type: 'string', format: 'uuid' }, description });
const r2 = (x: number) => Math.round(x * 100) / 100;
/** blocos por fluxo criado ou editado pelo MCP */
const MCP_MAX_NODES = 200;

/* ============================================================ Converza Members */

async function memberByRef(ctx: Parameters<ToolDef['run']>[0], a: { member_id?: string; phone?: string }) {
  if (a.member_id) return a.member_id;
  const digits = String(a.phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) throw new ToolError('Informe member_id ou phone (com DDD).');
  const r = await callRoute<{ members: { id: string; phone: string | null }[] }>(membersRouter, ctx, 'GET', '/people', { query: { q: digits.slice(-8) } });
  const hit = r.body.members.find((m) => (m.phone ?? '').endsWith(digits.slice(-8)));
  if (!hit) throw new ToolError('Nenhum aluno com esse número (com acesso ativo). Use members_list_people.');
  return hit.id;
}

const MEMBERS: ToolDef[] = [
  {
    name: 'members_list_courses', title: 'Converza Members: listar cursos',
    description: 'Cursos da área de membros com módulos (bloqueio, liberação por dias, bônus, regras de venda), aulas, produto ligado e o endereço da área.',
    group: 'members', write: false, inputSchema: S({}), args: z.object({}),
    async run(ctx) {
      const [list, settings] = await Promise.all([
        callRoute<{ courses: any[] }>(membersRouter, ctx, 'GET', '/courses'),
        callRoute<{ url: string; title: string }>(membersRouter, ctx, 'GET', '/settings'),
      ]);
      const courses = await Promise.all(list.body.courses.slice(0, 30).map(async (c) => {
        const d = await callRoute<{ course: any; modules: any[] }>(membersRouter, ctx, 'GET', `/courses/${c.id}`);
        return {
          id: c.id, title: c.title, description: c.description, published: c.published, product_id: c.productId, product_name: c.productName, members: c.members,
          modules: (d.body.modules ?? []).map((m: any) => ({
            id: m.id, title: m.title, locked: m.locked, unlock_after_days: m.unlockAfterDays, is_bonus: !!m.isBonus,
            unlock_on_sale_of: (m.unlockRules ?? []).map((r: any) => ({ rule_id: r.id, product_id: r.productId, product_name: r.productName })),
            lessons: (m.lessons ?? []).map((l: any) => ({ id: l.id, title: l.title, has_pdf: !!l.hasFile })),
          })),
        };
      }));
      return { result: { area_url: settings.body.url, area_title: settings.body.title, courses }, summary: `${courses.length} curso(s)` };
    },
  },
  {
    name: 'members_save_course', title: 'Converza Members: criar ou editar curso',
    description: 'Cria um curso (sem course_id) ou edita (com course_id). product_id liga o curso a um produto: a venda aprovada desse produto libera o curso sozinha. Curso novo nasce como rascunho; published=true publica.',
    group: 'members', write: true,
    inputSchema: S({ course_id: str('Curso a editar (vazio = criar)', { format: 'uuid' }), title: str('Nome do curso'), description: str('Descrição'), product_id: { type: ['string', 'null'], description: 'Produto que libera o curso na venda aprovada (null desliga)' }, published: bool('Publicado') }),
    args: z.object({ course_id: z.string().uuid().optional(), title: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(), product_id: z.string().uuid().nullable().optional(), published: z.boolean().optional() }),
    async run(ctx, a) {
      const body: Record<string, unknown> = {};
      if (a.title !== undefined) body.title = a.title;
      if (a.description !== undefined) body.description = a.description;
      if (a.product_id !== undefined) body.productId = a.product_id;
      if (a.published !== undefined) body.published = a.published;
      if (!a.course_id) {
        if (!a.title) throw new ToolError('Para criar, informe title.');
        const r = await callRoute<{ course: any }>(membersRouter, ctx, 'POST', '/courses', { body });
        return { result: { course_id: r.body.course.id, title: r.body.course.title, published: r.body.course.published }, summary: `curso criado: ${r.body.course.title}` };
      }
      const r = await callRoute<{ course: any }>(membersRouter, ctx, 'PATCH', `/courses/${a.course_id}`, { body });
      return { result: { course_id: r.body.course.id, title: r.body.course.title, published: r.body.course.published, product_id: r.body.course.productId }, summary: `curso atualizado: ${r.body.course.title}` };
    },
  },
  {
    name: 'members_save_module', title: 'Converza Members: criar ou editar módulo',
    description: 'Cria um módulo num curso (course_id + title) ou edita um existente (module_id). locked=true bloqueia para todos; com unlock_after_days, libera X dias depois da compra. is_bonus=true manda o módulo para a fileira de Bônus.',
    group: 'members', write: true,
    inputSchema: S({ course_id: str('Curso (para criar)', { format: 'uuid' }), module_id: str('Módulo a editar', { format: 'uuid' }), title: str('Nome do módulo'), locked: bool('Bloqueado para todos'), unlock_after_days: { type: ['integer', 'null'], minimum: 1, maximum: 3650, description: 'Libera X dias após a compra (precisa locked=true)' }, is_bonus: bool('É bônus') }),
    args: z.object({ course_id: z.string().uuid().optional(), module_id: z.string().uuid().optional(), title: z.string().trim().min(1).max(120).optional(), locked: z.boolean().optional(), unlock_after_days: z.number().int().min(1).max(3650).nullable().optional(), is_bonus: z.boolean().optional() }),
    async run(ctx, a) {
      let id = a.module_id as string | undefined;
      if (!id) {
        if (!a.course_id || !a.title) throw new ToolError('Para criar, informe course_id e title.');
        id = (await callRoute<{ module: any }>(membersRouter, ctx, 'POST', `/courses/${a.course_id}/modules`, { body: { title: a.title } })).body.module.id;
      }
      const patch: Record<string, unknown> = {};
      if (a.module_id && a.title !== undefined) patch.title = a.title;
      if (a.locked !== undefined) patch.locked = a.locked;
      if (a.unlock_after_days !== undefined) { patch.unlockAfterDays = a.unlock_after_days; if (a.unlock_after_days && a.locked === undefined) patch.locked = true; }
      if (a.is_bonus !== undefined) patch.isBonus = a.is_bonus;
      if (Object.keys(patch).length) await callRoute(membersRouter, ctx, 'PATCH', `/modules/${id}`, { body: patch });
      return { result: { module_id: id, created: !a.module_id, ...patch }, summary: a.module_id ? 'módulo atualizado' : 'módulo criado' };
    },
  },
  {
    name: 'members_add_lesson', title: 'Converza Members: criar aula',
    description: 'Cria uma aula num módulo. pdf_url (https, até 100 MB) baixa o PDF e anexa à aula; sem pdf_url a aula fica sem material até alguém subir o PDF no painel.',
    group: 'members', write: true,
    inputSchema: S({ module_id: str('Módulo', { format: 'uuid' }), title: str('Nome da aula'), description: str('Descrição'), pdf_url: str('Link público do PDF (https)') }, ['module_id', 'title']),
    args: z.object({ module_id: uuid('module_id'), title: z.string().trim().min(1).max(160), description: z.string().max(2000).optional(), pdf_url: z.string().url().max(2000).optional() }),
    async run(ctx, a) {
      const l = (await callRoute<{ lesson: any }>(membersRouter, ctx, 'POST', `/modules/${a.module_id}/lessons`, { body: { title: a.title, description: a.description ?? null } })).body.lesson;
      let pdf: { fileName: string; fileSize: number } | null = null;
      if (a.pdf_url) {
        if (!/^https:\/\//i.test(a.pdf_url)) throw new ToolError(`Aula criada (${l.id}), mas o pdf_url precisa começar com https://`);
        let file;
        try { file = await safeDownload(a.pdf_url, 100 * 1024 * 1024); } catch (e) { throw new ToolError(`Aula criada (${l.id}), mas o PDF não veio: ${(e as Error).message}`); }
        if (file.data.subarray(0, 4).toString() !== '%PDF') throw new ToolError(`Aula criada (${l.id}), mas o link não é um PDF.`);
        const name = /\.pdf$/i.test(file.fileName) ? file.fileName : `${a.title}.pdf`;
        const up = await callRoute<{ lesson: any }>(membersRouter, ctx, 'POST', `/lessons/${l.id}/file`, { stream: { data: file.data, type: 'application/pdf', headers: { 'x-file-name': encodeURIComponent(name) } } });
        pdf = { fileName: up.body.lesson.fileName, fileSize: up.body.lesson.fileSize };
      }
      return { result: { lesson_id: l.id, title: l.title, pdf }, summary: pdf ? 'aula criada com PDF' : 'aula criada' };
    },
  },
  {
    name: 'members_unlock_rule', title: 'Converza Members: regra de venda que libera módulo',
    description: 'Liga (ou remove, com rule_id) a regra "venda aprovada do produto X libera o módulo Y" para o comprador — ideal para upsell e order bump. apply_past libera também para quem já comprou, sem mensagem.',
    group: 'members', write: true,
    inputSchema: S({ module_id: str('Módulo', { format: 'uuid' }), product_id: str('Produto', { format: 'uuid' }), apply_past: bool('Liberar para quem já comprou'), rule_id: str('Regra a remover', { format: 'uuid' }) }),
    args: z.object({ module_id: z.string().uuid().optional(), product_id: z.string().uuid().optional(), apply_past: z.boolean().optional(), rule_id: z.string().uuid().optional() }),
    async run(ctx, a) {
      if (a.rule_id) { await callRoute(membersRouter, ctx, 'DELETE', `/rules/${a.rule_id}`); return { result: { removed: true }, summary: 'regra removida' }; }
      if (!a.module_id || !a.product_id) throw new ToolError('Informe module_id e product_id (ou rule_id para remover).');
      const r = await callRoute<{ rule: any; applied: number }>(membersRouter, ctx, 'POST', `/modules/${a.module_id}/rules`, { body: { productId: a.product_id, applyPast: !!a.apply_past } });
      return { result: { rule_id: r.body.rule.id, product_name: r.body.rule.productName, applied_to_past_buyers: r.body.applied }, summary: 'regra criada' };
    },
  },
  {
    name: 'members_list_people', title: 'Converza Members: listar alunos',
    description: 'Alunos com acesso ativo: nome, WhatsApp, e-mail, cursos, progresso e origem do acesso (venda, manual, fluxo). Filtra por nome/telefone/e-mail ou curso.',
    group: 'members', write: false,
    inputSchema: S({ q: str('Busca'), course_id: str('Curso', { format: 'uuid' }) }),
    args: z.object({ q: z.string().max(80).optional(), course_id: z.string().uuid().optional() }),
    async run(ctx, a) {
      const r = await callRoute<{ members: any[] }>(membersRouter, ctx, 'GET', '/people', { query: { ...(a.q ? { q: a.q } : {}), ...(a.course_id ? { courseId: a.course_id } : {}) } });
      const people = r.body.members.slice(0, 100).map((m) => ({ member_id: m.id, name: m.name, phone: m.phone, email: m.email, last_login_at: m.lastLoginAt, courses: (m.courses ?? []).map((c: any) => ({ course_id: c.courseId, title: c.title, source: c.source, since: c.since, lessons_done: Number(c.done), lessons_total: Number(c.total) })) }));
      return { result: { total: r.body.members.length, people }, summary: `${people.length} aluno(s)` };
    },
  },
  {
    name: 'members_grant_access', title: 'Converza Members: liberar cursos para um número',
    description: 'Libera cursos para um WhatsApp sem venda (o número vira o login). notify=true manda o link de acesso pelo WhatsApp (se houve conversa nas últimas 24h) ou e-mail.',
    group: 'members', write: true,
    inputSchema: S({ phone: str('WhatsApp com DDD (e DDI se não for Brasil)'), name: str('Nome'), course_ids: ids('Cursos'), notify: bool('Mandar o link de acesso') }, ['phone', 'course_ids']),
    args: z.object({ phone: z.string().min(8).max(30), name: z.string().max(120).optional(), course_ids: z.array(z.string().uuid()).min(1).max(30), notify: z.boolean().optional() }),
    async run(ctx, a) {
      const r = await callRoute<any>(membersRouter, ctx, 'POST', '/people', { body: { phone: a.phone, name: a.name, courseIds: a.course_ids, notify: !!a.notify } });
      return { result: { member_id: r.body.memberId, granted: r.body.granted, already_had: r.body.already, notified: r.body.notified }, summary: `acesso liberado a ${r.body.granted?.length ?? 0} curso(s)` };
    },
  },
  {
    name: 'members_revoke_access', title: 'Converza Members: tirar acesso',
    description: 'Tira o acesso de um aluno (member_id ou phone): aos cursos de course_ids, ou a todos se course_ids vier vazio. O aluno não recebe aviso.',
    group: 'members', write: true,
    inputSchema: S({ member_id: str('Aluno', { format: 'uuid' }), phone: str('WhatsApp do aluno'), course_ids: ids('Cursos (vazio = todos)') }),
    args: z.object({ member_id: z.string().uuid().optional(), phone: z.string().max(30).optional(), course_ids: z.array(z.string().uuid()).max(30).optional() }),
    async run(ctx, a) {
      const mid = await memberByRef(ctx, a);
      if (!a.course_ids?.length) {
        const r = await callRoute<{ revoked: number }>(membersRouter, ctx, 'DELETE', `/people/${mid}/access`);
        return { result: { member_id: mid, revoked: r.body.revoked }, summary: 'acesso bloqueado' };
      }
      const list = await callRoute<{ members: any[] }>(membersRouter, ctx, 'GET', '/people');
      const m = list.body.members.find((x) => x.id === mid);
      const acc = (m?.courses ?? []).filter((c: any) => a.course_ids!.includes(c.courseId));
      for (const c of acc) await callRoute(membersRouter, ctx, 'DELETE', `/access/${c.accessId}`);
      return { result: { member_id: mid, revoked: acc.length }, summary: `${acc.length} acesso(s) retirado(s)` };
    },
  },
  {
    name: 'members_set_member_module', title: 'Converza Members: módulo de um aluno',
    description: 'Libera ou bloqueia um módulo só para um aluno, ou volta à regra do módulo (state "rule"). Vence a regra geral do módulo.',
    group: 'members', write: true,
    inputSchema: S({ member_id: str('Aluno', { format: 'uuid' }), phone: str('WhatsApp do aluno'), module_id: str('Módulo', { format: 'uuid' }), state: { type: 'string', enum: ['unlocked', 'locked', 'rule'] } }, ['module_id', 'state']),
    args: z.object({ member_id: z.string().uuid().optional(), phone: z.string().max(30).optional(), module_id: uuid('module_id'), state: z.enum(['unlocked', 'locked', 'rule']) }),
    async run(ctx, a) {
      const mid = await memberByRef(ctx, a);
      await callRoute(membersRouter, ctx, 'PUT', `/people/${mid}/modules/${a.module_id}`, { body: { state: a.state === 'rule' ? null : a.state } });
      return { result: { member_id: mid, module_id: a.module_id, state: a.state }, summary: `módulo: ${a.state}` };
    },
  },
];

/* ============================================================ Fluxos */

/** Formato de cada bloco (os mesmos campos que o editor salva) e as saídas que cada um tem. */
const BLOCK_SHAPES: Record<string, { data: Record<string, unknown>; outputs: string; note?: string }> = {
  trigger: { data: { type: 'any_message | keyword | first_message | webhook | ad_click | tag_added', keywords: 'palavra1, palavra2', match: 'contains | exact', connectionId: '', webhookId: '', reentry: 'always | once | cooldown', cooldownHours: 24 }, outputs: 'null', note: 'Exatamente um, com id "trigger".' },
  message: { data: { items: [{ type: 'text', text: 'Olá {{primeiro_nome}}', typingSeconds: 3 }, { type: 'interval', mode: 'fixed | random', seconds: 5 }, { type: 'image | video | audio | file | sticker', fileId: '<arquivo já enviado>', url: '<ou link público>', filename: 'nome.pdf', caption: '', recordingSeconds: 5 }, { type: 'contact', name: '', phone: '' }] }, outputs: 'null', note: 'Mídia sem fileId nem url não é enviada: o usuário anexa no editor.' },
  template: { data: { connectionId: '', name: '<modelo aprovado>', language: 'pt_BR', paramFormat: 'positional', bodyText: '', bodyVars: [], vars: {}, headerFormat: '', headerVar: '', headerText: '', headerMediaUrl: '', buttons: [], buttonValues: {}, timeoutAmount: 60, timeoutUnit: 'minutes' }, outputs: 'null; ou, se espera resposta: ids dos botões, "replied", "timeout"' },
  tags: { data: { mode: 'add | remove', tags: ['Comprou'] }, outputs: 'null' },
  pix: { data: { keyType: 'evp | cpf | cnpj | email | phone', key: '', merchantName: '', amount: '47,00', text: '', imageUrl: '', imageFileId: '', imageName: '' }, outputs: 'null' },
  menu: { data: { style: 'list | buttons', text: '', buttonLabel: 'Ver opções', expireAmount: 0, expireUnit: 'minutes | hours | days', options: [{ id: 'opt_1', title: 'Opção', description: '' }], saveAs: '', invalidText: '', maxRetries: 1 }, outputs: 'ids das opções, "fallback" e (com expireAmount > 0) "timeout"' },
  carousel: { data: { expireAmount: 0, expireUnit: 'days', text: '', cards: [{ id: 'card_1', text: '', imageUrl: '', imageFileId: '', imageName: '', buttons: [{ id: 'btn_1', type: 'reply | url', title: '', url: '' }] }] }, outputs: 'com botões de resposta: ids dos botões, "fallback", "timeout"; senão null' },
  ask: { data: { text: '', saveAs: 'resposta', validation: 'any | email | phone | number | cpf', invalidText: '', maxRetries: 2, waitForever: false, timeoutAmount: 20, timeoutUnit: 'seconds | minutes | hours | days', buffer: false, bufferSeconds: 5, quote: false, react: true, reactEmoji: '❤️' }, outputs: 'null (respondeu), "invalid", "timeout"' },
  chat_status: { data: { status: 'pending | open | resolved', assignUserId: '', pause: true }, outputs: 'null' },
  notify: { data: { name: '', country: '55', phone: '', text: '', templateName: '', templateLanguage: '', templateVarCount: 0, templateParam: '' }, outputs: 'null' },
  condition: { data: { logic: 'all | any', rules: [{ id: 'r1', var: 'comprovante.valor', op: 'eq | neq | gt | gte | lt | lte | contains | not_contains | empty | not_empty | has_tag | not_has_tag', value: '40' }] }, outputs: '"true", "false"' },
  distributor: { data: { mode: 'sticky | round_robin | random', outputs: [{ id: 'out_1', label: 'Saída 1' }, { id: 'out_2', label: 'Saída 2' }] }, outputs: 'ids das saídas' },
  goto_flow: { data: { flowId: '<id do fluxo (flow_resources)>' }, outputs: 'nenhuma (o contato passa para o outro fluxo)' },
  pixel: { data: { platform: 'meta', pixelId: '<id (flow_resources)>', event: 'Purchase | Lead | InitiateCheckout | …', value: '{{comprovante.valor}}', currency: 'BRL', pageId: '' }, outputs: 'null' },
  delay: { data: { mode: 'interval | date | business_hours', amount: 1, unit: 'seconds | minutes | hours | days', date: '', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', useBusinessHours: false }, outputs: 'null' },
  department: { data: { action: 'set | clear', departmentId: '<id (flow_resources)>' }, outputs: 'null' },
  http: { data: { method: 'GET | POST | PUT | PATCH | DELETE', url: '', headersJson: '{}', body: '', mappings: [{ path: 'data.id', var: 'id' }], saveAs: 'http' }, outputs: '"success", "error"' },
  ai: { data: { provider: 'converza', model: '', input: '{{resposta}}', saveAs: '', send: true, prompt: '', audio: false, image: false, pdf: false, detectReceipt: false, receiptOnly: false, validatePixKey: false, pixKeys: [''], validateRecipient: false, recipientNames: [''], validateAmount: false, amountProductId: '<id do produto (flow_resources)>', conditions: [{ id: 'c1', label: '', description: '' }], keepContext: false, contextSize: 5 }, outputs: 'com detectReceipt: "receipt" (mandou comprovante; cria {{comprovante.valor}}, {{comprovante.nome_pagador}}, {{comprovante.currency}}…), "pix_wrong" (com validatePixKey), "name_wrong" (com validateRecipient), "amount_wrong" (com validateAmount: valor fora da faixa do produto); ids das conditions; null (resposta normal); "error"' },
  ai_agent: { data: { action: 'assign | remove', agentId: '<id (flow_resources)>' }, outputs: 'null' },
  kanban: { data: { action: 'add | move | remove', boardId: '<id>', columnId: '<id (flow_resources)>' }, outputs: 'null' },
  set_var: { data: { name: 'variavel', op: 'set | add | subtract | append', value: '' }, outputs: 'null' },
  sale: { data: { productId: '<id (flow_resources)>', customerName: '{{comprovante.nome_pagador}}', amount: '{{comprovante.valor}}', currency: '{{comprovante.currency}}', notifyTitle: '', notifySubtitle: '' }, outputs: 'null' },
  members: { data: { action: 'grant | revoke', courseIds: [], moduleIds: [], courseModules: { '<curso>': ['<módulos liberados na entrega>'] }, unlockRestOnSale: false, unlockRestProductId: '', unlockRestAfter: false, unlockRestDays: 7, sendMessage: true, text: '… {{membros.link}}' }, outputs: 'null' },
  payment: { data: { productId: '', url: '', text: '{{link}}', wait: true, timeoutMinutes: 60 }, outputs: 'com wait: "paid", "unpaid"; senão null' },
  card: { data: { productId: '', amount: '', description: '', text: '{{link}}', wait: true, timeoutMinutes: 60 }, outputs: 'com wait: "paid", "unpaid"; senão null' },
  xpag: { data: { currency: 'MXN', method: 'SPEI', productId: '', amount: '', description: '', text: '{{instrucoes}}', wait: true, timeoutMinutes: 1440 }, outputs: 'com wait: "paid", "unpaid"; senão null' },
  ai_reply: { data: { prompt: '', model: '', useHistory: true, send: true, saveAs: '', fallbackText: '' }, outputs: 'null' },
  ai_classify: { data: { categories: [{ id: 'cat_1', label: '', description: '' }], instructions: '' }, outputs: 'ids das categorias, "none"' },
  media: { data: { mediaType: 'image', url: '', caption: '' }, outputs: 'null', note: 'antigo: prefira message' },
  random: { data: { percentA: 50 }, outputs: '"a", "b"', note: 'antigo: prefira distributor' },
  action: { data: { setStage: '', addTags: [], removeTags: [], setName: '', kanbanBoardId: '', kanbanColumnId: '', setFields: [] }, outputs: 'null', note: 'antigo' },
  handoff: { data: { message: '', assignUserId: '' }, outputs: 'null', note: 'antigo: prefira chat_status' },
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const isId = (v: unknown) => typeof v === 'string' && v.length > 0;

/**
 * Grafo do MCP sem perdas: blocos, campos e ids ficam exatamente como vieram (como o editor salva).
 * O que não dá para salvar com segurança vira ERRO (nada é salvo), nunca descarte silencioso.
 * Referências vazias (produto, pixel, setor…) e mídia sem arquivo viram avisos: o usuário completa no editor.
 */
async function prepareMcpGraph(ctx: Parameters<ToolDef['run']>[0], raw: { nodes: any[]; edges: any[] }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[] = [];
  const label = (n: any) => `bloco "${n?.data?.label || n?.id}" (${n?.type})`;
  const seen = new Set<string>();
  for (const [i, n] of raw.nodes.entries()) {
    if (!n || typeof n !== 'object') { errors.push(`nodes[${i}] não é um objeto`); continue; }
    const id = String(n.id ?? '');
    if (!ID_RE.test(id)) { errors.push(`nodes[${i}]: id "${id}" inválido (use letras, números, _ - . :, até 64)`); continue; }
    if (seen.has(id)) { errors.push(`id repetido: "${id}"`); continue; }
    seen.add(id);
    const type = String(n.type ?? '');
    if (!(BLOCK_TYPES as readonly string[]).includes(type)) { errors.push(`${label(n)}: tipo desconhecido. Tipos válidos: ${BLOCK_TYPES.join(', ')}`); continue; }
    const data = n.data && typeof n.data === 'object' && !Array.isArray(n.data) ? n.data : {};
    if (JSON.stringify(data).length > 100_000) { errors.push(`${label(n)}: dados grandes demais`); continue; }
    const px = Number(n.position?.x), py = Number(n.position?.y);
    nodes.push({ id, type, position: { x: Number.isFinite(px) ? Math.round(px) : NaN, y: Number.isFinite(py) ? Math.round(py) : NaN }, data });
  }
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) errors.push(triggers.length ? `o fluxo tem ${triggers.length} gatilhos (trigger); precisa de exatamente um` : 'falta o bloco trigger');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: { id: string; source: string; target: string; sourceHandle: string | null }[] = [];
  const used = new Set<string>();
  for (const [i, e] of raw.edges.entries()) {
    const src = byId.get(String(e?.source)), dst = byId.get(String(e?.target));
    if (!src || !dst) { errors.push(`edges[${i}]: ${!src ? `origem "${e?.source}"` : `destino "${e?.target}"`} não existe`); continue; }
    if (dst.type === 'trigger') { errors.push(`edges[${i}]: nada pode ligar no trigger`); continue; }
    let h: string | null = e.sourceHandle ?? e.handle ?? null;
    if (h === '' || h === 'out' || h === 'null') h = null;
    const outs = outputsOf(src);
    if (!outs.includes(h)) {
      errors.push(`edges[${i}] ${src.id} → ${dst.id}: a saída "${h ?? 'null'}" não existe em ${label(src)}. Saídas válidas: ${outs.length ? outs.map((x) => x ?? 'null').join(', ') : 'nenhuma'}`);
      continue;
    }
    const key = `${src.id}::${h ?? ''}`;
    if (used.has(key)) { errors.push(`edges[${i}]: a saída "${h ?? 'null'}" de ${label(src)} já está ligada (cada saída liga em um bloco só)`); continue; }
    used.add(key);
    edges.push({ id: String(e.id ?? `e_${src.id}_${h ?? 'out'}_${dst.id}`).slice(0, 120), source: src.id, target: dst.id, sourceHandle: h });
  }
  if (errors.length) throw new ToolError(`Nada foi salvo. Corrija e mande de novo:\n- ${errors.slice(0, 25).join('\n- ')}${errors.length > 25 ? `\n- … e mais ${errors.length - 25}` : ''}`);

  // referências da conta: id inexistente é erro; vazio é aviso (o usuário escolhe no editor)
  const res = await accountResources(ctx);
  const known = {
    product: new Set(res.products.map((x: any) => x.id)), pixel: new Set(res.pixels.map((x: any) => x.id)), department: new Set(res.departments.map((x: any) => x.id)),
    flow: new Set(res.flows.map((x: any) => x.id)), agent: new Set(res.agents.map((x: any) => x.id)),
    board: new Map<string, Set<string>>(res.kanban.map((b: any) => [b.id, new Set<string>(b.columns.map((c: any) => c.id))])),
    course: new Set(res.courses.flatMap((c: any) => [c.id, ...c.modules.map((m: any) => m.id)])),
  };
  const ref = (n: any, field: string, set: Set<unknown>, what: string) => {
    const v = n.data[field];
    if (!isId(v)) warnings.push(`${label(n)}: falta escolher ${what} (complete no editor antes de ativar)`);
    else if (!set.has(v as string)) errors.push(`${label(n)}: ${what} "${v}" não existe na conta (veja flow_resources)`);
  };
  for (const n of nodes) {
    if (n.type === 'sale') ref(n, 'productId', known.product, 'o produto');
    if (n.type === 'pixel') ref(n, 'pixelId', known.pixel, 'o pixel');
    if (n.type === 'department' && n.data.action !== 'clear') ref(n, 'departmentId', known.department, 'o setor');
    if (n.type === 'goto_flow') ref(n, 'flowId', known.flow, 'o fluxo de destino');
    if (n.type === 'ai_agent') ref(n, 'agentId', known.agent, 'o agente');
    if (n.type === 'kanban') {
      const cols = known.board.get(String(n.data.boardId ?? ''));
      if (!isId(n.data.boardId)) warnings.push(`${label(n)}: falta escolher o quadro do Kanban`);
      else if (!cols) errors.push(`${label(n)}: quadro "${n.data.boardId}" não existe (veja flow_resources)`);
      else if (n.data.action !== 'remove' && isId(n.data.columnId) && !cols.has(String(n.data.columnId))) errors.push(`${label(n)}: coluna "${n.data.columnId}" não é desse quadro`);
      else if (n.data.action !== 'remove' && !isId(n.data.columnId)) warnings.push(`${label(n)}: falta escolher a coluna do Kanban`);
    }
    if (n.type === 'members') {
      const all = [...(Array.isArray(n.data.courseIds) ? n.data.courseIds : []), ...(Array.isArray(n.data.moduleIds) ? n.data.moduleIds : [])].map(String);
      const bad = all.filter((x) => !known.course.has(x));
      if (bad.length) errors.push(`${label(n)}: curso/módulo inexistente: ${bad.join(', ')} (veja members_list_courses)`);
      if (!all.length) warnings.push(`${label(n)}: falta escolher o curso`);
    }
    if (n.type === 'message' && Array.isArray(n.data.items)) {
      const missing = n.data.items.filter((it: any) => ['image', 'video', 'audio', 'file', 'sticker'].includes(it?.type) && !it.fileId && !it.url).length;
      if (missing) warnings.push(`${label(n)}: ${missing} arquivo(s) para anexar no editor`);
    }
  }
  if (errors.length) throw new ToolError(`Nada foi salvo. Corrija e mande de novo:\n- ${errors.slice(0, 25).join('\n- ')}`);

  const graph = { nodes, edges };
  if (nodes.some((n) => !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y))) autoLayout(graph as never);
  return { graph, warnings };
}

async function accountResources(ctx: Parameters<ToolDef['run']>[0]) {
  const get = async <T,>(router: any, path: string, pick: (b: any) => T, fallback: T): Promise<T> => {
    try { return pick((await callRoute(router, ctx, 'GET', path)).body); } catch { return fallback; }
  };
  const [products, flows, kanban, departments, pixels, agents, tags, connections, globals, fields, courses] = await Promise.all([
    get(settingsRouter, '/products', (b) => b.products.map((p: any) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, min_price: p.minPrice, max_price: p.maxPrice })), []),
    get(flowsRouter, '/', (b) => b.flows.map((f: any) => ({ id: f.id, name: f.name, status: f.status })), []),
    get(kanbanRouter, '/boards', (b) => b.boards.map((x: any) => ({ id: x.id, name: x.name, columns: (x.columns ?? []).map((c: any) => ({ id: c.id, name: c.name })) })), []),
    get(departmentsRouter, '/', (b) => b.departments.map((d: any) => ({ id: d.id, name: d.name })), []),
    get(pixelsRouter, '/', (b) => b.pixels.map((p: any) => ({ id: p.id, name: p.name, platform: p.platform, status: p.status })), []),
    get(agentsRouter, '/', (b) => b.agents.map((a: any) => ({ id: a.id, name: a.name, enabled: a.enabled })), []),
    get(settingsRouter, '/tags', (b) => b.tags.map((t: any) => t.name), []),
    get(connectionsRouter, '/', (b) => b.connections.map((c: any) => ({ id: c.id, name: c.name, phone: c.displayPhone })), []),
    get(globalsRouter, '/', (b) => b.variables.map((v: any) => v.key), []),
    get(contactsRouter, '/fields', (b) => b.fields.map((f: any) => f.key), []),
    get(membersRouter, '/flow-options', (b) => b.courses, []),
  ]);
  return { products, flows, kanban, departments, pixels, agents, tags, connections, globals, contact_fields: fields, courses };
}

/** Guarda o grafo atual antes de o MCP trocar (as 15 últimas cópias de cada fluxo). */
async function backupFlow(ctx: Parameters<ToolDef['run']>[0], flowId: string): Promise<string> {
  const cur = (await callRoute<{ flow: any }>(flowsRouter, ctx, 'GET', `/${flowId}`)).body.flow;
  const [b] = await db.insert(schema.flowBackups).values({ accountId: ctx.accountId, flowId, name: cur.name, graph: cur.graph }).returning({ id: schema.flowBackups.id });
  await db.execute(sql`delete from flow_backups where flow_id = ${flowId} and id not in (select id from flow_backups where flow_id = ${flowId} order by created_at desc limit 15)`);
  return b.id;
}

const graphArg = z.object({ nodes: z.array(z.any()).min(1).max(MCP_MAX_NODES, `Até ${MCP_MAX_NODES} blocos por fluxo`), edges: z.array(z.any()).max(MCP_MAX_NODES * 4) });

const FLOWS: ToolDef[] = [
  {
    name: 'flow_blocks_reference', title: 'Fluxos: referência dos blocos',
    description: 'Todos os tipos de bloco, os campos de cada um (os mesmos que o editor salva) e as saídas válidas. Leia antes de montar ou editar um fluxo.',
    group: 'flows', write: false, inputSchema: S({}), args: z.object({}),
    async run() {
      return {
        result: {
          format: '{"nodes":[{"id":"trigger","type":"trigger","position":{"x":0,"y":0},"data":{…}},{"id":"m1","type":"message","data":{…}}],"edges":[{"source":"trigger","target":"m1","sourceHandle":null}]}',
          rules: [
            'O grafo é salvo exatamente como vier: ids, campos e variáveis (ex.: {{comprovante.valor}}) não são alterados.',
            'Exatamente um trigger. Cada saída (sourceHandle) liga em um bloco só; null = saída padrão. As saídas válidas de cada bloco estão em "blocks".',
            'Ids de produto, pixel, setor, Kanban, agente, fluxo e curso: pegue em flow_resources. Id que não existe = erro; campo vazio = aviso (o usuário escolhe no editor).',
            'Se qualquer coisa estiver errada, nada é salvo e a resposta lista o que corrigir.',
            'Arquivos: use fileId de um fluxo existente (get_flow) ou url pública; sem os dois, o usuário anexa no editor.',
            'position é opcional; se faltar em algum bloco, o fluxo é organizado sozinho.',
            `Até ${MCP_MAX_NODES} blocos. O fluxo novo nasce em rascunho, a não ser que activate=true.`,
            'Para editar, leia com get_flow, mude o que precisa e mande o grafo inteiro em update_flow (ids iguais preservam o resto).',
          ],
          blocks: BLOCK_SHAPES,
          variables: 'Contato: {{nome}}, {{primeiro_nome}}, {{telefone}}, {{email}}; campos {{campo.<chave>}}; globais {{global.<chave>}}; salvas por blocos (saveAs) e {{comprovante.*}}, {{membros.*}}, {{venda.*}}.',
        },
        summary: 'referência dos blocos',
      };
    },
  },
  {
    name: 'flow_resources', title: 'Fluxos: ids da conta',
    description: 'Ids e nomes para usar nos blocos: produtos, fluxos, quadros e colunas do Kanban, setores, pixels, agentes de IA, etiquetas, números de WhatsApp, variáveis globais, campos do contato e cursos/módulos da Converza Members.',
    group: 'flows', write: false, inputSchema: S({}), args: z.object({}),
    async run(ctx) {
      const r = await accountResources(ctx);
      return { result: r, summary: `${r.products.length} produto(s), ${r.flows.length} fluxo(s), ${r.departments.length} setor(es)` };
    },
  },
  {
    name: 'get_flow', title: 'Fluxos: ver fluxo',
    description: 'O grafo completo de um fluxo, exatamente como está salvo (blocos com posição e todos os campos, conexões), e o status.',
    group: 'flows', write: false,
    inputSchema: S({ flow_id: str('Fluxo', { format: 'uuid' }) }, ['flow_id']), args: z.object({ flow_id: uuid('flow_id') }),
    async run(ctx, a) {
      const f = (await callRoute<{ flow: any }>(flowsRouter, ctx, 'GET', `/${a.flow_id}`)).body.flow;
      return {
        result: { id: f.id, name: f.name, status: f.status, nodes: f.graph.nodes.map((n: any) => ({ id: n.id, type: n.type, position: n.position, data: n.data })), edges: f.graph.edges.map((e: any) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })) },
        summary: `fluxo ${f.name} (${f.graph.nodes.length} blocos)`,
      };
    },
  },
  {
    name: 'create_flow', title: 'Fluxos: criar fluxo',
    description: 'Cria um fluxo com o grafo exatamente como enviado (veja flow_blocks_reference e flow_resources). Se algo estiver errado, nada é salvo e a resposta diz o que corrigir. Nasce em rascunho; activate=true coloca no ar.',
    group: 'flows', write: true,
    inputSchema: S({ name: str('Nome do fluxo'), graph: { type: 'object', description: '{nodes, edges}' }, activate: bool('Ativar já') }, ['name', 'graph']),
    args: z.object({ name: z.string().trim().min(1).max(120), graph: graphArg, activate: z.boolean().optional() }),
    async run(ctx, a) {
      const { graph, warnings } = await prepareMcpGraph(ctx, a.graph);
      const f = (await callRoute<{ flow: any }>(flowsRouter, ctx, 'POST', '/', { body: { name: a.name, graph } })).body.flow;
      if (a.activate) await callRoute(flowsRouter, ctx, 'PUT', `/${f.id}`, { body: { status: 'active' } });
      return { result: { flow_id: f.id, name: f.name, status: a.activate ? 'active' : 'draft', blocks: graph.nodes.length, connections: graph.edges.length, warnings }, summary: `fluxo criado: ${f.name}${warnings.length ? ` (${warnings.length} aviso(s))` : ''}` };
    },
  },
  {
    name: 'update_flow', title: 'Fluxos: editar fluxo',
    description: 'Renomeia, troca o grafo inteiro (salvo exatamente como enviado, mesmo formato do get_flow) ou muda o status (draft, active, paused). Se o grafo tiver erro, nada muda.',
    group: 'flows', write: true,
    inputSchema: S({ flow_id: str('Fluxo', { format: 'uuid' }), name: str('Novo nome'), graph: { type: 'object', description: '{nodes, edges}' }, status: { type: 'string', enum: ['draft', 'active', 'paused'] } }, ['flow_id']),
    args: z.object({ flow_id: uuid('flow_id'), name: z.string().trim().min(1).max(120).optional(), graph: graphArg.optional(), status: z.enum(['draft', 'active', 'paused']).optional() }),
    async run(ctx, a) {
      const body: Record<string, unknown> = {};
      let warnings: string[] = [];
      if (a.name) body.name = a.name;
      if (a.graph) { const p = await prepareMcpGraph(ctx, a.graph); body.graph = p.graph; warnings = p.warnings; }
      if (a.status) body.status = a.status;
      if (!Object.keys(body).length) throw new ToolError('Nada para mudar: informe name, graph ou status.');
      let backupId: string | null = null;
      if (body.graph) backupId = await backupFlow(ctx, a.flow_id);
      const f = (await callRoute<{ flow: any }>(flowsRouter, ctx, 'PUT', `/${a.flow_id}`, { body })).body.flow;
      return { result: { flow_id: f.id, name: f.name, status: f.status, blocks: f.graph?.nodes?.length, warnings, backup_id: backupId }, summary: `fluxo atualizado: ${f.name}${backupId ? ' (cópia anterior guardada)' : ''}` };
    },
  },
  {
    name: 'flow_backups', title: 'Fluxos: cópias anteriores',
    description: 'Lista as cópias que o Converza guarda de um fluxo antes de cada troca de grafo pelo MCP (as 15 últimas) e restaura uma delas (restore_backup_id). Restaurar também guarda uma cópia do estado atual.',
    group: 'flows', write: true,
    inputSchema: S({ flow_id: str('Fluxo', { format: 'uuid' }), restore_backup_id: str('Cópia a restaurar', { format: 'uuid' }) }, ['flow_id']),
    args: z.object({ flow_id: uuid('flow_id'), restore_backup_id: z.string().uuid().optional() }),
    async run(ctx, a) {
      await callRoute(flowsRouter, ctx, 'GET', `/${a.flow_id}`); // confere que o fluxo é da conta
      if (a.restore_backup_id) {
        const [b] = await db.select().from(schema.flowBackups).where(and(eq(schema.flowBackups.id, a.restore_backup_id), eq(schema.flowBackups.flowId, a.flow_id), eq(schema.flowBackups.accountId, ctx.accountId))).limit(1);
        if (!b) throw new ToolError('Cópia não encontrada para esse fluxo.');
        const safety = await backupFlow(ctx, a.flow_id);
        const f = (await callRoute<{ flow: any }>(flowsRouter, ctx, 'PUT', `/${a.flow_id}`, { body: { graph: b.graph, name: b.name } })).body.flow;
        return { result: { flow_id: f.id, restored_from: b.id, restored_at: b.createdAt, blocks: f.graph.nodes.length, backup_of_current: safety }, summary: `fluxo restaurado para ${new Date(b.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` };
      }
      const rows = await db.select({ id: schema.flowBackups.id, name: schema.flowBackups.name, graph: schema.flowBackups.graph, createdAt: schema.flowBackups.createdAt })
        .from(schema.flowBackups).where(and(eq(schema.flowBackups.flowId, a.flow_id), eq(schema.flowBackups.accountId, ctx.accountId))).orderBy(desc(schema.flowBackups.createdAt)).limit(15);
      return { result: { backups: rows.map((r) => ({ backup_id: r.id, name: r.name, blocks: (r.graph as any)?.nodes?.length ?? 0, saved_at: r.createdAt })) }, summary: `${rows.length} cópia(s)` };
    },
  },
];

/* ============================================================ Agentes de IA */

const agentFields = {
  name: z.string().trim().min(1).max(60).optional(), description: z.string().max(240).optional(),
  role: z.enum(['sales', 'support', 'recovery', 'custom']).optional(), enabled: z.boolean().optional(),
  instructions: z.string().max(8000).optional(), tone: z.string().max(1000).optional(), knowledge: z.string().max(30000).optional(),
  faq: z.array(z.object({ q: z.string().max(300), a: z.string().max(1000) })).max(40).optional(), rules: z.string().max(3000).optional(),
  flow_id: z.string().uuid().nullable().optional(), flow_when: z.string().max(500).optional(),
  handoff_when: z.string().max(500).optional(), handoff_message: z.string().max(500).optional(),
  audience: z.enum(['all', 'ads', 'tags']).optional(), audience_tags: z.array(z.string().max(40)).max(30).optional(),
};
const agentProps = {
  name: str('Nome'), description: str('Descrição curta'), role: { type: 'string', enum: ['sales', 'support', 'recovery', 'custom'] }, enabled: bool('Atendendo (cuidado: responde clientes de verdade)'),
  instructions: str('Como atender (instruções)'), tone: str('Jeito de falar'), knowledge: str('O que ele precisa saber (oferta, preços, prazos)'),
  faq: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } }, rules: str('Regras (o que nunca fazer)'),
  flow_id: { type: ['string', 'null'], description: 'Fluxo que o agente dispara (ex.: checkout)' }, flow_when: str('Quando disparar o fluxo'),
  handoff_when: str('Quando passar para a equipe'), handoff_message: str('Mensagem ao passar'),
  audience: { type: 'string', enum: ['all', 'ads', 'tags'], description: 'Quem ele atende' }, audience_tags: { type: 'array', items: { type: 'string' } },
};
function agentBody(a: Record<string, any>) {
  const map: Record<string, string> = { instructions: 'systemPrompt', flow_id: 'flowId', flow_when: 'flowWhen', handoff_when: 'handoffWhen', handoff_message: 'handoffMessage', audience_tags: 'audienceTags' };
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && !['agent_id', 'from_site_url', 'notes'].includes(k)).map(([k, v]) => [map[k] ?? k, v]));
}
const agentView = (x: any) => ({ id: x.id, name: x.name, role: x.role, enabled: x.enabled, description: x.description, audience: x.audience, flow: x.flowName, stats: x.stats });

const AGENTS: ToolDef[] = [
  {
    name: 'list_agents', title: 'Agentes de IA: listar',
    description: 'Agentes de IA da conta: papel, se está atendendo, público, fluxo ligado e números (conversas, vendas).',
    group: 'agents', write: false, inputSchema: S({}), args: z.object({}),
    async run(ctx) {
      const r = await callRoute<{ agents: any[]; limit: any; balance: number }>(agentsRouter, ctx, 'GET', '/');
      return { result: { agents: r.body.agents.map(agentView), limit: r.body.limit, ai_tokens_balance: r.body.balance }, summary: `${r.body.agents.length} agente(s)` };
    },
  },
  {
    name: 'create_agent', title: 'Agentes de IA: criar',
    description: 'Cria um agente de IA com instruções, conhecimento, FAQ e regras. Com from_site_url, a IA da Converza lê o site e monta o agente sozinha (gasta tokens de IA da conta). Nasce desligado, a não ser que enabled=true.',
    group: 'agents', write: true,
    inputSchema: S({ ...agentProps, from_site_url: str('Montar a partir deste site'), notes: str('Observações para montar pelo site') }),
    args: z.object({ ...agentFields, from_site_url: z.string().max(500).optional(), notes: z.string().max(3000).optional() }),
    async run(ctx, a) {
      if (a.from_site_url) {
        const r = await callRoute<{ agent: any; tokens: number }>(agentsRouter, ctx, 'POST', '/build', { body: { source: 'site', url: a.from_site_url, notes: a.notes ?? null, flowId: a.flow_id ?? null } });
        let agent = r.body.agent;
        const extra = agentBody(a);
        delete (extra as Record<string, unknown>).flowId;
        if (Object.keys(extra).length) agent = (await callRoute<{ agent: any }>(agentsRouter, ctx, 'PUT', `/${agent.id}`, { body: extra })).body.agent;
        return { result: { agent: agentView(agent), ai_tokens_used: r.body.tokens }, summary: `agente criado pelo site: ${agent.name}` };
      }
      if (!a.name) throw new ToolError('Informe name (ou from_site_url).');
      const r = await callRoute<{ agent: any }>(agentsRouter, ctx, 'POST', '/', { body: { enabled: false, ...agentBody(a) } });
      return { result: { agent: agentView(r.body.agent) }, summary: `agente criado: ${r.body.agent.name}` };
    },
  },
  {
    name: 'update_agent', title: 'Agentes de IA: editar',
    description: 'Muda instruções, conhecimento, FAQ, regras, público, fluxo ligado ou liga/desliga um agente (enabled).',
    group: 'agents', write: true,
    inputSchema: S({ agent_id: str('Agente', { format: 'uuid' }), ...agentProps }, ['agent_id']),
    args: z.object({ agent_id: uuid('agent_id'), ...agentFields }),
    async run(ctx, a) {
      const body = agentBody(a);
      if (!Object.keys(body).length) throw new ToolError('Nada para mudar.');
      const r = await callRoute<{ agent: any }>(agentsRouter, ctx, 'PUT', `/${a.agent_id}`, { body });
      return { result: { agent: agentView(r.body.agent) }, summary: `agente atualizado: ${r.body.agent.name}` };
    },
  },
];

/* ============================================================ Campanhas (Meta Ads) */

const PERIOD = { type: 'string', enum: ['today', 'yesterday', '7d', '14d', '30d', '90d', 'month', 'last_month', 'custom'], description: 'Período (custom usa from/to AAAA-MM-DD)' };
const periodArgs = { period: z.enum(['today', 'yesterday', '7d', '14d', '30d', '90d', 'month', 'last_month', 'custom']).default('7d'), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() };
const query = (a: Record<string, any>, extra: Record<string, string | undefined> = {}) => Object.fromEntries(Object.entries({ period: a.period, from: a.from, to: a.to, ...extra }).filter(([, v]) => v)) as Record<string, string>;

const ADS: ToolDef[] = [
  {
    name: 'ads_report', title: 'Campanhas: métricas',
    description: 'Métricas das campanhas, conjuntos ou anúncios da Meta no período: gasto, impressões, alcance, frequência, CTR, CPC, CPM, conversas, resultado e custo por resultado, e o que o Converza atribuiu a cada um (leads, vendas, faturamento, ROAS, CPA, lucro). Use act_id/campaign_id/adset_id para descer de nível.',
    group: 'ads', write: false,
    inputSchema: S({ level: { type: 'string', enum: ['campaign', 'adset', 'ad'], default: 'campaign' }, period: PERIOD, from: str('Início (custom)'), to: str('Fim (custom)'), act_id: str('Conta de anúncios (act_…)'), campaign_id: str('Campanha'), adset_id: str('Conjunto') }),
    args: z.object({ level: z.enum(['campaign', 'adset', 'ad']).default('campaign'), ...periodArgs, act_id: actId.optional(), campaign_id: z.string().regex(/^\d{1,30}$/).optional(), adset_id: z.string().regex(/^\d{1,30}$/).optional() }),
    async run(ctx, a) {
      const r = await callRoute<any>(metaRouter, ctx, 'GET', '/manager', { query: query(a, { level: a.level, actId: a.act_id, campaignId: a.campaign_id, adsetId: a.adset_id }) });
      const b = r.body;
      if (!b.accounts?.length) throw new ToolError('Nenhuma conta de anúncios ligada. Conecte em Facebook → Perfis e contas no Converza.');
      const rows = [...b.rows].sort((x: any, y: any) => y.metrics.spend - x.metrics.spend).slice(0, 100).map((x: any) => ({
        id: x.id, level: x.level, name: x.name, act_id: x.actId, currency: x.currency, campaign_id: x.campaignId, adset_id: x.adsetId,
        status: x.status?.label, on: x.configured === 'ACTIVE', objective: x.objective, optimization: x.optimization, budget: x.budget, bid_strategy: x.bidStrategy,
        spend: r2(x.metrics.spend), impressions: x.metrics.impressions, reach: x.metrics.reach, frequency: x.derived.frequency, link_clicks: x.metrics.linkClicks,
        ctr: x.derived.ctr, cpc: x.derived.cpc, cpm: x.derived.cpm, conversations: x.metrics.conversations, cost_per_conversation: x.derived.costPerConversation,
        result: x.result ? { label: x.result.label, value: x.result.value, cost: x.result.cost } : null, hook_rate: x.derived.hookRate,
        converza: x.converza, rankings: x.rankings, flow: x.flow?.name ?? null,
      }));
      return {
        result: { period: b.period, from: b.from, to: b.to, accounts: b.accounts.map((x: any) => ({ act_id: x.actId, name: x.name, currency: x.currency, can_manage: x.canManage })), totals: b.totals, rows, total_rows: b.total, unattributed: b.unmatched, errors: b.errors, profit_settings: b.profit },
        summary: `${rows.length} linha(s) de ${a.level}`,
      };
    },
  },
  {
    name: 'ads_breakdown', title: 'Campanhas: detalhamento',
    description: 'Detalha as métricas por idade, gênero, idade+gênero, país, região, plataforma, posicionamento, dispositivo, dia, semana ou mês (como no Gerenciador da Meta).',
    group: 'ads', write: false,
    inputSchema: S({ by: { type: 'string', enum: ['age', 'gender', 'age_gender', 'country', 'region', 'platform', 'placement', 'device', 'day', 'week', 'month'] }, level: { type: 'string', enum: ['campaign', 'adset', 'ad'] }, period: PERIOD, from: str('Início'), to: str('Fim'), act_id: str('Conta'), campaign_id: str('Campanha'), adset_id: str('Conjunto') }, ['by']),
    args: z.object({ by: z.enum(['age', 'gender', 'age_gender', 'country', 'region', 'platform', 'placement', 'device', 'day', 'week', 'month']), level: z.enum(['campaign', 'adset', 'ad']).default('campaign'), ...periodArgs, act_id: actId.optional(), campaign_id: z.string().regex(/^\d{1,30}$/).optional(), adset_id: z.string().regex(/^\d{1,30}$/).optional() }),
    async run(ctx, a) {
      const r = await callRoute<any>(metaRouter, ctx, 'GET', '/manager/breakdown', { query: query(a, { by: a.by, level: a.level, actId: a.act_id, campaignId: a.campaign_id, adsetId: a.adset_id }) });
      const rows = (r.body.rows ?? []).slice(0, 120).map((x: any) => ({ key: x.key, label: x.label, spend: r2(x.metrics.spend), impressions: x.metrics.impressions, link_clicks: x.metrics.linkClicks, conversations: x.metrics.conversations, purchases: x.metrics.purchases, ctr: x.derived.ctr, cpc: x.derived.cpc, cpm: x.derived.cpm, cost_per_conversation: x.derived.costPerConversation }));
      return { result: { by: a.by, rows, errors: r.body.errors }, summary: `${rows.length} linha(s) por ${a.by}` };
    },
  },
  {
    name: 'ads_set_status', title: 'Campanhas: pausar ou ativar',
    description: 'Pausa ou ativa uma campanha, conjunto ou anúncio na Meta. Precisa do act_id da conta (veja ads_report) e da permissão de gerenciar anúncios no perfil conectado.',
    group: 'ads', write: true,
    inputSchema: S({ object_id: str('ID da campanha, conjunto ou anúncio'), act_id: str('Conta de anúncios (act_…)'), status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } }, ['object_id', 'act_id', 'status']),
    args: z.object({ object_id: metaId('object_id'), act_id: actId, status: z.enum(['ACTIVE', 'PAUSED']) }),
    async run(ctx, a) {
      await callRoute(metaRouter, ctx, 'POST', `/objects/${a.object_id}/status`, { body: { actId: a.act_id, status: a.status } });
      return { result: { object_id: a.object_id, status: a.status }, summary: a.status === 'PAUSED' ? 'pausado na Meta' : 'ativado na Meta' };
    },
  },
  {
    name: 'ads_set_budget', title: 'Campanhas: mudar orçamento',
    description: 'Muda o orçamento diário ou total de uma campanha (orçamento da campanha) ou conjunto, na moeda da conta (ex.: 50 = R$ 50,00). Mude aos poucos (até ~20% por vez) para não reiniciar o aprendizado.',
    group: 'ads', write: true,
    inputSchema: S({ object_id: str('ID da campanha ou conjunto que tem o orçamento'), act_id: str('Conta de anúncios (act_…)'), kind: { type: 'string', enum: ['daily', 'lifetime'] }, amount: { type: 'number', minimum: 1, description: 'Valor na moeda da conta' } }, ['object_id', 'act_id', 'kind', 'amount']),
    args: z.object({ object_id: metaId('object_id'), act_id: actId, kind: z.enum(['daily', 'lifetime']), amount: z.number().positive().max(10_000_000) }),
    async run(ctx, a) {
      await callRoute(metaRouter, ctx, 'POST', `/objects/${a.object_id}/budget`, { body: { actId: a.act_id, kind: a.kind, amount: a.amount } });
      return { result: { object_id: a.object_id, kind: a.kind, amount: a.amount }, summary: `orçamento ${a.kind === 'daily' ? 'diário' : 'total'}: ${a.amount}` };
    },
  },
];

export const MORE_TOOLS: ToolDef[] = [...MEMBERS, ...FLOWS, ...AGENTS, ...ADS];
