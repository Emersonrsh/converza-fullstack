/**
 * Leitor de PDF da área de membros: desenha as páginas na própria página (pdf.js),
 * sem a barra do navegador — então não há botão de baixar nem de imprimir.
 * O arquivo vem de um endereço que só responde com o token do aluno.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { Icon } from '../icons';

interface Props {
  url: string;
  token: string | null;
  storeKey: string;
  onEnd?: (atEnd: boolean) => void;
}

type PageBox = { w: number; h: number };
type Link = { href: string; x: number; y: number; w: number; h: number };

const fsElement = () => document.fullscreenElement ?? (document as unknown as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;
const exitFs = () => (document.exitFullscreen ? document.exitFullscreen() : (document as unknown as { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen?.());

const ZOOMS = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

let lib: Promise<typeof import('pdfjs-dist')> | null = null;
function pdfjs() {
  lib ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([m, w]) => {
    m.GlobalWorkerOptions.workerSrc = w.default;
    return m;
  });
  return lib;
}

export default function PdfReader({ url, token, storeKey, onEnd }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [boxes, setBoxes] = useState<PageBox[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [progress, setProgress] = useState(0);
  const [real, setReal] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  const full = real || pseudo;
  const [pageInput, setPageInput] = useState('1');

  // abre o documento
  useEffect(() => {
    let alive = true;
    let task: { destroy: () => Promise<void> } | null = null;
    setDoc(null); setBoxes([]); setErr(null); setPage(1); setProgress(0);
    pdfjs().then(async (m) => {
      const t = m.getDocument({ url, httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined, isEvalSupported: false, disableRange: true, disableStream: true });
      task = t;
      const d = await t.promise;
      const sizes: PageBox[] = [];
      for (let i = 1; i <= d.numPages; i++) {
        const p = await d.getPage(i);
        const v = p.getViewport({ scale: 1 });
        sizes.push({ w: v.width, h: v.height });
      }
      if (!alive) return;
      setBoxes(sizes); setDoc(d);
    }).catch((e) => { if (alive) setErr(/401/.test(String(e?.message ?? e)) ? 'Sua sessão expirou. Entre de novo.' : 'Não foi possível abrir o material. Recarregue a página.'); });
    return () => { alive = false; void task?.destroy(); };
  }, [url, token]);

  // largura disponível
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const on = () => setReal(fsElement() === wrap.current);
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => { document.removeEventListener('fullscreenchange', on); document.removeEventListener('webkitfullscreenchange', on); };
  }, []);
  // tela cheia "da página" (iPhone não deixa um elemento que não é vídeo ocupar a tela): trava a rolagem de fundo
  useEffect(() => {
    if (!pseudo) return;
    const html = document.documentElement, prev = html.style.overflow;
    html.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPseudo(false); };
    window.addEventListener('keydown', esc);
    return () => { html.style.overflow = prev; window.removeEventListener('keydown', esc); };
  }, [pseudo]);
  // ao entrar e sair da tela cheia, continua na mesma página
  const pageRef = useRef(1);
  pageRef.current = page;
  useEffect(() => { const p = pageRef.current; if (p > 1) requestAnimationFrame(() => requestAnimationFrame(() => goTo(p, false))); }, [full]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxW = boxes.length ? Math.max(...boxes.map((b) => b.w)) : 1;
  const pad = width < 600 ? 12 : 32;
  const fit = Math.max(0.2, Math.min((width - pad * 2) / maxW, width < 600 ? 4 : 1.6));
  const scale = fit * zoom;

  const goTo = useCallback((n: number, smooth = true) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // volta para a página onde o aluno parou
  const restored = useRef(false);
  useEffect(() => { restored.current = false; }, [url]);
  useEffect(() => {
    if (!doc || !width || restored.current) return;
    restored.current = true;
    let saved = 1;
    try { saved = Number(localStorage.getItem(storeKey)) || 1; } catch { /* sem storage */ }
    if (saved > 1 && saved <= doc.numPages) requestAnimationFrame(() => goTo(saved, false));
  }, [doc, width, storeKey, goTo]);

  function onScroll() {
    const el = scroller.current;
    if (!el || !boxes.length) return;
    const max = el.scrollHeight - el.clientHeight;
    const p = max > 0 ? el.scrollTop / max : 1;
    setProgress(p);
    const mid = el.scrollTop + el.clientHeight * 0.35;
    const pages = el.querySelectorAll<HTMLElement>('[data-page]');
    let cur = 1;
    pages.forEach((pg) => { if (pg.offsetTop <= mid) cur = Number(pg.dataset.page); });
    if (cur !== page) {
      setPage(cur); setPageInput(String(cur));
      try { localStorage.setItem(storeKey, String(cur)); } catch { /* sem storage */ }
    }
    onEnd?.(p > 0.97 || (cur === boxes.length && p > 0.9));
  }
  // documento curto que cabe sem rolar
  useEffect(() => { if (doc && scroller.current && scroller.current.scrollHeight <= scroller.current.clientHeight + 4) onEnd?.(true); });

  function toggleFull() {
    if (pseudo) { setPseudo(false); return; }
    if (fsElement()) { void exitFs(); return; }
    const el = wrap.current as (HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    const req = el && (el.requestFullscreen ? () => el.requestFullscreen() : el.webkitRequestFullscreen ? () => el.webkitRequestFullscreen!() : null);
    if (!req || !(document.fullscreenEnabled || (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled)) { setPseudo(true); return; }
    try { Promise.resolve(req()).catch(() => setPseudo(true)); } catch { setPseudo(true); }
  }
  const zi = ZOOMS.findIndex((z) => Math.abs(z - zoom) < 0.001);
  const n = boxes.length;

  return (
    <div className={`mbr-reader${full ? ' full' : ''}${pseudo ? ' pseudo' : ''}`} ref={wrap} data-testid="mbr-pdf" onContextMenu={(e) => e.preventDefault()}>
      <div className="mbr-reader-bar">
        <div className="mbr-reader-grp">
          <button type="button" className="mbr-ibtn" onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="Página anterior"><Icon name="chevronUp" size={16} /></button>
          <form className="mbr-reader-page" onSubmit={(e) => { e.preventDefault(); const v = Math.min(Math.max(1, Number(pageInput) || 1), n || 1); setPageInput(String(v)); goTo(v); }}>
            <input value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))} inputMode="numeric" aria-label="Página" data-testid="mbr-page-input" />
            <span>de {n || '–'}</span>
          </form>
          <button type="button" className="mbr-ibtn" onClick={() => goTo(page + 1)} disabled={!n || page >= n} aria-label="Próxima página"><Icon name="chevronDown" size={16} /></button>
        </div>
        <div className="mbr-reader-grp">
          <button type="button" className="mbr-ibtn" onClick={() => zi > 0 && setZoom(ZOOMS[zi - 1])} disabled={zi <= 0} aria-label="Diminuir"><Icon name="minus" size={16} /></button>
          <button type="button" className="mbr-zoom" onClick={() => setZoom(1)} title="Ajustar à largura" data-testid="mbr-zoom">{Math.round(zoom * 100)}%</button>
          <button type="button" className="mbr-ibtn" onClick={() => zi < ZOOMS.length - 1 && setZoom(ZOOMS[zi + 1])} disabled={zi >= ZOOMS.length - 1} aria-label="Aumentar"><Icon name="plus" size={16} /></button>
          <span className="mbr-reader-sep" />
          <button type="button" className="mbr-ibtn" onClick={toggleFull} aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'} title={full ? 'Sair da tela cheia' : 'Tela cheia'} data-testid="mbr-fullscreen"><Icon name={full ? 'minimize' : 'maximize'} size={16} /></button>
        </div>
        <i className="mbr-reader-prog" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="mbr-reader-pages" ref={scroller} onScroll={onScroll}>
        {err ? <div className="mbr-reader-msg"><Icon name="alert" size={24} /><p>{err}</p></div>
          : !doc || !width ? <div className="mbr-reader-msg"><span className="mbr-spin" /><p>Abrindo o material…</p></div>
            : boxes.map((b, i) => <Page key={i} doc={doc} n={i + 1} box={b} scale={scale} root={scroller} />)}
      </div>
    </div>
  );
}

function Page({ doc, n, box, scale, root }: { doc: PDFDocumentProxy; n: number; box: PageBox; scale: number; root: React.RefObject<HTMLDivElement> }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [links, setLinks] = useState<Link[]>([]);
  const [drawn, setDrawn] = useState(false);
  const w = Math.floor(box.w * scale), h = Math.floor(box.h * scale);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); }, { root: root.current, rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let alive = true;
    doc.getPage(n).then(async (p: PDFPageProxy) => {
      if (!alive || !canvas.current) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const v = p.getViewport({ scale: scale * dpr });
      const c = canvas.current;
      c.width = Math.floor(v.width); c.height = Math.floor(v.height);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport: v });
      await task.promise;
      if (!alive) return;
      setDrawn(true);
      const lv = p.getViewport({ scale });
      const ann = await p.getAnnotations();
      setLinks(ann.filter((a) => a.subtype === 'Link' && typeof a.url === 'string' && /^(https?:|mailto:|tel:)/i.test(a.url)).map((a) => {
        const [x1, y1, x2, y2] = lv.convertToViewportRectangle(a.rect);
        return { href: a.url as string, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      }));
    }).catch(() => undefined);
    return () => { alive = false; task?.cancel(); };
  }, [doc, n, scale, near]);

  return (
    <div className="mbr-page" data-page={n} ref={ref} style={{ width: w, height: h }}>
      {!drawn && <span className="mbr-page-ph" />}
      <canvas ref={canvas} style={{ width: w, height: h }} />
      {links.map((l, i) => <a key={i} href={l.href} target="_blank" rel="noreferrer noopener" className="mbr-page-link" style={{ left: l.x, top: l.y, width: l.w, height: l.h }} aria-label={l.href} />)}
    </div>
  );
}
