import { Router, type Request } from 'express';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { asyncHandler, AppError, isUuid, publicBase } from '../utils/http';
import { emitToAccount } from '../realtime/io';
import { WhatsAppError, listTemplates, onConnectionIssue } from '../whatsapp/cloud-api';
import { maybeAlertInstance } from './instanceAlerts';
import {
  exchangeCodeForToken, getBusinessProfile, getPhoneHealth, registerPhone, requestSmbSync, subscribeAppToWaba,
  tokenAppId, updateBusinessProfile, wabaPhoneNumbers, wabaSubscriptions,
} from '../whatsapp/graph';
import { errorPatch, healthPatch } from '../whatsapp/health';
import { emitConnection, publicConnection, type ConnRow } from './connectionView';
import { connectionLimitFor } from './plans';
import { WEB_PREFIX } from '../whatsapp/web/convert';
/** sessões do QR Code (carregado só quando usado: importar este módulo não abre conexões) */
const qr = () => import('../whatsapp/web/manager');

/**
 * Conexões de WhatsApp (Cloud API oficial): limite do plano, Meta em 1 clique (Embedded Signup),
 * WhatsApp Business do celular (coexistência), conexão manual, saúde do número, perfil e registro.
 */
export const connectionsRouter = Router();

const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Apenas donos e administradores mexem nas conexões');
}

/* -------------------------------------------------------------- plano */

export { connectionLimitFor };

async function planInfo(accountId: string) {
  const [sub] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.accountId, accountId)).limit(1);
  const active = sub?.status === 'active';
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.connections).where(eq(schema.connections.accountId, accountId));
  const instances = sub?.instances ?? 0;
  // redução agendada para a próxima renovação: já não dá para conectar além dela
  const scheduled = active && sub?.pendingInstances != null && sub.pendingInstances < instances ? sub.pendingInstances : null;
  return { active, status: sub?.status ?? 'inactive', instances, scheduledInstances: scheduled, max: connectionLimitFor(scheduled ?? instances, active), used: Number(n) };
}

async function assertRoom(accountId: string) {
  const p = await planInfo(accountId);
  if (!p.active) throw new AppError(403, 'Sua assinatura está inativa. Assine para conectar um número de WhatsApp.', { code: 'no_plan', plan: p });
  if (p.max !== null && p.used >= p.max) {
    if (p.scheduledInstances !== null) {
      throw new AppError(403, `Você agendou a redução para ${p.scheduledInstances} ${p.scheduledInstances === 1 ? 'instância' : 'instâncias'} na próxima renovação e já usa ${p.used}. Desfaça a redução em Cobranças e assinaturas para conectar outro número.`, { code: 'connection_limit', plan: p });
    }
    throw new AppError(403, `Você contratou ${p.max} ${p.max === 1 ? 'instância' : 'instâncias'} e já usa ${p.used}. Contrate mais instâncias em Cobranças e assinaturas para conectar outro número.`, { code: 'connection_limit', plan: p });
  }
}

/** O mesmo número não pode estar em duas contas (as mensagens iriam para a primeira). */
async function assertFreeNumber(accountId: string, phoneNumberId: string, exceptId?: string) {
  const list = await db.select({ id: schema.connections.id, accountId: schema.connections.accountId, name: schema.connections.name })
    .from(schema.connections).where(eq(schema.connections.phoneNumberId, phoneNumberId));
  const other = list.find((c) => c.id !== exceptId);
  if (!other) return;
  if (other.accountId === accountId) throw new AppError(409, `Esse número já está conectado aqui como “${other.name}”.`, { connectionId: other.id });
  throw new AppError(409, 'Esse número já está conectado em outra conta do Converza.');
}

/* ------------------------------------------------------------- formato */

export { publicConnection };

async function ownConnection(accountId: string, id: string) {
  if (!isUuid(id)) throw new AppError(404, 'Conexão não encontrada');
  const [c] = await db.select().from(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.accountId, accountId))).limit(1);
  if (!c) throw new AppError(404, 'Conexão não encontrada');
  return c;
}

const emit = emitConnection;

/* --------------------------------------------------------------- saúde */

/** Consulta a Meta e grava a saúde do número. Não lança: problemas viram `lastError`. */
export async function checkConnection(c: ConnRow): Promise<ConnRow> {
  // QR Code: a saúde é a própria sessão (aberta ou não) — não há o que perguntar para a Meta
  if (c.provider === 'web') return c;
  const patch: Partial<typeof schema.connections.$inferInsert> = { lastCheckedAt: new Date() };
  if (!c.phoneNumberId || !c.accessToken) {
    Object.assign(patch, { status: 'pending', lastError: 'Falta o Phone Number ID ou o token desta conexão.' });
  } else {
    try {
      Object.assign(patch, healthPatch(await getPhoneHealth(c.phoneNumberId, c.accessToken)));
    } catch (err) {
      const e = err as WhatsAppError;
      Object.assign(patch, errorPatch({ code: e.code ?? null, message: e.message }));
    }
    if (c.wabaId && patch.status !== 'disconnected') {
      try {
        const apps = await wabaSubscriptions(c.wabaId, c.accessToken);
        patch.webhookSubscribed = c.source !== 'manual' && config.whatsapp.appId ? apps.some((a) => a.id === config.whatsapp.appId) : apps.length > 0;
      } catch { /* mantém o que sabia */ }
    }
  }
  const [row] = await db.update(schema.connections).set(patch).where(eq(schema.connections.id, c.id)).returning();
  if (row) {
    emit(row);
    void maybeAlertInstance(c, row).catch((err) => console.error('[conexões] aviso por e-mail:', (err as Error).message));
  }
  return row ?? c;
}

const inflight = new Set<string>();
/** Verifica em segundo plano as conexões que não são checadas há um tempo. */
function refreshStale(list: ConnRow[], maxAgeMs = 30 * 60_000) {
  const now = Date.now();
  for (const c of list) {
    if (c.provider === 'web' || !c.accessToken || !c.phoneNumberId || inflight.has(c.id)) continue;
    if (c.lastCheckedAt && now - c.lastCheckedAt.getTime() < maxAgeMs) continue;
    inflight.add(c.id);
    checkConnection(c).catch(() => {}).finally(() => inflight.delete(c.id));
  }
}

/** A cada 30 min, confere os números que não são verificados há 3 h (status sempre atualizado). */
export function startConnectionHealthSweep() {
  const run = async () => {
    try {
      const stale = await db.select().from(schema.connections)
        .where(or(isNull(schema.connections.lastCheckedAt), lt(schema.connections.lastCheckedAt, new Date(Date.now() - 3 * 3600_000)))).limit(200);
      for (const c of stale) if (c.provider !== 'web' && c.accessToken && c.phoneNumberId) await checkConnection(c);
    } catch (err) { console.error('[conexões] verificação periódica:', (err as Error).message); }
  };
  setInterval(run, 30 * 60_000).unref();
}

// envio falhou por token/bloqueio/registro → marca a conexão na hora
onConnectionIssue((phoneNumberId, message, code) => {
  void (async () => {
    const p = errorPatch({ code, message });
    const before = await db.select().from(schema.connections).where(eq(schema.connections.phoneNumberId, phoneNumberId));
    const updated = await db.update(schema.connections)
      .set({ ...(p.status ? { status: p.status } : {}), lastError: p.lastError, lastCheckedAt: new Date() })
      .where(eq(schema.connections.phoneNumberId, phoneNumberId)).returning();
    updated.forEach(emit);
    for (const u of updated) await maybeAlertInstance(before.find((b) => b.id === u.id) ?? null, u);
  })().catch((err) => console.error('[conexões] marcar problema:', (err as Error).message));
});

/* ================================================================ rotas */

/** Config pública do Embedded Signup para o frontend montar o botão da Meta. */
connectionsRouter.get('/embedded-signup/config', (_req, res) => {
  const configured = Boolean(config.whatsapp.appId && config.whatsapp.configId);
  res.json({ configured, appId: config.whatsapp.appId, configId: config.whatsapp.configId, graphVersion: config.whatsapp.graphVersion });
});

connectionsRouter.get('/', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const list = await db.select().from(schema.connections).where(eq(schema.connections.accountId, accountId)).orderBy(asc(schema.connections.createdAt));
  const ids = list.map((c) => c.id);
  const convs = ids.length ? await rows<{ connectionId: string; n: string }>(sql`
    select connection_id as "connectionId", count(*) as n from conversations
    where account_id = ${accountId} and connection_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) group by connection_id`) : [];
  const plan = await planInfo(accountId);
  refreshStale(list);
  const manager = req.role !== 'agent';
  res.json({
    connections: list.map((c) => ({ ...publicConnection(c), conversations: Number(convs.find((x) => x.connectionId === c.id)?.n ?? 0) })),
    counts: { connected: list.filter((c) => c.status === 'connected').length, disconnected: list.filter((c) => c.status !== 'connected').length },
    plan,
    signup: { configured: Boolean(config.whatsapp.appId && config.whatsapp.configId), appId: config.whatsapp.appId, configId: config.whatsapp.configId, graphVersion: config.whatsapp.graphVersion },
    webhook: manager ? { url: `${publicBase(req, config.publicApiUrl)}/api/v1/webhooks/whatsapp`, verifyToken: config.whatsapp.verifyToken, signatureCheck: Boolean(config.whatsapp.appSecret) } : null,
    qrCode: {
      enabled: config.waWeb.enabled, simulator: config.waWeb.driver === 'mock',
      dispatch: { minGapSec: config.waWeb.dispatchMinGapSec, maxGapSec: config.waWeb.dispatchMaxGapSec, dailyLimit: config.waWeb.dailyLimit },
    },
  });
}));

/* ------------------------------------------------- QR Code (API não oficial) */

function assertWebEnabled() {
  if (!config.waWeb.enabled) throw new AppError(403, 'A conexão por QR Code está desligada neste servidor (WA_WEB_ENABLED=false).');
}

const webCreateSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a conexão').max(60),
  /** o dono confirma que leu o aviso de risco (API não oficial) */
  acceptRisk: z.literal(true, { errorMap: () => ({ message: 'Confirme que entendeu os riscos da conexão por QR Code.' }) }),
  phone: z.string().trim().max(30).optional(),
});
const phoneOk = (p?: string) => {
  const d = (p ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length < 10 || d.length > 15) throw new AppError(422, 'Digite o número com DDI e DDD, ex.: 55 11 99999-0000');
  return d;
};

/**
 * Cria a conexão e liga a sessão: o QR Code chega pela tela (evento wa:qr) ou por GET /:id/web.
 * Com `phone`, gera também o código de pareamento (para digitar no celular em vez de ler o QR).
 */
connectionsRouter.post('/web', asyncHandler(async (req, res) => {
  managerOnly(req);
  assertWebEnabled();
  const accountId = req.accountId!;
  const p = webCreateSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  const pairingPhone = phoneOk(p.data.phone);
  await assertRoom(accountId);
  const [created] = await db.insert(schema.connections).values({
    accountId, name: p.data.name, provider: 'web', source: 'web', status: 'pending', webState: 'starting', accessToken: 'web', phoneNumberId: null,
  }).returning();
  const [row] = await db.update(schema.connections).set({ phoneNumberId: `${WEB_PREFIX}${created.id}` }).where(eq(schema.connections.id, created.id)).returning();
  emit(row);
  try { await (await qr()).webStart(row.id, { pairingPhone, fresh: true }); } catch (err) {
    await db.update(schema.connections).set({ lastError: (err as Error).message }).where(eq(schema.connections.id, row.id));
  }
  res.status(201).json({ connection: publicConnection(row) });
}));

async function ownWeb(req: Request) {
  const c = await ownConnection(req.accountId!, req.params.id);
  if (c.provider !== 'web') throw new AppError(422, 'Esta conexão é da API oficial da Meta (não usa QR Code).');
  return c;
}

/** Estado da sessão e o QR Code/código atual (a tela consulta enquanto espera a leitura). */
connectionsRouter.get('/:id/web', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownWeb(req);
  const st = await (await qr()).webStatus(c.id);
  res.json({ connection: publicConnection(c), ...st });
}));

/** Novo QR Code (ou código de pareamento, com `phone`) — também serve para reconectar. */
connectionsRouter.post('/:id/web/start', asyncHandler(async (req, res) => {
  managerOnly(req);
  assertWebEnabled();
  const c = await ownWeb(req);
  const { phone } = z.object({ phone: z.string().trim().max(30).optional() }).parse(req.body ?? {});
  const pairingPhone = phoneOk(phone);
  const { hasSession } = await import('../whatsapp/web/auth');
  const paired = await hasSession(c.id);
  // aparelho pareado e sessão caída: só religa (sem QR). Sem pareamento: QR/código novo.
  const m = await qr();
  try { await m.webStart(c.id, { pairingPhone, fresh: !paired || !!pairingPhone }); } catch (err) {
    throw new AppError(503, (err as Error).message);
  }
  const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, c.id)).limit(1);
  res.json({ connection: publicConnection(row ?? c), ...(await m.webStatus(c.id)) });
}));

/** Desconecta o aparelho (some de "Aparelhos conectados" no celular). A conexão continua, para ler o QR de novo. */
connectionsRouter.post('/:id/web/logout', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownWeb(req);
  await (await qr()).webLogout(c.id);
  const [row] = await db.update(schema.connections).set({ status: 'disconnected', webState: 'logged_out', lastError: 'Desconectado por você no Converza. Leia o QR Code para conectar de novo.' })
    .where(eq(schema.connections.id, c.id)).returning();
  emit(row);
  res.json({ connection: publicConnection(row) });
}));

/* ---------------------------------------------------------- manual */

const manualSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a conexão').max(60),
  phoneNumberId: z.string().trim().regex(/^\d{6,20}$/, 'O Phone Number ID tem só números (veja em Meta for Developers › WhatsApp › Configuração da API)'),
  wabaId: z.string().trim().regex(/^\d{6,20}$/, 'O WABA ID tem só números').optional().or(z.literal('')),
  accessToken: z.string().trim().min(20, 'Cole o token de acesso completo'),
  appSecret: z.string().trim().max(100).optional().or(z.literal('')),
});

function zodMsg(e: z.ZodError) {
  const i = e.issues[0];
  return i?.message && !/^(Expected|Invalid|String must|Required)/.test(i.message) ? i.message : `Campo inválido: ${i?.path.join('.') || 'dados'}`;
}

/** Conexão com token próprio: confere na Meta antes de salvar e já inscreve os webhooks. */
connectionsRouter.post('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const p = manualSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  const d = p.data;
  await assertRoom(accountId);
  await assertFreeNumber(accountId, d.phoneNumberId);
  // com a conferência de assinatura ligada, token de OUTRO app da Meta precisa da chave secreta desse app
  if (config.whatsapp.appSecret && !d.appSecret) {
    const app = await tokenAppId(d.accessToken);
    if (app && app !== config.whatsapp.appId) {
      throw new AppError(422, 'Esse token é de outro app da Meta. Informe a “Chave secreta do app” desse app para conferirmos a assinatura das mensagens — sem ela, as mensagens recebidas seriam recusadas.', { field: 'appSecret' });
    }
  }
  let health;
  try { health = await getPhoneHealth(d.phoneNumberId, d.accessToken); } catch (err) {
    const e = err as WhatsAppError;
    throw new AppError(422, `Não consegui acessar esse número com esse token: ${e.code === 100 || e.code === 190 ? errorPatch({ code: e.code, message: e.message }).lastError : e.message}`);
  }
  let webhookSubscribed: boolean | null = null;
  if (d.wabaId) {
    try { await subscribeAppToWaba(d.wabaId, d.accessToken); webhookSubscribed = true; } catch (err) {
      console.warn('[conexões] inscrição manual:', (err as Error).message);
      webhookSubscribed = false;
    }
  }
  const hp = healthPatch(health);
  const [row] = await db.insert(schema.connections).values({
    accountId, name: d.name, phoneNumberId: d.phoneNumberId, wabaId: d.wabaId || null, accessToken: d.accessToken,
    appSecret: d.appSecret || null, source: 'manual', ...hp, displayPhone: hp.displayPhone ?? null, coexistence: hp.coexistence ?? false,
    webhookSubscribed, lastCheckedAt: new Date(),
  }).returning();
  emit(row);
  res.status(201).json({ connection: publicConnection(row) });
}));

/* ------------------------------------------------- Embedded Signup */

const exchangeSchema = z.object({
  code: z.string().min(1),
  wabaId: z.string().min(1),
  phoneNumberId: z.string().optional().nullable(),
  coexistence: z.boolean().optional(),
});

/**
 * Finaliza o Embedded Signup: troca o `code` por token, inscreve o app nos webhooks do WABA e
 * registra o número (número novo) — ou, na coexistência (WhatsApp Business do celular), descobre o
 * número no WABA, não registra e pede a sincronização dos contatos e do histórico.
 */
connectionsRouter.post('/embedded-signup/exchange', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  if (!config.whatsapp.appId || !config.whatsapp.appSecret) throw new AppError(400, 'A conexão em 1 clique não está configurada no servidor (META_APP_ID/META_APP_SECRET).');
  const d = exchangeSchema.parse(req.body);
  let token: string;
  try { token = await exchangeCodeForToken(d.code); } catch (err) { throw new AppError(502, `A Meta não aceitou a autorização: ${(err as Error).message}`); }
  let phoneNumberId = d.phoneNumberId || null;
  if (!phoneNumberId) {
    try {
      const phones = await wabaPhoneNumbers(d.wabaId, token);
      phoneNumberId = phones[0]?.id ?? null;
    } catch (err) { throw new AppError(502, `Não consegui ler o número na Meta: ${(err as Error).message}`); }
    if (!phoneNumberId) throw new AppError(422, 'A conta do WhatsApp Business não tem número. Termine o cadastro na Meta e conecte de novo.');
  }
  const [existing] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.accountId, accountId), eq(schema.connections.phoneNumberId, phoneNumberId))).limit(1);
  if (!existing) { await assertRoom(accountId); await assertFreeNumber(accountId, phoneNumberId); }

  const notes: string[] = [];
  let webhookSubscribed = false;
  try { await subscribeAppToWaba(d.wabaId, token); webhookSubscribed = true; } catch (err) { notes.push(`inscrição nos webhooks: ${(err as Error).message}`); }

  let health = null as Awaited<ReturnType<typeof getPhoneHealth>> | null;
  try { health = await getPhoneHealth(phoneNumberId, token); } catch (err) { notes.push(`saúde: ${(err as Error).message}`); }
  const coexistence = d.coexistence || health?.is_on_biz_app === true;

  let pin = existing?.pin ?? null;
  let registerError: string | null = null;
  if (!coexistence) {
    // número novo na Cloud API: registra com um PIN de duas etapas criado pelo Converza
    pin = pin ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    try { await registerPhone(phoneNumberId, token, pin); } catch (err) {
      registerError = (err as Error).message;
      if ((err as WhatsAppError).code === 133005) pin = null; // o número já tinha outro PIN
    }
  }
  if (health === null) { try { health = await getPhoneHealth(phoneNumberId, token); } catch { /* fica sem */ } }
  const hp = health ? healthPatch(health) : null;
  const values = {
    name: existing?.name ?? (health?.verified_name || 'WhatsApp'), wabaId: d.wabaId, accessToken: token, appSecret: null,
    source: coexistence ? 'coexistence' : 'embedded', coexistence, webhookSubscribed, pin, lastCheckedAt: new Date(), onboardedAt: new Date(),
    ...(hp ?? { status: 'pending' as const }),
    displayPhone: hp?.displayPhone ?? existing?.displayPhone ?? null,
    lastError: registerError ? `Registro do número: ${registerError}` : hp?.lastError ?? (notes.length ? notes.join(' · ') : null),
    ...(registerError ? { status: 'pending' as const } : {}),
  };
  let row: ConnRow;
  if (existing) [row] = await db.update(schema.connections).set(values).where(eq(schema.connections.id, existing.id)).returning();
  else [row] = await db.insert(schema.connections).values({ accountId, phoneNumberId, ...values }).returning();

  // cada entrada pela Meta permite pedir contatos e histórico uma vez: número novo, ou que tinha sido
  // desconectado (pelo app/Meta) e voltou agora
  if (coexistence && (!row.syncRequestedAt || existing?.status === 'disconnected')) row = await requestSync(row);
  emit(row);
  res.status(existing ? 200 : 201).json({ connection: publicConnection(row), registerError });
}));

/** Coexistência: pede contatos e histórico do celular (uma vez, em até 24h depois de conectar). */
async function requestSync(c: ConnRow): Promise<ConnRow> {
  if (!c.phoneNumberId || !c.accessToken) return c;
  const errors: string[] = [];
  for (const type of ['smb_app_state_sync', 'history'] as const) {
    try { await requestSmbSync(c.phoneNumberId, c.accessToken, type); } catch (err) { errors.push((err as Error).message); }
  }
  const [row] = await db.update(schema.connections).set({
    syncRequestedAt: errors.length === 2 ? null : new Date(),
    historyProgress: errors.length === 2 ? c.historyProgress : 0,
    ...(errors.length ? { lastError: `Sincronização do celular: ${errors[0]}` } : {}),
  }).where(eq(schema.connections.id, c.id)).returning();
  return row ?? c;
}

/* --------------------------------------------------------- por conexão */

connectionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const accountId = req.accountId!;
  const c = await ownConnection(accountId, req.params.id);
  const [stats] = await rows<{ conversations: string; inbound: string; outbound: string }>(sql`
    select (select count(*) from conversations where connection_id = ${c.id}) as conversations,
      count(*) filter (where m.direction = 'in') as inbound, count(*) filter (where m.direction = 'out' and m.type <> 'note') as outbound
    from messages m join conversations v on v.id = m.conversation_id
    where v.connection_id = ${c.id} and m.created_at >= now() - interval '30 days'`);
  const agents = await db.select({
    id: schema.agents.id, name: schema.agents.name, enabled: schema.agents.enabled,
    // atende só este número (é pausado se a conexão for excluída)
    exclusive: sql<boolean>`${schema.agents.connectionIds} = array[${c.id}::uuid]`,
  }).from(schema.agents)
    .where(and(eq(schema.agents.accountId, accountId), sql`(${c.id}::uuid = any(${schema.agents.connectionIds}) or cardinality(${schema.agents.connectionIds}) = 0)`));
  res.json({
    connection: { ...publicConnection(c), pin: req.role !== 'agent' ? c.pin : null },
    stats: { conversations: Number(stats?.conversations ?? 0), inbound30: Number(stats?.inbound ?? 0), outbound30: Number(stats?.outbound ?? 0) },
    agents,
  });
}));

connectionsRouter.post('/:id/check', asyncHandler(async (req, res) => {
  const c = await ownConnection(req.accountId!, req.params.id);
  res.json({ connection: publicConnection(await checkConnection(c)) });
}));

const patchSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a conexão').max(60).optional(),
  accessToken: z.string().trim().min(20, 'Cole o token de acesso completo').optional(),
  wabaId: z.string().trim().regex(/^\d{6,20}$/, 'O WABA ID tem só números').optional().or(z.literal('')),
  appSecret: z.string().trim().max(100).optional().or(z.literal('')),
});

/** Renomear, trocar o token (reconectar manualmente) ou o WABA/chave secreta. */
connectionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  const p = patchSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  const d = p.data;
  if (c.provider === 'web' && (d.accessToken || d.wabaId || d.appSecret)) throw new AppError(422, 'Conexões por QR Code não usam token, WABA nem chave secreta da Meta.');
  if (d.accessToken && c.phoneNumberId) {
    try { await getPhoneHealth(c.phoneNumberId, d.accessToken); } catch (err) {
      throw new AppError(422, `Esse token não acessa o número desta conexão: ${(err as Error).message}`);
    }
  }
  const [row] = await db.update(schema.connections).set({
    ...(d.name ? { name: d.name } : {}),
    ...(d.accessToken ? { accessToken: d.accessToken } : {}),
    ...(d.wabaId !== undefined ? { wabaId: d.wabaId || null } : {}),
    ...(d.appSecret !== undefined ? { appSecret: d.appSecret || null } : {}),
  }).where(eq(schema.connections.id, c.id)).returning();
  const out = d.accessToken || d.wabaId ? await checkConnection(row) : row;
  emit(out);
  res.json({ connection: publicConnection(out) });
}));

/** Registrar o número na Cloud API com o PIN de duas etapas (o atual ou um novo). */
connectionsRouter.post('/:id/register', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  if (c.provider === 'web') throw new AppError(422, 'Conexões por QR Code não são registradas na Cloud API.');
  if (c.coexistence) throw new AppError(422, 'Números do WhatsApp Business do celular já ficam registrados pelo próprio app.');
  const { pin } = z.object({ pin: z.string().regex(/^\d{6}$/, 'O PIN tem 6 números') }).parse(req.body ?? {});
  if (!c.phoneNumberId || !c.accessToken) throw new AppError(422, 'Falta o Phone Number ID ou o token desta conexão.');
  try { await registerPhone(c.phoneNumberId, c.accessToken, pin); } catch (err) { throw new AppError(422, (err as Error).message); }
  await db.update(schema.connections).set({ pin, lastError: null }).where(eq(schema.connections.id, c.id));
  const row = await checkConnection({ ...c, pin });
  res.json({ connection: publicConnection(row) });
}));

/** Inscrever (de novo) o app para receber as mensagens deste número. */
connectionsRouter.post('/:id/subscribe', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  if (!c.wabaId || !c.accessToken) throw new AppError(422, 'Informe o WABA ID desta conexão para inscrever os webhooks.');
  try { await subscribeAppToWaba(c.wabaId, c.accessToken); } catch (err) { throw new AppError(502, (err as Error).message); }
  const [row] = await db.update(schema.connections).set({ webhookSubscribed: true }).where(eq(schema.connections.id, c.id)).returning();
  emit(row);
  res.json({ connection: publicConnection(row) });
}));

/** Coexistência: pedir de novo a sincronização (se não foi pedida). */
connectionsRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  if (!c.coexistence) throw new AppError(422, 'Só números do WhatsApp Business do celular sincronizam contatos e histórico.');
  if (c.syncRequestedAt) throw new AppError(409, 'A sincronização já foi pedida (a Meta permite uma vez por conexão).');
  if (Date.now() - c.onboardedAt.getTime() > 24 * 3600_000) throw new AppError(422, 'O prazo de 24h para importar contatos e histórico do celular já passou. As conversas novas continuam chegando normalmente.');
  const row = await requestSync(c);
  emit(row);
  res.json({ connection: publicConnection(row) });
}));

/* ------------------------------------------------ perfil do WhatsApp */

const VERTICALS = ['UNDEFINED', 'OTHER', 'AUTO', 'BEAUTY', 'APPAREL', 'EDU', 'ENTERTAIN', 'EVENT_PLAN', 'FINANCE', 'GROCERY', 'GOVT', 'HOTEL', 'HEALTH', 'NONPROFIT', 'PROF_SERVICES', 'RETAIL', 'TRAVEL', 'RESTAURANT', 'NOT_A_BIZ'] as const;

connectionsRouter.get('/:id/profile', asyncHandler(async (req, res) => {
  const c = await ownConnection(req.accountId!, req.params.id);
  if (c.provider === 'web') { res.json({ profile: null, verticals: VERTICALS, error: 'Na conexão por QR Code, o perfil (foto, recado, endereço) é editado no próprio app do WhatsApp no celular.' }); return; }
  // número fora do ar não é erro da tela: o detalhe mostra o motivo no lugar do perfil
  if (!c.phoneNumberId || !c.accessToken) { res.json({ profile: null, verticals: VERTICALS, error: 'Conexão sem número ou token.' }); return; }
  try { res.json({ profile: await getBusinessProfile(c.phoneNumberId, c.accessToken), verticals: VERTICALS, error: null }); } catch (err) {
    res.json({ profile: null, verticals: VERTICALS, error: `Não foi possível ler o perfil na Meta: ${(err as Error).message}` });
  }
}));

const profileSchema = z.object({
  about: z.string().trim().max(139, 'O recado tem até 139 letras').optional(),
  description: z.string().trim().max(512, 'A descrição tem até 512 letras').optional(),
  address: z.string().trim().max(256, 'O endereço tem até 256 letras').optional(),
  email: z.string().trim().max(128).email('E-mail inválido').optional().or(z.literal('')),
  websites: z.array(z.string().trim().url('Site inválido (comece com https://)').max(256)).max(2, 'No máximo 2 sites').optional(),
  vertical: z.enum(VERTICALS).optional(),
});

connectionsRouter.put('/:id/profile', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  if (c.provider === 'web') throw new AppError(422, 'Na conexão por QR Code, edite o perfil no app do WhatsApp do celular.');
  if (!c.phoneNumberId || !c.accessToken) throw new AppError(422, 'Conexão sem número/token.');
  const p = profileSchema.safeParse(req.body ?? {});
  if (!p.success) throw new AppError(422, zodMsg(p.error));
  try {
    await updateBusinessProfile(c.phoneNumberId, c.accessToken, p.data);
    res.json({ profile: await getBusinessProfile(c.phoneNumberId, c.accessToken) });
  } catch (err) { throw new AppError(502, (err as Error).message); }
}));

/** Modelos de mensagem aprovados do número (para iniciar conversas e falar fora das 24h). */
connectionsRouter.get('/:id/templates', asyncHandler(async (req, res) => {
  const c = await ownConnection(req.accountId!, req.params.id);
  if (c.provider === 'web') throw new AppError(422, 'Modelos de mensagem (templates) são da API oficial da Meta: a conexão por QR Code não tem.');
  if (!c.accessToken || !c.wabaId) throw new AppError(422, 'Esta conexão não tem a conta do WhatsApp Business (WABA) configurada.');
  try {
    res.json({ templates: await listTemplates(c.accessToken, c.wabaId) });
  } catch (err) {
    throw new AppError(502, (err as Error).message);
  }
}));

connectionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  managerOnly(req);
  const c = await ownConnection(req.accountId!, req.params.id);
  // agente que atendia SÓ neste número é pausado: lista vazia quer dizer "todos os números",
  // e ele não pode passar a responder nos outros sem ninguém pedir
  const paused = await db.update(schema.agents)
    .set({ enabled: false, connectionIds: sql`'{}'::uuid[]`, updatedAt: new Date() })
    .where(and(eq(schema.agents.accountId, c.accountId), eq(schema.agents.enabled, true), sql`${schema.agents.connectionIds} = array[${c.id}::uuid]`))
    .returning({ id: schema.agents.id, name: schema.agents.name });
  await db.update(schema.agents).set({ connectionIds: sql`array_remove(${schema.agents.connectionIds}, ${c.id}::uuid)` })
    .where(and(eq(schema.agents.accountId, c.accountId), sql`${c.id}::uuid = any(${schema.agents.connectionIds})`));
  // QR Code: tira o aparelho do celular antes (senão ele continua em "Aparelhos conectados")
  if (c.provider === 'web') await (await qr()).webLogout(c.id).catch((err) => console.error('[qr] sair ao excluir:', (err as Error).message));
  await db.delete(schema.connections).where(eq(schema.connections.id, c.id));
  emitToAccount(c.accountId, 'connection:deleted', { id: c.id });
  res.json({ ok: true, pausedAgents: paused });
}));

