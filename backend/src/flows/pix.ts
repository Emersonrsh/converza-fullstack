/**
 * Pix "copia e cola" (BR Code estático, padrão EMV do Banco Central) — puro, testável.
 * Usado pelo bloco Botão PIX: o código vai no cartão de pagamento do WhatsApp e, se o cartão
 * não puder ser enviado, numa mensagem de texto.
 */

export type PixKeyType = 'evp' | 'cpf' | 'cnpj' | 'email' | 'phone';

/** Nome do tipo de chave como a Meta espera no cartão de pagamento. */
export const META_KEY_TYPE: Record<PixKeyType, string> = { evp: 'EVP', cpf: 'CPF', cnpj: 'CNPJ', email: 'EMAIL', phone: 'PHONE' };

export const PIX_KEY_LABEL: Record<PixKeyType, string> = {
  evp: 'Chave aleatória', cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', phone: 'Telefone',
};

const digits = (s: string) => s.replace(/\D/g, '');

/** Valor em reais a partir de "49,90", "49.90", "R$ 1.234,56"… (NaN se não der). */
export function parseMoney(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  let s = String(raw ?? '').trim().replace(/R\$|\s/gi, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function validCpf(v: string): boolean {
  const d = digits(v);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function validCnpj(v: string): boolean {
  const d = digits(v);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * w[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** Chave no formato do BR Code. Lança Error com a mensagem para a pessoa. */
export function normalizePixKey(type: PixKeyType, raw: string): string {
  const v = String(raw ?? '').trim();
  switch (type) {
    case 'cpf':
      if (!validCpf(v)) throw new Error('CPF da chave Pix inválido.');
      return digits(v);
    case 'cnpj':
      if (!validCnpj(v)) throw new Error('CNPJ da chave Pix inválido.');
      return digits(v);
    case 'email': {
      const e = v.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 77) throw new Error('E-mail da chave Pix inválido.');
      return e;
    }
    case 'phone': {
      let d = digits(v);
      if (d.length === 10 || d.length === 11) d = `55${d}`;
      if (d.length < 12 || d.length > 13) throw new Error('Telefone da chave Pix inválido (use DDD + número).');
      return `+${d}`;
    }
    case 'evp': {
      const e = v.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(e)) throw new Error('Chave aleatória do Pix inválida (formato 123e4567-e89b-12d3-a456-426614174000).');
      return e;
    }
    default:
      throw new Error('Tipo de chave Pix inválido.');
  }
}

/** Texto sem acento e só com caracteres aceitos no BR Code. */
function ascii(s: string, max: number): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .,&-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), como o Banco Central pede. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PixCodeInput { type: PixKeyType; key: string; name: string; city?: string; amount?: number | null; txid?: string }

/** Monta o Pix copia e cola. Lança Error se a chave for inválida. */
export function pixCode(i: PixCodeInput): string {
  const key = normalizePixKey(i.type, i.key);
  const name = ascii(i.name, 25) || 'RECEBEDOR';
  const city = ascii(i.city ?? '', 15) || 'BRASIL';
  const txid = String(i.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  let payload = tlv('00', '01') + tlv('26', account) + tlv('52', '0000') + tlv('53', '986');
  if (i.amount && i.amount > 0) payload += tlv('54', i.amount.toFixed(2));
  payload += tlv('58', 'BR') + tlv('59', name) + tlv('60', city) + tlv('62', tlv('05', txid)) + '6304';
  return payload + crc16(payload);
}
