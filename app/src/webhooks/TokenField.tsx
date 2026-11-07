import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { SPECIALS, type Leaf } from './types';

/** Campo de texto com "+ dado": insere {{primeiro_nome}}, {{valor}} ou um campo do evento onde está o cursor. */
export function TokenField({ value, onChange, leaves, vars, placeholder, testId, maxLength = 1024, specials = SPECIALS }: {
  value: string; onChange: (v: string) => void; leaves: Leaf[]; vars: string[]; placeholder?: string; testId?: string; maxLength?: number;
  /** nomes prontos oferecidos (padrão: os do webhook) */
  specials?: [string, string][];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const insert = (token: string) => {
    const at = caret.current ?? value.length;
    const ins = `{{${token}}}`;
    const next = `${value.slice(0, at)}${ins}${value.slice(at)}`.slice(0, maxLength);
    onChange(next);
    setOpen(false); setQ('');
    setTimeout(() => { inp.current?.focus(); const p = at + ins.length; inp.current?.setSelectionRange(p, p); }, 0);
  };
  const t = q.trim().toLowerCase();
  const sp = specials.filter(([k, l]) => !t || k.includes(t) || l.toLowerCase().includes(t));
  const vs = vars.filter((v) => !t || v.includes(t));
  const ls = leaves.filter((l) => !t || l.path.toLowerCase().includes(t) || l.value.toLowerCase().includes(t)).slice(0, 60);

  return (
    <div className="wh-tok" ref={ref}>
      <input ref={inp} className="input" value={value} maxLength={maxLength} placeholder={placeholder} data-testid={testId}
        onChange={(e) => { onChange(e.target.value); caret.current = e.target.selectionStart; }}
        onSelect={(e) => { caret.current = (e.target as HTMLInputElement).selectionStart; }} />
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)} data-testid={testId ? `${testId}-add` : undefined}><Icon name="plus" size={13} />Dado</button>
      {open && (
        <div className="ss-pop wh-pp-pop fade">
          <input className="input sm" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" />
          {sp.length > 0 && <div className="wh-pp-hd">Dados prontos</div>}
          {sp.map(([k, l]) => <button type="button" key={k} onClick={() => insert(k)} data-testid="tok-option"><span>{l}</span><small>{`{{${k}}}`}</small></button>)}
          {vs.length > 0 && <div className="wh-pp-hd">Suas variáveis</div>}
          {vs.map((v) => <button type="button" key={v} onClick={() => insert(v)}><span>{v}</span><small>{`{{${v}}}`}</small></button>)}
          {ls.length > 0 && <div className="wh-pp-hd">Campos do evento</div>}
          {ls.map((l) => <button type="button" key={l.path} onClick={() => insert(l.path)}><code>{l.path}</code><small>{l.value || 'vazio'}</small></button>)}
        </div>
      )}
    </div>
  );
}
