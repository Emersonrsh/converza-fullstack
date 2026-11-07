/** Troca o nome de uma etiqueta dentro de JSON (fluxos, webhooks, públicos de disparo). Puro e testável. */

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Em chaves cujo nome fala de etiqueta (tags, addTags, removeTags, tag, audienceTags…), troca o valor igual ao
 * nome antigo: string exata, item de lista ou item de lista separada por vírgula. Nas condições de fluxo
 * ({ field: 'tags', value }) troca o `value`. Devolve [novo valor, quantas trocas].
 */
export function renameTagDeep<T>(input: T, from: string, to: string): [T, number] {
  let count = 0;
  const walk = (v: unknown, key: string | null, parent: Record<string, unknown> | null): unknown => {
    if (Array.isArray(v)) {
      if (key && /tag/i.test(key)) {
        return v.map((x) => (typeof x === 'string' && same(x, from) ? (count++, to) : walk(x, null, null)));
      }
      return v.map((x) => walk(x, null, null));
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = walk(val, k, obj);
      return out;
    }
    if (typeof v === 'string' && key) {
      const tagKey = /tag/i.test(key) || (key === 'value' && parent && parent.field === 'tags');
      if (tagKey) {
        if (same(v, from)) { count++; return to; }
        if (v.includes(',')) {
          const parts = v.split(',');
          if (parts.some((p) => same(p, from))) {
            count++;
            return parts.map((p) => (same(p, from) ? to : p.trim())).join(', ');
          }
        }
      }
    }
    return v;
  };
  const out = walk(input, null, null) as T;
  return [out, count];
}
