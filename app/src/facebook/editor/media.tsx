import { useEffect, useRef, useState } from 'react';
import { api, apiFetch } from '../../api';
import { Icon } from '../../icons';
import { Spinner, cx, toast } from '../../components/ui';
import { CROPS, type Crop, type Media } from './model';
import { MediaPicker, errMsg, localVideos, readImage, useLookup, waitVideo } from './parts';

/**
 * "Personalizar mídia" como na Meta: cortes da imagem por proporção, duração do vídeo, miniatura,
 * mídia própria para Stories/Status/Reels e legendas.
 */

type Tab = 'crop' | 'trim' | 'thumb' | 'places' | 'captions';

export function MediaCustomize({ actId, media, story, allowStory, onClose, onSave }: {
  actId: string; media: Media; story: Media | null; allowStory: boolean; onClose: () => void; onSave: (m: Media, story: Media | null) => void;
}) {
  const [m, setM] = useState<Media>(media);
  const [st, setSt] = useState<Media | null>(story);
  const video = m.kind === 'video';
  const [tab, setTab] = useState<Tab>(video ? 'trim' : 'crop');
  const tabs: [Tab, string, string][] = [
    ...(video ? [] : [['crop', 'Cortar', 'crop']] as [Tab, string, string][]),
    ...(video ? [['trim', 'Duração do vídeo', 'scissors'], ['thumb', 'Miniatura', 'image']] as [Tab, string, string][] : []),
    ['places', 'Posicionamentos', 'grid'],
    ...(video ? [['captions', 'Legendas', 'captions']] as [Tab, string, string][] : []),
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fade mc" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" data-testid="mc">
        <div className="mh"><div><b>Personalizar mídia</b><small className="faint">Opcional. As mudanças valem só para esta mídia neste anúncio.</small></div><button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="mc-body">
          <nav className="mc-nav">
            <div className="mc-file">{m.url ? <img src={m.url} alt="" /> : <span><Icon name={video ? 'video' : 'image'} /></span>}<div><b>{m.name || (video ? 'Vídeo' : 'Imagem')}</b>{m.width && m.height ? <small>{m.width} × {m.height}</small> : null}</div></div>
            {tabs.map(([id, label, ic]) => (
              <button key={id} type="button" className={cx(tab === id && 'on')} onClick={() => setTab(id)} data-testid={`mc-tab-${id}`}><Icon name={ic} size={15} />{label}<Icon name="chevronRight" size={13} /></button>
            ))}
          </nav>
          <div className="mc-main">
            {tab === 'crop' && <Crops m={m} set={setM} />}
            {tab === 'trim' && <Trim actId={actId} m={m} set={setM} />}
            {tab === 'thumb' && <Thumb actId={actId} m={m} set={setM} />}
            {tab === 'places' && (
              <div className="mc-places" data-testid="mc-places">
                <b>Mídia para Stories, Status e Reels</b>
                <p className="faint">Por padrão a mesma mídia aparece em todos os posicionamentos (a Meta adapta). Para usar uma versão vertical (9:16) só em Stories, Status e Reels, escolha abaixo; os feeds continuam com a mídia principal.</p>
                {allowStory
                  ? <MediaPicker actId={actId} value={st} onChange={setSt} testId="mc-story" />
                  : <div className="ed-note"><Icon name="info" size={15} />A Meta só aceita mídia diferente por posicionamento quando o destino do anúncio é Site ou App.</div>}
                <p className="faint">Para não aparecer em algum lugar (ex.: Audience Network), use os posicionamentos manuais do conjunto de anúncios.</p>
              </div>
            )}
            {tab === 'captions' && <Captions actId={actId} m={m} />}
          </div>
        </div>
        <div className="mf">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" onClick={() => { onSave(m, st); onClose(); }} data-testid="mc-save">Salvar</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- cortes */

function useNatural(m: Media) {
  const [n, setN] = useState<{ w: number; h: number } | null>(m.width && m.height ? { w: m.width, h: m.height } : null);
  useEffect(() => {
    if (n || !m.url) return;
    const i = new Image(); i.onload = () => setN({ w: i.naturalWidth, h: i.naturalHeight }); i.src = m.url;
  }, [m.url]); // eslint-disable-line react-hooks/exhaustive-deps
  return n;
}
/** maior retângulo da proporção, centrado */
export function centerCrop(w: number, h: number, aw: number, ah: number, scale = 1): Crop {
  let cw = w; let ch = (w * ah) / aw;
  if (ch > h) { ch = h; cw = (h * aw) / ah; }
  cw *= scale; ch *= scale;
  const x = (w - cw) / 2; const y = (h - ch) / 2;
  return [[Math.round(x), Math.round(y)], [Math.round(x + cw), Math.round(y + ch)]];
}

function Crops({ m, set }: { m: Media; set: (m: Media) => void }) {
  const nat = useNatural(m);
  if (!m.url) return <p className="faint">A imagem ainda não carregou.</p>;
  if (!nat) return <Spinner />;
  return (
    <div className="mc-crops" data-testid="mc-crops">
      <small className="faint mc-hint"><Icon name="info" size={13} />A Meta também pode mostrar a mídia em outros posicionamentos compatíveis quando for melhorar o resultado.</small>
      {CROPS.map((c) => {
        const cur = m.crops?.[c.key];
        const setCrop = (v: Crop | null) => {
          const next = { ...(m.crops ?? {}) };
          if (v) next[c.key] = v; else delete next[c.key];
          set({ ...m, width: nat.w, height: nat.h, crops: next });
        };
        return (
          <div key={c.key} className="mc-crop" data-testid={`mc-crop-${c.key}`}>
            <div className="mc-crop-h"><b>{c.label}</b><small className="faint">{c.use}</small></div>
            <select className="input" value={cur ? 'custom' : 'original'} onChange={(e) => setCrop(e.target.value === 'custom' ? centerCrop(nat.w, nat.h, c.w, c.h) : null)} data-testid={`mc-crop-mode-${c.key}`}>
              <option value="original">Original (a Meta ajusta)</option><option value="custom">Personalizado</option>
            </select>
            <CropBox url={m.url!} nat={nat} aspect={c.w / c.h} crop={cur ?? null} onChange={setCrop} />
          </div>
        );
      })}
    </div>
  );
}

/** Imagem com o retângulo do corte: arrastar move, o controle muda o tamanho. */
function CropBox({ url, nat, aspect, crop, onChange }: { url: string; nat: { w: number; h: number }; aspect: number; crop: Crop | null; onChange: (c: Crop) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const W = 230; const k = W / nat.w; const H = nat.h * k;
  const drag = useRef<{ x: number; y: number; c: Crop } | null>(null);
  const cw = crop ? crop[1][0] - crop[0][0] : 0; const ch = crop ? crop[1][1] - crop[0][1] : 0;
  const full = centerCrop(nat.w, nat.h, aspect, 1);
  const scale = crop ? cw / (full[1][0] - full[0][0]) : 1;
  const move = (dx: number, dy: number, base: Crop) => {
    const w = base[1][0] - base[0][0]; const h = base[1][1] - base[0][1];
    const x = Math.min(Math.max(0, base[0][0] + dx), nat.w - w); const y = Math.min(Math.max(0, base[0][1] + dy), nat.h - h);
    onChange([[Math.round(x), Math.round(y)], [Math.round(x + w), Math.round(y + h)]]);
  };
  return (
    <div className="mc-cropbox">
      <div ref={box} className="mc-cropimg" style={{ width: W, height: H, backgroundImage: `url(${url})` }}
        onPointerMove={(e) => { if (drag.current) move((e.clientX - drag.current.x) / k, (e.clientY - drag.current.y) / k, drag.current.c); }}
        onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
        {crop ? (
          <div className="mc-croprect" style={{ left: crop[0][0] * k, top: crop[0][1] * k, width: cw * k, height: ch * k }}
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, c: crop }; }} />
        ) : (
          (() => { const f = centerCrop(nat.w, nat.h, aspect, 1); return <div className="mc-croprect ghost" style={{ left: f[0][0] * k, top: f[0][1] * k, width: (f[1][0] - f[0][0]) * k, height: (f[1][1] - f[0][1]) * k }} />; })()
        )}
      </div>
      {crop && (
        <label className="mc-zoom"><Icon name="search" size={12} />
          <input type="range" min={30} max={100} value={Math.round(scale * 100)} onChange={(e) => {
            const s = Number(e.target.value) / 100;
            const nc = centerCrop(nat.w, nat.h, aspect, 1);
            const nw = (nc[1][0] - nc[0][0]) * s; const nh = (nc[1][1] - nc[0][1]) * s;
            const cx0 = (crop[0][0] + crop[1][0]) / 2; const cy0 = (crop[0][1] + crop[1][1]) / 2;
            const x = Math.min(Math.max(0, cx0 - nw / 2), nat.w - nw); const y = Math.min(Math.max(0, cy0 - nh / 2), nat.h - nh);
            onChange([[Math.round(x), Math.round(y)], [Math.round(x + nw), Math.round(y + nh)]]);
          }} />
        </label>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- vídeo */

const ts = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;

function Trim({ actId, m, set }: { actId: string; m: Media; set: (m: Media) => void }) {
  const local = m.videoId ? localVideos.get(m.videoId) : undefined;
  const vref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState<number | null>(null);
  const [a, setA] = useState(0); const [b, setB] = useState(15);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (dur) setB(Math.min(dur, Math.max(b, 1))); }, [dur]); // eslint-disable-line react-hooks/exhaustive-deps
  async function apply() {
    if (!m.videoId || b - a < 1) return;
    setBusy('Cortando o vídeo…');
    try {
      let id: string;
      const name = `${(m.name ?? 'video').replace(/\.[^.]+$/, '')}-${Math.round(b - a)}s.mp4`;
      if (local) {
        const r = await apiFetch('/meta/editor/video', { method: 'POST', headers: { 'x-act-id': actId, 'x-file-name': encodeURIComponent(name), 'x-trim-start': String(a), 'x-trim-end': String(b), 'content-type': local.file.type || 'video/mp4' }, body: local.file });
        id = ((await r.json()) as { id: string }).id;
      } else {
        id = (await api.post<{ id: string }>(`/meta/editor/video/${m.videoId}/trim`, { actId, start: a, end: b, name })).id;
      }
      if (local) localVideos.set(id, local);
      setBusy('A Meta está processando a versão cortada…');
      set({ ...m, videoId: id, url: null, name, thumbHash: null });
      await waitVideo(actId, id, (u) => set({ ...m, videoId: id, url: u, name, thumbHash: null }));
      toast('Versão cortada pronta.');
    } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  }
  return (
    <div className="mc-trim" data-testid="mc-trim">
      <b>Duração do vídeo</b>
      <p className="faint">Crie uma versão mais curta. Vídeos curtos (até 15 segundos) aparecem em mais posicionamentos.</p>
      {local
        ? <video ref={vref} src={local.url} controls className="mc-video" onLoadedMetadata={(e) => setDur((e.target as HTMLVideoElement).duration)} />
        : m.url ? <img src={m.url} alt="" className="mc-video" /> : null}
      {local && dur ? (
        <div className="mc-range">
          <label>Início <input type="range" min={0} max={dur} step={0.1} value={a} onChange={(e) => { const v = Math.min(Number(e.target.value), b - 1); setA(v); if (vref.current) vref.current.currentTime = v; }} data-testid="mc-trim-a" /><span>{ts(a)}</span></label>
          <label>Fim <input type="range" min={0} max={dur} step={0.1} value={b} onChange={(e) => { const v = Math.max(Number(e.target.value), a + 1); setB(v); if (vref.current) vref.current.currentTime = v; }} data-testid="mc-trim-b" /><span>{ts(b)}</span></label>
          <small className={cx(b - a > 15 ? 'warn' : 'faint')}><Icon name="clock" size={12} />Duração: {(b - a).toFixed(1)} s (recomendado: até 15 s)</small>
        </div>
      ) : (
        <div className="ed-grid2">
          <label className="ed-row"><span>Início (segundos)</span><input className="input" type="number" min={0} step={0.1} value={a} onChange={(e) => setA(Number(e.target.value) || 0)} data-testid="mc-trim-start" /></label>
          <label className="ed-row"><span>Fim (segundos)</span><input className="input" type="number" min={1} step={0.1} value={b} onChange={(e) => setB(Number(e.target.value) || 1)} data-testid="mc-trim-end" /></label>
        </div>
      )}
      <button type="button" className="btn primary" disabled={!!busy || b - a < 1} onClick={() => void apply()} data-testid="mc-trim-apply">{busy ? <span className="spin sm" /> : <Icon name="scissors" size={14} />}{busy ?? 'Criar versão cortada'}</button>
      <small className="faint">O corte é feito no Converza e a versão nova sobe para a sua conta; o vídeo original continua na biblioteca. O corte cai no quadro-chave mais próximo (pode variar alguns décimos de segundo).</small>
    </div>
  );
}

function Thumb({ actId, m, set }: { actId: string; m: Media; set: (m: Media) => void }) {
  const [list, setList] = useState<{ id: string; uri: string; preferred: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const local = m.videoId ? localVideos.get(m.videoId) : undefined;
  const vref = useRef<HTMLVideoElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!m.videoId) return;
    api.get<{ results: { id: string; uri: string; preferred: boolean }[] }>(`/meta/editor/lookup/video-thumbs?actId=${actId}&q=${m.videoId}`).then((r) => setList(r.results)).catch(() => setList([]));
  }, [m.videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function upload(data: string, name: string, preview: string) {
    setBusy(true);
    try {
      const r = await api.post<{ hash: string; url: string | null }>('/meta/editor/image', { actId, name, data });
      set({ ...m, thumbHash: r.hash, url: r.url ?? preview }); toast('Miniatura escolhida.');
    } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  }
  function grab() {
    const v = vref.current; if (!v) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    const url = c.toDataURL('image/jpeg', 0.9);
    void upload(url.split(',')[1], `capa-${Math.round(v.currentTime)}s.jpg`, url);
  }
  return (
    <div className="mc-thumb" data-testid="mc-thumb">
      <b>Miniatura</b>
      <p className="faint">A imagem que aparece antes do vídeo começar.</p>
      {list === null ? <Spinner /> : list.length > 0 && (
        <div className="ed-lib">
          {list.map((t) => (
            <button type="button" key={t.id} className={cx(!m.thumbHash && m.url === t.uri && 'on')} onClick={() => set({ ...m, url: t.uri, thumbHash: null })} data-testid="mc-thumb-opt"><img src={t.uri} alt="" /></button>
          ))}
        </div>
      )}
      {local && (
        <div className="mc-grab">
          <video ref={vref} src={local.url} controls className="mc-video" />
          <button type="button" className="btn" disabled={busy} onClick={grab} data-testid="mc-thumb-grab"><Icon name="image" size={14} />Usar o quadro atual</button>
        </div>
      )}
      <input ref={file} type="file" hidden accept="image/jpeg,image/png" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const i = await readImage(f); await upload(i.data, i.name, i.preview); } catch (err) { toast(errMsg(err)); } }} data-testid="mc-thumb-file" />
      <button type="button" className="btn ghost" disabled={busy} onClick={() => file.current?.click()}><Icon name="upload" size={14} />Enviar uma imagem como miniatura</button>
      {m.url && <div className="mc-thumb-cur"><small className="faint">Miniatura atual</small><img src={m.url} alt="" /></div>}
    </div>
  );
}

function Captions({ actId, m }: { actId: string; m: Media }) {
  const [locale, setLocale] = useState('pt_BR');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  async function send(f: File) {
    if (!m.videoId) return;
    setBusy(true);
    try {
      const srt = await f.text();
      await api.post(`/meta/editor/video/${m.videoId}/captions`, { actId, srt, locale });
      setDone(true); toast('Legendas enviadas.');
    } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="mc-trim" data-testid="mc-captions">
      <b>Legendas</b>
      <p className="faint">Envie um arquivo de legendas .srt (com os tempos “00:00:01,000 --&gt; 00:00:03,000”). Muita gente assiste sem som.</p>
      <label className="ed-row"><span>Idioma</span>
        <select className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
          <option value="pt_BR">Português (Brasil)</option><option value="en_US">Inglês</option><option value="es_LA">Espanhol</option>
        </select>
      </label>
      <input ref={file} type="file" hidden accept=".srt,application/x-subrip,text/plain" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void send(f); }} data-testid="mc-captions-file" />
      <button type="button" className="btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? <span className="spin sm" /> : <Icon name="upload" size={14} />}Enviar arquivo .srt</button>
      {done && <small className="ok"><Icon name="checkCircle" size={13} />Legendas no vídeo.</small>}
      <small className="faint">A audiodescrição e as legendas automáticas da Meta não estão disponíveis pela API.</small>
    </div>
  );
}

/* ---------------------------------------------------------------- pixel, publicação existente e parâmetros de URL */

export type PixelOpt = { id: string; name: string; active?: boolean; lastFired?: string | null };

/** Escolher o conjunto de dados (pixel) com o ID e a situação, como na Meta. */
export function PixelSelect({ actId, value, onChange, testId }: { actId: string; value: string; onChange: (id: string) => void; testId: string }) {
  const pixels = useLookup<PixelOpt>(actId, 'pixels');
  const [open, setOpen] = useState(false);
  const cur = pixels.list?.find((p) => p.id === value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="px-sel" ref={ref}>
      <button type="button" className="input px-sel-btn" onClick={() => setOpen(!open)} data-testid={testId}>
        {cur ? <><i className={cx('px-dot', cur.active && 'on')} />{cur.name}</> : <span className="faint">{pixels.list === null ? 'Carregando…' : pixels.list.length ? 'Escolha o conjunto de dados' : 'Nenhum pixel nesta conta'}</span>}
        <Icon name="chevron" size={13} />
      </button>
      {open && (
        <div className="px-sel-list" data-testid={`${testId}-list`}>
          {(pixels.list ?? []).map((p) => (
            <button type="button" key={p.id} className={cx(p.id === value && 'on')} onClick={() => { onChange(p.id); setOpen(false); }} data-testid={`${testId}-opt`}>
              <span className="px-radio" /><i className={cx('px-dot', p.active && 'on')} title={p.active ? 'Recebendo eventos' : 'Sem eventos nos últimos 7 dias'} />
              <span><b>{p.name}</b><small>Pixel ID: {p.id}{p.lastFired ? ` · último evento ${new Date(p.lastFired).toLocaleDateString('pt-BR')}` : ''}</small></span>
            </button>
          ))}
          {pixels.error && <small className="err">{pixels.error}</small>}
        </div>
      )}
    </div>
  );
}

type Post = { id: string; text: string; picture: string | null; at: string | null; type?: string | null };

export function PostPicker({ actId, pageId, igId, postId, igMediaId, onPick }: {
  actId: string; pageId: string; igId: string; postId: string; igMediaId: string; onPick: (p: { postId: string; igMediaId: string; picture: string | null; text: string }) => void;
}) {
  const [net, setNet] = useState<'fb' | 'ig'>(igMediaId ? 'ig' : 'fb');
  const [list, setList] = useState<Post[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setList(null); setErr(null);
    if (net === 'fb' && !pageId) { setList([]); return; }
    if (net === 'ig' && !igId) { setList([]); return; }
    const url = net === 'fb' ? `/meta/editor/lookup/page-posts?actId=${actId}&pageId=${pageId}` : `/meta/editor/lookup/ig-media?actId=${actId}&q=${igId}`;
    api.get<{ results: Post[] }>(url).then((r) => setList(r.results)).catch((e) => { setList([]); setErr(errMsg(e)); });
  }, [net, pageId, igId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="pp" data-testid="ed-posts">
      <div className="ed-create-tabs pp-tabs">
        <button type="button" className={cx(net === 'fb' && 'on')} onClick={() => setNet('fb')}>Facebook</button>
        <button type="button" className={cx(net === 'ig' && 'on')} onClick={() => setNet('ig')} data-testid="ed-posts-ig">Instagram</button>
      </div>
      {list === null ? <Spinner /> : !list.length ? (
        <small className="faint">{err ?? (net === 'fb' ? (pageId ? 'Nenhuma publicação na Página.' : 'Escolha a Página primeiro.') : igId ? 'Nenhuma publicação no Instagram.' : 'Escolha a conta do Instagram na identidade.')}</small>
      ) : (
        <div className="pp-list">
          {list.map((p) => {
            const on = net === 'fb' ? postId === p.id : igMediaId === p.id;
            return (
              <button type="button" key={p.id} className={cx('pp-item', on && 'on')} onClick={() => onPick(net === 'fb' ? { postId: p.id, igMediaId: '', picture: p.picture, text: p.text } : { postId: '', igMediaId: p.id, picture: p.picture, text: p.text })} data-testid="ed-post">
                {p.picture ? <img src={p.picture} alt="" /> : <span className="pp-ph"><Icon name="image" /></span>}
                <span><small>{p.at ? new Date(p.at).toLocaleDateString('pt-BR') : ''}{p.type === 'VIDEO' ? ' · vídeo' : ''}</small>{p.text ? p.text.slice(0, 90) : <i className="faint">Sem texto</i>}</span>
                {on && <Icon name="checkCircle" size={16} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const DYN: [string, string][] = [['{{campaign.name}}', 'Nome da campanha'], ['{{campaign.id}}', 'ID da campanha'], ['{{adset.name}}', 'Nome do conjunto'], ['{{adset.id}}', 'ID do conjunto'],
  ['{{ad.name}}', 'Nome do anúncio'], ['{{ad.id}}', 'ID do anúncio'], ['{{placement}}', 'Posicionamento'], ['{{site_source_name}}', 'Origem (fb, ig, msg, an)']];

/** "Criar um parâmetro de URL": UTMs com os parâmetros dinâmicos da Meta. */
export function UtmBuilder({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const cur = new URLSearchParams(value);
  const [f, setF] = useState({
    utm_source: cur.get('utm_source') ?? '{{site_source_name}}', utm_medium: cur.get('utm_medium') ?? 'paid', utm_campaign: cur.get('utm_campaign') ?? '{{campaign.name}}',
    utm_content: cur.get('utm_content') ?? '{{ad.name}}', utm_term: cur.get('utm_term') ?? '{{adset.name}}',
  });
  const out = Object.entries(f).filter(([, v]) => v.trim()).map(([k, v]) => `${k}=${v.trim()}`).join('&');
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fade" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" data-testid="utm">
        <div className="mh"><b>Criar um parâmetro de URL</b><button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="mb utm">
          {([['utm_source', 'Origem da campanha'], ['utm_medium', 'Mídia da campanha'], ['utm_campaign', 'Nome da campanha'], ['utm_content', 'Conteúdo da campanha'], ['utm_term', 'Termo']] as const).map(([k, l]) => (
            <label key={k} className="ed-row"><span>{l} <code>{k}</code></span>
              <input className="input" list="utm-dyn" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`utm-${k}`} />
            </label>
          ))}
          <datalist id="utm-dyn">{DYN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</datalist>
          <small className="faint">Parâmetros dinâmicos: {DYN.map(([v]) => v).join(' ')}</small>
          <div className="utm-out"><small>Prévia</small><code data-testid="utm-out">{out}</code></div>
        </div>
        <div className="mf"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => { onChange(out); onClose(); }} data-testid="utm-apply">Aplicar</button></div>
      </div>
    </div>
  );
}
