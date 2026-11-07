import { and, eq, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db';
import { phoneVariants } from '../utils/phone';

export type ContactRow = typeof schema.contacts.$inferSelect;

/**
 * Contato da conta com esse telefone. Procura pelo telefone e pelo wa_id, nas duas formas dos
 * celulares brasileiros (com e sem o 9) — assim o cliente importado ou cadastrado à mão é o mesmo
 * que depois escreve pelo WhatsApp, e não vira um contato duplicado.
 */
export async function findContactByPhone(accountId: string, phone: string, exceptId?: string): Promise<ContactRow | null> {
  const v = phoneVariants(phone);
  const list = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, accountId), or(inArray(schema.contacts.phone, v), inArray(schema.contacts.waId, v))))
    .limit(6);
  const others = exceptId ? list.filter((c) => c.id !== exceptId) : list;
  return others.find((c) => c.phone === phone) ?? others.find((c) => c.waId === phone) ?? others[0] ?? null;
}

/** Mapa telefone (do jeito que veio) → contato existente, para muitos números de uma vez (importação). */
export async function findContactsByPhones(accountId: string, phones: string[]): Promise<Map<string, ContactRow>> {
  const out = new Map<string, ContactRow>();
  if (!phones.length) return out;
  const all = [...new Set(phones.flatMap(phoneVariants))];
  const list = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.accountId, accountId), or(inArray(schema.contacts.phone, all), inArray(schema.contacts.waId, all))));
  const byKey = new Map<string, ContactRow>();
  for (const c of list) if (!byKey.has(c.phone)) byKey.set(c.phone, c); // telefone idêntico vence o wa_id
  for (const c of list) if (c.waId && !byKey.has(c.waId)) byKey.set(c.waId, c);
  for (const p of phones) {
    const hit = byKey.get(p) ?? phoneVariants(p).map((x) => byKey.get(x)).find(Boolean);
    if (hit) out.set(p, hit);
  }
  return out;
}
