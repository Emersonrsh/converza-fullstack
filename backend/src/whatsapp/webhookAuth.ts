/** Assinatura dos avisos da Meta: quais partes de um aviso a chave que assinou autoriza. */

export type Change = { field?: string; value?: { metadata?: { phone_number_id?: string } } };
export type Entry = { id?: string; changes?: Change[] };
export const phoneIdsOf = (e: Entry) => [...new Set((e.changes ?? []).map((c) => c.value?.metadata?.phone_number_id).filter((x): x is string => !!x))];

/**
 * Quais mudanças do aviso a assinatura autoriza. Com a chave do app do operador, tudo vale.
 * Com a chave cadastrada numa conexão manual, só valem as mudanças DAQUELA conexão: cada mudança
 * precisa ter o número de uma conexão cuja chave conferiu, e o account_update (que usa o entry.id)
 * só vale quando o entry.id é o WABA dessa mesma conexão. Antes a autorização era por entrada inteira:
 * bastava citar o próprio número numa mudança para passar junto uma mudança com o número (ou o WABA)
 * de outra empresa, e assim forjar mensagens ou marcar a conexão dela como banida.
 */
export function authorizedEntries(
  entries: Entry[],
  opts: { globalOk: boolean; okSecrets: Set<string>; conns: { phoneNumberId: string | null; wabaId: string | null; appSecret: string | null }[] },
): { keep: Entry[]; dropped: Entry[] } {
  if (opts.globalOk) return { keep: entries, dropped: [] };
  const ok = opts.conns.filter((c) => c.appSecret && opts.okSecrets.has(c.appSecret));
  const okPhones = new Set(ok.map((c) => c.phoneNumberId).filter((x): x is string => !!x));
  const okWabas = new Set(ok.map((c) => c.wabaId).filter((x): x is string => !!x));
  const keep: Entry[] = [];
  const dropped: Entry[] = [];
  for (const e of entries) {
    const all = e.changes ?? [];
    const allowed = all.filter((ch) => {
      if (String(ch.field ?? 'messages') === 'account_update') return !!e.id && okWabas.has(e.id);
      const pid = ch.value?.metadata?.phone_number_id;
      return !!pid && okPhones.has(pid);
    });
    if (allowed.length) keep.push(allowed.length === all.length ? e : { ...e, changes: allowed });
    if (allowed.length !== all.length) dropped.push({ ...e, changes: all.filter((ch) => !allowed.includes(ch)) });
  }
  return { keep, dropped };
}
