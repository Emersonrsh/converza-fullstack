/** Cobranças e assinaturas: formato das respostas da API e textos da tela. */

export type Currency = 'BRL' | 'USD';
export type InvoiceStatus = 'pending' | 'paid' | 'overdue' | 'refunded' | 'canceled';
export type InvoiceKind = 'subscription' | 'instances' | 'tokens' | 'dispatch';

export interface Invoice {
  id: string; number: number; kind: InvoiceKind; description: string; amount: number; currency: Currency;
  status: InvoiceStatus; method: string | null; gateway: 'asaas' | 'paddle'; dueDate: string | null; paidAt: string | null;
  createdAt: string; refundedAt: string | null; refundAmount: number | null; periodStart: string | null; periodEnd: string | null;
  hasLink: boolean;
}

export interface Summary {
  status: { key: 'none' | 'pending' | 'active' | 'canceling' | 'past_due' | 'canceled'; label: string; text: string };
  subscription: {
    status: string; instances: number; inUse: number; free: number; pendingInstances: number | null; pendingFrom: string | null; nextInstances: number | null;
    monthly: number; currentMonthly: number; currency: Currency; unitPrice: number; startedAt: string | null; currentPeriodEnd: string | null;
    nextDueDate: string | null; paymentMethod: string | null; billingCountry: 'BR' | 'INTL'; gateway: string | null;
    cancelAtPeriodEnd: boolean; canceledAt: string | null; renewing: boolean; canChange: boolean;
    taxId: string | null; billingName: string | null; hasTaxId: boolean;
  };
  openInvoices: Invoice[];
  tokens: { balance: number; used: number; lastPurchaseAt: string | null };
  account: { number: number | null; name: string; createdAt: string | null; ownerName: string | null; ownerEmail: string | null };
  invoices: Invoice[];
  gateways: { asaas: boolean; paddle: boolean; paddleSubscriptions: boolean };
  pricing: {
    instanceBRL: number; instanceUSD: number; tokensPer1000BRL: number; tokensPer1000USD: number;
    tokensMin: number; tokensMax: number; tokensStep: number; maxInstances: number;
    perInstance: { agents: number; dispatches: number; webhookEvents: number };
  };
  dispatchPacks: { id: string; quantity: number; price: number; priceUSD: number }[];
  supportUrl: string | null;
  canEdit: boolean;
  /** conta da casa (HOUSE_EMAILS no servidor): sem cobrança e tokens de IA sem limite */
  house?: boolean;
}

export interface CheckoutResult { url: string | null; invoiceId?: string; applied?: boolean; scheduled?: boolean; message?: string; instances?: number }

export const fmtInt = (n: number) => n.toLocaleString('pt-BR');
export const fmtMoney = (n: number, c: Currency = 'BRL') =>
  n.toLocaleString(c === 'USD' ? 'en-US' : 'pt-BR', { style: 'currency', currency: c });
export const pl = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  // datas puras (AAAA-MM-DD) não podem "voltar um dia" por causa do fuso
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, m, day] = d.split('-'); return `${day}/${m}/${y}`; }
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

export const STATUS_LABEL: Record<InvoiceStatus, [string, string]> = {
  pending: ['Em aberto', 'amber'],
  paid: ['Paga', 'green'],
  overdue: ['Vencida', 'red'],
  refunded: ['Reembolsada', 'blue'],
  canceled: ['Cancelada', ''],
};

export const KIND_LABEL: Record<InvoiceKind, string> = {
  subscription: 'Mensalidade',
  instances: 'Instâncias',
  tokens: 'Tokens de IA',
  dispatch: 'Disparos extras',
};

export const METHOD_LABEL: Record<string, string> = { pix: 'Pix', card: 'Cartão', boleto: 'Boleto', paypal: 'PayPal' };
export const methodLabel = (m: string | null | undefined, gateway?: string | null) =>
  m ? METHOD_LABEL[m] ?? m : gateway === 'paddle' ? 'Paddle' : '—';

/** Abre a página de pagamento do gateway numa aba nova (a tela daqui atualiza sozinha quando o pagamento cai). false = o navegador bloqueou. */
export function openPayment(url: string) {
  const w = window.open(url, '_blank');
  if (!w) return false;
  try { w.opener = null; } catch { /* outra origem */ }
  return true;
}

/** Só letras maiúsculas e números (o CNPJ novo, de 31/07/2026 em diante, pode ter letras). */
export const normDoc = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '');

/** CPF (000.000.000-00) ou CNPJ (00.000.000/0000-00, com ou sem letras) enquanto digita. */
export function maskDoc(v: string) {
  const d = normDoc(v).slice(0, 14);
  if (d.length <= 11 && /^\d*$/.test(d)) {
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 8)].filter(Boolean).join('.')
    + (d.length > 8 ? `/${d.slice(8, 12)}` : '') + (d.length > 12 ? `-${d.slice(12)}` : '');
}

function cpfOk(d: string) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const dv = (len: number) => { let s = 0; for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
/** Módulo 11 com o valor de cada caractere = código ASCII − 48 (vale para o CNPJ numérico e o com letras). */
function cnpjOk(d: string) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d) || /^(.)\1+$/.test(d)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = w.reduce((a, x, i) => a + (d.charCodeAt(i) - 48) * x, 0) % 11; return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}
/** Mesma conta que o servidor faz (dígitos verificadores), para avisar antes de enviar. */
export const docValid = (v: string) => { const d = normDoc(v); return d.length === 11 ? cpfOk(d) : d.length === 14 ? cnpjOk(d) : false; };
