import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Modal, cx, toast } from '../components/ui';
import { useSocketEvent } from '../settings/common';

interface Smart { enabled: boolean; offers: number; steps: number; conversations30: number; aiEnabled: boolean }

let cached: Smart | null = null;

/** Botão do topo da conversa: liga e desliga a Automatização inteligente da conta. */
export function SmartToggle() {
  const { accounts, accountId } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [s, setS] = useState<Smart | null>(cached);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => { api.get<{ smart: Smart }>('/agents/smart').then((r) => { cached = r.smart; setS(r.smart); }).catch(() => undefined); };
  useEffect(load, [accountId]);
  useSocketEvent('smart:updated', load);

  async function save(enabled: boolean) {
    setBusy(true);
    try {
      const r = await api.put<{ smart: Smart }>('/agents/smart', { enabled });
      cached = r.smart; setS(r.smart); setAsk(false);
      toast(enabled ? 'Automatização inteligente ligada' : 'Automatização inteligente desligada');
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  }

  if (!s) return null;
  const title = s.enabled
    ? `Ligada: conhece ${s.offers} oferta${s.offers === 1 ? '' : 's'} dos fluxos ativos e responde quando o fluxo não anda ou o cliente vai para o suporte`
    : 'Desligada: clique para a IA responder quando o fluxo não andar e atender quem vai para o suporte';
  return (
    <>
      <button type="button" className={cx('cv-smart', s.enabled && 'on')} title={canEdit ? title : `${title} (só donos e administradores mudam)`}
        onClick={() => { if (!canEdit || busy) return; if (s.enabled) void save(false); else setAsk(true); }} aria-pressed={s.enabled} data-testid="smart-toggle">
        <span className="cv-smart-ic">✨</span>
        <span>Automatização inteligente</span>
        <i className={cx('switch', s.enabled && 'on')}><i /></i>
      </button>
      {ask && (
        <Modal title="Ligar a Automatização inteligente?" icon="bolt" onClose={() => setAsk(false)} width={460}
          footer={<><button className="btn" onClick={() => setAsk(false)}>Cancelar</button><button className="btn primary" disabled={busy} onClick={() => void save(true)} data-testid="smart-confirm">Ligar</button></>}>
          <p>Ela vai responder clientes de verdade, em todas as conversas que vieram pelos fluxos:</p>
          <ul className="cv-smart-list">
            <li>quando a resposta do cliente não faz o fluxo andar;</li>
            <li>quando um fluxo manda o cliente para um setor de suporte, e daí até a venda;</li>
            <li>levando o cliente para a etapa certa dos fluxos quando a conversa pedir.</li>
          </ul>
          <p className="faint">Hoje ela conhece {s.offers} fluxo{s.offers === 1 ? '' : 's'} ativo{s.offers === 1 ? '' : 's'} e {s.steps} etapa{s.steps === 1 ? '' : 's'}. Para quando alguém da equipe clica em Atender. Gasta tokens de IA da conta.</p>
          {!s.aiEnabled && <p className="cv-smart-warn">A IA ainda não está configurada na plataforma: ela não vai conseguir responder.</p>}
        </Modal>
      )}
    </>
  );
}
