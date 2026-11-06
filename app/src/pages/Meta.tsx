import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';

export function Meta() {
  const [status, setStatus] = useState<{ connected: boolean } | null>(null);

  useEffect(() => { api.get<{ connected: boolean }>('/meta/status').then(setStatus); }, []);

  async function connect() {
    const r = await api.post<{ oauthUrl: string }>('/meta/connect');
    toast('Abra o OAuth da Meta para autorizar');
    window.open(r.oauthUrl, '_blank');
  }

  if (!status) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="card pad" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 13, background: 'var(--info-50)', color: 'var(--info)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="meta" size={24} /></div>
        <div style={{ flex: 1 }}><b style={{ fontSize: 15 }}>Conta de anúncios Meta</b>
          <div className="muted" style={{ fontSize: 13 }}>Conecte para medir ROAS, CPA e atribuição de vendas por campanha.</div></div>
        <button className="btn primary" onClick={connect}><Icon name="globe" size={16} />Conectar com a Meta</button>
      </div>
      <div className="empty card" style={{ padding: 40 }}>
        Nenhuma campanha para exibir ainda. Conecte sua conta Meta para puxar os anúncios e cruzar com as vendas.
      </div>
    </div>
  );
}
