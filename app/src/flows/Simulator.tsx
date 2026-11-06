import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { cx } from '../components/ui';

type SimOutput =
  | { kind: 'bot'; text: string }
  | { kind: 'media'; mediaType: string; url: string; caption?: string }
  | { kind: 'menu'; text: string; options: { id: string; title: string }[] }
  | { kind: 'note'; text: string };

type Item = (SimOutput | { kind: 'me'; text: string }) & { key: number; answered?: boolean };

interface SimState { status: 'idle' | 'input' | 'payment' | 'end'; nodeId: string | null; [k: string]: unknown; }
interface SimResult { outputs: SimOutput[]; state: SimState; visited: string[]; }

type SimInput =
  | { type: 'start' }
  | { type: 'message'; text: string; replyId?: string | null }
  | { type: 'payment'; paid: boolean };

interface Props {
  hidden?: boolean;
  triggerType: string;
  getGraph: () => { nodes: unknown[]; edges: unknown[] };
  onCursor: (nodeId: string | null) => void;
  onClose: () => void;
}

let seq = 0;
const MEDIA_LABEL: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', document: '📄 Documento' };

export function Simulator({ hidden, triggerType, getGraph, onCursor, onClose }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [simState, setSimState] = useState<SimState | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [realHttp, setRealHttp] = useState(false);
  const [contactName, setContactName] = useState('Cliente Teste');
  const [showOpts, setShowOpts] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout>>();

  const status = simState?.status ?? 'idle';

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [items, busy]);

  useEffect(() => () => { clearTimeout(endTimer.current); onCursor(null); }, [onCursor]);

  const push = (...list: (SimOutput | { kind: 'me'; text: string })[]) =>
    setItems((cur) => [...cur, ...list.map((o) => ({ ...o, key: ++seq }))]);

  async function run(input: SimInput, echo?: string) {
    if (busy) return;
    clearTimeout(endTimer.current);
    if (echo !== undefined) {
      setItems((cur) => cur.map((i) => (i.kind === 'menu' ? { ...i, answered: true } : i)));
      push({ kind: 'me', text: echo });
    }
    setBusy(true);
    try {
      const state = simState ?? { contact: { name: contactName.trim() || 'Cliente Teste', phone: '+55 11 99999-0000', stage: 'new', tags: [] } };
      const r = await api.post<SimResult>('/flows/simulate', { graph: getGraph(), state, input, realHttp });
      push(...r.outputs);
      setSimState(r.state);
      const waiting = r.state.status === 'input' || r.state.status === 'payment';
      const cursor = waiting ? r.state.nodeId : r.visited[r.visited.length - 1] ?? null;
      onCursor(cursor);
      if (!waiting) endTimer.current = setTimeout(() => onCursor(null), 1800);
    } catch (err) {
      push({ kind: 'note', text: `⚠️ ${(err as Error).message}` });
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void run({ type: 'message', text: t }, t);
  }

  function restart() {
    clearTimeout(endTimer.current);
    setItems([]); setSimState(null); setText(''); onCursor(null);
  }

  const startsByEvent = triggerType === 'webhook' || triggerType === 'manual';

  return (
    <aside className="fb-sim fade" style={hidden ? { display: 'none' } : undefined} onKeyDown={(e) => e.stopPropagation()} data-testid="simulator">
      <div className="sim-hd">
        <div className="av"><Icon name="play" size={16} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Simulador</b>
          <div className="faint" style={{ fontSize: 11.5, fontWeight: 600 }}>Teste como cliente — nada é enviado no WhatsApp</div>
        </div>
        <button type="button" className={cx('btn icon sm ghost', showOpts && 'on')} onClick={() => setShowOpts((v) => !v)} title="Opções" aria-label="Opções do simulador"><Icon name="gear" size={15} /></button>
        <button type="button" className="btn icon sm ghost" onClick={restart} title="Reiniciar" aria-label="Reiniciar simulação"><Icon name="refresh" size={15} /></button>
        <button type="button" className="btn icon sm ghost" onClick={onClose} title="Fechar" aria-label="Fechar simulador"><Icon name="close" size={16} /></button>
      </div>

      {showOpts && (
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 10 }}>
          <div>
            <label className="label">Nome do contato de teste</label>
            <input className="input sm" value={contactName} disabled={!!simState} onChange={(e) => setContactName(e.target.value)} />
            {simState && <div className="cf-hint">Reinicie a simulação para trocar o nome.</div>}
          </div>
          <label className="tgl">
            <input type="checkbox" checked={realHttp} onChange={(e) => setRealHttp(e.target.checked)} />
            <span className={cx('switch', realHttp && 'on')} aria-hidden="true"><i /></span>
            <span style={{ fontSize: 12.5 }}>Chamar integrações (Webhook/HTTP) de verdade</span>
          </label>
          <div className="cf-hint" style={{ marginTop: -4 }}>Blocos de IA respondem de verdade e consomem tokens do plano.</div>
        </div>
      )}

      <div className="sim-chat" ref={chatRef}>
        {items.length === 0 && !busy && (
          <div className="simnote" style={{ marginTop: 'auto', marginBottom: 'auto' }}>
            {startsByEvent
              ? 'Este fluxo começa por um evento (webhook ou outro fluxo). Clique em “Iniciar” para simular o evento.'
              : 'Clique em “Iniciar” para disparar o gatilho, ou escreva uma mensagem como se fosse o cliente.'}
          </div>
        )}
        {items.map((it) => {
          if (it.kind === 'me') return <div key={it.key} className="bub me">{it.text}</div>;
          if (it.kind === 'bot') return <div key={it.key} className="bub bot">{it.text}</div>;
          if (it.kind === 'note') return <div key={it.key} className="simnote">{it.text}</div>;
          if (it.kind === 'media') {
            return (
              <div key={it.key} className="bub bot">
                {it.mediaType === 'image' && /^https?:\/\//.test(it.url)
                  ? <img src={it.url} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  : <div className="media"><Icon name="paperclip" size={14} />{MEDIA_LABEL[it.mediaType] ?? 'Arquivo'}</div>}
                <div className="faint" style={{ fontSize: 11, wordBreak: 'break-all' }}>{it.url}</div>
                {it.caption && <div style={{ marginTop: 4 }}>{it.caption}</div>}
              </div>
            );
          }
          return (
            <div key={it.key} className="bub bot">
              {it.text}
              <div className="opts">
                {it.options.map((o) => (
                  <button type="button" key={o.id} disabled={it.answered || busy}
                    onClick={() => run({ type: 'message', text: o.title, replyId: o.id }, o.title)}>{o.title}</button>
                ))}
              </div>
            </div>
          );
        })}
        {busy && <div className="typing"><i /><i /><i /></div>}
      </div>

      <div className="sim-ft">
        {status === 'payment' ? (
          <>
            <div className="faint" style={{ fontSize: 12, fontWeight: 700 }}>Simular o resultado do pagamento:</div>
            <div className="sim-pay">
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => run({ type: 'payment', paid: true }, '✅ (pagamento aprovado)')}>Aprovado</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => run({ type: 'payment', paid: false }, '⌛ (não pagou no prazo)')}>Não pagou</button>
            </div>
          </>
        ) : (
          <>
            {(status === 'idle' || status === 'end') && (
              <button type="button" className="btn sm primary" style={{ justifyContent: 'center' }} disabled={busy}
                onClick={() => { void run({ type: 'start' }); }} data-testid="sim-start">
                <Icon name="play" size={14} />{status === 'end' ? 'Iniciar de novo' : 'Iniciar'}
              </button>
            )}
            <form onSubmit={send}>
              <input ref={inputRef} className="input sm" value={text} onChange={(e) => setText(e.target.value)}
                placeholder={status === 'input' ? 'Responda como o cliente…' : 'Mensagem do cliente…'} maxLength={4000} data-testid="sim-input" />
              <button type="submit" className="btn sm primary icon" disabled={!text.trim() || busy} aria-label="Enviar"><Icon name="send" size={15} /></button>
            </form>
          </>
        )}
      </div>
    </aside>
  );
}
