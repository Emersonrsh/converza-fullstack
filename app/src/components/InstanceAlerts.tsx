import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { getSocket } from '../socket';
import { cx } from './ui';

interface Alert { connectionId: string; kind: 'banned' | 'down' | 'restricted'; title: string; body: string; at: number }

/** Aviso na tela quando um número cai, é banido ou fica restrito (fica até a pessoa fechar). */
export function InstanceAlerts({ accountId }: { accountId: string | null }) {
  const [list, setList] = useState<Alert[]>([]);
  const nav = useNavigate();
  useEffect(() => {
    setList([]);
    if (!accountId) return;
    const sock = getSocket();
    const on = (a: Omit<Alert, 'at'>) => setList((l) => [{ ...a, at: Date.now() }, ...l.filter((x) => !(x.connectionId === a.connectionId && x.kind === a.kind))].slice(0, 3));
    sock?.on('instance:alert', on);
    return () => { sock?.off('instance:alert', on); };
  }, [accountId]);
  if (!list.length) return null;
  const close = (a: Alert) => setList((l) => l.filter((x) => x !== a));
  return (
    <div className="inst-alerts" role="alert" aria-live="assertive">
      {list.map((a) => (
        <div key={`${a.connectionId}-${a.kind}-${a.at}`} className={cx('inst-alert', a.kind)} data-testid="instance-alert">
          <span className="inst-alert-ic"><Icon name={a.kind === 'banned' ? 'ban' : 'alert'} size={18} /></span>
          <div className="inst-alert-t">
            <b>{a.title.replace(/^[^\p{L}\d]+/u, '')}</b>
            <span>{a.body}</span>
            <button type="button" className="btn sm" onClick={() => { close(a); nav('/connections'); }}>Abrir Conexões</button>
          </div>
          <button type="button" className="btn icon sm ghost" onClick={() => close(a)} aria-label="Fechar aviso"><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
