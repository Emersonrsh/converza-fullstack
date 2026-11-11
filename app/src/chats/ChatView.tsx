import { Fragment, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Avatar, cx } from '../components/ui';
import { api, mediaSrc } from '../api';
import { EMOJIS, dayLabel, fillVars, fmtPhone, msgTime, quoteText } from './util';
import { isTextOnly, quickPreview } from '../settings/QuickReplies';
import { toast } from '../components/ui';
import type { ChatDetail, ChatMessage, QuickReply, ReplyPreview } from './types';
import { FlowLauncher, FlowPauseButton, RESUME_OPEN_EVENT, openResume, useFlowRuns } from './FlowControls';
const ResumeFlowModal = lazy(() => import('./ResumeFlowModal').then((m) => ({ default: m.ResumeFlowModal })));

/* ---------------------------------------------------------------- texto */

const URL_RE = /(https?:\/\/[^\s<]+)/g;
/** *negrito*, _itálico_, ~riscado~ e links, como no WhatsApp. */
function richText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(URL_RE).forEach((part, i) => {
    if (i % 2 === 1) { out.push(<a key={i} href={part} target="_blank" rel="noreferrer">{part}</a>); return; }
    const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
    part.split(re).forEach((seg, j) => {
      const k = `${i}-${j}`;
      if (/^\*[^*]+\*$/.test(seg)) out.push(<b key={k}>{seg.slice(1, -1)}</b>);
      else if (/^_[^_]+_$/.test(seg)) out.push(<i key={k}>{seg.slice(1, -1)}</i>);
      else if (/^~[^~]+~$/.test(seg)) out.push(<s key={k}>{seg.slice(1, -1)}</s>);
      else if (seg) out.push(<Fragment key={k}>{seg}</Fragment>);
    });
  });
  return out;
}

const TICKS: Record<string, [string, string]> = {
  queued: ['🕓', 'Enviando…'], sent: ['✓', 'Enviada'], delivered: ['✓✓', 'Entregue'], read: ['✓✓', 'Lida'], failed: ['⚠', 'Falhou'],
};

function Media({ m }: { m: ChatMessage }) {
  const [broken, setBroken] = useState(false);
  const url = mediaSrc(m.mediaUrl);
  // modelo com cabeçalho de mídia: o tipo vem do mimeType ("image/*")
  const kind = m.type === 'template' ? (m.mimeType ?? '').split('/')[0] : m.type;
  if (!url) return <div className="bub-file"><Icon name="paperclip" size={16} /><span>{m.fileName ?? 'Arquivo'}</span><small>indisponível</small></div>;
  if (broken) {
    return <a className="bub-file" href={url} target="_blank" rel="noreferrer"><Icon name="image" size={16} /><span>{kind === 'video' ? 'Vídeo' : 'Imagem'} indisponível</span><small>Abrir link</small></a>;
  }
  if (kind === 'image' || kind === 'sticker') {
    return <a href={url} target="_blank" rel="noreferrer" className={cx('bub-img', kind === 'sticker' && 'sticker')}><img src={url} alt={m.fileName ?? 'Imagem'} loading="lazy" onError={() => setBroken(true)} /></a>;
  }
  if (kind === 'video') return <video className="bub-video" src={url} controls preload="metadata" onError={() => setBroken(true)} />;
  if (kind === 'audio') return <audio className="bub-audio" src={url} controls preload="metadata" />;
  return (
    <a className="bub-file" href={url} target="_blank" rel="noreferrer" download={m.fileName ?? undefined}>
      <Icon name="file" size={18} /><span>{m.fileName ?? 'Documento'}</span><small>Baixar</small>
    </a>
  );
}

type Quoted = Pick<ReplyPreview, 'id' | 'body' | 'type' | 'direction' | 'fileName' | 'senderUserId'>;

function Quote({ q, contactName, meId, onJump }: { q: Quoted | null; contactName: string; meId: string; onJump?: () => void }) {
  if (!q) return <div className="bub-quote"><b>Mensagem</b><span>Mensagem anterior</span></div>;
  const who = q.direction === 'in' ? contactName || 'Cliente' : q.senderUserId === meId ? 'Você' : q.senderUserId ? 'Equipe' : '🤖 Automação';
  return (
    <button type="button" className={cx('bub-quote', q.direction === 'in' ? 'in' : 'out')} onClick={onJump} data-testid="quote">
      <b>{who}</b><span>{quoteText(q)}</span>
    </button>
  );
}

function Bubble({ m, quoted, contactName, meId, onRetry, onReply, onJump, heldAt, onResume }: {
  m: ChatMessage; quoted: Quoted | null; contactName: string; meId: string;
  onRetry: (m: ChatMessage) => void; onReply: (m: ChatMessage) => void; onJump: (id: string) => void;
  /** o fluxo parou nesta mensagem (ela não saiu): Retomar fluxo reenvia e segue */
  heldAt?: boolean; onResume?: (m: ChatMessage) => void;
}) {
  if (m.type === 'note' && !m.senderUserId) {
    return <div className="bub-event" data-testid="event"><span>{m.body}<small>{msgTime(m.createdAt)}</small></span></div>;
  }
  if (m.type === 'note') {
    return (
      <div className="bub-note" data-testid="note">
        <div className="bub-note-h"><Icon name="lock" size={12} />Nota interna{m.senderName ? ` · ${m.senderName}` : ''} · {msgTime(m.createdAt)}</div>
        <div className="bub-text">{richText(m.body ?? '')}</div>
      </div>
    );
  }
  const out = m.direction === 'out';
  const hasMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type) || (m.type === 'template' && !!m.mediaUrl);
  const [tick, tickLabel] = TICKS[m.status] ?? ['', ''];
  return (
    <div id={`m-${m.id}`} className={cx('bub', out ? 'out' : 'in', m.status === 'failed' && 'failed')} data-testid={out ? 'msg-out' : 'msg-in'}>
      <button type="button" className="bub-act" onClick={() => onReply(m)} title="Responder" aria-label="Responder" data-testid="reply"><Icon name="reply" size={14} /></button>
      <div className="bub-b">
        {m.replyToId && <Quote q={quoted} contactName={contactName} meId={meId} onJump={() => m.replyToId && onJump(m.replyToId)} />}
        {out && m.type === 'template' && <span className="bub-tpl">Modelo</span>}
        {hasMedia && <Media m={m} />}
        {m.body && <div className={cx('bub-text', m.type === 'unsupported' && 'faint')}>{m.type === 'location' && '📍 '}{m.type === 'contacts' && '👤 '}{richText(m.body)}</div>}
        {m.type === 'audio' && m.transcript && <div className="bub-transcript" data-testid="transcript"><Icon name="file" size={12} />{m.transcript}</div>}
        <div className="bub-ft">
          {out && <span className="bub-who" data-testid="bub-who">{m.via === 'phone' ? '📱 WhatsApp do celular' : m.via === 'history' ? '🕘 Do histórico do celular' : m.senderUserId ? m.senderName ?? 'Equipe' : m.agentName ? `🤖 ${m.agentName}` : '🤖 Automação'}</span>}
          {!out && m.via === 'history' && <span className="bub-who" title="Importada do histórico do WhatsApp Business do celular">🕘 histórico</span>}
          <span>{msgTime(m.createdAt)}</span>
          {out && <span className={cx('tk', m.status)} title={tickLabel}>{tick}</span>}
        </div>
      </div>
      {m.status === 'failed' && (
        <div className="bub-err">
          <Icon name="alert" size={12} />{m.error ?? 'Não foi possível enviar'}
          {heldAt && onResume
            ? <button type="button" className="bub-err-resume" onClick={() => onResume(m)} data-testid="resume-flow">Retomar fluxo</button>
            : m.type === 'text' && <button type="button" onClick={() => onRetry(m)}>Tentar de novo</button>}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- conversa */

export interface UploadOpts { voice?: boolean; replyToId?: string | null }

export function ChatView({
  detail, messages, hasMore, loadingOlder, onLoadOlder, meId, quickReplies, panelOpen, onTogglePanel,
  onAccept, onRelease, onResolve, onReopen, onTransfer, onSend, onNote, onUpload, onTemplate, onRetry, onManageQuick, listCollapsed, onExpandList, onQuickSend,
}: {
  detail: ChatDetail; messages: ChatMessage[]; hasMore: boolean; loadingOlder: boolean; onLoadOlder: () => void; meId: string;
  quickReplies: QuickReply[]; panelOpen: boolean; onTogglePanel: () => void;
  onAccept: () => void; onRelease: () => void; onResolve: () => void; onReopen: () => void; onTransfer: () => void;
  onSend: (text: string, replyToId?: string | null) => Promise<boolean>; onNote: (text: string) => Promise<boolean>;
  onUpload: (file: File, caption: string, opts?: UploadOpts) => Promise<boolean>;
  onTemplate: () => void; onRetry: (m: ChatMessage) => void; onManageQuick: () => void; listCollapsed: boolean; onExpandList: () => void;
  /** resposta rápida com anexos: envia tudo (o servidor preenche as variáveis) */
  onQuickSend: (q: QuickReply) => Promise<boolean>;
}) {
  const c = detail.conversation;
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const contactName = detail.contact.name || fmtPhone(detail.contact.phone);

  function jump(id: string) {
    const el = scroller.current?.querySelector<HTMLElement>(`#m-${CSS.escape(id)}`);
    if (!el) { toast('Essa mensagem é mais antiga: carregue as mensagens anteriores para vê-la'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  const resolved = c.status === 'resolved';
  const mine = c.assignedUserId === meId;
  const scroller = useRef<HTMLDivElement>(null);
  const [newBelow, setNewBelow] = useState(false);
  const [menu, setMenu] = useState(false);
  const prevCount = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);

  // rolagem: abre no fim; mensagem nova desce se já estava perto do fim; carregar antigas mantém a posição
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    if (prevFirst.current && first !== prevFirst.current && messages.length > prevCount.current && prevHeight.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current + el.scrollTop;
    } else if (messages.length > prevCount.current) {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      const last = messages[messages.length - 1];
      const mineNow = last?.direction === 'out' && last.senderUserId === meId; // o que EU acabei de enviar sempre desce
      if (near || prevCount.current === 0 || mineNow) { el.scrollTop = el.scrollHeight; setNewBelow(false); }
      else setNewBelow(true);
    }
    prevCount.current = messages.length;
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages, meId]);
  useEffect(() => { prevCount.current = 0; prevFirst.current = null; prevHeight.current = 0; }, [c.id]);

  const runs = useFlowRuns(c.id, messages.length);
  const failedIds = useMemo(() => new Set(runs.map((r) => r.failedMessageId).filter(Boolean) as string[]), [runs]);
  // popup "Retomar fluxo" (aberto pela mensagem que falhou, pelo cabeçalho ou pelo painel do contato)
  const [resumeId, setResumeId] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => setResumeId(String((e as CustomEvent<string>).detail));
    window.addEventListener(RESUME_OPEN_EVENT, h);
    return () => window.removeEventListener(RESUME_OPEN_EVENT, h);
  }, []);
  useEffect(() => { setResumeId(null); }, [c.id]);
  const resumeRunRow = runs.find((r) => r.id === resumeId) ?? null;

  // mensagens agrupadas por dia (o separador do dia fica fixo no topo enquanto o dia está na tela)
  const groups = useMemo(() => {
    const list: { key: string; label: string; msgs: ChatMessage[] }[] = [];
    for (const m of messages) {
      const d = new Date(m.createdAt).toDateString();
      const g = list[list.length - 1];
      if (g && g.key === d) g.msgs.push(m);
      else list.push({ key: d, label: dayLabel(m.createdAt), msgs: [m] });
    }
    return list;
  }, [messages]);

  return (
    <section className="cv" data-testid="chat-view">
      <header className="cv-hd">
        {listCollapsed && <button type="button" className="btn icon sm ghost" onClick={onExpandList} title="Mostrar lista" aria-label="Mostrar lista"><Icon name="chevronRight" size={16} /></button>}
        <Avatar name={detail.contact.name || detail.contact.phone} size={40} />
        <div className="cv-who">
          <b>{detail.contact.name || fmtPhone(detail.contact.phone)}</b>
          <span>{fmtPhone(detail.contact.phone)}{detail.connection ? ` · via ${detail.connection.name}` : ' · sem conexão'}</span>
        </div>
        <span className="spacer" />
        {detail.department && !resolved && <span className="pill" style={{ background: `${detail.department.color}22`, color: detail.department.color }} title="Setor da conversa" data-testid="cv-dept">{detail.department.name}</span>}
        {!resolved && !c.botPaused && <button type="button" className="pill teal cv-bot" onClick={onTogglePanel} title="Fluxos e agentes de IA podem responder esta conversa">🤖 Automação ativa</button>}
        {resolved && <span className="pill green">Resolvida</span>}
        {!resolved && c.assignedUserId && !mine && <span className="pill">Com {detail.assignedName?.split(' ')[0] ?? 'outra pessoa'}</span>}
        {resolved ? (
          <button type="button" className="btn sm primary" onClick={onReopen} data-testid="reopen"><Icon name="refresh" size={14} />Reabrir</button>
        ) : !c.assignedUserId ? (
          <button type="button" className="btn sm primary" onClick={onAccept} data-testid="accept"><Icon name="headset" size={14} />Atender</button>
        ) : (<>
          {!mine && <button type="button" className="btn sm" onClick={onAccept} data-testid="take-over">Assumir</button>}
          <button type="button" className="btn sm" onClick={onTransfer} data-testid="transfer"><Icon name="userArrow" size={14} />Transferir</button>
          <button type="button" className="btn sm primary" onClick={onResolve} data-testid="resolve"><Icon name="check" size={14} />Resolver</button>
        </>)}
        <div className="menu-wrap">
          <button type="button" className="btn icon sm ghost" onClick={() => setMenu((v) => !v)} aria-label="Mais ações" data-testid="chat-more"><Icon name="dots" size={16} /></button>
          {menu && (
            <div className="menu fade" onClick={() => setMenu(false)} onMouseLeave={() => setMenu(false)}>
              {!resolved && c.assignedUserId && <button type="button" onClick={onRelease}><Icon name="inbox" size={15} />Devolver para a fila</button>}
              {!resolved && !c.assignedUserId && <button type="button" onClick={onTransfer} data-testid="menu-transfer"><Icon name="userArrow" size={15} />Transferir (pessoa ou setor)</button>}
              {!resolved && !c.assignedUserId && <button type="button" onClick={onResolve}><Icon name="check" size={15} />Resolver sem atender</button>}
              {detail.connection?.provider !== 'web' && <button type="button" onClick={onTemplate} disabled={!detail.connection}><Icon name="file" size={15} />Enviar modelo de mensagem</button>}
              <button type="button" onClick={onManageQuick}><Icon name="bolt" size={15} />Respostas rápidas</button>
            </div>
          )}
        </div>
        {!resolved && <FlowPauseButton convId={c.id} runs={runs} />}
        <FlowLauncher convId={c.id} />
        <button type="button" className={cx('btn icon sm', panelOpen ? 'on' : 'ghost')} onClick={onTogglePanel} title="Dados do contato" aria-label="Dados do contato" data-testid="toggle-panel"><Icon name="user" size={16} /></button>
      </header>
      {resumeRunRow && (
        <Suspense fallback={null}>
          <ResumeFlowModal convId={c.id} runId={resumeRunRow.id} flowId={resumeRunRow.flowId} flowName={resumeRunRow.flowName}
            stoppedAt={resumeRunRow.currentNodeId ?? null} failed={resumeRunRow.status === 'failed'} onClose={() => setResumeId(null)} />
        </Suspense>
      )}

      <div className="cv-msgs" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) setNewBelow(false);
      }}>
        {hasMore && <button type="button" className="cv-older" disabled={loadingOlder} onClick={() => { prevHeight.current = scroller.current?.scrollHeight ?? 0; onLoadOlder(); }}>{loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores'}</button>}
        {messages.length === 0 && <div className="cv-none">Nenhuma mensagem ainda.{!detail.windowOpen && ' Para começar, envie um modelo de mensagem aprovado.'}</div>}
        {groups.map((g) => (
          <div key={g.key} className="cv-group">
            <div className="cv-day"><span>{g.label}</span></div>
            {g.msgs.map((m) => (
              <Bubble key={m.id} m={m} quoted={m.replyToId ? byId.get(m.replyToId) ?? m.reply ?? null : null} contactName={contactName} meId={meId}
                onRetry={onRetry} onReply={(x) => setReplyTo(x)} onJump={jump}
                heldAt={m.status === 'failed' && failedIds.has(m.id)} onResume={(x) => { const r = runs.find((y) => y.failedMessageId === x.id); if (r) openResume(r.id); }} />
            ))}
          </div>
        ))}
      </div>
      {newBelow && <button type="button" className="cv-newbelow" onClick={() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; setNewBelow(false); }}>Novas mensagens ↓</button>}

      <Composer key={c.id} detail={detail} quickReplies={quickReplies} onSend={onSend} onNote={onNote} onUpload={onUpload} onTemplate={onTemplate} onManageQuick={onManageQuick} onQuickSend={onQuickSend}
        replyTo={replyTo} contactName={contactName} meId={meId} onCancelReply={() => setReplyTo(null)} />
    </section>
  );
}

/* --------------------------------------------------------------- campo */

const REC_TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const MAX_REC_MS = 10 * 60 * 1000;
const clock = (ms: number) => { const sec = Math.floor(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

function Composer({ detail, quickReplies, onSend, onNote, onUpload, onTemplate, onManageQuick, onQuickSend, replyTo, contactName, meId, onCancelReply }: {
  detail: ChatDetail; quickReplies: QuickReply[]; onQuickSend: (q: QuickReply) => Promise<boolean>;
  onSend: (text: string, replyToId?: string | null) => Promise<boolean>; onNote: (text: string) => Promise<boolean>;
  onUpload: (file: File, caption: string, opts?: UploadOpts) => Promise<boolean>;
  onTemplate: () => void; onManageQuick: () => void;
  replyTo: ChatMessage | null; contactName: string; meId: string; onCancelReply: () => void;
}) {
  // ---- gravação de áudio (mensagem de voz)
  const [rec, setRec] = useState<{ started: number; elapsed: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const micStream = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);
  const canRecord = typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
  const recStarted = rec?.started;
  useEffect(() => {
    if (!recStarted) return;
    const t = setInterval(() => setRec((r) => (r ? { ...r, elapsed: Date.now() - r.started } : r)), 250);
    return () => clearInterval(t);
  }, [recStarted]);
  useEffect(() => { if (rec && rec.elapsed >= MAX_REC_MS) stopRec(); }, [rec?.elapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    cancelled.current = true;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    micStream.current?.getTracks().forEach((t) => t.stop());
  }, []);
  const [mode, setMode] = useState<'msg' | 'note'>('msg');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const [qrIndex, setQrIndex] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closed = mode === 'msg' && !detail.windowOpen;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  // atalho de resposta rápida: # ou / no começo
  const slash = mode === 'msg' && /^[#/][^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const trigger = text[0] === '/' ? '/' : '#';
  const qrMatches = slash !== null ? quickReplies.filter((q) => q.shortcut.toLowerCase().startsWith(slash)).slice(0, 8) : [];
  useEffect(() => { setQrIndex(0); }, [slash]);

  async function pickQuick(q: QuickReply) {
    // com anexos: envia tudo na ordem; só texto: vira rascunho (com as variáveis do contato preenchidas)
    if (!isTextOnly(q)) {
      setText(''); setBusy(true);
      await onQuickSend(q);
      setBusy(false);
      return;
    }
    const local = fillVars(q.text, detail.contact.name || '');
    setText(local);
    try {
      const r = await api.get<{ text: string }>(`/conversations/${detail.conversation.id}/quick-replies/${q.id}/render`);
      // só troca se a pessoa ainda não mexeu (nem enviou) o rascunho
      if (r.text) setText((cur) => (cur === local ? r.text : cur));
    } catch { /* fica o texto preenchido aqui mesmo */ }
    requestAnimationFrame(() => ta.current?.focus());
  }

  function insertEmoji(e: string) {
    const el = ta.current;
    const s = el?.selectionStart ?? text.length;
    const en = el?.selectionEnd ?? text.length;
    setText(text.slice(0, s) + e + text.slice(en));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + e.length, s + e.length); });
  }

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      micStream.current = stream;
      const mime = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      chunks.current = [];
      cancelled.current = false;
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!cancelled.current) void finishRec(r.mimeType || mime || 'audio/webm');
      };
      r.start(250);
      recorder.current = r;
      setRec({ started: Date.now(), elapsed: 0 });
    } catch (e) {
      toast((e as DOMException)?.name === 'NotAllowedError' ? 'Permita o acesso ao microfone no navegador para gravar áudio' : 'Não foi possível acessar o microfone');
    }
  }
  function stopRec() { if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop(); }
  function cancelRec() { cancelled.current = true; stopRec(); setRec(null); }
  async function finishRec(mime: string) {
    const blob = new Blob(chunks.current, { type: mime });
    setRec(null);
    if (blob.size < 800) { toast('Áudio muito curto'); return; }
    const base = mime.split(';')[0];
    const ext = base.includes('ogg') ? 'ogg' : base.includes('mp4') ? 'm4a' : 'webm';
    setBusy(true);
    const ok = await onUpload(new File([blob], `audio.${ext}`, { type: base }), '', { voice: true, replyToId: replyTo?.id ?? null });
    setBusy(false);
    if (ok) onCancelReply();
  }

  async function submit() {
    if (busy) return;
    const t = text.trim();
    if (file) {
      setBusy(true);
      const ok = await onUpload(file, t, { replyToId: replyTo?.id ?? null });
      setBusy(false);
      if (ok) { setFile(null); setText(''); onCancelReply(); }
      return;
    }
    if (!t) return;
    setBusy(true);
    const ok = mode === 'note' ? await onNote(t) : await onSend(t, replyTo?.id ?? null);
    setBusy(false);
    if (ok) { setText(''); if (mode === 'msg') onCancelReply(); }
    requestAnimationFrame(() => ta.current?.focus());
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (qrMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setQrIndex((i) => (i + 1) % qrMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setQrIndex((i) => (i - 1 + qrMatches.length) % qrMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); void pickQuick(qrMatches[qrIndex]); return; }
      if (e.key === 'Escape') { setText(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
  }

  return (
    <div className={cx('cc', mode === 'note' && 'note')} data-testid="composer">
      {closed && (
        <div className="cc-window">
          <Icon name="clock" size={15} />
          <span>{detail.lastInboundAt ? 'A janela de 24h fechou: o cliente não fala com você há mais de 24 horas.' : 'Este contato ainda não te mandou mensagem.'} Para falar com ele, envie um <b>modelo de mensagem aprovado</b>.</span>
          <button type="button" className="btn sm primary" onClick={onTemplate} disabled={!detail.connection} data-testid="open-templates">Enviar modelo</button>
        </div>
      )}
      <div className="cc-modes">
        <button type="button" className={cx(mode === 'msg' && 'on')} onClick={() => setMode('msg')}>Mensagem</button>
        <button type="button" className={cx(mode === 'note' && 'on')} onClick={() => { setMode('note'); setFile(null); }} data-testid="note-mode"><Icon name="lock" size={12} />Nota interna</button>
        {mode === 'msg' && !closed && <span className="faint" style={{ fontSize: 11.5, fontWeight: 600 }}>Digite <b>#</b> para respostas rápidas</span>}
      </div>
      {qrMatches.length > 0 && (
        <div className="cc-qr" data-testid="quick-list">
          {qrMatches.map((q, i) => (
            <button type="button" key={q.id} className={cx(i === qrIndex && 'on')} onMouseEnter={() => setQrIndex(i)} onClick={() => void pickQuick(q)} data-testid="quick-item">
              <b>{trigger}{q.shortcut}</b><span>{quickPreview(q)}</span>
              {!isTextOnly(q) && <span className="pill mini teal" title="Envia na hora, com os anexos">envia {q.actions?.length ?? 1} {(q.actions?.length ?? 1) === 1 ? 'item' : 'itens'}</span>}
            </button>
          ))}
          <button type="button" className="cc-qr-manage" onClick={onManageQuick}>Gerenciar respostas rápidas</button>
        </div>
      )}
      {slash !== null && qrMatches.length === 0 && (
        <div className="cc-qr"><div className="faint" style={{ padding: '8px 10px', fontSize: 12.5 }}>Nenhuma resposta com “{trigger}{slash}”.</div><button type="button" className="cc-qr-manage" onClick={onManageQuick}>Criar respostas rápidas</button></div>
      )}
      {replyTo && mode === 'msg' && (
        <div className="cc-reply" data-testid="reply-bar">
          <Icon name="reply" size={15} />
          <div><b>Respondendo {replyTo.direction === 'in' ? contactName : replyTo.senderUserId === meId ? 'a você' : 'à equipe'}</b><span>{quoteText(replyTo)}</span></div>
          <button type="button" className="btn icon sm ghost" onClick={onCancelReply} aria-label="Cancelar resposta"><Icon name="close" size={14} /></button>
        </div>
      )}
      {file && (
        <div className="cc-file">
          <Icon name="paperclip" size={14} /><b>{file.name}</b><span className="faint">{(file.size / 1024 / 1024).toFixed(2).replace('.', ',')} MB</span>
          <span className="faint">· o texto vira legenda</span><span className="spacer" />
          <button type="button" className="btn icon sm ghost" onClick={() => setFile(null)} aria-label="Remover arquivo"><Icon name="close" size={14} /></button>
        </div>
      )}
      {rec ? (
        <div className="cc-row cc-rec" data-testid="recording">
          <button type="button" className="cc-ic" onClick={cancelRec} title="Descartar áudio" aria-label="Descartar áudio" data-testid="rec-cancel"><Icon name="trash" size={18} /></button>
          <span className="cc-rec-dot" /><b className="cc-rec-time">{clock(rec.elapsed)}</b><span className="faint">Gravando áudio…</span>
          <span className="spacer" />
          <button type="button" className="cc-send" onClick={stopRec} aria-label="Enviar áudio" data-testid="rec-send"><Icon name="send" size={17} /></button>
        </div>
      ) : (
      <div className="cc-row">
        <div className="menu-wrap">
          <button type="button" className="cc-ic" onClick={() => setEmoji((v) => !v)} disabled={closed} title="Emojis" aria-label="Emojis"><Icon name="smile" size={19} /></button>
          {emoji && (
            <div className="menu cc-emoji up fade" onMouseLeave={() => setEmoji(false)}>
              {EMOJIS.map((e) => <button type="button" key={e} onClick={() => insertEmoji(e)}>{e}</button>)}
            </div>
          )}
        </div>
        {mode === 'msg' && (
          <>
            <button type="button" className="cc-ic" onClick={() => fileInput.current?.click()} disabled={closed} title="Anexar arquivo" aria-label="Anexar arquivo" data-testid="attach"><Icon name="paperclip" size={19} /></button>
            <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ''; }} data-testid="file-input" />
          </>
        )}
        <textarea ref={ta} rows={1} value={text} disabled={closed && !file} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          placeholder={mode === 'note' ? 'Escreva uma nota para a equipe (o cliente não vê)…' : closed ? 'Envie um modelo para retomar a conversa' : file ? 'Legenda (opcional)…' : 'Escreva uma mensagem…'}
          data-testid="composer-input" />
        {mode === 'msg' && !closed && !file && !text.trim() && canRecord ? (
          <button type="button" className="cc-send" onClick={startRec} disabled={busy} title="Gravar áudio" aria-label="Gravar áudio" data-testid="record">
            {busy ? <span className="cc-spin" /> : <Icon name="mic" size={18} />}
          </button>
        ) : (
          <button type="button" className="cc-send" onClick={submit} disabled={busy || (closed && !file) || (!text.trim() && !file)} aria-label="Enviar" data-testid="send">
            {busy ? <span className="cc-spin" /> : <Icon name={mode === 'note' ? 'check' : 'send'} size={17} />}
          </button>
        )}
      </div>
      )}
    </div>
  );
}
