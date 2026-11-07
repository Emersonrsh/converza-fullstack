import { useEffect, useRef, useState } from 'react';
import { api, apiFetch } from '../api';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';
import { useRecorder, mmss } from '../components/useRecorder';
import { ConfirmModal } from '../kanban/modals';
import type { Voice } from './types';

interface Sample { id: string; blob: Blob; name: string; seconds: number | null; url: string }
const ACCEPT = 'audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.webm,.flac';
const OK_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|mp4|aac|webm|flac)$/i;
const rid = () => Math.random().toString(36).slice(2, 9);

/** Duração de um arquivo de áudio pelo navegador (null se ele não souber dizer). */
function probe(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : null);
    a.onerror = () => resolve(null);
    a.src = url;
    setTimeout(() => resolve(null), 4000);
  });
}

function VoiceRow({ v, onChange, onDelete }: { v: Voice; onChange: (v: Voice) => void; onDelete: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    if (v.hasPreview) {
      apiFetch(`/agents/voices/${v.id}/preview`).then((r) => r.blob()).then((b) => { if (alive) { url = URL.createObjectURL(b); setSrc(url); } }).catch(() => {});
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [v.id, v.hasPreview, v.previewText]);
  async function accept() {
    setBusy(true);
    try { const r = await api.post<{ voice: Voice }>(`/agents/voices/${v.id}/accept`); onChange({ ...v, ...r.voice }); toast(`Voz “${v.name}” aceita — já dá para usar nos agentes`); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  }
  async function regen() {
    setBusy(true);
    try { const r = await api.post<{ voice: Voice }>(`/agents/voices/${v.id}/preview`, {}); onChange({ ...v, ...r.voice, previewText: `${r.voice.previewText}` }); toast('Prévia gerada de novo'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  }
  return (
    <div className="ag-voice" data-testid="voice-row">
      <span className="ag-voice-ic"><Icon name="mic" size={16} /></span>
      <div className="ag-voice-main">
        <div className="row" style={{ gap: 8 }}>
          <b>{v.name}</b>
          <span className={cx('pill', v.status === 'ready' ? 'green' : 'amber')} data-testid="voice-status">{v.status === 'ready' ? 'Aceita' : 'Ouça e decida'}</span>
          <small className="faint">{v.samples} áudio{v.samples === 1 ? '' : 's'}{v.agents.length ? ` · usada por ${v.agents.join(', ')}` : ''}</small>
        </div>
        {src ? <audio controls preload="none" src={src} data-testid="voice-preview" /> : <small className="faint">{v.hasPreview ? 'Carregando a prévia…' : 'Sem prévia — gere de novo.'}</small>}
        {v.previewText && <small className="faint">“{v.previewText}”</small>}
      </div>
      <div className="ag-voice-act">
        {v.status === 'pending' && <button type="button" className="btn sm primary" disabled={busy} onClick={accept} data-testid="voice-accept"><Icon name="check" size={14} />Ficar com ela</button>}
        <button type="button" className="btn sm" disabled={busy} onClick={regen} title="Gera a prévia de novo (gasta tokens)"><Icon name="refresh" size={14} />Ouvir de novo</button>
        <button type="button" className="btn sm ghost danger" disabled={busy} onClick={onDelete} data-testid="voice-delete"><Icon name="trash" size={14} />{v.status === 'pending' ? 'Descartar' : 'Excluir'}</button>
      </div>
    </div>
  );
}

export function VoicesTab({ canEdit }: { canEdit: boolean }) {
  const [list, setList] = useState<Voice[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [languages, setLanguages] = useState<{ id: string; label: string }[]>([{ id: 'pt', label: 'Português' }]);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('pt');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [del, setDel] = useState<Voice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.get<{ voices: Voice[]; voiceEnabled: boolean; languages: { id: string; label: string }[] }>('/agents/voices')
    .then((r) => { setList(r.voices); setEnabled(r.voiceEnabled); setLanguages(r.languages); })
    .catch((e) => { toast(e instanceof Error ? e.message : 'Erro'); setList([]); });
  useEffect(() => { void load(); }, []);
  useEffect(() => () => samples.forEach((s) => URL.revokeObjectURL(s.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function addBlobs(items: { blob: Blob; name: string; seconds?: number }[]) {
    const room = 3 - samples.length;
    if (room <= 0) { toast('No máximo 3 áudios por voz'); return; }
    const accepted = items.filter((x) => x.blob.type.startsWith('audio/') || x.blob.type === 'video/webm' || OK_EXT.test(x.name));
    if (accepted.length < items.length) toast('Só arquivos de áudio: MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC');
    const next: Sample[] = [];
    for (const x of accepted.slice(0, room)) {
      const url = URL.createObjectURL(x.blob);
      next.push({ id: rid(), blob: x.blob, name: x.name, url, seconds: x.seconds ?? await probe(url) });
    }
    if (accepted.length > room) toast('No máximo 3 áudios por voz');
    setSamples((s) => [...s, ...next]);
  }
  const rec = useRecorder({ maxSeconds: 120, onDone: (blob, secs) => { void addBlobs([{ blob, name: `Gravação ${samples.length + 1}`, seconds: secs }]); } });
  function remove(id: string) { setSamples((s) => { const x = s.find((y) => y.id === id); if (x) URL.revokeObjectURL(x.url); return s.filter((y) => y.id !== id); }); }

  const total = samples.reduce((a, s) => a + (s.seconds ?? 0), 0);
  async function create() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('language', language);
      for (const s of samples) {
        const ext = OK_EXT.test(s.name) ? '' : `.${(s.blob.type.split('/')[1] ?? 'webm').split(';')[0].replace('mpeg', 'mp3')}`;
        fd.append('files', s.blob, `${s.name}${ext}`);
      }
      const res = await apiFetch('/agents/voices', { method: 'POST', body: fd });
      const r = await res.json() as { voice: Voice };
      setList((l) => [r.voice, ...(l ?? [])]);
      samples.forEach((s) => URL.revokeObjectURL(s.url));
      setSamples([]); setName('');
      toast('Voz criada — ouça a prévia e decida se fica com ela');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível criar a voz'); }
    setBusy(false);
  }

  if (!list) return <Spinner />;
  return (
    <div className="stack" style={{ gap: 16 }} data-testid="voices-tab">
      <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>Grave ou anexe de 1 a 3 áudios, dê um nome e crie. Ouça a prévia e decida se fica com ela. A voz aceita pode ser usada por qualquer agente desta conta — outras contas não veem.</p>
      {!enabled && <div className="hint"><Icon name="alert" size={14} />A clonagem de voz precisa da chave da ElevenLabs no servidor (ELEVENLABS_API_KEY). Sem ela, os agentes respondem só em texto.</div>}
      {canEdit && (
        <div className="card pad ag-voice-form">
          <div className="ag-two">
            <div><label className="label">Nome</label><input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Voz da Ana" data-testid="voice-name" /></div>
            <div><label className="label">Idioma da fala</label>
              <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="voice-language">
                {languages.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
          </div>
          <label className="label" style={{ marginTop: 12 }}>Áudios</label>
          <div className={cx('ag-drop', drag && 'on')} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); void addBlobs([...e.dataTransfer.files].map((f) => ({ blob: f, name: f.name }))); }} data-testid="voice-drop">
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn ag-drop-btn" disabled={!enabled || samples.length >= 3 || rec.recording} onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} />Anexar áudio</button>
              {rec.supported && (
                <button type="button" className={cx('btn', rec.recording && 'danger')} disabled={!enabled || (samples.length >= 3 && !rec.recording)} onClick={() => (rec.recording ? rec.stop() : void rec.start())} data-testid="voice-record">
                  <Icon name={rec.recording ? 'pause' : 'mic'} size={15} />{rec.recording ? `Parar ${mmss(rec.seconds)}` : 'Gravar'}
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { void addBlobs([...(e.target.files ?? [])].map((f) => ({ blob: f, name: f.name }))); e.target.value = ''; }} data-testid="voice-file" />
            <small className="faint">Ou solte o áudio aqui. De 1 a 3 áudios da voz: MP3, WAV, OGG, M4A, AAC, WEBM ou FLAC.</small>
            {rec.error && <small className="err">{rec.error}</small>}
            {samples.length > 0 && (
              <div className="ag-samples">
                {samples.map((s) => (
                  <div key={s.id} className="ag-sample" data-testid="voice-sample">
                    <Icon name="mic" size={14} /><span className="ag-sample-name">{s.name}</span>
                    <small className="faint">{s.seconds ? mmss(s.seconds) : ''}</small>
                    <audio controls preload="metadata" src={s.url} />
                    <button type="button" className="btn icon sm ghost" onClick={() => remove(s.id)} aria-label={`Remover ${s.name}`}><Icon name="close" size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <small className="faint" style={{ display: 'block', marginTop: 6 }}>
            Dica: fale naturalmente, sem música nem barulho ao fundo. Juntando tudo, de 30 segundos a 2 minutos dá o melhor resultado{total ? ` (agora: ${mmss(total)})` : ''}.
          </small>
          <button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={!enabled || busy || !name.trim() || !samples.length} onClick={create} data-testid="voice-create">
            {busy ? 'Criando a voz…' : 'Criar voz'}
          </button>
        </div>
      )}
      {list.length ? (
        <div className="stack" style={{ gap: 10 }}>
          {list.map((v) => <VoiceRow key={v.id} v={v} onChange={(nv) => setList((l) => (l ?? []).map((x) => (x.id === nv.id ? nv : x)))} onDelete={() => setDel(v)} />)}
        </div>
      ) : <p className="faint" style={{ margin: 0 }} data-testid="voices-empty">Nenhuma voz criada.</p>}
      {del && (
        <ConfirmModal title={del.status === 'pending' ? 'Descartar voz' : 'Excluir voz'} confirm={del.status === 'pending' ? 'Descartar' : 'Excluir'} danger onClose={() => setDel(null)}
          onConfirm={async () => {
            try { await api.del(`/agents/voices/${del.id}`); setList((l) => (l ?? []).filter((x) => x.id !== del.id)); toast('Voz removida'); setDel(null); }
            catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
          }}>
          {del.agents.length ? <>Os agentes <b>{del.agents.join(', ')}</b> voltam para a voz padrão da plataforma.</> : <>A voz <b>{del.name}</b> será apagada.</>}
        </ConfirmModal>
      )}
    </div>
  );
}
