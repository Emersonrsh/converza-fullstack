import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../icons';
import { getSocket } from '../socket';

interface Notice { id: number; kind: string; title: string; body: string; conversationId?: string | null; at: string }

let seq = 0;

/** Avisos em tempo real para a equipe (ex.: "Venda aprovada" de um fluxo), com aviso do navegador se permitido. */
export function AppNotices({ accountId }: { accountId: string | null }) {
  const nav = useNavigate();
  const [list, setList] = useState<Notice[]>([]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = (n: Omit<Notice, 'id'>) => {
      const id = ++seq;
      setList((l) => [...l.slice(-3), { ...n, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 9000);
      // com a aba em segundo plano, o aviso do sistema (o card na tela não seria visto)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          const sys = new Notification(n.title, { body: n.body, tag: `converza-${n.kind}-${n.at}`, icon: '/favicon.svg' });
          sys.onclick = () => { window.focus(); if (n.conversationId) nav(`/inbox?c=${n.conversationId}`); sys.close(); };
        } catch { /* navegador sem suporte a avisos fora de um service worker */ }
      }
    };
    sock.on('app:notify', on);
    return () => { sock.off('app:notify', on); };
  }, [accountId, nav]);

  if (!list.length) return null;
  return (
    <div className="app-notices" data-testid="app-notices">
      {list.map((n) => (
        <div key={n.id} className="app-notice fade" role="status">
          <span className="ic-wrap"><Icon name={n.kind === 'sale' ? 'dollar' : 'bell'} size={17} /></span>
          <button type="button" className="txt" onClick={() => { if (n.conversationId) nav(`/inbox?c=${n.conversationId}`); setList((l) => l.filter((x) => x.id !== n.id)); }}>
            <b>{n.title}</b>{n.body && <small>{n.body}</small>}
          </button>
          <button type="button" className="x" onClick={() => setList((l) => l.filter((x) => x.id !== n.id))} aria-label="Fechar aviso"><Icon name="close" size={13} /></button>
        </div>
      ))}
    </div>
  );
}
