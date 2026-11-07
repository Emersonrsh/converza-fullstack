import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Field, Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import type { ContactField } from './types';

let cache: Promise<ContactField[]> | null = null;
export function loadFields(refresh = false): Promise<ContactField[]> {
  if (!cache || refresh) cache = api.get<{ fields: ContactField[] }>('/contacts/fields').then((r) => r.fields).catch(() => []);
  return cache;
}
export function useContactFields() {
  const [fields, setFields] = useState<ContactField[] | null>(null);
  useEffect(() => { let alive = true; loadFields().then((f) => alive && setFields(f)); return () => { alive = false; }; }, []);
  return fields;
}

export const TYPE_LABEL: Record<ContactField['type'], string> = { text: 'Texto', number: 'Número', date: 'Data', select: 'Lista de opções' };

/** Valor exibido: datas em dd/mm/aaaa, números com vírgula. */
export function fieldDisplay(f: ContactField, v: string | undefined) {
  if (!v) return '';
  if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split('-').reverse().join('/');
  if (f.type === 'number') return v.replace('.', ',');
  return v;
}

export function FieldInput({ field, value, onChange, onCommit, small }: {
  field: ContactField; value: string; onChange: (v: string) => void; onCommit?: (v: string) => void; small?: boolean;
}) {
  const cls = cx(field.type === 'select' ? 'select' : 'input', small && 'sm');
  if (field.type === 'select') {
    return (
      <select className={cls} value={value} onChange={(e) => { onChange(e.target.value); onCommit?.(e.target.value); }} aria-label={field.label} data-testid={`field-${field.key}`}>
        <option value="">—</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  return (
    <input className={cls} type={field.type === 'date' ? 'date' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined}
      value={field.type === 'number' ? value.replace('.', ',') : value} placeholder={field.type === 'number' ? '0' : ''}
      onChange={(e) => onChange(e.target.value)} onBlur={(e) => onCommit?.(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && onCommit) e.currentTarget.blur(); }} aria-label={field.label} data-testid={`field-${field.key}`} />
  );
}

/** Campos personalizados de um contato (formulário). */
export function CustomFieldsEditor({ fields, values, onChange }: {
  fields: ContactField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void;
}) {
  if (!fields.length) return null;
  return (
    <div className="cf-grid">
      {fields.map((f) => (
        <Field key={f.id} label={f.label}>
          <FieldInput field={f} value={values[f.key] ?? ''} onChange={(v) => onChange({ ...values, [f.key]: v })} />
        </Field>
      ))}
    </div>
  );
}

/** Configurações › Campos personalizados: criar, editar, ordenar e excluir. */
export function FieldsManager() {
  const [list, setList] = useState<ContactField[] | null>(null);
  const [editing, setEditing] = useState<ContactField | null>(null);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ContactField['type']>('text');
  const [options, setOptions] = useState('');
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<ContactField | null>(null);

  const load = useCallback(async () => setList(await loadFields(true)), []);
  useEffect(() => { void load(); }, [load]);

  function edit(f: ContactField | null) {
    setEditing(f); setLabel(f?.label ?? ''); setType(f?.type ?? 'text'); setOptions(f?.options.join(', ') ?? '');
  }

  async function save() {
    if (!label.trim() || busy) return;
    const body = { label: label.trim(), type, options: type === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : [] };
    if (type === 'select' && !body.options.length) { toast('Escreva as opções separadas por vírgula'); return; }
    setBusy(true);
    try {
      if (editing) await api.patch(`/contacts/fields/${editing.id}`, body);
      else await api.post('/contacts/fields', body);
      toast(editing ? 'Campo atualizado' : `Campo “${body.label}” criado`);
      edit(null);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); }
    setBusy(false);
  }

  async function move(i: number, dir: -1 | 1) {
    if (!list) return;
    const ids = list.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setList(ids.map((id) => list.find((f) => f.id === id)!));
    try { await api.put('/contacts/fields/order', { ids }); await loadFields(true); } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); void load(); }
  }

  if (!list) return <div style={{ height: 120 }}><Spinner /></div>;
  return (
    <div className="stack" style={{ gap: 16 }} data-testid="fields-manager">
      <div>
        <b style={{ fontSize: 15 }}>Campos personalizados</b>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Informações extras dos contatos (CPF, cidade, plano…). Aparecem no cadastro, no Chats ao vivo, na importação/exportação em CSV e nos fluxos como <code>{'{{campos.chave}}'}</code>.</div>
      </div>
      <div className="fm-form">
        <Field label="Nome do campo"><input className="input" maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: CPF" data-testid="field-label" /></Field>
        <Field label="Tipo">
          <select className="select" value={type} onChange={(e) => setType(e.target.value as ContactField['type'])} data-testid="field-type">
            {(Object.keys(TYPE_LABEL) as ContactField['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </Field>
        {type === 'select' && (
          <Field label="Opções (separe por vírgula)"><input className="input" value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Básico, Pro, Premium" data-testid="field-options" /></Field>
        )}
        <div className="row" style={{ gap: 8, alignSelf: 'end' }}>
          {editing && <button type="button" className="btn" onClick={() => edit(null)}>Cancelar</button>}
          <button type="button" className="btn primary" disabled={!label.trim() || busy} onClick={save} data-testid="field-save">{editing ? 'Salvar' : 'Adicionar campo'}</button>
        </div>
      </div>
      {list.length === 0 ? <div className="empty" style={{ padding: 20 }}>Nenhum campo personalizado ainda.</div> : (
        <table className="fm-table">
          <thead><tr><th>Campo</th><th>Tipo</th><th>Variável nos fluxos</th><th /></tr></thead>
          <tbody>
            {list.map((f, i) => (
              <tr key={f.id} data-testid="field-row">
                <td><b>{f.label}</b>{f.type === 'select' && <div className="faint" style={{ fontSize: 11.5 }}>{f.options.join(' · ')}</div>}</td>
                <td>{TYPE_LABEL[f.type]}</td>
                <td><code>{`{{campos.${f.key}}}`}</code></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><Icon name="chevronUp" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Descer"><Icon name="chevron" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" onClick={() => edit(f)} aria-label="Editar"><Icon name="edit" size={14} /></button>
                  <button type="button" className="btn icon sm ghost" onClick={() => setDel(f)} aria-label="Excluir"><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {del && (
        <ConfirmModal title="Excluir campo" confirm="Excluir campo" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/contacts/fields/${del.id}`); toast('Campo excluído'); setDel(null); await load(); }
          catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível excluir'); }
        }}>
          Excluir o campo <b>{del.label}</b>? O valor dele será apagado de todos os contatos.
        </ConfirmModal>
      )}
    </div>
  );
}
