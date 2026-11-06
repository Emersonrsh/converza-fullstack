import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';

export interface Audience {
  all?: boolean;
  stage?: 'new' | 'in_service' | 'negotiating' | 'won' | 'lost';
  contactIds?: string[];
}

/** Resolve a definição de público em uma lista concreta de contatos da conta. */
export async function resolveAudienceContacts(accountId: string, audience: Audience) {
  if (audience.contactIds?.length) {
    return db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.accountId, accountId), inArray(schema.contacts.id, audience.contactIds)));
  }
  if (audience.stage) {
    return db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.accountId, accountId), eq(schema.contacts.stage, audience.stage)));
  }
  return db.select().from(schema.contacts).where(eq(schema.contacts.accountId, accountId));
}
