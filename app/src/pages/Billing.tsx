import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import type { Plan, Subscription } from '../types';

export function Billing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);

  const load = () => Promise.all([
    api.get<{ plans: Plan[] }>('/billing/plans'),
    api.get<{ subscription: Subscription | null }>('/billing/subscription'),
  ]).then(([p, s]) => { setPlans(p.plans); setSub(s.subscription); });
  useEffect(() => { load(); }, []);

  async function subscribe(plan: string) {
    await api.post('/billing/subscribe', { plan }); load(); toast('Assinatura ativada');
  }

  if (!plans) return <Spinner />;
  const active = sub?.status === 'active';

  return (
    <div className="fade grid">
      <div className="card pad" style={{ background: active ? 'var(--success-50)' : 'var(--accent-50)', borderColor: active ? 'var(--success)' : 'var(--accent)' }}>
        <div className="row"><div><b style={{ fontSize: 15 }}>{active ? `Assinatura ativa — plano ${sub?.plan}` : 'Assinatura inativa'}</b>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{active ? 'Tudo liberado.' : 'Escolha um plano para liberar conexões, disparos e agentes de IA.'}</div></div>
          <div className="spacer" /><span className={`pill ${active ? 'green' : 'amber'} dot`}>{active ? 'ativa' : 'inativa'}</span></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {plans.map((p) => (
          <div className="card pad" key={p.id} style={p.id === 'growth' ? { border: '2px solid var(--primary)', position: 'relative' } : { position: 'relative' }}>
            {p.id === 'growth' && <span className="pill teal" style={{ position: 'absolute', top: -11, left: 18 }}>Mais popular</span>}
            <b style={{ fontSize: 16 }}>{p.name}</b>
            <div style={{ margin: '10px 0' }}><span style={{ fontSize: 30, fontWeight: 800 }}>{money(p.price)}</span><span className="muted">/mês</span></div>
            <div className="grid" style={{ gap: 9, margin: '14px 0' }}>
              {p.features.map((f) => <div className="row" key={f} style={{ gap: 9, fontSize: 13 }}><Icon name="check" size={16} /><span>{f}</span></div>)}
            </div>
            <button className={`btn ${p.id === 'growth' ? 'primary' : ''}`} style={{ width: '100%' }} onClick={() => subscribe(p.id)}
              disabled={active && sub?.plan === p.id}>
              {active && sub?.plan === p.id ? 'Plano atual' : 'Assinar'}
            </button>
          </div>
        ))}
      </div>
      <div className="faint" style={{ fontSize: 12 }}>Pagamento real (cartão/Pix) entra atrás do botão Assinar via gateway — ative com suas chaves.</div>
    </div>
  );
}
