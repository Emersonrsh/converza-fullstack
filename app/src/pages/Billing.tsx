import { useLocation } from 'react-router-dom';
import { Overview } from '../billing/Overview';
import { InvoiceList } from '../billing/InvoiceList';

/** Cobranças e assinaturas: visão geral, faturas e reembolsos. */
export function Billing() {
  const sub = useLocation().pathname.replace(/^\/billing\/?/, '').split('/')[0];
  if (sub === 'faturas') return <InvoiceList />;
  if (sub === 'reembolsos') return <InvoiceList refunds />;
  return <Overview />;
}
