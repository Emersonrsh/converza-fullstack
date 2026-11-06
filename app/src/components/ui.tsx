import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../icons';

export const cx = (...a: Array<string | false | undefined>) => a.filter(Boolean).join(' ');

const PAL = ['#0e9488', '#2f73e0', '#f59e0b', '#8b5cf6', '#e23b3b', '#1a9f52', '#db2777', '#0891b2'];
export const avatarColor = (s: string) => PAL[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PAL.length];
export const initials = (s: string) => s.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

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

export function Modal({ title, onClose, children, footer }:
  { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fade" onClick={(e) => e.stopPropagation()}>
        <div className="mh"><b style={{ fontSize: 15 }}>{title}</b>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="close" /></button></div>
        <div className="mb">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </div>
  );
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
