import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';

export interface SearchOption { value: string; label: string; hint?: string }

/** Campo de escolha com busca (lista abre ao clicar; "limpar" volta para nenhum). */
export function SearchSelect({ value, options, onChange, placeholder, icon = 'search', testId, empty = 'Nada encontrado' }: {
  value: string | null; options: SearchOption[]; onChange: (v: string | null) => void; placeholder: string; icon?: string; testId?: string; empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const cur = options.find((o) => o.value === value) ?? null;
  const list = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 50);
  return (
    <div className="ss" ref={ref} data-testid={testId}>
      <div className={cx('ss-box', open && 'on')} onClick={() => setOpen(true)}>
        <Icon name={icon} size={14} />
        <input value={open ? q : cur?.label ?? ''} placeholder={cur ? cur.label : placeholder} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { setQ(''); setOpen(true); }} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && list[0]) { e.preventDefault(); onChange(list[0].value); setOpen(false); } }} />
        {cur ? <button type="button" className="ss-clear" onClick={(e) => { e.stopPropagation(); onChange(null); setQ(''); }} aria-label="Limpar"><Icon name="close" size={12} /></button>
          : <Icon name="chevron" size={13} />}
      </div>
      {open && (
        <div className="ss-pop fade">
          {list.map((o) => (
            <button type="button" key={o.value} className={cx(o.value === value && 'on')} onClick={() => { onChange(o.value); setOpen(false); setQ(''); }}>
              <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
            </button>
          ))}
          {!list.length && <div className="ss-empty">{empty}</div>}
        </div>
      )}
    </div>
  );
}
