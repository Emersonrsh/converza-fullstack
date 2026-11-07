/** DDD → UF (Brasil). */
export const DDD_UF: Record<string, string> = {
  '11': 'SP', '12': 'SP', '13': 'SP', '14': 'SP', '15': 'SP', '16': 'SP', '17': 'SP', '18': 'SP', '19': 'SP',
  '21': 'RJ', '22': 'RJ', '24': 'RJ',
  '27': 'ES', '28': 'ES',
  '31': 'MG', '32': 'MG', '33': 'MG', '34': 'MG', '35': 'MG', '37': 'MG', '38': 'MG',
  '41': 'PR', '42': 'PR', '43': 'PR', '44': 'PR', '45': 'PR', '46': 'PR',
  '47': 'SC', '48': 'SC', '49': 'SC',
  '51': 'RS', '53': 'RS', '54': 'RS', '55': 'RS',
  '61': 'DF',
  '62': 'GO', '64': 'GO',
  '63': 'TO',
  '65': 'MT', '66': 'MT',
  '67': 'MS',
  '68': 'AC',
  '69': 'RO',
  '71': 'BA', '73': 'BA', '74': 'BA', '75': 'BA', '77': 'BA',
  '79': 'SE',
  '81': 'PE', '87': 'PE',
  '82': 'AL',
  '83': 'PB',
  '84': 'RN',
  '85': 'CE', '88': 'CE',
  '86': 'PI', '89': 'PI',
  '91': 'PA', '93': 'PA', '94': 'PA',
  '92': 'AM', '97': 'AM',
  '95': 'RR',
  '96': 'AP',
  '98': 'MA', '99': 'MA',
};

/** Estado (UF) a partir do telefone: aceita +55, DDD com 10/11 dígitos. Retorna null fora do Brasil. */
export function ufFromPhone(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  let ddd: string | null = null;
  // com 55: 55 + DDD + 8 dígitos (fixo) ou + 9 + 8 dígitos (celular)
  if (/^55\d{10}$/.test(d) || /^55\d{2}9\d{8}$/.test(d)) ddd = d.slice(2, 4);
  // sem 55: celular (DDD + 9 + 8 dígitos) ou fixo (DDD + 2–5 + 7 dígitos)
  else if (/^\d{2}9\d{8}$/.test(d) || /^\d{2}[2-5]\d{7}$/.test(d)) ddd = d.slice(0, 2);
  return ddd ? DDD_UF[ddd] ?? null : null;
}

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
