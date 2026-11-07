import { api } from '../api';
import { toast } from '../components/ui';
import { openPayment, type Invoice } from './types';

/** Abre o link de pagar/ver de uma fatura (o PDF da Paddle é gerado na hora). */
export async function openInvoice(inv: Pick<Invoice, 'id'>) {
  try {
    const r = await api.get<{ url: string }>(`/billing/invoices/${inv.id}/link`);
    if (!openPayment(r.url)) window.location.assign(r.url);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Não foi possível abrir a fatura');
  }
}
