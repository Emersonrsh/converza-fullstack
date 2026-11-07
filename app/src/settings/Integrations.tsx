import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner } from '../components/ui';
import { Badge, Head, LoadError, relTime, useLoad } from './common';

interface Item { id: string; name: string; href: string; description: string; state: 'ok' | 'warn' | 'off'; detail: string; lastAt?: string | null }
interface Resp { items: Item[]; server: { id: string; name: string; on: boolean; hint: string }[]; showServerHints: boolean }

const ICON: Record<string, string> = { whatsapp: 'phone', facebook_ads: 'megaphone', pixels: 'target', webhooks: 'webhook', tracking: 'link', mcp: 'key' };
const STATE: Record<Item['state'], [string, string]> = { ok: ['Conectado', 'green'], warn: ['Precisa de atenção', 'amber'], off: ['Não configurado', ''] };

export function IntegrationsPage() {
  const { accountId } = useAuth();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/integrations'), [accountId]);
  if (error && !data) return <><Head slug="integracoes" /><LoadError error={error} onRetry={reload} /></>;
  if (!data) return <><Head slug="integracoes" /><Spinner /></>;
  return (
    <div data-testid="integrations-page">
      <Head slug="integracoes" />
      <div className="st-grid2">
        {data.items.map((i) => {
          const [label, tone] = STATE[i.state];
          return (
            <div key={i.id} className="st-int-card" data-testid={`int-${i.id}`}>
              <div className="top">
                <span className={`st-stat-ic ${i.state === 'ok' ? 'green' : i.state === 'warn' ? 'amber' : 'gray'}`}><Icon name={ICON[i.id] ?? 'plug'} size={18} /></span>
                <b>{i.name}</b>
                <Badge tone={tone}>{label}</Badge>
              </div>
              <p>{i.description}</p>
              <div className="det">{i.detail}{i.lastAt ? <span className="st-mini"> · último evento {relTime(i.lastAt)}</span> : null}</div>
              <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => nav(i.href)}>{i.state === 'off' ? 'Configurar' : 'Abrir'}<Icon name="chevronRight" size={13} /></button>
            </div>
          );
        })}
      </div>

      <div className="st-section-t"><Icon name="server" size={15} />Recursos do servidor <small>— ligados por quem hospeda o Converza</small></div>
      <div className="st-tbl">
        <table>
          <tbody>
            {data.server.map((s) => (
              <tr key={s.id} data-testid={`srv-${s.id}`}>
                <td><b>{s.name}</b></td>
                <td style={{ width: 160 }}><Badge tone={s.on ? 'green' : ''}>{s.on ? 'Disponível' : 'Desligado'}</Badge></td>
                {data.showServerHints && <td className="st-mini">{s.on ? '' : `Variável: ${s.hint}`}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
