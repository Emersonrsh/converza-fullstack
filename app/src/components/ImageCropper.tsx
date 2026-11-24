import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { Icon } from '../icons';

/**
 * Recorte de imagem num tamanho exato (ex.: 1200×628 da prévia de link).
 * Arraste para enquadrar e use o zoom; o resultado sai em JPEG já no tamanho final.
 */
export function ImageCropper({ file, width, height, title, hint, onCancel, onDone }: {
  file: File; width: number; height: number; title: string; hint?: string;
  onCancel: () => void; onDone: (blob: Blob) => void | Promise<void>;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // deslocamento do centro, em px do quadro
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [fw, setFw] = useState(520);
  const fh = (fw * height) / width;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const el = frame.current; if (!el) return;
    const ro = new ResizeObserver(() => setFw(el.clientWidth || 520));
    ro.observe(el); return () => ro.disconnect();
  }, []);

  // escala que cobre o quadro inteiro (zoom 1 = imagem encostando nas bordas)
  const base = img ? Math.max(fw / img.naturalWidth, fh / img.naturalHeight) : 1;
  const scale = base * zoom;
  const dw = img ? img.naturalWidth * scale : 0;
  const dh = img ? img.naturalHeight * scale : 0;
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(-(dw - fw) / 2, Math.min((dw - fw) / 2, p.x)),
    y: Math.max(-(dh - fh) / 2, Math.min((dh - fh) / 2, p.y)),
  });
  const cur = clamp(pos);

  function down(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: cur.x, py: cur.y };
  }
  function move(e: React.PointerEvent) {
    const d = drag.current; if (!d) return;
    setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
  }

  async function done() {
    if (!img) return;
    setBusy(true);
    try {
      const k = width / fw; // do quadro na tela para o tamanho final
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      const left = (fw - dw) / 2 + cur.x; const top = (fh - dh) / 2 + cur.y;
      ctx.drawImage(img, left * k, top * k, dw * k, dh * k);
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
      if (blob) await onDone(blob);
    } finally { setBusy(false); }
  }

  return (
    <Modal title={title} subtitle={`${width} × ${height} px`} onClose={onCancel} width={600}
      footer={<>
        <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
        <button type="button" className="btn primary" disabled={!img || busy} onClick={() => void done()} data-testid="crop-save">{busy ? 'Salvando…' : 'Usar este recorte'}</button>
      </>}>
      <div ref={frame} className="crop-frame" style={{ aspectRatio: `${width} / ${height}` }} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} data-testid="crop-frame">
        {img && <img src={img.src} alt="" draggable={false} style={{ width: dw, height: dh, transform: `translate(calc(-50% + ${cur.x}px), calc(-50% + ${cur.y}px))` }} />}
      </div>
      <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
        <Icon name="search" size={15} />
        <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ flex: 1 }} aria-label="Zoom" data-testid="crop-zoom" />
      </div>
      <div className="cf-hint" style={{ marginTop: 8 }}>{hint ?? 'Arraste a imagem para enquadrar. O que está dentro do quadro é exatamente o que aparece.'}</div>
    </Modal>
  );
}
