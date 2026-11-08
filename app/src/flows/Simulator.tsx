import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { cx, toast } from '../components/ui';

type Btn = { id: string; title: string; type?: string };
type SimOutput =
  | { kind: 'bot'; text: string }
  | { kind: 'media'; mediaType: string; url: string; caption?: string }
  | { kind: 'menu'; text: string; options: { id: string; title: string; description?: string }[] }
  | { kind: 'contact'; name: string; phone: string }
  | { kind: 'pix'; text: string; amount: number; merchant: string; key: string; code: string }
  | { kind: 'carousel'; text: string; cards: { text: string; image: string; buttons: Btn[] }[] }
  | { kind: 'template'; name: string; text: string; buttons: Btn[] }
  | { kind: 'reaction'; emoji: string }
  | { kind: 'note'; text: string };

type Item = (SimOutput | { kind: 'me'; text: string; reaction?: string }) & { uid: number; answered?: boolean };

interface SimState { status: 'idle' | 'input' | 'payment' | 'end'; nodeId: string | null; canTimeout?: boolean; [k: string]: unknown; }
interface SimResult { outputs: SimOutput[]; state: SimState; visited: string[]; }

type SimInput =
  | { type: 'start' }
  | { type: 'message'; text: string; replyId?: string | null }
  | { type: 'payment'; paid: boolean }
  | { type: 'timeout' };

interface Props {
  triggerType: string;
  getGraph: () => { nodes: unknown[]; edges: unknown[] };
  onCursor: (nodeId: string | null) => void;
  onClose: () => void;
}

let seq = 0;
const MEDIA_LABEL: Record<string, string> = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎧 Áudio', document: '📄 Documento', sticker: '🌟 Sticker' };
const isHttp = (u: string) => /^https?:\/\//.test(u);
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const answerable = (k: Item['kind']) => k === 'menu' || k === 'carousel' || k === 'template';

function Media({ it }: { it: Extract<SimOutput, { kind: 'media' }> }) {
  const ok = isHttp(it.url);
  return (
    <div className="bub bot">
      {ok && (it.mediaType === 'image' || it.mediaType === 'sticker')
        ? <img src={it.url} alt="" className={cx(it.mediaType === 'sticker' && 'sticker')} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        : ok && it.mediaType === 'video' ? <video src={it.url} controls preload="metadata" />
        : ok && it.mediaType === 'audio' ? <audio src={it.url} controls preload="metadata" />
        : <div className="media"><Icon name="paperclip" size={14} />{MEDIA_LABEL[it.mediaType] ?? 'Arquivo'}</div>}
      {!ok && <div className="faint" style={{ fontSize: 11, wordBreak: 'break-all' }}>{it.url || '(sem arquivo)'}</div>}
      {it.mediaType === 'document' && ok && <a className="linkbtn" href={it.url} target="_blank" rel="noreferrer">Abrir documento</a>}
      {it.caption && <div style={{ marginTop: 4 }}>{it.caption}</div>}
    </div>
  );
}

/** Imagem do cartão do carrossel (link quebrado vira um espaço com ícone). */
function CardImg({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (!isHttp(src) || broken) return <div className="sim-noimg"><Icon name="image" size={18} /></div>;
  return <img src={src} alt="" onError={() => setBroken(true)} />;
}

export function Simulator({ triggerType, getGraph, onCursor, onClose }: Props) {
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

  function push(list: SimOutput[]) {
    setItems((cur) => {
      const next = [...cur];
      for (const o of list) {
        if (o.kind === 'reaction') {
          // a reação vai na última mensagem do cliente
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i];
            if (it.kind === 'me') { next[i] = { ...it, reaction: o.emoji }; break; }
          }
          continue;
        }
        next.push({ ...o, uid: ++seq });
      }
      return next;
    });
  }

  async function run(input: SimInput, echo?: string) {
    if (busy) return;
    clearTimeout(endTimer.current);
    if (echo !== undefined) {
      setItems((cur) => [...cur.map((i) => (answerable(i.kind) ? { ...i, answered: true } : i)), { kind: 'me' as const, text: echo, uid: ++seq }]);
    }
    setBusy(true);
    try {
      const state = simState ?? { contact: { name: contactName.trim() || 'Cliente Teste', phone: '+55 11 99999-0000', stage: 'new', tags: [] } };
      const r = await api.post<SimResult>('/flows/simulate', { graph: getGraph(), state, input, realHttp });
      push(r.outputs);
      setSimState(r.state);
      const waiting = r.state.status === 'input' || r.state.status === 'payment';
      const cursor = waiting ? r.state.nodeId : r.visited[r.visited.length - 1] ?? null;
      onCursor(cursor);
      if (!waiting) endTimer.current = setTimeout(() => onCursor(null), 1800);
    } catch (err) {
      push([{ kind: 'note', text: `⚠️ ${(err as Error).message}` }]);
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
  const tap = (b: Btn) => run({ type: 'message', text: b.title, replyId: b.id }, b.title);

  return (
    <aside className="fb-sim fade" onKeyDown={(e) => e.stopPropagation()} data-testid="simulator">
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
          <div className="cf-hint" style={{ marginTop: -4 }}>Blocos de IA respondem de verdade (Converza IA consome tokens; chave própria é cobrada pelo provedor). Mídias, pixel, vendas e notificações não são enviados.</div>
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
          switch (it.kind) {
            case 'me': return (
              <div key={it.uid} className="bub me">{it.text}{it.reaction && <span className="sim-react">{it.reaction}</span>}</div>
            );
            case 'bot': return <div key={it.uid} className="bub bot">{it.text}</div>;
            case 'note': return <div key={it.uid} className="simnote">{it.text}</div>;
            case 'media': return <Media key={it.uid} it={it} />;
            case 'contact': return (
              <div key={it.uid} className="bub bot sim-contact">
                <span className="av"><Icon name="user" size={16} /></span>
                <div><b>{it.name}</b><small>+{it.phone.replace(/^\+/, '')}</small></div>
              </div>
            );
            case 'pix': return (
              <div key={it.uid} className="bub bot sim-pix" data-testid="sim-pix">
                <small>Pagamento · {it.merchant}</small>
                <b>{brl(it.amount)}</b>
                {it.text && <div>{it.text}</div>}
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(it.code).then(() => toast('Código Pix copiado ✓')).catch(() => {}); }}>
                  <Icon name="copy" size={13} />Copiar código Pix
                </button>
                <div className="mono sim-code">{it.code}</div>
              </div>
            );
            case 'carousel': return (
              <div key={it.uid} className="sim-car">
                {it.text && <div className="bub bot">{it.text}</div>}
                <div className="sim-car-l">
                  {it.cards.map((c, i) => (
                    <div className="sim-card" key={i}>
                      <CardImg src={c.image} />
                      {c.text && <p>{c.text}</p>}
                      {c.buttons.map((b) => (b.type === 'url'
                        ? <span key={b.id} className="sim-cbtn link"><Icon name="link" size={12} />{b.title}</span>
                        : <button type="button" key={b.id} className="sim-cbtn" disabled={it.answered || busy} onClick={() => tap(b)}>{b.title}</button>))}
                    </div>
                  ))}
                </div>
              </div>
            );
            case 'template': return (
              <div key={it.uid} className="bub bot" data-testid="sim-template">
                <div className="sim-tpl">📄 Template · {it.name}</div>
                {it.text}
                {it.buttons.length > 0 && (
                  <div className="opts">
                    {it.buttons.map((b) => <button type="button" key={b.id} disabled={it.answered || busy} onClick={() => tap(b)}>{b.title}</button>)}
                  </div>
                )}
              </div>
            );
            case 'menu': return (
              <div key={it.uid} className="bub bot">
                {it.text}
                <div className="opts">
                  {it.options.map((o) => (
                    <button type="button" key={o.id} disabled={it.answered || busy} onClick={() => tap(o)} title={o.description}>{o.title}</button>
                  ))}
                </div>
              </div>
            );
            default: return null;
          }
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
            {status === 'input' && simState?.canTimeout && (
              <button type="button" className="btn sm" style={{ justifyContent: 'center' }} disabled={busy}
                onClick={() => run({ type: 'timeout' }, '⏰ (cliente não respondeu a tempo)')} data-testid="sim-timeout">
                <Icon name="clock" size={14} />Simular “sem resposta”
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
