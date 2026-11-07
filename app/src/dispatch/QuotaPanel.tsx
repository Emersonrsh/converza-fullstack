import type { ReactNode } from 'react';
import { money } from '../api';
import { Icon } from '../icons';
import type { DispatchList } from './types';

const fmt = (n: number) => n.toLocaleString('pt-BR');

function Stat({ value, label, help, testId }: { value: ReactNode; label: string; help?: string; testId?: string }) {
  return (
    <div className="card ds-stat" data-testid={testId}>
      <b>{value}</b>
      <span>{label}{help && <span className="ds-help" title={help} aria-label={help} tabIndex={0}><Icon name="help" size={13} /></span>}</span>
    </div>
  );
}

export type PackChoice = { pack: DispatchList['packs'][number]; gateway: 'asaas' | 'paddle' };

/** Cota do ciclo + compra de disparos extras (página Disparos e Configurações › Disparos em massa). */
export function QuotaPanel({ data, onBuy }: { data: DispatchList; onBuy: (c: PackChoice) => void }) {
  const q = data.quota;
  const renew = new Date(q.cycleEnd).toLocaleDateString('pt-BR');
  return (
    <>
      <div className="ds-stats">
        <Stat value={fmt(q.remaining)} label="Restantes" testId="ds-remaining"
          help={`O que sobra da cota do ciclo (${fmt(Math.max(0, q.cycleLimit - q.usedInCycle))}) + saldo extra (${fmt(q.extra)}). A cota renova em ${renew}; o saldo extra não vence.`} />
        <Stat value={<>{fmt(q.usedInCycle)}<small> / {fmt(q.cycleLimit)}</small></>} label="Usados no ciclo" testId="ds-used" />
        <Stat value={fmt(data.counts.running)} label="Em andamento" testId="ds-running" />
        <Stat value={fmt(data.counts.done)} label="Concluídos" testId="ds-done" />
      </div>

      {data.canEdit && (
        <section className="card ds-buy" data-testid="ds-buy">
          <b>Comprar disparos extras</b>
          <small>Pacote fechado. Entra no saldo extra e não mexe na cota do ciclo (1.000 disparos por instância contratada).</small>
          <div className="ds-packs">
            {data.packs.map((p) => (
              <div key={p.id} className="ds-pack" data-testid="ds-pack">
                <b>{fmt(p.quantity)} disparos extras</b>
                <strong>{money(p.price)}</strong>
                <div className="ds-pack-btns">
                  <button type="button" className="btn primary" disabled={!data.purchase.enabled || !data.purchase.asaas}
                    title={!data.purchase.asaas ? 'Pix e cartão (Asaas) não configurados neste servidor' : data.purchase.message ?? undefined}
                    onClick={() => onBuy({ pack: p, gateway: 'asaas' })} data-testid="ds-buy-asaas"><span className="ds-br">BR</span>Pix ou cartão</button>
                  <button type="button" className="btn" disabled={!data.purchase.enabled || !data.purchase.paddle}
                    title={!data.purchase.paddle ? 'Paddle não configurada neste servidor' : data.purchase.message ?? undefined}
                    onClick={() => onBuy({ pack: p, gateway: 'paddle' })} data-testid="ds-buy-paddle"><Icon name="globe" size={14} />Paddle (internacional)</button>
                </div>
              </div>
            ))}
          </div>
          <small>O que sobrar continua no próximo mês. O que já foi gasto não volta.{q.extra > 0 ? ` Saldo extra hoje: ${fmt(q.extra)}.` : ''}</small>
          {data.purchase.message && <div className="hint" data-testid="ds-buy-off"><Icon name="info" size={14} />{data.purchase.message}</div>}
        </section>
      )}

    </>
  );
}
