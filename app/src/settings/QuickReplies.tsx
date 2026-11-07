import { useRef, useState } from 'react';
import { API_BASE, api, getAccountId, getToken, mediaSrc } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Modal, Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import type { QuickAction, QuickActionType, QuickFile, QuickReply } from '../chats/types';
import { Badge, EmptyBox, Head, LoadError, SearchBox, errMsg, useDebounced, useLoad } from './common';

export const ACTION_META: Record<QuickActionType, { label: string; icon: string; accept: string; hint: string }> = {
  text: { label: 'Texto', icon: 'chat', accept: '', hint: '' },
  image: { label: 'Imagem', icon: 'image', accept: 'image/jpeg,image/png', hint: 'JPG ou PNG até 5 MB' },
  video: { label: 'Vídeo', icon: 'play', accept: 'video/mp4,video/3gpp', hint: 'MP4 ou 3GP até 16 MB' },
  audio: { label: 'Áudio', icon: 'mic', accept: 'audio/*', hint: 'MP3, OGG, AAC, AMR ou M4A até 16 MB' },
  document: { label: 'Documento', icon: 'file', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,application/*,text/*', hint: 'PDF, planilha, texto… até 16 MB' },
  sticker: { label: 'Sticker', icon: 'smile', accept: 'image/webp', hint: 'WEBP 512×512 até 500 KB' },
};
const TYPES = Object.keys(ACTION_META) as QuickActionType[];
const VARS = ['primeiro_nome', 'nome', 'telefone', 'email', 'saudacao', 'data', 'hora'];

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', '3gp': 'video/3gpp', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', opus: 'audio/ogg', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
const mimeOf = (f: File) => f.type || MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function uploadFile(kind: QuickActionType, file: File): Promise<QuickFile> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'x-file-type': mimeOf(file) };
  const t = getToken(); const a = getAccountId();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (a) headers['x-account-id'] = a;
  const res = await fetch(`${API_BASE}/quick-replies/files?kind=${kind}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers, body: file });
  const data = await res.json().catch(() => ({})) as { file?: QuickFile; error?: string };
  if (!res.ok || !data.file) throw new Error(data.error ?? `Erro ${res.status}`);
  return data.file;
}

/** Uma linha de texto da resposta: o que aparece na lista. */
export function quickPreview(q: QuickReply): string {
  const acts = q.actions ?? [{ type: 'text' as const, text: q.text }];
  return acts.map((a) => (a.type === 'text' ? a.text ?? '' : `[${ACTION_META[a.type].label}${a.file?.fileName ? `: ${a.file.fileName}` : ''}]${a.caption ? ` ${a.caption}` : ''}`)).join(' · ');
}
export const isTextOnly = (q: QuickReply) => (q.actions ?? [{ type: 'text' }]).every((a) => a.type === 'text');

function ActionEditor({ a, index, total, onChange, onRemove, onMove }: {
  a: QuickAction; index: number; total: number; onChange: (a: QuickAction) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void;
}) {
  const meta = ACTION_META[a.type];
  const input = useRef<HTMLInputElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    try { const file = await uploadFile(a.type, f); onChange({ ...a, fileId: file.id, file }); }
    catch (e) { toast(errMsg(e, 'Não foi possível enviar o arquivo')); }
    setBusy(false);
  }
  const insertVar = (v: string) => {
    const el = ta.current; const cur = a.text ?? ''; const token = `{{${v}}}`;
    const s = el?.selectionStart ?? cur.length; const e = el?.selectionEnd ?? cur.length;
    onChange({ ...a, text: cur.slice(0, s) + token + cur.slice(e) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + token.length, s + token.length); });
  };
  return (
    <div className="st-action" data-testid="qr-action">
      <div className="st-action-h">
        <Icon name={meta.icon} size={15} />{index + 1}. {meta.label}
        <span className="spacer" />
        <button type="button" className="btn icon sm ghost" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Subir"><Icon name="chevronUp" size={14} /></button>
        <button type="button" className="btn icon sm ghost" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Descer"><Icon name="chevron" size={14} /></button>
        <button type="button" className="btn icon sm ghost" onClick={onRemove} aria-label="Remover ação"><Icon name="trash" size={14} /></button>
      </div>
      {a.type === 'text' ? (
        <>
          <textarea ref={ta} className="input" rows={3} value={a.text ?? ''} maxLength={4096} onChange={(e) => onChange({ ...a, text: e.target.value })} placeholder="Olá {{primeiro_nome}}! …" data-testid="qr-action-text" />
          <div className="vchips">{VARS.map((v) => <button type="button" key={v} className="vchip" onClick={() => insertVar(v)}>{`{{${v}}}`}</button>)}</div>
        </>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {a.file ? (
            <div className="st-file">
              {a.type === 'image' || a.type === 'sticker' ? <img src={mediaSrc(a.file.url) ?? ''} alt="" /> : <span className="st-stat-ic" style={{ width: 40, height: 40 }}><Icon name={meta.icon} size={17} /></span>}
              <div style={{ flex: 1, minWidth: 0 }}><b>{a.file.fileName}</b><span className="st-mini">{kb(a.file.size)}</span></div>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => input.current?.click()}>Trocar</button>
            </div>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()} data-testid="qr-pick-file"><Icon name="upload" size={15} />{busy ? 'Enviando…' : `Escolher ${meta.label.toLowerCase()}`}</button>
          )}
          <input ref={input} type="file" hidden accept={meta.accept} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} data-testid="qr-file-input" />
          <span className="st-mini">{meta.hint}</span>
          {a.type !== 'audio' && a.type !== 'sticker' && (
            <input className="input" value={a.caption ?? ''} maxLength={1024} onChange={(e) => onChange({ ...a, caption: e.target.value })} placeholder="Legenda (opcional) — aceita {{primeiro_nome}}" />
          )}
        </div>
      )}
    </div>
  );
}

export function QuickReplyModal({ initial, onClose, onSaved }: { initial: QuickReply | null; onClose: () => void; onSaved: (q: QuickReply) => void }) {
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '');
  const [actions, setActions] = useState<QuickAction[]>(initial?.actions?.length ? initial.actions : [{ type: 'text', text: initial?.text ?? '' }]);
  const [busy, setBusy] = useState(false);
  const ok = shortcut.trim() && actions.length && actions.every((a) => (a.type === 'text' ? a.text?.trim() : a.fileId));
  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    const body = { shortcut, actions: actions.map((a) => (a.type === 'text' ? { type: 'text', text: a.text } : { type: a.type, fileId: a.fileId, ...(a.caption?.trim() ? { caption: a.caption } : {}) })) };
    try {
      const r = initial
        ? await api.patch<{ quickReply: QuickReply }>(`/quick-replies/${initial.id}`, body)
        : await api.post<{ quickReply: QuickReply }>('/quick-replies', body);
      toast(initial ? 'Resposta rápida salva' : `Atalho #${r.quickReply.shortcut} criado`);
      onSaved(r.quickReply);
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  const move = (i: number, dir: -1 | 1) => setActions((l) => { const n = [...l]; const j = i + dir; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <Modal title={initial ? 'Editar resposta rápida' : 'Nova resposta rápida'} icon="bolt" width={620} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ok || busy} onClick={save} data-testid="qr-save">{busy ? 'Salvando…' : 'Salvar'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <label className="label">Atalho</label>
          <div className="qr-sc"><span>#</span><input className="input" autoFocus placeholder="preco" value={shortcut} maxLength={30}
            onChange={(e) => setShortcut(e.target.value.replace(/^[#/]+/, '').replace(/\s+/g, '-').toLowerCase())} data-testid="qr-shortcut" /></div>
          <div className="st-help">No Chats ao vivo, digite <b>#</b> (ou <b>/</b>) e o atalho. Só texto: vira rascunho para você editar. Com anexos: envia tudo na ordem.</div>
        </div>
        <div>
          <label className="label">Ações (enviadas nesta ordem)</label>
          <div className="st-actions-list">
            {actions.map((a, i) => (
              <ActionEditor key={i} a={a} index={i} total={actions.length} onChange={(x) => setActions((l) => l.map((y, j) => (j === i ? x : y)))}
                onRemove={() => setActions((l) => l.filter((_, j) => j !== i))} onMove={(d) => move(i, d)} />
            ))}
          </div>
          {actions.length < 10 && (
            <div className="st-addbar" style={{ marginTop: 10 }}>
              {TYPES.map((t) => (
                <button type="button" key={t} className="btn sm" onClick={() => setActions((l) => [...l, t === 'text' ? { type: 'text', text: '' } : { type: t }])} data-testid={`qr-add-${t}`}>
                  <Icon name={ACTION_META[t].icon} size={14} />{ACTION_META[t].label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Lista + editor (usado em Configurações e no Chats ao vivo). */
export function QuickRepliesManager({ onChange }: { onChange?: (list: QuickReply[]) => void }) {
  const { accountId } = useAuth();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const dq = useDebounced(q);
  const qs = new URLSearchParams({ ...(dq.trim() ? { q: dq.trim() } : {}), ...(type ? { type } : {}) }).toString();
  const { data, error, reload } = useLoad(async () => {
    const r = await api.get<{ quickReplies: QuickReply[] }>(`/quick-replies${qs ? `?${qs}` : ''}`);
    if (!qs) onChange?.(r.quickReplies);
    return r;
  }, [accountId, qs]);
  const [editing, setEditing] = useState<QuickReply | null | 'new'>(null);
  const [del, setDel] = useState<QuickReply | null>(null);
  const refreshAll = async () => {
    await reload();
    if (qs && onChange) onChange((await api.get<{ quickReplies: QuickReply[] }>('/quick-replies')).quickReplies);
  };

  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  return (
    <div data-testid="qr-manager">
      <div className="st-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Buscar atalho ou texto" testId="qr-search" />
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo" data-testid="qr-type">
          <option value="">Todos os tipos</option>
          {TYPES.map((t) => <option key={t} value={t}>{ACTION_META[t].label}</option>)}
        </select>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => setEditing('new')} data-testid="qr-new"><Icon name="plus" size={15} />Nova resposta</button>
      </div>
      {!data ? <Spinner /> : data.quickReplies.length === 0 ? (
        <div className="st-card"><EmptyBox icon="bolt" title={q || type ? 'Nada encontrado' : 'Nenhuma resposta rápida ainda'} text="Crie atalhos para mensagens que você manda sempre: preço, endereço, catálogo em PDF, áudio de boas-vindas… No chat, é só digitar # e o atalho."
          action={!q && !type && <button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />Nova resposta</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Atalho</th><th>Conteúdo</th><th>Tipo</th><th className="acts" /></tr></thead>
            <tbody>
              {data.quickReplies.map((r) => (
                <tr key={r.id} data-testid="qr-row">
                  <td><b className="mono">#{r.shortcut}</b></td>
                  <td className="muted" style={{ maxWidth: 420 }}><div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{quickPreview(r)}</div></td>
                  <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{(r.types ?? ['text']).map((t) => <Badge key={t} tone={t === 'text' ? '' : 'teal'}><Icon name={ACTION_META[t].icon} size={11} />{ACTION_META[t].label}</Badge>)}{(r.actions?.length ?? 1) > 1 && <span className="st-mini">{r.actions!.length} ações</span>}</div></td>
                  <td className="acts">
                    <button type="button" className="btn icon sm ghost" onClick={() => setEditing(r)} aria-label="Editar" data-testid="qr-edit"><Icon name="edit" size={14} /></button>
                    <button type="button" className="btn icon sm ghost" onClick={() => setDel(r)} aria-label="Excluir" data-testid="qr-del"><Icon name="trash" size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <QuickReplyModal initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refreshAll(); }} />}
      {del && (
        <ConfirmModal title="Excluir resposta rápida" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/quick-replies/${del.id}`); toast('Resposta rápida excluída'); setDel(null); void refreshAll(); }
          catch (e) { toast(errMsg(e)); }
        }}>Excluir o atalho <b>#{del.shortcut}</b>?</ConfirmModal>
      )}
    </div>
  );
}

export function QuickRepliesPage() {
  return (
    <div data-testid="quick-replies-page" className={cx()}>
      <Head slug="respostas-rapidas" />
      <QuickRepliesManager />
    </div>
  );
}
