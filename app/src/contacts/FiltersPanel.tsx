import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';
import type { TagDef } from '../components/TagPicker';
import { STAGES } from './util';
import type { ContactField, ContactFiltersState } from './types';
import type { KBoardSummary } from '../kanban/types';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Painel "Filtros": datas de criação, campo personalizado, etiquetas, etapas do Kanban e etapa do funil. */
export function FiltersPanel({ value, fields, tags, boards, onApply }: {
  value: ContactFiltersState; fields: ContactField[]; tags: TagDef[]; boards: KBoardSummary[];
  onApply: (f: Partial<ContactFiltersState>) => void;
}) {
  const [d, setD] = useState(value);
  const [kq, setKq] = useState('');
  useEffect(() => { setD(value); }, [value]);
  const set = (p: Partial<ContactFiltersState>) => setD((x) => ({ ...x, ...p }));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const shownBoards = boards
    .map((b) => ({ ...b, columns: kq.trim() && !norm(b.name).includes(norm(kq.trim())) ? b.columns.filter((c) => norm(c.name).includes(norm(kq.trim()))) : b.columns }))
    .filter((b) => b.columns.length);

  return (
    <div className="ctf fade" data-testid="filters-panel">
      <div className="ctf-row">
        <label><span>Criado a partir de</span><input className="input sm" type="date" value={d.from} max={d.to || undefined} onChange={(e) => set({ from: e.target.value })} data-testid="cf-from" /></label>
        <label><span>Criado até</span><input className="input sm" type="date" value={d.to} min={d.from || undefined} onChange={(e) => set({ to: e.target.value })} data-testid="cf-to" /></label>
        <label className="wide"><span>Campo personalizado</span>
          <select className="select sm" value={d.field} onChange={(e) => set({ field: e.target.value, ...(e.target.value ? {} : { fieldValue: '' }) })} data-testid="cf-field">
            <option value="">{fields.length ? 'Selecione um campo...' : 'Nenhum campo criado'}</option>
            {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label className="wide"><span>Valor</span>
          <input className="input sm" placeholder={d.field ? 'Opcional. Filtrar por valor...' : 'Escolha um campo primeiro'} disabled={!d.field} value={d.fieldValue}
            onChange={(e) => set({ fieldValue: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') onApply(d); }} data-testid="cf-value" />
        </label>
        <button type="button" className="btn sm primary" onClick={() => onApply(d)} data-testid="cf-apply">Aplicar filtros</button>
        <button type="button" className="btn sm ghost" onClick={() => { const clear = { from: '', to: '', field: '', fieldValue: '', tags: [], columns: [], stages: [] }; setD((x) => ({ ...x, ...clear })); onApply(clear); }} data-testid="cf-clear">
          <Icon name="close" size={13} />Limpar filtros
        </button>
      </div>

      <div className="ctf-group">
        <b>Etiquetas</b>
        {tags.length === 0 ? <small className="ctf-hint">Nenhuma etiqueta disponível. Crie etiquetas primeiro para poder associá-las aos contatos.</small> : (
          <div className="ctf-chips">
            {tags.map((t) => (
              <button type="button" key={t.id} className={cx('ctf-chip', d.tags.includes(t.name) && 'on')} style={{ ['--tc' as string]: t.color }}
                onClick={() => set({ tags: toggle(d.tags, t.name) })} data-testid="cf-tag">{t.name}</button>
            ))}
          </div>
        )}
      </div>

      <div className="ctf-group">
        <b>Etapa do funil</b>
        <div className="ctf-chips">
          {STAGES.map(([v, l]) => <button type="button" key={v} className={cx('ctf-chip', d.stages.includes(v) && 'on')} onClick={() => set({ stages: toggle(d.stages, v) })} data-testid="cf-stage">{l}</button>)}
        </div>
      </div>

      <div className="ctf-group">
        <b>Etapas do Kanban</b>
        <small className="ctf-hint">Contatos com card em qualquer uma das etapas selecionadas.</small>
        {boards.length === 0 ? <small className="ctf-hint">Nenhum quadro no Kanban ainda.</small> : (
          <>
            <div className="fl-search ctf-ksearch">
              <Icon name="search" size={15} />
              <input className="input sm" placeholder="Buscar quadro ou etapa..." value={kq} onChange={(e) => setKq(e.target.value)} data-testid="cf-kanban-search" />
            </div>
            <div className="ctf-boards">
              {shownBoards.map((b) => (
                <div key={b.id}>
                  <small className="ctf-board">{b.name}</small>
                  <div className="ctf-chips">
                    {b.columns.map((c) => (
                      <button type="button" key={c.id} className={cx('ctf-chip', d.columns.includes(c.id) && 'on')} style={{ ['--tc' as string]: c.color }}
                        onClick={() => set({ columns: toggle(d.columns, c.id) })} data-testid="cf-column">{c.name}</button>
                    ))}
                  </div>
                </div>
              ))}
              {shownBoards.length === 0 && <small className="ctf-hint">Nenhum quadro ou etapa com “{kq.trim()}”.</small>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
