/**
 * Telefone como o WhatsApp usa: só dígitos, com DDI.
 * - "+..." ou "00..." = número internacional, fica como veio (ex.: +1 415 555 2671).
 * - Sem DDI: número brasileiro com DDD (10 ou 11 dígitos) ganha o 55.
 * - "0" de discagem/operadora na frente ("011 9...", "0 21 11 9...") é removido.
 * Devolve null se não parecer um telefone válido.
 */
export function normalizePhone(raw: unknown): string | null {
  // planilha exportada como número decimal ("11988887777.0") não pode ganhar um dígito a mais
  const s = String(raw ?? '').trim().replace(/^(\+?\d+)[.,]0+$/, '$1');
  let d = s.replace(/\D/g, '');
  const intl = s.startsWith('+') || d.startsWith('00');
  if (d.startsWith('00')) d = d.slice(2);
  if (!intl && d.startsWith('0')) {
    const rest = d.replace(/^0+/, '');
    if (rest.length === 10 || rest.length === 11) d = rest; // 0 + DDD + número
    else if (rest.length === 12 || rest.length === 13) d = rest.slice(2); // 0 + operadora + DDD + número
  }
  if (!intl && (d.length === 10 || d.length === 11)) d = `55${d}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/**
 * Formas do mesmo número brasileiro: o WhatsApp ainda identifica muitos celulares antigos
 * sem o 9 extra (wa_id 55 11 8888-7777 para quem digita 55 11 98888-7777). Para achar o mesmo
 * contato vale procurar pelas duas. Fixos (começam com 2 a 5) e números de outros países: só ele mesmo.
 */
export function phoneVariants(phone: string): string[] {
  const d = phone.replace(/\D/g, '');
  if (!d.startsWith('55')) return [d];
  const ddd = d.slice(2, 4);
  const num = d.slice(4);
  if (num.length === 9 && num[0] === '9') return [d, `55${ddd}${num.slice(1)}`];
  if (num.length === 8 && /[6-9]/.test(num[0])) return [d, `55${ddd}9${num}`];
  return [d];
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
