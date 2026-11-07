import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { ColorChooser, ColorPill, EmptyBox, Head, LoadError, PRESET_COLORS, SearchBox, errMsg, fmtNum, useLoad, useSocketEvent } from './common';

interface Tag { id: string; name: string; color: string; contacts: number }

function TagModal({ tag, onClose, onSaved }: { tag: Tag | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? PRESET_COLORS[1]);
  const [busy, setBusy] = useState(false);
  const renaming = !!tag && name.trim() && name.trim() !== tag.name;
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (tag) {
        const r = await api.patch<{ renamed: number }>(`/settings/tags/${tag.id}`, { name: name.trim(), color });
        toast(r.renamed ? `Etiqueta renomeada (${fmtNum(r.renamed)} lugar(es) atualizados)` : 'Etiqueta salva');
      } else {
        const r = await api.post<{ existed?: boolean }>('/settings/tags', { name: name.trim(), color });
        toast(r.existed ? 'Essa etiqueta já existia' : `Etiqueta ${name.trim()} criada`);
      }
      onSaved(); onClose();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  return (
    <Modal title={tag ? 'Editar Etiqueta' : 'Nova Etiqueta'} icon="tag" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={save} data-testid="tag-save">{busy ? 'Salvando…' : 'Salvar'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Nome"><input className="input" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="Ex.: Cliente VIP" data-testid="tag-name" /></Field>
        <div><label className="label">Cor</label><ColorChooser value={color} onChange={setColor} /></div>
        <div>
          <label className="label">Visualização</label>
          <div className="st-preview"><ColorPill name={name.trim() || 'Nome da etiqueta'} color={color} testId="tag-preview" /> é assim que aparece nos contatos e no Chats ao vivo.</div>
        </div>
        {renaming && <div className="hint"><Icon name="info" size={14} />O nome novo vale em todos os contatos, agentes, fluxos, webhooks e disparos que ainda não foram enviados.</div>}
        <div className="st-help">As etiquetas ficam no Converza. A API oficial do WhatsApp não mexe nas etiquetas do aplicativo WhatsApp Business do celular (elas não são sincronizadas).</div>
      </div>
    </Modal>
  );
}

export function TagsPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ tags: Tag[]; canEdit: boolean }>('/settings/tags'), [accountId]);
  useSocketEvent(['tags:changed', 'contacts:changed'], () => void reload());
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Tag | null | 'new'>(null);
  const [del, setDel] = useState<Tag | null>(null);
  const head = <Head slug="etiquetas" actions={<button type="button" className="btn primary" onClick={() => setEditing('new')} data-testid="tag-new"><Icon name="plus" size={15} />Nova Etiqueta</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const list = data.tags.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div data-testid="tags-page">
      {head}
      <div className="st-toolbar"><SearchBox value={q} onChange={setQ} placeholder="Buscar etiqueta" testId="tag-search" /><span className="st-mini">{data.tags.length} etiqueta(s)</span></div>
      {data.tags.length === 0 ? (
        <div className="st-card"><EmptyBox icon="tag" title="Nenhuma etiqueta ainda" text="Etiquetas organizam os contatos (VIP, Lead quente, Instagram…). Fluxos, agentes, webhooks e links rastreáveis também podem colocar e tirar etiquetas."
          action={<button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />Nova Etiqueta</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Etiqueta</th><th>Contatos</th><th className="acts" /></tr></thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} data-testid="tag-row">
                  <td><ColorPill name={t.name} color={t.color} /></td>
                  <td className="muted">{fmtNum(t.contacts)}</td>
                  <td className="acts">{data.canEdit && <>
                    <button type="button" className="btn icon sm ghost" onClick={() => setEditing(t)} aria-label="Editar" data-testid="tag-edit"><Icon name="edit" size={14} /></button>
                    <button type="button" className="btn icon sm ghost" onClick={() => setDel(t)} aria-label="Excluir" data-testid="tag-del"><Icon name="trash" size={14} /></button>
                  </>}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={3}><div className="empty" style={{ padding: 20 }}>Nenhuma etiqueta com esse nome.</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {!data.canEdit && <div className="st-help">Você pode criar etiquetas; renomear e excluir é com o proprietário e os administradores.</div>}
      {editing && <TagModal tag={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {del && (
        <ConfirmModal title="Excluir etiqueta" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/settings/tags/${del.id}`); toast('Etiqueta excluída'); setDel(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>Excluir <b>{del.name}</b>? Ela sai de {fmtNum(del.contacts)} contato(s).</ConfirmModal>
      )}
    </div>
  );
}
