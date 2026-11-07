import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';
import type { Leaf } from './types';

/**
 * Escolha de um campo do evento recebido: lista os campos do exemplo com o valor ao lado,
 * busca pelo nome ou pelo valor e aceita um caminho digitado (ex.: data.buyer.phone).
 */
export function PathPicker({ value, onChange, leaves, specials, placeholder = 'Escolher campo do evento', testId, disabled }: {
  value: string | undefined; onChange: (v: string | undefined) => void; leaves: Leaf[];
  /** nomes prontos (status_venda, valor…) oferecidos antes dos campos do JSON */
  specials?: [string, string][]; placeholder?: string; testId?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); }, [open]);

  const t = q.trim().toLowerCase();
  const sp = (specials ?? []).filter(([k, l]) => !t || k.includes(t) || l.toLowerCase().includes(t));
  const ls = leaves.filter((l) => !t || l.path.toLowerCase().includes(t) || l.value.toLowerCase().includes(t)).slice(0, 80);
  const special = specials?.find(([k]) => k === value);
  const leaf = leaves.find((l) => l.path === value);
  const typed = q.trim();
  const canUseTyped = typed && !leaves.some((l) => l.path === typed) && !specials?.some(([k]) => k === typed) && /^[^{}\s][^{}]*$/.test(typed);
  const pick = (v: string | undefined) => { onChange(v); setOpen(false); setQ(''); };

  return (
    <div className={cx('ss wh-pp', disabled && 'disabled')} ref={ref} data-testid={testId}>
      <button type="button" className={cx('ss-box wh-pp-box', open && 'on', !value && 'empty')} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {value ? (
          special ? <span className="wh-pp-val"><b>{special[1]}</b></span>
            : <span className="wh-pp-val"><code>{value}</code>{leaf ? <small>{leaf.value || 'vazio'}</small> : leaves.length ? <small className="miss">não veio no exemplo</small> : null}</span>
        ) : <span className="wh-pp-ph">{placeholder}</span>}
        {value && !disabled ? <span role="button" tabIndex={0} className="ss-clear" aria-label="Limpar" onClick={(e) => { e.stopPropagation(); pick(undefined); }}><Icon name="close" size={12} /></span>
          : <Icon name="chevron" size={13} />}
      </button>
      {open && (
        <div className="ss-pop wh-pp-pop fade">
          <input ref={input} className="input sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pelo nome ou valor, ou digitar o caminho"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter') {
                e.preventDefault();
                // igual a um campo ou nome pronto → ele; senão o primeiro da lista; senão o caminho digitado
                const exactLeaf = leaves.find((l) => l.path === typed);
                const exactSp = specials?.find(([k]) => k === typed);
                if (exactLeaf) pick(exactLeaf.path); else if (exactSp) pick(exactSp[0]); else if (sp[0]) pick(sp[0][0]); else if (ls[0]) pick(ls[0].path); else if (canUseTyped) pick(typed);
              }
            }} data-testid={testId ? `${testId}-q` : undefined} />
          {sp.length > 0 && <div className="wh-pp-hd">Dados prontos</div>}
          {sp.map(([k, l]) => (
            <button type="button" key={k} className={cx(k === value && 'on')} onClick={() => pick(k)}><span>{l}</span><small>{`{{${k}}}`}</small></button>
          ))}
          {ls.length > 0 && <div className="wh-pp-hd">Campos do evento</div>}
          {ls.map((l) => (
            <button type="button" key={l.path} className={cx(l.path === value && 'on')} onClick={() => pick(l.path)} data-testid="pp-option">
              <code>{l.path}</code><small>{l.value || 'vazio'}</small>
            </button>
          ))}
          {canUseTyped && <button type="button" onClick={() => pick(typed)} data-testid="pp-typed"><span>Usar o caminho <code>{typed}</code></span></button>}
          {!sp.length && !ls.length && !canUseTyped && <div className="ss-empty">{leaves.length ? 'Nada encontrado' : 'Ainda não chegou um evento de exemplo — digite o caminho (ex.: data.buyer.phone)'}</div>}
        </div>
      )}
    </div>
  );
}
