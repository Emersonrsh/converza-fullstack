import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons';

/** Aviso de assinatura inativa/pendente (Dashboard, Conexões…). */
export function SubscriptionAlert({ status }: { status: string | null | undefined }) {
  const nav = useNavigate();
  if (status === 'active') return null;
  const pastDue = status === 'past_due';
  return (
    <section className="card subalert" data-testid="sub-alert">
      <Icon name="card" size={18} />
      <div style={{ flex: 1 }}>
        <b>{pastDue ? 'Pagamento pendente' : 'Assinatura inativa'}</b>
        <p>{pastDue
          ? 'A mensalidade não foi paga: os números pararam de enviar mensagens. Pague a fatura em aberto para tudo voltar na hora.'
          : 'Sua assinatura está inativa. Contrate suas instâncias (cada uma é um número de WhatsApp) para começar a usar o serviço.'}</p>
      </div>
      <button type="button" className="btn primary" onClick={() => nav('/billing')}>{pastDue ? 'Pagar fatura' : 'Assinar agora'}</button>
    </section>
  );
}
