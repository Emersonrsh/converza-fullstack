import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner } from '../components/ui';
import { DispatchPackModal } from '../billing/modals';
import { QuotaPanel, type PackChoice } from '../dispatch/QuotaPanel';
import type { DispatchList } from '../dispatch/types';
import { Head, LoadError, useLoad, useSocketEvent } from './common';

const RULES: [string, string, string][] = [
  ['flow', 'Cada contato recebe um fluxo', 'O disparo manda um fluxo para cada pessoa do público. Quem falou com você nas últimas 24 horas recebe o fluxo na hora.'],
  ['file', 'Fora das 24 horas, vai um modelo antes', 'Para quem não fala com você há mais de 24 horas, a Meta só permite um modelo aprovado (Templates WhatsApp). O fluxo começa quando a pessoa responder.'],
  ['close', 'Quem pede para sair não recebe mais', 'Se o contato responder SAIR, PARAR ou parecido, ele sai dos disparos em massa na hora (e volta se mandar VOLTAR).'],
  ['timer', 'Pausa sozinho quando precisa', 'Se o número chegar ao limite diário da Meta, o disparo pausa e continua sozinho quando liberar. Se a conexão cair, o fluxo for pausado ou a cota acabar, ele pausa e avisa o motivo.'],
  ['bolt', 'Cota do ciclo + saldo extra', '1.000 disparos por instância contratada a cada ciclo da assinatura. O saldo extra (pacotes) só é usado depois da cota e não vence.'],
];

export function DispatchSettingsPage() {
  const { accountId } = useAuth();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<DispatchList>('/dispatch'), [accountId]);
  useSocketEvent(['campaign:progress', 'billing:changed'], () => void reload());
  const [buy, setBuy] = useState<PackChoice | null>(null);
  const head = <Head slug="disparos" actions={<button type="button" className="btn primary" onClick={() => nav('/dispatch')} data-testid="open-dispatch"><Icon name="send" size={15} />Abrir Disparos em massa</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  return (
    <div data-testid="dispatch-settings" className="ds-page">
      {head}
      <QuotaPanel data={data} onBuy={setBuy} />
      <section className="st-card">
        <div className="st-card-h"><b>Regras que valem para todo disparo</b></div>
        <div className="stack" style={{ gap: 10 }}>
          {RULES.map(([icon, title, text]) => (
            <div className="st-toggle-row" key={title} style={{ alignItems: 'flex-start', background: 'var(--surface)' }}>
              <span className="st-stat-ic" style={{ width: 34, height: 34 }}><Icon name={icon} size={16} /></span>
              <div><b>{title}</b><small>{text}</small></div>
            </div>
          ))}
        </div>
      </section>
      {buy && <DispatchPackModal pack={buy.pack} gateway={buy.gateway} hasTaxId={data.purchase.hasTaxId} onClose={() => { setBuy(null); void reload(); }} />}
    </div>
  );
}
