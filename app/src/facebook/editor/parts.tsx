import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, apiFetch } from '../../api';
import { Icon } from '../../icons';
import { Spinner, cx, toast } from '../../components/ui';
import type { Media } from './model';

/** Peças do editor: seções, campos, buscas na Meta, dinheiro e mídia. */

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');

export function Section({ title, children, ok, badge, testId, defaultOpen = true, right }: {
  title: string; children: ReactNode; ok?: boolean; badge?: string; testId?: string; defaultOpen?: boolean; right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="ed-sec" data-testid={testId}>
      <header onClick={() => setOpen(!open)}>
        <span className={cx('ed-ok', ok === false && 'bad')}><Icon name={ok === false ? 'alert' : 'checkCircle'} size={16} /></span>
        <b>{title}</b>
        {badge && <span className="ed-badge"><Icon name="sparkles" size={11} />{badge}</span>}
        <span className="ed-sec-r" onClick={(e) => e.stopPropagation()}>{right}</span>
        <Icon name={open ? 'chevronUp' : 'chevron'} size={15} />
      </header>
      {open && <div className="ed-sec-b">{children}</div>}
    </section>
  );
}

export function Row({ label, hint, children, testId }: { label: ReactNode; hint?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="ed-row" data-testid={testId}>
      <label>{label}</label>
      {children}
      {hint && <small className="faint">{hint}</small>}
    </div>
  );
}

export function Radio<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string; desc?: string; extra?: ReactNode }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="ed-radios" data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.id} className={cx('ed-radio', value === o.id && 'on')} onClick={() => onChange(o.id)} data-testid={testId ? `${testId}-${o.id || 'none'}` : undefined}>
          <i />
          <span><b>{o.label}</b>{o.desc && <small>{o.desc}</small>}{o.extra}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label?: string; testId?: string }) {
  return (
    <button type="button" className={cx('ed-toggle', on && 'on')} onClick={() => onChange(!on)} data-testid={testId} aria-pressed={on}>
      {label && <span>{label}</span>}<i />
    </button>
  );
}

export const parseMoney = (v: string) => {
  const s = v.replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n: number | null) => (n == null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function MoneyInput({ value, onChange, currency, testId, placeholder }: { value: number | null; onChange: (v: number | null) => void; currency: string; testId?: string; placeholder?: string }) {
  const [txt, setTxt] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setTxt(fmt(value)); }, [value]);
  return (
    <div className="ed-money">
      <input className="input" inputMode="decimal" value={txt} placeholder={placeholder}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; setTxt(fmt(value)); }}
        onChange={(e) => { setTxt(e.target.value); onChange(parseMoney(e.target.value)); }} data-testid={testId} />
      <span>{currency}</span>
    </div>
  );
}

/** Lista que vem da Meta (pixels, públicos, Páginas…), guardada por conta enquanto o editor está aberto. */
const cache = new Map<string, Promise<unknown[]>>();
export function useLookup<T>(actId: string, what: string, pageId?: string | null, enabled = true): { list: T[] | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const k = `${actId}:${what}:${pageId ?? ''}`;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    if (!cache.has(k) || n) {
      const qs = new URLSearchParams({ actId, ...(pageId ? { pageId } : {}) });
      cache.set(k, api.get<{ results: unknown[] }>(`/meta/editor/lookup/${what}?${qs}`).then((r) => r.results));
    }
    setError(null);
    cache.get(k)!.then((r) => { if (alive) setList(r as T[]); }).catch((e) => { cache.delete(k); if (alive) { setList([]); setError(errMsg(e)); } });
    return () => { alive = false; };
  }, [k, n, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { list, error, reload: () => setN((x) => x + 1) };
}
export const lookupSearch = <T,>(actId: string, what: string) => (q: string) =>
  api.get<{ results: T[] }>(`/meta/editor/lookup/${what}?${new URLSearchParams({ actId, q })}`).then((r) => r.results);

/** Campo de busca com lista (locais, interesses, idiomas…). */
export function SearchPick<T>({ placeholder, search, onPick, render, testId }: {
  placeholder: string; search: (q: string) => Promise<T[]>; onPick: (x: T) => void; render: (x: T) => ReactNode; testId: string;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<T[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setList(null); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      search(term).then((r) => { if (my === seq.current) setList(r); }).catch((e) => { if (my === seq.current) { setList([]); toast(errMsg(e)); } })
        .finally(() => { if (my === seq.current) setBusy(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cw-search">
      <div className="cw-search-in"><Icon name="search" size={14} /><input className="input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} data-testid={testId} />{busy && <Spinner />}</div>
      {list && (
        <div className="cw-search-list" data-testid={`${testId}-list`}>
          {!list.length && <div className="faint">Nada encontrado com “{q.trim()}”.</div>}
          {list.map((x, i) => (
            <button type="button" key={i} onClick={() => { onPick(x); setQ(''); setList(null); }} data-testid={`${testId}-opt`}>{render(x)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Chips<T>({ items, label, onRemove, tone, testId }: { items: T[]; label: (x: T) => ReactNode; onRemove: (i: number) => void; tone?: (x: T) => string | undefined; testId?: string }) {
  if (!items.length) return null;
  return (
    <div className="cw-chips" data-testid={testId}>
      {items.map((x, i) => (
        <span key={i} className={cx('cw-chip', tone?.(x))}>{label(x)}<button type="button" onClick={() => onRemove(i)} aria-label="Remover"><Icon name="close" size={11} /></button></span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ mídia */

/** Lê a imagem e reduz no navegador (lado maior até 1440 px, JPEG). */
export function readImage(file: File): Promise<{ name: string; data: string; preview: string }> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.type)) { reject(new Error('Use uma imagem JPG ou PNG.')); return; }
    if (file.size > 30 * 1024 * 1024) { reject(new Error('Imagem muito grande (máximo 30 MB).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1440 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k); const h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('Não deu para ler a imagem.')); return; }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
      const out = c.toDataURL('image/jpeg', 0.9);
      URL.revokeObjectURL(url);
      resolve({ name: `${file.name.replace(/\.[^.]+$/, '') || 'anuncio'}.jpg`, data: out.split(',')[1], preview: out });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não deu para abrir essa imagem.')); };
    img.src = url;
  });
}

async function waitVideo(actId: string, id: string, onThumb: (u: string | null, ready: boolean) => void) {
  for (let i = 0; i < 60; i++) {
    const s = await api.get<{ ready: boolean; thumbnail: string | null; status: string }>(`/meta/editor/video/${id}?actId=${actId}`).catch(() => null);
    if (s?.ready && s.thumbnail) { onThumb(s.thumbnail, true); return; }
    if (s?.status === 'error') throw new Error('A Meta não conseguiu processar esse vídeo.');
    await new Promise((r) => setTimeout(r, 4000));
  }
}

/** Escolher mídia: enviar imagem ou vídeo, ou pegar da biblioteca da conta. */
export function MediaPicker({ actId, value, onChange, testId, allowVideo = true }: { actId: string; value: Media | null; onChange: (m: Media | null) => void; testId: string; allowVideo?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [lib, setLib] = useState<'images' | 'videos' | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const images = useLookup<{ hash: string; name: string | null; url: string | null }>(actId, 'images', null, lib === 'images');
  const videos = useLookup<{ id: string; title: string | null; picture: string | null }>(actId, 'videos', null, lib === 'videos');

  async function pick(f: File) {
    try {
      if (f.type.startsWith('video/')) {
        if (!allowVideo) throw new Error('Aqui só cabe imagem.');
        if (f.size > 200 * 1024 * 1024) throw new Error('Vídeo muito grande (máximo 200 MB).');
        setBusy('Enviando o vídeo para a Meta…');
        const r = await apiFetch('/meta/editor/video', { method: 'POST', headers: { 'x-act-id': actId, 'x-file-name': encodeURIComponent(f.name), 'content-type': f.type || 'video/mp4' }, body: f });
        const { id } = await r.json() as { id: string };
        onChange({ kind: 'video', videoId: id, url: null, name: f.name });
        setBusy('A Meta está processando o vídeo…');
        await waitVideo(actId, id, (u) => onChange({ kind: 'video', videoId: id, url: u, name: f.name }));
      } else {
        setBusy('Enviando a imagem…');
        const img = await readImage(f);
        const r = await api.post<{ hash: string; url: string | null }>('/meta/editor/image', { actId, name: img.name, data: img.data });
        onChange({ kind: 'image', hash: r.hash, url: r.url ?? img.preview, name: img.name });
      }
    } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <div className="ed-media" data-testid={testId}>
      <input ref={file} type="file" hidden accept={allowVideo ? 'image/jpeg,image/png,video/*' : 'image/jpeg,image/png'} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f); }} data-testid={`${testId}-file`} />
      {value ? (
        <div className="ed-media-has">
          {value.url ? <img src={value.url} alt="" /> : <span className="ed-media-ph"><Icon name={value.kind === 'video' ? 'video' : 'image'} size={22} /></span>}
          <div><b>{value.name || (value.kind === 'video' ? 'Vídeo' : 'Imagem')}</b><small>{value.kind === 'video' ? (value.url ? 'Vídeo pronto' : 'Processando na Meta…') : 'Imagem'}</small></div>
          <button type="button" className="btn sm" onClick={() => file.current?.click()}>Trocar</button>
          <button type="button" className="btn sm ghost icon" onClick={() => onChange(null)} aria-label="Tirar"><Icon name="trash" size={14} /></button>
        </div>
      ) : (
        <div className="ed-media-empty">
          <button type="button" className="btn" onClick={() => file.current?.click()} data-testid={`${testId}-upload`}><Icon name="upload" size={14} />{allowVideo ? 'Enviar imagem ou vídeo' : 'Enviar imagem'}</button>
          <button type="button" className="btn ghost" onClick={() => setLib(lib === 'images' ? null : 'images')} data-testid={`${testId}-lib`}><Icon name="image" size={14} />Biblioteca de imagens</button>
          {allowVideo && <button type="button" className="btn ghost" onClick={() => setLib(lib === 'videos' ? null : 'videos')}><Icon name="video" size={14} />Vídeos da conta</button>}
        </div>
      )}
      {busy && <div className="ed-media-busy"><span className="spin sm" />{busy}</div>}
      {lib && (
        <div className="ed-lib" data-testid={`${testId}-library`}>
          {lib === 'images' && (images.list === null ? <Spinner /> : !images.list.length ? <small className="faint">{images.error ?? 'Nenhuma imagem na conta ainda.'}</small> : images.list.map((i) => (
            <button type="button" key={i.hash} onClick={() => { onChange({ kind: 'image', hash: i.hash, url: i.url, name: i.name ?? undefined }); setLib(null); }} title={i.name ?? ''}>{i.url ? <img src={i.url} alt="" /> : <Icon name="image" />}</button>
          )))}
          {lib === 'videos' && (videos.list === null ? <Spinner /> : !videos.list.length ? <small className="faint">{videos.error ?? 'Nenhum vídeo na conta ainda.'}</small> : videos.list.map((v) => (
            <button type="button" key={v.id} onClick={() => { onChange({ kind: 'video', videoId: v.id, url: v.picture, name: v.title ?? undefined }); setLib(null); }} title={v.title ?? ''}>{v.picture ? <img src={v.picture} alt="" /> : <Icon name="video" />}</button>
          )))}
        </div>
      )}
    </div>
  );
}
