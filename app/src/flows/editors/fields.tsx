import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { cx, toast } from '../../components/ui';
import { api, apiFetch } from '../../api';
import { EMOJIS } from '../../chats/util';

export type { D } from './types';

/* ------------------------------------------------------------------ básicos */

export function Field({ label, hint, warn, required, right, children }: {
  label?: ReactNode; hint?: ReactNode; warn?: ReactNode; required?: boolean; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="bm-f">
      {(label || right) && (
        <div className="bm-lbl">
          {label && <label>{label}{required && <span className="req"> *</span>}</label>}
          {right}
        </div>
      )}
      {children}
      {hint && <div className="bm-hint">{hint}</div>}
      {warn && <div className="bm-warn">{warn}</div>}
    </div>
  );
}

export function Section({ title, sub, right, dashed, children }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; dashed?: boolean; children: ReactNode }) {
  return (
    <div className={cx('bm-sec', dashed && 'dashed')}>
      {(title || right) && <div className="bm-sec-h">{title && <b>{title}</b>}{right}</div>}
      {sub && <p className="bm-sec-sub">{sub}</p>}
      {children}
    </div>
  );
}

/** "Como funciona" no pé do editor. */
export function HowItWorks({ icon = 'info', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="bm-how">
      <div className="bm-how-h"><Icon name={icon} size={13} /><b>Como funciona</b></div>
      <div className="bm-how-b">{children}</div>
    </div>
  );
}

export function Switch({ checked, onChange, testId }: { checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <button type="button" className={cx('switch', checked && 'on')} onClick={() => onChange(!checked)} aria-pressed={checked} data-testid={testId}><i /></button>
  );
}

/** Opção liga/desliga com título e explicação (como nos editores da barra Ferramentas). */
export function ToggleCard({ title, desc, checked, onChange, testId, accent }: {
  title: string; desc?: ReactNode; checked: boolean; onChange: (v: boolean) => void; testId?: string; accent?: boolean;
}) {
  return (
    <div className={cx('bm-tgl', checked && accent && 'on')}>
      <div><b>{title}</b>{desc && <small>{desc}</small>}</div>
      <Switch checked={checked} onChange={onChange} testId={testId} />
    </div>
  );
}

/** Chave com rótulo dos dois lados (ex.: "Remover etiquetas ⟷ Adicionar etiquetas"). */
export function SideSwitch({ left, right, value, onChange, testId }: { left: string; right: string; value: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <div className="bm-side">
      <span className={cx(!value && 'on')}>{left}</span>
      <Switch checked={value} onChange={onChange} testId={testId} />
      <span className={cx(value && 'on')}>{right}</span>
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, testId }: { value: T; options: [T, string, string?][]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="bm-tabs" data-testid={testId}>
      {options.map(([v, label, icon]) => (
        <button type="button" key={v} className={cx(value === v && 'on')} onClick={() => onChange(v)} data-testid={testId ? `${testId}-${v}` : undefined}>
          {icon && <Icon name={icon} size={14} />}{label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ variáveis */

function useOutside(ref: React.RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, open, close]);
}

/** Lista de variáveis com busca: clicar insere {{variavel}}. */
export function VarMenu({ vars, onPick, onClose, align = 'right' }: { vars: string[]; onPick: (v: string) => void; onClose: () => void; align?: 'left' | 'right' }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, true, onClose);
  const list = vars.filter((v) => v.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80);
  return (
    <div className={cx('bm-vars fade', align)} ref={ref} data-testid="var-menu">
      <input className="input sm" autoFocus placeholder="Buscar variável…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="bm-vars-l">
        {list.map((v) => <button type="button" key={v} onClick={() => { onPick(v); onClose(); }}><code>{`{{${v}}}`}</code></button>)}
        {!list.length && <div className="faint" style={{ padding: 8, fontSize: 12 }}>Nenhuma variável</div>}
      </div>
    </div>
  );
}

function insertAt(el: HTMLInputElement | HTMLTextAreaElement | null, cur: string, token: string, onChange: (v: string) => void) {
  if (!el) { onChange(cur + token); return; }
  const s = el.selectionStart ?? cur.length;
  const e = el.selectionEnd ?? cur.length;
  onChange(cur.slice(0, s) + token + cur.slice(e));
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
}

/** Campo de uma linha com o botão {} de variáveis. */
export function VarInput({ value, onChange, vars, placeholder, testId, type = 'text', maxLength }: {
  value: string; onChange: (v: string) => void; vars: string[]; placeholder?: string; testId?: string; type?: string; maxLength?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="bm-vi">
      <input ref={ref} className="input" type={type} value={value ?? ''} placeholder={placeholder} maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      <button type="button" className="bm-vi-b" title="Inserir variável" aria-label="Inserir variável" onClick={() => setOpen((v) => !v)}><Icon name="code" size={14} /></button>
      {open && <VarMenu vars={vars} onPick={(v) => insertAt(ref.current, value ?? '', `{{${v}}}`, onChange)} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Texto com barra: negrito, itálico, tachado, emoji e variáveis (formatação do WhatsApp). */
export function RichText({ value, onChange, vars, placeholder, rows = 4, testId, maxLength, showCount }: {
  value: string; onChange: (v: string) => void; vars: string[]; placeholder?: string; rows?: number; testId?: string; maxLength?: number; showCount?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<null | 'emoji' | 'vars'>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  useOutside(emojiRef, menu === 'emoji', () => setMenu(null));
  const wrap = (mark: string) => {
    const el = ref.current;
    const cur = value ?? '';
    if (!el) return;
    const s = el.selectionStart ?? cur.length;
    const e = el.selectionEnd ?? cur.length;
    const sel = cur.slice(s, e) || 'texto';
    onChange(cur.slice(0, s) + mark + sel + mark + cur.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + 1, s + 1 + sel.length); });
  };
  return (
    <div className="bm-rt">
      <textarea ref={ref} className="input" rows={rows} value={value ?? ''} placeholder={placeholder} maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      <div className="bm-rt-bar">
        <button type="button" title="Negrito" aria-label="Negrito" onClick={() => wrap('*')}><Icon name="bold" size={14} /></button>
        <button type="button" title="Itálico" aria-label="Itálico" onClick={() => wrap('_')}><Icon name="italic" size={14} /></button>
        <button type="button" title="Tachado" aria-label="Tachado" onClick={() => wrap('~')}><Icon name="strike" size={14} /></button>
        <div style={{ position: 'relative' }} ref={emojiRef}>
          <button type="button" title="Emoji" aria-label="Emoji" onClick={() => setMenu((m) => (m === 'emoji' ? null : 'emoji'))}><Icon name="smile" size={14} /></button>
          {menu === 'emoji' && (
            <div className="bm-emoji fade">
              {EMOJIS.map((e) => <button type="button" key={e} onClick={() => { insertAt(ref.current, value ?? '', e, onChange); setMenu(null); }}>{e}</button>)}
            </div>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button type="button" title="Inserir variável" aria-label="Inserir variável" onClick={() => setMenu((m) => (m === 'vars' ? null : 'vars'))}><Icon name="code" size={14} /></button>
          {menu === 'vars' && <VarMenu vars={vars} align="left" onPick={(v) => insertAt(ref.current, value ?? '', `{{${v}}}`, onChange)} onClose={() => setMenu(null)} />}
        </div>
        {showCount && maxLength ? <span className="bm-count">{(value ?? '').length}/{maxLength}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tempo */

export const UNITS: [string, string][] = [['seconds', 'Segundos'], ['minutes', 'Minutos'], ['hours', 'Horas'], ['days', 'Dias']];

export function Duration({ amount, unit, onAmount, onUnit, units = UNITS, min = 0, testId, amountVars }: {
  amount: any; unit: string; onAmount: (v: any) => void; onUnit: (v: string) => void; units?: [string, string][]; min?: number; testId?: string;
  /** permite variável no tempo */ amountVars?: string[];
}) {
  return (
    <div className="bm-dur">
      {amountVars
        ? <VarInput value={String(amount ?? '')} onChange={onAmount} vars={amountVars} testId={testId ? `${testId}-amount` : undefined} />
        : <input className="input" type="number" min={min} value={amount ?? ''} onChange={(e) => onAmount(e.target.value === '' ? '' : Number(e.target.value))} data-testid={testId ? `${testId}-amount` : undefined} />}
      <select className="select" value={unit} onChange={(e) => onUnit(e.target.value)} data-testid={testId ? `${testId}-unit` : undefined}>
        {units.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ arquivos */

export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';
export interface FlowFile { id: string; fileName: string; mime: string; size: number; url: string; originalSize?: number; compressed?: boolean }

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', '3gp': 'video/3gpp', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', amr: 'audio/amr', opus: 'audio/ogg', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip',
};
const mimeOf = (f: File) => f.type || MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';

export async function uploadFlowFile(kind: FileKind, file: File): Promise<FlowFile> {
  const res = await apiFetch(`/flows/files?kind=${kind}&filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-type': mimeOf(file) }, body: file,
  });
  const data = await res.json() as { file: FlowFile };
  return data.file;
}

/** Links de prévia já assinados (valem 12 h; guardamos por 11 h) — pedidos do mesmo instante vão juntos. */
const signCache = new Map<string, { url: string | null; at: number }>();
let signQueue: { id: string; done: (u: string | null) => void }[] = [];
let signTimer: ReturnType<typeof setTimeout> | null = null;
export function cachedSignedUrl(fileId: string): Promise<string | null> {
  const hit = signCache.get(fileId);
  if (hit && Date.now() - hit.at < 11 * 3600_000) return Promise.resolve(hit.url);
  return new Promise((done) => {
    signQueue.push({ id: fileId, done });
    signTimer ??= setTimeout(async () => {
      const batch = signQueue; signQueue = []; signTimer = null;
      const ids = [...new Set(batch.map((b) => b.id))].slice(0, 300);
      let files: Record<string, FlowFile> = {};
      try { files = (await api.post<{ files: Record<string, FlowFile> }>('/flows/files/sign', { ids })).files; } catch { /* sem prévia */ }
      for (const id of ids) signCache.set(id, { url: files[id]?.url ?? null, at: Date.now() });
      for (const b of batch) b.done(signCache.get(b.id)?.url ?? null);
    }, 30);
  });
}

/** Link de prévia (12 h) de um arquivo já enviado. */
export async function signedUrl(fileId: string): Promise<string | null> {
  try { const r = await api.post<{ files: Record<string, FlowFile> }>('/flows/files/sign', { ids: [fileId] }); return r.files[fileId]?.url ?? null; } catch { return null; }
}

const ACCEPT: Record<FileKind, string> = {
  image: 'image/jpeg,image/png', video: 'video/mp4,video/3gpp', audio: 'audio/*,.ogg,.opus,.m4a,.mp3,.aac,.amr,.wav',
  document: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,application/pdf', sticker: 'image/webp',
};
/** Tamanho máximo de cada tipo (o mesmo que o servidor aceita). */
const MAX_MB: Record<FileKind, number> = { image: 15, video: 16, audio: 30, document: 30, sticker: 0.5 };
const sizeLabel = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const TOO_BIG_TIP: Record<FileKind, string> = {
  document: 'Comprima o PDF (ex.: ilovepdf.com › Comprimir PDF) ou use a aba URL com um link direto do arquivo.',
  image: 'Diminua a imagem ou salve em JPG com qualidade menor.',
  video: 'Comprima o vídeo ou use a aba URL com um link direto.',
  audio: 'Comprima o áudio ou use a aba URL com um link direto.',
  sticker: 'Figurinhas precisam ser WEBP 512×512 com até 500 KB.',
};

const RULES: Record<FileKind, string> = {
  image: 'JPG ou PNG, até 15 MB — comprimimos automaticamente', video: 'MP4 ou 3GP, até 16 MB', audio: 'MP3, OGG, M4A, WAV…, até 30 MB — comprimimos automaticamente',
  document: 'PDF, planilha, texto… até 30 MB — PDFs são comprimidos automaticamente', sticker: 'WEBP 512×512, até 500 KB (formato que o WhatsApp exige)',
};

/** Arquivo enviado aqui ou link (as duas formas que o WhatsApp aceita). */
function FileThumb({ fileId }: { fileId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { let on = true; void cachedSignedUrl(fileId).then((u) => { if (on) setSrc(u); }); return () => { on = false; }; }, [fileId]);
  return src ? <img className="bm-file-thumb" src={src} alt="" data-testid="file-thumb" /> : null;
}

export function FileOrUrl({ kind, url, fileId, fileName, onChange, vars, testId, urlPlaceholder }: {
  kind: FileKind; url: string; fileId: string; fileName?: string; vars: string[]; testId?: string; urlPlaceholder?: string;
  onChange: (v: { url: string; fileId: string; fileName: string }) => void;
}) {
  const [mode, setMode] = useState<'file' | 'url'>(url && !fileId ? 'url' : 'file');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function pick(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_MB[kind] * 1024 * 1024) {
      const lim = MAX_MB[kind] >= 1 ? `${MAX_MB[kind]} MB` : `${MAX_MB[kind] * 1000} KB`;
      toast(`“${f.name}” tem ${sizeLabel(f.size)} e o limite é ${lim}. ${TOO_BIG_TIP[kind]}`);
      if (input.current) input.current.value = '';
      return;
    }
    setBusy(true);
    try {
      const up = await uploadFlowFile(kind, f);
      onChange({ url: '', fileId: up.id, fileName: up.fileName });
      if (up.compressed && up.originalSize) toast(`Arquivo comprimido: ${sizeLabel(up.originalSize)} → ${sizeLabel(up.size)} (−${Math.round((1 - up.size / up.originalSize) * 100)}%)`);
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function open() {
    const u = await signedUrl(fileId);
    if (u) window.open(u, '_blank', 'noopener');
  }
  return (
    <div className="bm-fu" data-testid={testId}>
      <Tabs value={mode} options={[['file', 'Arquivo', 'upload'], ['url', 'URL', 'link']]} onChange={setMode} testId={testId ? `${testId}-mode` : undefined} />
      {mode === 'file' ? (
        fileId ? (
          <div className="bm-file">
            {(kind === 'image' || kind === 'sticker') && <FileThumb fileId={fileId} />}
            <Icon name={kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'mic' : kind === 'sticker' ? 'sticker' : 'file'} size={16} />
            <button type="button" className="linkbtn" onClick={open} title="Abrir">{fileName || 'arquivo'}</button>
            <button type="button" className="btn icon sm ghost" onClick={() => onChange({ url: '', fileId: '', fileName: '' })} aria-label="Remover arquivo"><Icon name="trash" size={14} /></button>
          </div>
        ) : (
          <div className="bm-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}>
            <span className="bm-drop-ic"><Icon name={kind === 'audio' ? 'mic' : kind === 'video' ? 'video' : kind === 'document' ? 'file' : 'image'} size={20} /></span>
            <small>{RULES[kind]}</small>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => input.current?.click()} data-testid={testId ? `${testId}-pick` : undefined}>
              <Icon name="upload" size={14} />{busy ? 'Enviando e comprimindo…' : 'Enviar arquivo'}
            </button>
            <input ref={input} type="file" hidden accept={ACCEPT[kind]} onChange={(e) => void pick(e.target.files?.[0])} data-testid={testId ? `${testId}-input` : undefined} />
          </div>
        )
      ) : (
        <VarInput value={url} onChange={(v) => onChange({ url: v, fileId: '', fileName: '' })} vars={vars} placeholder={urlPlaceholder ?? 'https://… ou {{variavel}}'} testId={testId ? `${testId}-url` : undefined} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ busca */

export interface Opt { value: string; label: string; hint?: string }

/** Escolha com busca (lista abre ao clicar). */
export function Picker({ value, options, onChange, placeholder, testId, empty = 'Nada encontrado', clearable = true }: {
  value: string; options: Opt[]; onChange: (v: string) => void; placeholder: string; testId?: string; empty?: string; clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  const cur = options.find((o) => o.value === value) ?? null;
  const list = options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 100);
  return (
    <div className="bm-pk" ref={ref} data-testid={testId}>
      <div className={cx('bm-pk-box', open && 'on')} onClick={() => setOpen(true)}>
        <Icon name="search" size={14} />
        <input value={open ? q : cur?.label ?? ''} placeholder={cur ? cur.label : placeholder}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => { setQ(''); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && list[0]) { e.preventDefault(); onChange(list[0].value); setOpen(false); } }} />
        {cur && clearable ? <button type="button" className="bm-pk-x" onClick={(e) => { e.stopPropagation(); onChange(''); setQ(''); }} aria-label="Limpar"><Icon name="close" size={12} /></button>
          : <Icon name="chevron" size={13} />}
      </div>
      {open && (
        <div className="bm-pk-list fade">
          {list.map((o) => (
            <button type="button" key={o.value} className={cx(o.value === value && 'on')} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
            </button>
          ))}
          {!list.length && <div className="bm-pk-empty">{empty}</div>}
        </div>
      )}
    </div>
  );
}

/** Etiquetas: busca as existentes ou cria com Enter. */
export function TagInput({ tags, onChange, catalog, onCreated, testId }: {
  tags: string[]; onChange: (t: string[]) => void; catalog: { name: string; color: string }[]; onCreated?: (t: { name: string; color: string }) => void; testId?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  const has = (n: string) => tags.some((t) => t.toLowerCase() === n.toLowerCase());
  const matches = catalog.filter((t) => !has(t.name) && t.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30);
  async function add(name: string) {
    const n = name.trim().slice(0, 40);
    if (!n || has(n)) { setQ(''); return; }
    onChange([...tags, n]);
    setQ('');
    if (!catalog.some((t) => t.name.toLowerCase() === n.toLowerCase())) {
      try { const r = await api.post<{ tag: { name: string; color: string } }>('/settings/tags', { name: n }); onCreated?.(r.tag); }
      catch { /* sem permissão para criar no catálogo: a etiqueta vale só no fluxo */ }
    }
  }
  const color = (n: string) => catalog.find((t) => t.name.toLowerCase() === n.toLowerCase())?.color ?? '#94a3b8';
  return (
    <div className="bm-tags" ref={ref} data-testid={testId}>
      <div className="bm-tags-box" onClick={() => setOpen(true)}>
        <Icon name="tag" size={14} />
        {tags.map((t) => (
          <span key={t} className="bm-chip" style={{ ['--c' as string]: color(t) }}>
            {t}<button type="button" onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }} aria-label={`Remover ${t}`}>×</button>
          </span>
        ))}
        <input value={q} placeholder={tags.length ? '' : 'Digite para buscar ou criar etiqueta'} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void add(matches.find((m) => m.name.toLowerCase() === q.trim().toLowerCase())?.name ?? q); }
            if (e.key === 'Backspace' && !q && tags.length) onChange(tags.slice(0, -1));
          }} data-testid={testId ? `${testId}-input` : undefined} />
      </div>
      {open && (matches.length > 0 || q.trim()) && (
        <div className="bm-pk-list fade">
          {matches.map((t) => (
            <button type="button" key={t.name} onClick={() => void add(t.name)}><span><i className="bm-dot" style={{ background: t.color }} />{t.name}</span></button>
          ))}
          {q.trim() && !catalog.some((t) => t.name.toLowerCase() === q.trim().toLowerCase()) && (
            <button type="button" onClick={() => void add(q)}><span><Icon name="plus" size={12} /> Criar “{q.trim()}”</span></button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lista simples com subir/remover (opções de menu, condições, saídas…). */
export function moveItem<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}
