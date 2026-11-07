import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { Badge, EmptyBox, Head, LoadError, SearchBox, copyText, errMsg, relTime, useDebounced, useLoad, useSocketEvent } from './common';

interface GlobalVar { id: string; key: string; description: string; type: 'text' | 'number'; value: string; updatedAt: string; createdAt: string }

/** Igual ao servidor: "Estoque Loja" → g_estoque_loja */
export const globalKeyOf = (raw: string) => {
  const s = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/^(g_+)+/, '').replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return s ? `g_${s}` : '';
};

function VarModal({ v, onClose, onSaved }: { v: GlobalVar | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(v ? v.key.replace(/^g_/, '') : '');
  const [description, setDescription] = useState(v?.description ?? '');
  const [type, setType] = useState<'text' | 'number'>(v?.type ?? 'text');
  const [value, setValue] = useState(v?.value ?? '');
  const [busy, setBusy] = useState(false);
  const key = globalKeyOf(name);
  const badNumber = type === 'number' && value.trim() !== '' && !/^-?\d+([.,]\d+)?$/.test(value.trim());
  async function save() {
    if (!key || badNumber || busy) return;
    setBusy(true);
    try {
      const body = { name: key, description, type, value };
      const r = v ? await api.patch<{ renamed: { from: string; to: string } | null }>(`/globals/${v.id}`, body) : await api.post('/globals', body);
      const renamed = (r as { renamed?: { from: string; to: string } | null })?.renamed;
      toast(renamed ? `Renomeada para {{${renamed.to}}} — troque nos fluxos que usavam {{${renamed.from}}}` : v ? 'Variável salva' : `{{${key}}} criada`);
      onSaved(); onClose();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  return (
    <Modal title={v ? 'Editar variável global' : 'Nova variável global'} icon="braces" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!key || badNumber || busy} onClick={save} data-testid="gv-save">{busy ? 'Salvando…' : 'Salvar'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <label className="label">Nome</label>
          <div className="qr-sc"><span>g_</span><input className="input" style={{ paddingLeft: 34 }} autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="estoque_promocao" data-testid="gv-name" /></div>
          <div className="st-help">Nos fluxos: <code>{key ? `{{${key}}}` : '{{g_…}}'}</code> — letras, números e _.</div>
        </div>
        <Field label="Descrição"><input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Para que serve (opcional)" data-testid="gv-desc" /></Field>
        <Field label="Tipo">
          <select className="select" value={type} onChange={(e) => setType(e.target.value as 'text' | 'number')} data-testid="gv-type">
            <option value="text">Texto</option>
            <option value="number">Número (dá para somar e subtrair nos fluxos)</option>
          </select>
        </Field>
        <div>
          <Field label={v ? 'Valor atual' : 'Valor inicial'}>
            <input className={badNumber ? 'input bad' : 'input'} value={value} maxLength={2000} inputMode={type === 'number' ? 'decimal' : undefined} onChange={(e) => setValue(e.target.value)} placeholder={type === 'number' ? '0' : 'Ex.: Black Friday até domingo'} data-testid="gv-value" />
          </Field>
          {badNumber && <div className="st-help" style={{ color: 'var(--danger)' }}>Use um número (ex.: 10 ou 2,5).</div>}
        </div>
      </div>
    </Modal>
  );
}

export function GlobalsPage() {
  const { accountId } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, error, reload } = useLoad(() => api.get<{ variables: GlobalVar[]; canEdit: boolean }>(`/globals${dq.trim() ? `?q=${encodeURIComponent(dq.trim())}` : ''}`), [accountId, dq]);
  useSocketEvent('globals:changed', () => void reload());
  const [editing, setEditing] = useState<GlobalVar | null | 'new'>(null);
  const [del, setDel] = useState<GlobalVar | null>(null);
  const head = <Head slug="variaveis" actions={data?.canEdit && <button type="button" className="btn primary" onClick={() => setEditing('new')} data-testid="gv-new"><Icon name="plus" size={15} />Nova variável</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  return (
    <div data-testid="globals-page">
      {head}
      <div className="st-toolbar"><SearchBox value={q} onChange={setQ} placeholder="Buscar variável" testId="gv-search" /></div>
      {data.variables.length === 0 ? (
        <div className="st-card"><EmptyBox icon="braces" title={q ? 'Nenhuma variável com esse nome' : 'Nenhuma variável global ainda'}
          text={<>Guarde valores que valem para a empresa toda — o cupom do mês, o link da live, as vagas restantes — e use em qualquer fluxo como <code>{'{{g_cupom}}'}</code>. Mudou aqui, muda em todos os fluxos. O bloco <b>Ação</b> dos fluxos também pode definir, somar ou subtrair.</>}
          action={data.canEdit && !q && <button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />Nova variável</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Variável</th><th>Descrição</th><th>Tipo</th><th>Valor</th><th>Atualizada</th><th className="acts" /></tr></thead>
            <tbody>
              {data.variables.map((v) => (
                <tr key={v.id} data-testid="gv-row">
                  <td><button type="button" className="linkbtn mono" onClick={() => void copyText(`{{${v.key}}}`, `{{${v.key}}} copiada`)} title="Copiar">{`{{${v.key}}}`}</button></td>
                  <td className="muted">{v.description || '—'}</td>
                  <td><Badge tone={v.type === 'number' ? 'blue' : ''}>{v.type === 'number' ? 'Número' : 'Texto'}</Badge></td>
                  <td style={{ maxWidth: 260 }}><b style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-testid="gv-value-cell">{v.value || <span className="faint">(vazio)</span>}</b></td>
                  <td className="muted">{relTime(v.updatedAt)}</td>
                  <td className="acts">{data.canEdit && <>
                    <button type="button" className="btn icon sm ghost" onClick={() => setEditing(v)} aria-label="Editar" data-testid="gv-edit"><Icon name="edit" size={14} /></button>
                    <button type="button" className="btn icon sm ghost" onClick={() => setDel(v)} aria-label="Excluir"><Icon name="trash" size={14} /></button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <VarModal v={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {del && (
        <ConfirmModal title="Excluir variável" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/globals/${del.id}`); toast('Variável excluída'); setDel(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>Excluir <b>{`{{${del.key}}}`}</b>? Nos fluxos que usam, ela passa a sair vazia.</ConfirmModal>
      )}
    </div>
  );
}
