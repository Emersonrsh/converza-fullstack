/** Aviso por e-mail ao proprietário (e administradores) quando um número desconecta ou fica restrito. */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { config } from '../config';
import { layout, plainText, sendMail } from '../email/mailer';

type Conn = typeof schema.connections.$inferSelect;

export const isRestricted = (c: Pick<Conn, 'qualityRating' | 'phoneStatus'> | null | undefined) =>
  !!c && (String(c.qualityRating ?? '').toUpperCase() === 'RED' || ['FLAGGED', 'RESTRICTED'].includes(String(c.phoneStatus ?? '').toUpperCase()));

/** O que mudou para pior entre antes e depois (null = nada para avisar). */
export function alertKind(before: Conn | null, after: Conn): 'down' | 'restricted' | null {
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
  const [acc] = await db.select({ name: schema.accounts.name, notify: schema.accounts.notifyInstanceEmail }).from(schema.accounts)
    .where(eq(schema.accounts.id, after.accountId)).limit(1);
  if (!acc?.notify) return;
  if (!(await claimAlert(after.id, kind))) return;
  const people = await db.select({ email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.accountId, after.accountId), inArray(schema.memberships.role, ['owner', 'admin'])));
  const num = after.displayPhone || after.name;
  const title = kind === 'down' ? `O número ${num} desconectou` : `O número ${num} está restrito pela Meta`;
  const lines = kind === 'down'
    ? [`A conexão <b>${after.name}</b> (${num}) da empresa <b>${acc.name}</b> parou de funcionar no WhatsApp.`,
      `Motivo informado: ${(after.lastError ?? 'sem detalhes').replace(/</g, '&lt;')}`,
      'Enquanto isso, mensagens, fluxos, agentes e disparos por esse número não saem. Abra Conexões e reconecte.']
    : [`A Meta marcou o número <b>${num}</b> (${after.name}) da empresa <b>${acc.name}</b> como restrito (qualidade ${after.qualityRating ?? '—'}, situação ${after.phoneStatus ?? '—'}).`,
      'Evite disparos para quem não pediu e confira a qualidade em Conexões.'];
  const button = { label: 'Abrir Conexões', url: `${config.appOrigin.replace(/\/+$/, '')}/connections` };
  const footer = 'Você recebe este aviso porque é proprietário ou administrador. Dá para desligar em Configurações › Empresa.';
  for (const p of people) {
    await sendMail({ to: p.email, subject: title, html: layout(title, lines, button, footer), text: plainText(title, lines, button) });
  }
}
