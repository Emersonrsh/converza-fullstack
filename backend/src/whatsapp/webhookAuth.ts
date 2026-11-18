/** Assinatura dos avisos da Meta: quais entradas de um aviso a chave que assinou autoriza. */

export type Entry = { id?: string; changes?: { value?: { metadata?: { phone_number_id?: string } } }[] };
export const phoneIdsOf = (e: Entry) => [...new Set((e.changes ?? []).map((c) => c.value?.metadata?.phone_number_id).filter((x): x is string => !!x))];

/**
 * Quais entradas do aviso a assinatura autoriza. Um aviso pode trazer várias entradas, e cada uma
 * só vale se a assinatura conferir com a chave do app do operador ou com a chave cadastrada na
 * conexão DAQUELA entrada. Sem isso, um cliente com conexão manual (que conhece a própria chave)
 * conseguia pôr no mesmo aviso uma entrada com o número de outra empresa e forjar eventos para ela.
 */
export function authorizedEntries(
  entries: Entry[],
  opts: { globalOk: boolean; okSecrets: Set<string>; conns: { phoneNumberId: string | null; wabaId: string | null; appSecret: string | null }[] },
): { keep: Entry[]; dropped: Entry[] } {
  if (opts.globalOk) return { keep: entries, dropped: [] };
  const keep: Entry[] = [];
  const dropped: Entry[] = [];
  for (const e of entries) {
    const phones = phoneIdsOf(e);
    const own = opts.conns.filter((c) => c.appSecret && ((c.phoneNumberId && phones.includes(c.phoneNumberId)) || (e.id && c.wabaId === e.id)));
    (own.some((c) => opts.okSecrets.has(c.appSecret!)) ? keep : dropped).push(e);
  }
  return { keep, dropped };
}
