/** Leitura dos eventos de venda recebidos por webhook (sem dependências, para testar isolado). */

export function mapSaleStatus(s: string): 'pending' | 'approved' | 'refused' | 'refunded' {
  const v = s.toLowerCase();
  // eventos negativos primeiro (um "pedido pago" que depois é estornado vira reembolso)
  if (v.includes('refund') || v.includes('estorn') || v.includes('reembols') || /charge_?d?_?back|contesta/.test(v)) return 'refunded';
  if (v.includes('refus') || v.includes('recus') || v.includes('declin') || v.includes('cancel') || v.includes('expir') || v.includes('rejected')) return 'refused';
  if (/unpaid|n[aã]o pago|not paid/.test(v)) return 'pending';
  if (v.includes('approv') || v.includes('aprov') || v.includes('paid') || v.includes('pago') || v.includes('complete')) return 'approved';
  return 'pending';
}

/* ----------------------------------------------------------- leitura do evento */

const get = (o: any, path: string) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function first(o: any, paths: string[]): any {
  for (const p of paths) {
    const v = get(o, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
/** "R$ 1.297,90" / "97.5" / 97 → número (reais). */
export function parseMoney(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!s) return 0;
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(norm) || 0;
}

/**
 * Extrai os dados da venda de formatos comuns (genérico, Hotmart, Kiwify e similares).
 * O mapeamento específico por plataforma é revisado no módulo Webhooks de entrada.
 */
export function extractSale(body: Record<string, any>) {
  const phone = String(first(body, [
    'customer.phone', 'customer.whatsapp', 'customer.mobile', 'customer.cellphone', 'buyer.phone', 'buyer.checkout_phone',
    'data.buyer.checkout_phone', 'data.buyer.phone', 'Customer.mobile', 'client.phone', 'cliente.telefone', 'phone', 'telefone', 'whatsapp',
  ]) ?? '').replace(/\D/g, '');
  const name = String(first(body, [
    'customer.name', 'customer.full_name', 'buyer.name', 'data.buyer.name', 'Customer.full_name', 'client.name', 'cliente.nome', 'name', 'nome',
  ]) ?? 'Cliente');
  const emailRaw = String(first(body, [
    'customer.email', 'buyer.email', 'data.buyer.email', 'Customer.email', 'client.email', 'cliente.email', 'email',
  ]) ?? '').trim().toLowerCase();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw) ? emailRaw : null;
  const event = String(first(body, ['event', 'status', 'order_status', 'data.purchase.status']) ?? '');
  const statusRaw = String(first(body, ['status', 'order_status', 'data.purchase.status', 'event']) ?? '');
  return {
    phone, name, email, event,
    amount: parseMoney(first(body, ['amount', 'price', 'value', 'valor', 'total', 'data.purchase.price.value', 'purchase.price.value', 'order.total'])),
    status: mapSaleStatus(`${statusRaw} ${event}`),
    currency: String(first(body, ['currency', 'moeda', 'data.purchase.price.currency_value', 'purchase.price.currency_value', 'order.currency']) ?? 'BRL'),
    externalId: first(body, ['transaction', 'transaction_id', 'order_id', 'orderId', 'sale_id', 'data.purchase.transaction', 'purchase.transaction', 'id']) as string | undefined,
    productName: first(body, ['product.name', 'product_name', 'produto', 'data.product.name', 'Product.product_name', 'offer.name']) as string | undefined,
    state: first(body, ['customer.state', 'customer.address.state', 'buyer.address.state', 'data.buyer.address.state', 'Customer.state', 'address.state', 'estado', 'uf']) as string | undefined,
    sourceId: first(body, ['source_id', 'sourceId', 'utm_content', 'tracking.source_id']) as string | undefined,
  };
}
