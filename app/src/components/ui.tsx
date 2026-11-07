import { useEffect, useRef, useState, type ReactNode } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';

export const cx = (...a: Array<string | false | undefined>) => a.filter(Boolean).join(' ');

const PAL = ['#0e9488', '#2f73e0', '#f59e0b', '#8b5cf6', '#e23b3b', '#1a9f52', '#db2777', '#0891b2'];
export const avatarColor = (s: string) => PAL[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length];
export const initials = (s: string) => s.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Fundo escuro de modal/gaveta: fecha só se o clique começou e terminou no próprio fundo
 *  (arrastar a seleção de um campo até fora, ou um botão que "pula" de lugar, não fecha o formulário). */
export function useBackdrop(onClose: () => void) {
  const down = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent) => { down.current = e.target === e.currentTarget; },
    onClick: (e: React.MouseEvent) => { if (down.current && e.target === e.currentTarget) onClose(); down.current = false; },
  };
}

export function Spinner() { return <div className="center"><div className="spin" /></div>; }

export function Avatar({ name, size = 38 }: { name: string; size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.37, background: avatarColor(name) }}>
      {initials(name)}
    </div>
  );
}

export function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={cx('switch', on && 'on')} onClick={onClick} aria-pressed={on}><i /></button>;
}

export function Modal({ title, onClose, children, footer, subtitle, icon, width }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; subtitle?: string; icon?: string; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Esc fecha (só o modal de cima, se houver mais de um)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.modal-bg');
      if (all[all.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const bg = useBackdrop(onClose);
  return (
    <div className="modal-bg" ref={ref} {...bg}>
      <div className="modal fade" style={width ? { maxWidth: width } : undefined} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh">
          <div className="mh-t">
            {icon && <span className="mh-ic"><Icon name={icon} size={18} /></span>}
            <div><b style={{ fontSize: 15 }}>{title}</b>{subtitle && <small>{subtitle}</small>}</div>
          </div>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="mb">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </div>
  );
}

/** Troca o subtítulo da barra do topo (ex.: "120 contatos • 45 ativos • 98 leads"). */
export function TopbarSub({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setEl(document.getElementById('topbar-sub')); }, []);
  return el ? createPortal(children, el) : null;
}

/** Botões no canto direito da barra do topo da página (ex.: "+ Novo Kanban"). */
export function TopbarActions({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setEl(document.getElementById('topbar-actions')); }, []);
  return el ? createPortal(children, el) : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/* Toast simples via evento global */
export function toast(message: string) {
  window.dispatchEvent(new CustomEvent('converza:toast', { detail: message }));
}
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const handler = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(t); t = setTimeout(() => setMsg(null), 2200);
    };
    window.addEventListener('converza:toast', handler);
    return () => { window.removeEventListener('converza:toast', handler); clearTimeout(t); };
  }, []);
  if (!msg) return null;
  return <div className="toast fade">{msg}</div>;
}
