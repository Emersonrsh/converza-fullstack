import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { cx } from './ui';

export interface TagDef { id: string; name: string; color: string; }

let cache: Promise<TagDef[]> | null = null;
/** Etiquetas da conta (carregadas uma vez; `refresh` força recarregar). */
export function loadTags(refresh = false): Promise<TagDef[]> {
  if (!cache || refresh) cache = api.get<{ tags: TagDef[] }>('/settings/tags').then((r) => r.tags).catch(() => []);
  return cache;
}

export function useTags(refreshKey = 0) {
  const [tags, setTags] = useState<TagDef[]>([]);
  useEffect(() => { let alive = true; loadTags(refreshKey > 0).then((t) => alive && setTags(t)); return () => { alive = false; }; }, [refreshKey]);
  return tags;
}

export const tagColor = (tags: TagDef[], name: string) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.color ?? '#64748b';

/** Escolha de várias etiquetas: busca, sugere as da conta e permite criar uma nova digitando. */
export function TagPicker({ value, onChange, placeholder = 'Adicionar etiqueta…', allowCreate = true, testId }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; allowCreate?: boolean; testId?: string;
}) {
  const tags = useTags();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const has = (n: string) => value.some((v) => v.toLowerCase() === n.toLowerCase());
  const t = q.trim();
  const options = tags.filter((x) => !has(x.name) && x.name.toLowerCase().includes(t.toLowerCase())).slice(0, 12);
  const exact = tags.some((x) => x.name.toLowerCase() === t.toLowerCase()) || has(t);
  // fecha a lista depois de escolher: aberta, ela cobriria o rodapé dos modais (botão de salvar)
  const add = (n: string) => { const v = n.trim(); if (v && !has(v)) onChange([...value, v]); setQ(''); setOpen(false); };

  return (
    <div className="tp" ref={ref} data-testid={testId}>
      <div className={cx('tp-box', open && 'on')} onClick={() => setOpen(true)}>
        {value.map((v) => (
          <span key={v} className="tp-chip" style={{ ['--tc' as string]: tagColor(tags, v) }}>
            {v}<button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((x) => x !== v)); }} aria-label={`Remover ${v}`}><Icon name="close" size={11} /></button>
          </span>
        ))}
        <input value={q} placeholder={value.length ? '' : placeholder} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const m = tags.find((x) => x.name.toLowerCase() === t.toLowerCase());
              if (m) add(m.name); else if (t && allowCreate) add(t); else if (options[0]) add(options[0].name);
            }
            if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
            if (e.key === 'Escape') setOpen(false);
          }} aria-label="Etiquetas" />
      </div>
      {open && (options.length > 0 || (t && allowCreate && !exact) || (!tags.length && !t)) && (
        <div className="tp-pop fade">
          {options.map((x) => <button type="button" key={x.id} onClick={() => add(x.name)}><i style={{ background: x.color }} />{x.name}</button>)}
          {t && allowCreate && !exact && <button type="button" onClick={() => add(t)} data-testid="tp-create"><Icon name="plus" size={12} />Criar “{t}”</button>}
          {!tags.length && !t && <div className="tp-empty">Nenhuma etiqueta ainda. Digite para criar.</div>}
        </div>
      )}
    </div>
  );
}
