import { useEffect, useRef, useState } from 'react';
import { API_BASE, ApiError, api, getAccountId, getToken } from '../api';
import { Icon } from '../icons';
import { Avatar, Field, Modal, Spinner, cx, toast } from '../components/ui';
import { TagPicker } from '../components/TagPicker';
import { parsePrice } from '../components/Products';
import { fmtPhone } from '../chats/util';
import { CustomFieldsEditor, useContactFields } from './CustomFields';
import { STAGES, dateTimeBR, downloadFromApi, readCsvFile } from './util';
import type { ContactExport, ContactItem, ImportResult } from './types';
import type { KBoardSummary } from '../kanban/types';

const err = (e: unknown, fb: string) => (e instanceof Error && e.message ? e.message : fb);

/* ------------------------------------------------------------ novo contato */

/** Primeiro busca (evita duplicar), depois cadastra. */
export function NewContactModal({ onClose, onCreated, onOpen }: {
  onClose: () => void; onCreated: (id: string) => void; onOpen: (id: string) => void;
}) {
  const fields = useContactFields() ?? [];
  const [step, setStep] = useState<'search' | 'form'>('search');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ContactItem[] | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [stage, setStage] = useState('new');
  const [value, setValue] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (step !== 'search') return;
    const t = q.trim();
    if (!t) { setResults(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      api.get<{ contacts: ContactItem[] }>(`/contacts?q=${encodeURIComponent(t)}&limit=8&sort=last_desc`)
        .then((r) => alive && setResults(r.contacts)).catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, step]);

  function toForm() {
    const t = q.trim();
    if (t.replace(/\D/g, '').length >= 8 && !/[a-z]/i.test(t)) setPhone(t);
    else if (t.includes('@')) setEmail(t);
    else setName(t);
    setStep('form');
  }

  const valueBad = !!value.trim() && Number.isNaN(parsePrice(value));
  const digits = phone.replace(/\D/g, '');
  const ready = !!name.trim() && digits.length >= 10 && digits.length <= 15 && !valueBad;

  async function create() {
    if (!ready || busy) return;
    setBusy(true); setDup(null);
    try {
      const r = await api.post<{ contact: { id: string } }>('/contacts', {
        name: name.trim(), phone, email: email.trim() || null, stage, tags, notes: notes.trim() || null,
        ...(value.trim() ? { value: parsePrice(value) } : {}),
        custom: Object.fromEntries(Object.entries(custom).filter(([, v]) => v.trim())),
      });
      toast('Contato criado');
      onCreated(r.contact.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const m = await api.get<{ contacts: ContactItem[] }>(`/contacts?q=${digits.slice(-8)}&limit=5`).catch(() => ({ contacts: [] as ContactItem[] }));
        const hit = m.contacts.find((x) => x.phone.endsWith(digits.slice(-8)));
        setDup(hit ? { id: hit.id, name: hit.name } : null);
      }
      toast(err(e, 'Não foi possível criar o contato'));
      setBusy(false);
    }
  }

  if (step === 'search') {
    return (
      <Modal title="Novo contato" subtitle="Digite para buscar contatos existentes" onClose={onClose} width={480} footer={<button type="button" className="btn" onClick={onClose}>Cancelar</button>}>
        <div className="fl-search" style={{ maxWidth: 'none' }}>
          <Icon name="search" size={16} />
          <input className="input" autoFocus placeholder="Buscar por nome, telefone ou e-mail..." value={q} onChange={(e) => setQ(e.target.value)} data-testid="nc-search" />
        </div>
        <div className="ncs-results">
          {!q.trim() && <div className="ncs-empty">Digite para buscar contatos existentes</div>}
          {q.trim() && results === null && <div style={{ height: 60 }}><Spinner /></div>}
          {q.trim() && results?.length === 0 && <div className="ncs-empty">Nenhum contato encontrado com “{q.trim()}”.</div>}
          {results?.map((c) => (
            <button type="button" key={c.id} className="nc-item" onClick={() => onOpen(c.id)} data-testid="nc-result">
              <Avatar name={c.name || c.phone} size={30} />
              <span><b>{c.name}</b><small>{fmtPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</small></span>
              <Icon name="arrowRight" size={15} />
            </button>
          ))}
        </div>
        <button type="button" className="btn primary" style={{ marginTop: 14 }} onClick={toForm} data-testid="nc-create"><Icon name="plus" size={15} />Criar novo contato</button>
      </Modal>
    );
  }

  return (
    <Modal title="Novo contato" subtitle="Preencha os dados do contato" onClose={onClose} width={540} footer={<>
      <button type="button" className="btn" onClick={() => setStep('search')}>Voltar</button>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ready || busy} onClick={create} data-testid="nc-save">{busy ? 'Criando…' : 'Criar contato'}</button>
    </>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="kb-2col">
          <Field label="Nome *"><input className="input" autoFocus={!name} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do contato" data-testid="nc-name" /></Field>
          <Field label="WhatsApp (com DDD) *"><input className="input" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setDup(null); }} placeholder="(11) 98888-7777" data-testid="nc-phone" /></Field>
          <Field label="E-mail"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@exemplo.com" data-testid="nc-email" /></Field>
          <Field label="Etapa do funil">
            <select className="select" value={stage} onChange={(e) => setStage(e.target.value)} data-testid="nc-stage">
              {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Valor da negociação (R$)"><input className={cx('input', valueBad && 'bad')} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" data-testid="nc-value" /></Field>
        </div>
        {dup && (
          <div className="hint"><Icon name="alert" size={14} />Já existe um contato com esse telefone: <b>{dup.name}</b>.
            <button type="button" className="linkbtn" onClick={() => onOpen(dup.id)} data-testid="nc-open-dup">Abrir contato</button>
          </div>
        )}
        <Field label="Etiquetas"><TagPicker value={tags} onChange={setTags} testId="nc-tags" /></Field>
        {fields.length > 0 && (
          <div>
            <label className="label">Campos personalizados</label>
            <CustomFieldsEditor fields={fields} values={custom} onChange={setCustom} />
          </div>
        )}
        <Field label="Anotações"><textarea className="input" rows={2} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="nc-notes" /></Field>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- importar */

export function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function template() {
    try { await downloadFromApi('/contacts/import/template', 'modelo_contatos.csv'); }
    catch (e) { toast(err(e, 'Não foi possível baixar o modelo')); }
  }

  async function upload(f: File) {
    if (!/\.(csv|txt)$/i.test(f.name)) { toast('Envie um arquivo .csv'); return; }
    if (f.size > 10 * 1024 * 1024) { toast('Arquivo grande demais (máx. 10 MB)'); return; }
    setBusy(true); setFile(f.name); setResult(null);
    try {
      const text = await readCsvFile(f);
      const res = await fetch(`${API_BASE}/contacts/import?tags=${encodeURIComponent(JSON.stringify(tags))}`, {
        method: 'POST', body: text,
        headers: { 'Content-Type': 'text/csv; charset=utf-8', Authorization: `Bearer ${getToken()}`, 'x-account-id': getAccountId() ?? '' },
      });
      const data = await res.json().catch(() => ({})) as ImportResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
      setResult(data);
      onDone();
    } catch (e) { toast(err(e, 'Não foi possível importar')); setFile(''); }
    setBusy(false);
  }

  return (
    <Modal title="Importar contatos via CSV" width={500} onClose={onClose}
      subtitle="Baixe a planilha modelo, preencha e envie o CSV. Etiquetas ficam no contato; ao abrir chat, copiam para a conversa."
      footer={result ? <>
        <button type="button" className="btn" onClick={() => { setResult(null); setFile(''); }}>Importar outro arquivo</button>
        <button type="button" className="btn primary" onClick={onClose}>Concluir</button>
      </> : undefined}>
      {result ? (
        <div className="stack" style={{ gap: 12 }} data-testid="import-result">
          <div className="imp-sum">
            <div><b>{result.created}</b><span>criado{result.created === 1 ? '' : 's'}</span></div>
            <div><b>{result.updated}</b><span>atualizado{result.updated === 1 ? '' : 's'}</span></div>
            <div className={cx(result.skipped > 0 && 'bad')}><b>{result.skipped}</b><span>com erro</span></div>
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>{file}: {result.total} linha{result.total === 1 ? '' : 's'} lida{result.total === 1 ? '' : 's'}. Contatos que já existiam (mesmo telefone) foram atualizados e as etiquetas, somadas.</div>
          {result.errors.length > 0 && (
            <div className="imp-errs">
              {result.errors.map((x) => <div key={x.line}><b>Linha {x.line}</b>{x.reason}</div>)}
              {result.skipped > result.errors.length && <div className="faint">… e mais {result.skipped - result.errors.length}</div>}
            </div>
          )}
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div>
            <label className="label">Etiquetas padrão (opcional)</label>
            <TagPicker value={tags} onChange={setTags} placeholder="Selecione etiquetas para todos os contatos..." testId="import-tags" />
            <small className="faint" style={{ display: 'block', marginTop: 6, fontSize: 11.5 }}>Aplicadas quando a linha do CSV não tiver etiquetas. Etiquetas do CSV têm prioridade.</small>
          </div>
          <div className="imp-opts">
            <button type="button" className="imp-opt" onClick={template} data-testid="import-template">
              <b><Icon name="download" size={15} />Baixar planilha modelo</b>
              <span>Arquivo com colunas e exemplos para facilitar a importação.</span>
            </button>
            <button type="button" className="imp-opt" disabled={busy} onClick={() => input.current?.click()} data-testid="import-pick">
              <b><Icon name="upload" size={15} />{busy ? 'Importando…' : 'Selecionar CSV para importar'}</b>
              <span>{busy ? file : 'Formato aceito: .csv'}</span>
            </button>
          </div>
          <input ref={input} type="file" hidden accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} data-testid="import-file" />
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------- exportações recentes */

export function ExportsModal({ onClose, refreshKey = 0 }: { onClose: () => void; refreshKey?: number }) {
  const [list, setList] = useState<ContactExport[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ exports: ContactExport[] }>('/contacts/exports').then((r) => alive && setList(r.exports)).catch(() => alive && setList([]));
    return () => { alive = false; };
  }, [refreshKey]);
  return (
    <Modal title="Exportações recentes" width={480} onClose={onClose}
      subtitle="Mostramos as 3 exportações mais recentes. Ao exportar de novo, a mais antiga some da lista. Baixe o CSV se ainda precisar.">
      {list === null ? <div style={{ height: 60 }}><Spinner /></div>
        : list.length === 0 ? <div className="muted" style={{ fontSize: 13.5 }}>Nenhuma exportação recente.</div>
          : (
            <div className="stack" style={{ gap: 8 }}>
              {list.map((x) => (
                <div key={x.id} className="exp-item" data-testid="export-item">
                  <Icon name="file" size={18} />
                  <div><b>{x.filename}</b><small>{x.rows} contato{x.rows === 1 ? '' : 's'} · {x.label} · {dateTimeBR(x.createdAt)}{x.userName ? ` · ${x.userName}` : ''}</small></div>
                  <button type="button" className="btn sm" onClick={() => downloadFromApi(`/contacts/exports/${x.id}/download`, x.filename).catch((e) => toast(err(e, 'Não foi possível baixar')))} data-testid="export-download">
                    <Icon name="download" size={14} />Baixar
                  </button>
                </div>
              ))}
            </div>
          )}
    </Modal>
  );
}

/* --------------------------------------------------------- ações em massa */

export function BulkTagsModal({ mode, count, onClose, onApply }: { mode: 'add' | 'remove'; count: number; onClose: () => void; onApply: (tags: string[]) => Promise<void> }) {
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={mode === 'add' ? 'Adicionar etiquetas' : 'Remover etiquetas'} subtitle={`${count} contato${count === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}`} width={440} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!tags.length || busy} onClick={async () => { setBusy(true); await onApply(tags); setBusy(false); }} data-testid="bulk-apply">
        {mode === 'add' ? 'Adicionar' : 'Remover'}
      </button>
    </>}>
      <TagPicker value={tags} onChange={setTags} allowCreate={mode === 'add'} testId="bulk-tags" />
    </Modal>
  );
}

export function BulkStageModal({ count, onClose, onApply }: { count: number; onClose: () => void; onApply: (stage: string) => Promise<void> }) {
  const [stage, setStage] = useState('negotiating');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Mudar etapa do funil" subtitle={`${count} contato${count === 1 ? '' : 's'} selecionado${count === 1 ? '' : 's'}`} width={420} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy} onClick={async () => { setBusy(true); await onApply(stage); setBusy(false); }} data-testid="bulk-apply">Aplicar</button>
    </>}>
      <select className="select" value={stage} onChange={(e) => setStage(e.target.value)} data-testid="bulk-stage">
        {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </Modal>
  );
}

export function BulkKanbanModal({ count, onClose, onApply }: { count: number; onClose: () => void; onApply: (boardId: string, columnId: string) => Promise<void> }) {
  const [boards, setBoards] = useState<KBoardSummary[] | null>(null);
  const [boardId, setBoardId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ boards: KBoardSummary[] }>('/kanban/boards').then((r) => {
      setBoards(r.boards);
      if (r.boards[0]) { setBoardId(r.boards[0].id); setColumnId(r.boards[0].columns[0]?.id ?? ''); }
    }).catch(() => setBoards([]));
  }, []);
  const board = boards?.find((b) => b.id === boardId);
  return (
    <Modal title="Colocar no Kanban" subtitle={`${count} contato${count === 1 ? '' : 's'}: quem não está no quadro entra no topo da coluna; quem já está é movido.`} width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!columnId || busy} onClick={async () => { setBusy(true); await onApply(boardId, columnId); setBusy(false); }} data-testid="bulk-apply">{busy ? 'Aplicando…' : 'Aplicar'}</button>
    </>}>
      {boards === null ? <div style={{ height: 60 }}><Spinner /></div> : boards.length === 0 ? <div className="muted">Crie um quadro no Kanban primeiro.</div> : (
        <div className="kb-2col">
          <Field label="Quadro">
            <select className="select" value={boardId} onChange={(e) => { setBoardId(e.target.value); setColumnId(boards.find((b) => b.id === e.target.value)?.columns[0]?.id ?? ''); }} data-testid="bulk-board">
              {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Coluna">
            <select className="select" value={columnId} onChange={(e) => setColumnId(e.target.value)} data-testid="bulk-column">
              {board?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
      )}
    </Modal>
  );
}
