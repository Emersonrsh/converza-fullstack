/** Regras da cobrança (sem rede, testáveis): CPF/CNPJ, datas do ciclo, proporcional e textos de status. */

export const onlyDigits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/**
 * Só letras maiúsculas e números (tira pontos, barra, traço e espaços).
 * Desde 31/07/2026 a Receita emite CNPJ com letras nas 12 primeiras posições (IN RFB 2.229/2024).
 */
export const normTaxId = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

function cpfOk(d: string) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const dv = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

/** CNPJ numérico ou alfanumérico: módulo 11 com o valor de cada caractere = código ASCII − 48 (A = 17, Z = 42). */
function cnpjOk(d: string) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d) || /^(.)\1+$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((acc, x, i) => acc + (d.charCodeAt(i) - 48) * x, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** É CPF ou CNPJ válido? (null quando não é nenhum dos dois) */
export function taxIdKind(v: unknown): 'cpf' | 'cnpj' | null {
  const d = normTaxId(v);
  if (d.length === 11) return cpfOk(d) ? 'cpf' : null;
  if (d.length === 14) return cnpjOk(d) ? 'cnpj' : null;
  return null;
}

/** CPF (11 dígitos) ou CNPJ (14 caracteres, com ou sem letras) com os dígitos verificadores certos. */
export function validTaxId(v: unknown): string | null {
  return taxIdKind(v) ? normTaxId(v) : null;
}

/** 000.000.000-00 ou 00.000.000/0000-00 (o CNPJ com letras usa a mesma máscara). */
export function formatTaxId(d: string) {
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return d;
}

export function maskTaxId(d: string | null | undefined) {
  if (!d) return null;
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
}

/** Data de hoje no Brasil (AAAA-MM-DD). */
export const todayBR = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Mesmo dia do mês seguinte (31/01 → 28/02). */
export function addMonthsDate(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export function addDaysDate(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}

/** Data (AAAA-MM-DD) para mostrar como DD/MM/AAAA. */
export const brDate = (d: string | Date | null | undefined) => {
  if (!d) return '';
  const s = typeof d === 'string' ? d : todayBR(d);
  const [y, m, day] = s.slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
};

/** Fim do dia (horário de Brasília) de uma data. */
export const endOfDayBR = (d: string) => new Date(`${d}T23:59:59-03:00`);

/** Período pago por uma mensalidade com vencimento em `due`: até o fim do dia do próximo vencimento. */
export const periodEndFromDue = (due: string) => endOfDayBR(addMonthsDate(due, 1));

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Instâncias a mais no meio do ciclo: paga só os dias que faltam até o próximo vencimento
 * (sobre 30 dias), nunca menos que R$ 5,00 — o mínimo de cobrança da Asaas.
 */
export function prorata(extra: number, unitPrice: number, periodEnd: Date | null, now = new Date(), min = 5) {
  if (extra <= 0) return 0;
  const days = periodEnd ? Math.max(1, Math.min(30, Math.ceil((periodEnd.getTime() - now.getTime()) / 86_400_000))) : 30;
  return Math.max(min, r2((extra * unitPrice * days) / 30));
}

export type SubStatusKey = 'none' | 'pending' | 'active' | 'canceling' | 'past_due' | 'canceled';

/** Situação da assinatura para a tela (texto honesto para cada caso). */
export function statusInfo(s: { status: string; instances: number; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null; startedAt: Date | null; canceledAt?: Date | null },
  awaitingFirstPayment: boolean): { key: SubStatusKey; label: string; text: string } {
  const until = s.currentPeriodEnd ? s.currentPeriodEnd.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'o fim do período';
  if (s.status === 'active' && s.cancelAtPeriodEnd) {
    return s.canceledAt
      ? { key: 'canceling', label: 'Cancelada', text: `Assinatura cancelada: tudo continua funcionando até ${until}. Depois disso, os números param de enviar mensagens e os disparos, agentes de IA e webhooks param.` }
      : { key: 'canceling', label: 'Não renova', text: `Esta assinatura não tem cobrança recorrente: tudo funciona até ${until}. Assine para continuar depois disso.` };
  }
  if (s.status === 'active') return { key: 'active', label: 'Ativa', text: 'Sua conta está ativa e operando normalmente. Cobrança mensal recorrente por instância contratada.' };
  if (s.status === 'past_due') return { key: 'past_due', label: 'Pagamento pendente', text: 'A mensalidade não foi paga: os números pararam de enviar mensagens e os disparos, agentes de IA e webhooks estão parados. Pague a fatura em aberto para tudo voltar na hora.' };
  if (awaitingFirstPayment) return { key: 'pending', label: 'Aguardando pagamento', text: 'Assim que o pagamento da primeira fatura for confirmado, as instâncias são liberadas sozinhas.' };
  if (s.status === 'canceled' || s.startedAt) return { key: 'canceled', label: 'Cancelada', text: 'Sua assinatura está cancelada: os números não enviam mensagens e os disparos, agentes de IA e webhooks estão parados. Assine de novo para voltar.' };
  return { key: 'none', label: 'Sem assinatura', text: 'Você ainda não tem assinatura. Escolha quantas instâncias (números de WhatsApp) quer contratar.' };
}
