import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, money } from '../api';
import { Icon } from '../icons';
import { Avatar, Field, Modal, Spinner, cx, toast } from '../components/ui';
import { parsePrice } from '../components/Products';
import { fmtPhone } from '../chats/util';
import { Funnel } from './Funnel';
import { COLUMN_COLORS, DEFAULT_PREVIEW, KIND_LABEL, columnLabel, dateBR, plural, timeAgo } from './util';
import type { ColumnKind, KCard, KColumn } from './types';
import type { TeamMember } from '../chats/types';

const err = (e: unknown, fb: string) => (e instanceof Error && e.message ? e.message : fb);

/* ----------------------------------------------------------- quadro */

/** Novo Kanban (com a prévia de como ele aparece na lista) ou renomear. */
export function BoardModal({ initial, columns, onClose, onSaved }: {
  initial?: { id: string; name: string }; columns?: Pick<KColumn, 'id' | 'name' | 'color' | 'cards'>[];
  onClose: () => void; onSaved: (board: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [busy, setBusy] = useState(false);
  const cols = columns ?? DEFAULT_PREVIEW.map((c, i) => ({ ...c, id: String(i), cards: 0 }));
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = initial
        ? await api.patch<{ board: { id: string; name: string } }>(`/kanban/boards/${initial.id}`, { name: name.trim() })
        : await api.post<{ board: { id: string; name: string } }>('/kanban/boards', { name: name.trim() });
      onSaved(r.board);
    } catch (e) { toast(err(e, 'Não foi possível salvar')); setBusy(false); }
  }
  return (
    <Modal title={initial ? 'Renomear Kanban' : 'Novo Kanban'} icon="kanban" width={480}
      subtitle={initial ? undefined : 'Dê um nome ao quadro. As colunas padrão já vêm prontas para você começar.'}
      onClose={onClose} footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={save} data-testid="board-save">{initial ? 'Salvar' : 'Criar'}</button>
      </>}>
      <Field label="Nome do Kanban">
        <input className="input" autoFocus maxLength={80} placeholder="Digite o nome do Kanban..." value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} data-testid="board-name" />
      </Field>
      <label className="label" style={{ marginTop: 16 }}>Visualização</label>
      <div className="kb-preview" data-testid="board-preview">
        <Funnel columns={cols} />
        <div className="kb-bcard-hd"><b>{name.trim() || 'Nome do Kanban'}</b><span className="kb-badge">{plural(cols.length, 'coluna', 'colunas')}</span></div>
        <small className="muted">Assim o quadro aparece na listagem, com o funil no topo.</small>
      </div>
    </Modal>
  );
}

export function ConfirmModal({ title, children, confirm, danger, onClose, onConfirm }: {
  title: string; children: ReactNode; confirm: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} width={440} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className={cx('btn', danger ? 'danger' : 'primary')} disabled={busy} data-testid="confirm"
        onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirm}</button>
    </>}>
      <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{children}</div>
    </Modal>
  );
}

/* ----------------------------------------------------------- colunas */

export function ColumnModal({ boardId, column, onClose, onSaved }: {
  boardId: string; column?: KColumn; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(column?.name ?? '');
  const [color, setColor] = useState(column?.color ?? COLUMN_COLORS[1]);
  const [kind, setKind] = useState<ColumnKind>(column?.kind ?? 'open');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (column) await api.patch(`/kanban/columns/${column.id}`, { name: name.trim(), color, kind });
      else await api.post(`/kanban/boards/${boardId}/columns`, { name: name.trim(), color, kind });
      onSaved();
    } catch (e) { toast(err(e, 'Não foi possível salvar')); setBusy(false); }
  }
  return (
    <Modal title={column ? 'Editar coluna' : 'Nova coluna'} onClose={onClose} width={440} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={save} data-testid="column-save">{column ? 'Salvar' : 'Criar coluna'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Nome da coluna">
          <input className="input" autoFocus maxLength={40} placeholder="Ex.: Proposta enviada" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} data-testid="column-name" />
        </Field>
        <div>
          <label className="label">Cor</label>
          <div className="kb-colors" role="radiogroup" aria-label="Cor">
            {COLUMN_COLORS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={color === c} aria-label={c} className={cx(color === c && 'on')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        <div>
          <label className="label">Tipo</label>
          <div className="seg" role="radiogroup" aria-label="Tipo da coluna">
            {(['open', 'won', 'lost'] as ColumnKind[]).map((k) => (
              <button type="button" key={k} role="radio" aria-checked={kind === k} className={cx(kind === k && 'active')} onClick={() => setKind(k)} data-testid={`kind-${k}`}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}><Icon name="info" size={14} />Cards em colunas de <b>Ganho</b> contam como conversão. Os de <b>Perdido</b> saem do valor do pipeline.</div>
        </div>
      </div>
    </Modal>
  );
}

export function DeleteColumnModal({ column, columns, count, onClose, onDone }: {
  column: KColumn; columns: KColumn[]; count: number; onClose: () => void; onDone: () => void;
}) {
  const others = columns.filter((c) => c.id !== column.id);
  const [mode, setMode] = useState<'move' | 'delete'>('move');
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const qs = count === 0 ? '' : mode === 'move' ? `?moveTo=${target}` : '?deleteCards=1';
      await api.del(`/kanban/columns/${column.id}${qs}`);
      toast(`Coluna “${column.name}” excluída`);
      onDone();
    } catch (e) { toast(err(e, 'Não foi possível excluir')); setBusy(false); }
  }
  return (
    <Modal title="Excluir coluna" onClose={onClose} width={460} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn danger" disabled={busy || (count > 0 && mode === 'move' && !target)} onClick={run} data-testid="confirm-delete-column">Excluir coluna</button>
    </>}>
      {count === 0 ? <p style={{ margin: 0 }}>A coluna <b>{column.name}</b> está vazia e será excluída.</p> : (
        <div className="stack" style={{ gap: 10 }}>
          <p style={{ margin: 0 }}>A coluna <b>{column.name}</b> tem {plural(count, 'card', 'cards')}. O que fazer com eles?</p>
          <label className={cx('kb-opt', mode === 'move' && 'on')}>
            <input type="radio" name="del" checked={mode === 'move'} onChange={() => setMode('move')} />
            <span>Mover para</span>
            <select className="select sm" value={target} onChange={(e) => { setTarget(e.target.value); setMode('move'); }} data-testid="move-to">
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className={cx('kb-opt danger', mode === 'delete' && 'on')}>
            <input type="radio" name="del" checked={mode === 'delete'} onChange={() => setMode('delete')} data-testid="delete-cards" />
            <span>Excluir os {plural(count, 'card', 'cards')} (os contatos continuam salvos)</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- cards */

interface ContactLite { id: string; name: string; phone: string; }

/** Novo card (contato salvo, novo contato ou só um título) ou edição de um card. */
export function CardModal({ boardId, columns, members, card, columnId, top, onClose, onSaved, onDeleted }: {
  boardId: string; columns: KColumn[]; members: TeamMember[]; card?: KCard; columnId?: string; top?: boolean;
  onClose: () => void; onSaved: (card: { id: string }) => void; onDeleted?: () => void;
}) {
  const nav = useNavigate();
  const editing = !!card;
  const [mode, setMode] = useState<'contact' | 'new' | 'title'>('contact');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ContactLite[] | null>(null);
  const [picked, setPicked] = useState<ContactLite | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [title, setTitle] = useState(card?.title ?? '');
  const [col, setCol] = useState(card?.columnId ?? columnId ?? columns[0]?.id ?? '');
  const [value, setValue] = useState(card && card.value ? String(card.value.toFixed(2)).replace('.', ',') : '');
  const [assigned, setAssigned] = useState(card?.assignedUserId ?? '');
  const [due, setDue] = useState(card?.dueDate ?? '');
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (editing || mode !== 'contact') return;
    let alive = true;
    const t = setTimeout(() => {
      api.get<{ contacts: ContactLite[] }>(`/contacts${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((r) => alive && setResults(r.contacts.slice(0, 8))).catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, mode, editing]);

  const parsedValue = value.trim() ? parsePrice(value) : null;
  const valueBad = parsedValue !== null && Number.isNaN(parsedValue);
  const digits = newPhone.replace(/\D/g, '');
  const ready = !valueBad && !!col && (editing ? !!title.trim()
    : mode === 'contact' ? !!picked : mode === 'new' ? digits.length >= 10 && digits.length <= 15 : !!title.trim());

  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    const common = {
      notes: notes.trim() ? notes : null, assignedUserId: assigned || null, dueDate: due || null,
      ...(parsedValue !== null ? { value: parsedValue } : editing ? { value: 0 } : {}),
    };
    try {
      if (editing && card) {
        await api.patch(`/kanban/cards/${card.id}`, { title: title.trim(), ...common });
        if (col !== card.columnId) await api.post(`/kanban/cards/${card.id}/move`, { columnId: col, top: true });
        onSaved({ id: card.id });
      } else {
        const body = {
          columnId: col, ...common, ...(top ? { top: true } : {}),
          ...(mode === 'contact' && picked ? { contactId: picked.id } : {}),
          ...(mode === 'new' ? { newContact: { name: newName.trim() || undefined, phone: newPhone } } : {}),
          ...(mode === 'title' ? { title: title.trim() } : {}),
        };
        const r = await api.post<{ card: { id: string } }>(`/kanban/boards/${boardId}/cards`, body);
        onSaved(r.card);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast(e.message);
      else toast(err(e, 'Não foi possível salvar o card'));
      setBusy(false);
    }
  }

  async function remove() {
    if (!card) return;
    try { await api.del(`/kanban/cards/${card.id}`); toast('Card excluído'); onDeleted?.(); }
    catch (e) { toast(err(e, 'Não foi possível excluir')); }
  }

  const column = columns.find((c) => c.id === col);
  return (
    <Modal title={editing ? 'Card' : 'Novo card'} onClose={onClose} width={520} footer={<>
      {editing && <button type="button" className="btn ghost danger" onClick={() => setConfirmDel(true)} data-testid="card-delete"><Icon name="trash" size={14} />Excluir</button>}
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ready || busy} onClick={save} data-testid="card-save">{editing ? 'Salvar' : 'Criar card'}</button>
    </>}>
      <div className="stack" style={{ gap: 12 }}>
        {editing && card ? (
          <>
            <Field label="Título">
              <input className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="card-title" />
            </Field>
            {card.contactId ? (
              <div className="kb-contact">
                <Avatar name={card.contactName || card.contactPhone || '?'} size={36} />
                <div><b>{card.contactName}</b><small>{fmtPhone(card.contactPhone)}</small></div>
                <span className="spacer" />
                {card.conversationId
                  ? <button type="button" className="btn sm" onClick={() => nav(`/inbox?c=${card.conversationId}`)} data-testid="card-open-chat"><Icon name="chats" size={14} />Abrir conversa</button>
                  : <span className="faint" style={{ fontSize: 12 }}>Sem conversa ainda</span>}
              </div>
            ) : <div className="faint" style={{ fontSize: 12.5 }}>Card sem contato.</div>}
          </>
        ) : (
          <>
            <div className="seg">
              <button type="button" className={cx(mode === 'contact' && 'active')} onClick={() => setMode('contact')}>Contato salvo</button>
              <button type="button" className={cx(mode === 'new' && 'active')} onClick={() => setMode('new')} data-testid="card-mode-new">Novo contato</button>
              <button type="button" className={cx(mode === 'title' && 'active')} onClick={() => setMode('title')} data-testid="card-mode-title">Sem contato</button>
            </div>
            {mode === 'contact' && (
              <div>
                <input className="input" autoFocus placeholder="Buscar contato por nome ou telefone" value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} data-testid="card-search" />
                <div className="nc-results">
                  {results === null && <div style={{ height: 50 }}><Spinner /></div>}
                  {results?.length === 0 && <div className="faint" style={{ padding: 10, fontSize: 13 }}>Nenhum contato. Use “Novo contato”.</div>}
                  {results?.map((c) => (
                    <button type="button" key={c.id} className={cx('nc-item', picked?.id === c.id && 'on')} onClick={() => setPicked(c)} data-testid="card-result">
                      <Avatar name={c.name || c.phone} size={28} /><span><b>{c.name}</b><small>{fmtPhone(c.phone)}</small></span>
                      {picked?.id === c.id && <Icon name="check" size={16} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {mode === 'new' && (
              <div className="kb-2col">
                <Field label="Nome"><input className="input" autoFocus placeholder="Nome do lead" value={newName} onChange={(e) => setNewName(e.target.value)} data-testid="card-new-name" /></Field>
                <Field label="WhatsApp (com DDD)"><input className="input" inputMode="tel" placeholder="(11) 98888-7777" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} data-testid="card-new-phone" /></Field>
              </div>
            )}
            {mode === 'title' && (
              <Field label="Título do card">
                <input className="input" autoFocus maxLength={120} placeholder="Ex.: Parceria com a escola" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="card-title" />
              </Field>
            )}
          </>
        )}
        <div className="kb-2col">
          <Field label="Coluna">
            <select className="select" value={col} onChange={(e) => setCol(e.target.value)} data-testid="card-column">
              {columns.map((c) => <option key={c.id} value={c.id}>{columnLabel(c)}</option>)}
            </select>
          </Field>
          <Field label="Valor (R$)">
            <input className={cx('input', valueBad && 'bad')} inputMode="decimal" placeholder={editing ? '0,00' : 'do contato'} value={value} onChange={(e) => setValue(e.target.value)} data-testid="card-value" />
          </Field>
          <Field label="Responsável">
            <select className="select" value={assigned} onChange={(e) => setAssigned(e.target.value)} data-testid="card-assignee">
              <option value="">Ninguém</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Prazo">
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="card-due" />
          </Field>
        </div>
        <Field label="Anotações">
          <textarea className="input" rows={3} maxLength={5000} placeholder="Detalhes da negociação, próximos passos…" value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="card-notes" />
        </Field>
        {editing && card && (
          <div className="faint" style={{ fontSize: 12 }}>
            Criado {timeAgo(card.createdAt)} · na coluna “{column?.name ?? '—'}” {timeAgo(card.movedAt)}
            {card.dueDate ? ` · prazo ${dateBR(card.dueDate)}` : ''}{card.value ? ` · ${money(card.value)}` : ''}
          </div>
        )}
      </div>
      {confirmDel && card && (
        <ConfirmModal title="Excluir card" confirm="Excluir" danger onClose={() => setConfirmDel(false)} onConfirm={remove}>
          Excluir o card <b>{card.title}</b>? {card.contactId ? 'O contato e a conversa continuam salvos.' : ''}
        </ConfirmModal>
      )}
    </Modal>
  );
}
