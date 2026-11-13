import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { siDiscord } from 'simple-icons';

export const DISCORD_INVITE = 'https://discord.gg/s8R4yMhEA';

const Mark = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"><path d={siDiscord.path} fill="currentColor" /></svg>
);

/** Telas em que o canto inferior direito é área de trabalho (painel do contato, minimapa do fluxo): o botão fica recolhido na borda. */
const DOCKED = [/^\/inbox/, /^\/flows\/[^/]+/];

/** Botão flutuante (canto inferior direito, em todas as telas) que abre o convite para a comunidade da Converza no Discord. */
export function DiscordInvite() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const docked = DOCKED.some((r) => r.test(pathname));
  useEffect(() => setOpen(false), [pathname]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className={`dc-fab-wrap${docked && !open ? ' docked' : ''}`} ref={box} data-testid="discord-wrap">
      {open && (
        <div className="dc-pop" role="dialog" aria-label="Comunidade da Converza no Discord" data-testid="discord-pop">
          <button type="button" className="dc-x" onClick={() => setOpen(false)} aria-label="Fechar">×</button>
          <div className="dc-pop-ic"><Mark size={26} /></div>
          <b>Entre na comunidade Converza</b>
          <p>Tire dúvidas, troque estratégias com outros usuários e fique por dentro das novidades antes de todo mundo.</p>
          <a className="dc-go" href={DISCORD_INVITE} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} data-testid="discord-join">
            <Mark size={18} /> Entrar no Discord
          </a>
        </div>
      )}
      <button type="button" className={`dc-fab${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-label="Comunidade da Converza no Discord" title="Comunidade no Discord" data-testid="discord-fab">
        <Mark size={28} />
      </button>
    </div>
  );
}
