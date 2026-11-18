/**
 * Avisos quando um número cai, é banido ou fica restrito: notificação no celular (push), aviso na tela
 * para quem está com o Converza aberto e e-mail para proprietários e administradores.
 * Banimento também dispara a proteção que pausa as campanhas ligadas ao número.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { layout, plainText, sendMail } from '../email/mailer';
import { emitToAccount } from '../realtime/io';
import { pushToAccount } from './push';
import { pauseCampaignsForBannedNumber, type GuardResult } from '../meta/banGuard';

type Conn = typeof schema.connections.$inferSelect;

export const isRestricted = (c: Pick<Conn, 'qualityRating' | 'phoneStatus'> | null | undefined) =>
  !!c && (String(c.qualityRating ?? '').toUpperCase() === 'RED' || ['FLAGGED', 'RESTRICTED'].includes(String(c.phoneStatus ?? '').toUpperCase()));

export const isBanned = (c: Pick<Conn, 'phoneStatus'> | null | undefined) => !!c && String(c.phoneStatus ?? '').toUpperCase() === 'BANNED';

/** O que mudou para pior entre antes e depois (null = nada para avisar). */
export function alertKind(before: Conn | null, after: Conn): 'banned' | 'down' | 'restricted' | null {
  if (isBanned(after) && !isBanned(before)) return 'banned';
  if (after.status === 'disconnected' && before?.status !== 'disconnected') return 'down';
  if (isRestricted(after) && !isRestricted(before)) return 'restricted';
  return null;
}

/** No máximo um e-mail a cada 6 horas por número e tipo de problema. */
async function claimAlert(connectionId: string, kind: string) {
  try {
    const { redis } = await import('../redis');
    return (await redis.set(`alert:${connectionId}:${kind}`, '1', 'EX', 6 * 3600, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

export async function maybeAlertInstance(before: Conn | null, after: Conn) {
  const kind = alertKind(before, after);
  if (!kind) return;
  // banido: primeiro pausa o que manda leads para o número (independe dos avisos)
  let guard: GuardResult | null = null;
  if (kind === 'banned') {
    guard = await pauseCampaignsForBannedNumber(after).catch((err) => {
      console.error('[proteção] pausar campanhas do número banido:', (err as Error).message);
      return { paused: [], errors: [(err as Error).message] };
    });
  }
  if (!(await claimAlert(after.id, kind))) return;
  const [acc] = await db.select({ name: schema.accounts.name, notify: schema.accounts.notifyInstanceEmail }).from(schema.accounts)
    .where(eq(schema.accounts.id, after.accountId)).limit(1);
  if (!acc) return;
  const num = after.displayPhone || after.name;
  const nC = guard?.paused.filter((p) => p.level === 'campaign').length ?? 0;
  const nS = (guard?.paused.length ?? 0) - nC;
  const what = [nC ? `${nC} ${nC === 1 ? 'campanha' : 'campanhas'}` : '', nS ? `${nS} ${nS === 1 ? 'conjunto de anúncios' : 'conjuntos de anúncios'}` : ''].filter(Boolean).join(' e ');
  const pausedLine = guard?.paused.length
    ? `Pausamos ${what} que ${guard.paused.length === 1 ? 'mandava' : 'mandavam'} pessoas para esse número: ${guard.paused.map((p) => `“${p.name}”`).join(', ')}.`
    : null;
  const title = kind === 'banned' ? `🚫 O número ${num} foi banido` : kind === 'down' ? `⚠️ O número ${num} caiu` : `⚠️ O número ${num} está restrito pela Meta`;
  const short = kind === 'banned'
    ? `${after.name}: o WhatsApp baniu o número. Mensagens, fluxos e agentes dele pararam.${pausedLine ? ` ${pausedLine}` : ''}`
    : kind === 'down'
      ? `${after.name}: ${after.lastError ?? 'a conexão com o WhatsApp parou'}. Reconecte em Conexões.`
      : `${after.name}: qualidade ${after.qualityRating ?? '—'}. Evite disparos para quem não pediu.`;

  // na tela de quem está com o Converza aberto
  emitToAccount(after.accountId, 'instance:alert', { connectionId: after.id, kind, title, body: short, paused: guard?.paused.length ?? 0 });
  // no celular (cada aparelho escolhe se quer esse aviso)
  await pushToAccount(after.accountId, 'instances', { title, body: short, url: '/connections', tag: `instance-${after.id}-${kind}` })
    .catch((err) => console.error('[push] aviso de número:', (err as Error).message));

  if (!acc.notify) return;
  const people = await db.select({ email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.accountId, after.accountId), inArray(schema.memberships.role, ['owner', 'admin'])));
  const esc = (t: string) => t.replace(/</g, '&lt;');
  const lines = kind === 'banned'
    ? [`O WhatsApp baniu o número <b>${num}</b> (${esc(after.name)}) da empresa <b>${esc(acc.name)}</b>.`,
      `Motivo informado: ${esc(after.lastError ?? 'sem detalhes')}`,
      ...(pausedLine ? [esc(pausedLine)] : []),
      ...(guard?.errors.length ? [`Não consegui pausar tudo: ${esc(guard.errors.slice(0, 3).join(' · '))}. Confira no Gerenciador de Anúncios.`] : []),
      'Mensagens, fluxos, agentes e disparos por esse número pararam. Se for um engano, peça revisão no WhatsApp e reconecte em Conexões.']
    : kind === 'down'
      ? [`A conexão <b>${esc(after.name)}</b> (${num}) da empresa <b>${esc(acc.name)}</b> parou de funcionar no WhatsApp.`,
        `Motivo informado: ${esc(after.lastError ?? 'sem detalhes')}`,
        'Enquanto isso, mensagens, fluxos, agentes e disparos por esse número não saem. Abra Conexões e reconecte.']
      : [`A Meta marcou o número <b>${num}</b> (${esc(after.name)}) da empresa <b>${esc(acc.name)}</b> como restrito (qualidade ${after.qualityRating ?? '—'}, situação ${after.phoneStatus ?? '—'}).`,
        'Evite disparos para quem não pediu e confira a qualidade em Conexões.'];
  const button = { label: 'Abrir Conexões', url: `${config.appOrigin.replace(/\/+$/, '')}/connections` };
  const footer = 'Você recebe este aviso porque é proprietário ou administrador. Dá para desligar em Configurações › Empresa.';
  const subject = title.replace(/^[^\p{L}\d]+/u, '');
  for (const p of people) {
    await sendMail({ to: p.email, subject, html: layout(subject, lines, button, footer), text: plainText(subject, lines, button) });
  }
}
