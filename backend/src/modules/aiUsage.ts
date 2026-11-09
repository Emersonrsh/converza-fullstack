/** Uso da IA: cada débito de tokens, agrupado por conversa (ou por ferramenta e dia). */
import { Router, type Request } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { asyncHandler, AppError } from '../utils/http';
import { USAGE_KIND_LABEL, type UsageKind } from '../ai/usage';
import { getTokenState } from './tokens';

export const aiUsageRouter = Router();

const rows = async <T = Record<string, any>>(q: SQL) => (await db.execute(q)).rows as T[];

function managerOnly(req: Request) {
  if (req.role === 'agent') throw new AppError(403, 'Só o dono e os administradores veem o uso da IA.');
}

const CONVERSATION_KINDS: UsageKind[] = ['agent_reply', 'agent_voice', 'transcription', 'flow_ai'];
const kindLabel = (k: string) => USAGE_KIND_LABEL[k as UsageKind] ?? k;

function periodStart(days: number) {
  return new Date(Date.now() - days * 86_400_000);
}

function toolTitle(key: string) {
  const [, kind, day] = key.split(':');
  const [y, m, d] = (day ?? '').split('-');
  return `${kindLabel(kind)}${d ? ` — ${d}/${m}/${y}` : ''}`;
}

aiUsageRouter.get('/', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const scope = ['conversations', 'tools'].includes(String(req.query.scope)) ? String(req.query.scope) : 'all';
  const sort = req.query.sort === 'tokens' ? 'tokens' : 'recent';
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const from = periodStart(days);

  const [tot] = await rows<{ tokens: number; calls: number; conversations: number; conv_tokens: number }>(sql`
    select coalesce(sum(tokens), 0)::int as tokens, count(*)::int as calls,
           count(distinct session_key) filter (where session_key like 'conv:%')::int as conversations,
           coalesce(sum(tokens) filter (where session_key like 'conv:%'), 0)::int as conv_tokens
      from ai_usage where account_id = ${accountId} and created_at >= ${from}`);
  const byKind = await rows<{ kind: string; tokens: number; calls: number }>(sql`
    select kind, sum(tokens)::int as tokens, count(*)::int as calls
      from ai_usage where account_id = ${accountId} and created_at >= ${from}
     group by kind order by sum(tokens) desc`);
  const byDay = await rows<{ day: string; tokens: number }>(sql`
    select to_char(date_trunc('day', created_at at time zone coalesce((select timezone from accounts where id = ${accountId}), 'America/Sao_Paulo')), 'YYYY-MM-DD') as day,
           sum(tokens)::int as tokens
      from ai_usage where account_id = ${accountId} and created_at >= ${from}
     group by 1 order by 1`);

  const scopeSql = scope === 'conversations' ? sql`and u.session_key like 'conv:%'` : scope === 'tools' ? sql`and u.session_key like 'tool:%'` : sql``;
  const like = q ? `%${q}%` : null;
  const digits = q.replace(/\D/g, '');
  const searchSql = like ? sql`and (c.name ilike ${like} ${digits.length >= 3 ? sql`or c.phone like ${`%${digits}%`}` : sql``} or u.label ilike ${like})` : sql``;
  const orderSql = sort === 'tokens' ? sql`order by sum(u.tokens) desc` : sql`order by max(u.created_at) desc`;
  const sessions = await rows<{
    key: string; conversation_id: string | null; contact_id: string | null; contact_name: string | null; contact_phone: string | null;
    kinds: string[]; calls: number; tokens: number; first_at: Date; last_at: Date; conv_exists: boolean;
  }>(sql`
    select u.session_key as key,
           (array_agg(u.conversation_id) filter (where u.conversation_id is not null))[1] as conversation_id,
           (array_agg(u.contact_id) filter (where u.contact_id is not null))[1] as contact_id,
           max(c.name) as contact_name, max(c.phone) as contact_phone,
           array_agg(distinct u.kind) as kinds, count(*)::int as calls, sum(u.tokens)::int as tokens,
           min(u.created_at) as first_at, max(u.created_at) as last_at,
           bool_or(cv.id is not null) as conv_exists
      from ai_usage u
      left join contacts c on c.id = u.contact_id
      left join conversations cv on cv.id = u.conversation_id
     where u.account_id = ${accountId} and u.created_at >= ${from} ${scopeSql} ${searchSql}
     group by u.session_key
     ${orderSql}
     limit 150`);

  const st = await getTokenState(accountId);
  res.json({
    days, scope, sort,
    totals: {
      tokens: Number(tot?.tokens ?? 0), calls: Number(tot?.calls ?? 0),
      conversations: Number(tot?.conversations ?? 0), conversationTokens: Number(tot?.conv_tokens ?? 0),
      toolTokens: Number(tot?.tokens ?? 0) - Number(tot?.conv_tokens ?? 0),
      perConversation: tot?.conversations ? Math.round(Number(tot.conv_tokens) / Number(tot.conversations)) : 0,
    },
    byKind: byKind.map((k) => ({ kind: k.kind, label: kindLabel(k.kind), tokens: Number(k.tokens), calls: Number(k.calls), inConversation: CONVERSATION_KINDS.includes(k.kind as UsageKind) })),
    byDay: byDay.map((d) => ({ day: d.day, tokens: Number(d.tokens) })),
    sessions: sessions.map((s) => {
      const isConv = s.key.startsWith('conv:');
      return {
        key: s.key,
        type: isConv ? 'conversation' : 'tool',
        title: isConv ? (s.contact_name || s.contact_phone || 'Conversa apagada') : toolTitle(s.key),
        conversationId: isConv && s.conv_exists ? s.conversation_id : null,
        contact: s.contact_id ? { id: s.contact_id, name: s.contact_name, phone: s.contact_phone } : null,
        kinds: (s.kinds ?? []).map((k) => ({ kind: k, label: kindLabel(k) })),
        calls: Number(s.calls), tokens: Number(s.tokens), firstAt: s.first_at, lastAt: s.last_at,
      };
    }),
    balance: st.balance, house: st.house, usedTotal: st.used,
  });
}));

/** Detalhe de uma sessão: cada débito, com o agente / fluxo que gastou. */
aiUsageRouter.get('/session', asyncHandler(async (req, res) => {
  managerOnly(req);
  const accountId = req.accountId!;
  const key = String(req.query.key ?? '');
  if (!/^(conv:[0-9a-f-]{36}|tool:[a-z_]+:\d{4}-\d{2}-\d{2})$/.test(key)) throw new AppError(404, 'Sessão não encontrada');
  const items = await rows<{
    id: string; kind: string; label: string; tokens: number; created_at: Date;
    agent_id: string | null; agent_name: string | null; flow_id: string | null; flow_name: string | null;
    conversation_id: string | null; contact_name: string | null; contact_phone: string | null;
  }>(sql`
    select u.id, u.kind, u.label, u.tokens, u.created_at, u.agent_id, a.name as agent_name, u.flow_id, f.name as flow_name,
           cv.id as conversation_id, c.name as contact_name, c.phone as contact_phone
      from ai_usage u
      left join agents a on a.id = u.agent_id
      left join flows f on f.id = u.flow_id
      left join conversations cv on cv.id = u.conversation_id
      left join contacts c on c.id = u.contact_id
     where u.account_id = ${accountId} and u.session_key = ${key}
     order by u.created_at desc
     limit 500`);
  if (!items.length) throw new AppError(404, 'Sessão não encontrada');
  const isConv = key.startsWith('conv:');
  const withName = items.find((i) => i.contact_name || i.contact_phone);
  res.json({
    key,
    type: isConv ? 'conversation' : 'tool',
    title: isConv ? (withName?.contact_name || withName?.contact_phone || 'Conversa apagada') : toolTitle(key),
    conversationId: isConv ? items.find((i) => i.conversation_id)?.conversation_id ?? null : null,
    tokens: items.reduce((a, i) => a + Number(i.tokens), 0),
    items: items.map((i) => ({
      id: i.id, kind: i.kind, kindLabel: kindLabel(i.kind), label: i.label, tokens: Number(i.tokens), createdAt: i.created_at,
      agent: i.agent_id ? { id: i.agent_id, name: i.agent_name } : null,
      flow: i.flow_id ? { id: i.flow_id, name: i.flow_name } : null,
    })),
  });
}));
