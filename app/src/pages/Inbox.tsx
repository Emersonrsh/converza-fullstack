import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Avatar, Spinner, Switch, toast } from '../components/ui';
import type { ActiveRun, Conversation, Message } from '../types';

const stageColor: Record<string, string> = { new: 'blue', in_service: 'amber', negotiating: 'teal', won: 'green', lost: 'red' };
const stageLabel: Record<string, string> = { new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido' };
const msgStatus: Record<string, string> = { queued: 'na fila', sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou', received: 'recebida' };
const runLabel: Record<string, string> = {
  running: 'executando', waiting: 'em espera', waiting_input: 'aguardando resposta', waiting_payment: 'aguardando pagamento',
};

export function Inbox() {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [txt, setTxt] = useState('');
  const [sending, setSending] = useState(false);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const loadRuns = (id: string) =>
    api.get<{ runs: ActiveRun[] }>(`/conversations/${id}/flow-runs`).then((r) => setRuns(r.runs)).catch(() => setRuns([]));

  const load = () => api.get<{ conversations: Conversation[] }>('/conversations').then((r) => {
    setConvs(r.conversations);
    setSel((cur) => cur ?? r.conversations[0]?.id ?? null);
  });

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!sel) return;
    api.get<{ messages: Message[] }>(`/conversations/${sel}/messages`).then((r) => setMsgs(r.messages));
    void loadRuns(sel);
  }, [sel]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onNew = (p: { conversationId: string; message: Message }) => {
      if (p.conversationId === sel) {
        setMsgs((m) => (m.some((x) => x.id === p.message.id) ? m : [...m, p.message]));
        void loadRuns(sel);
      }
      load();
    };
    const onUpdated = (p: { conversation: Partial<Conversation> & { id: string } }) => {
      setConvs((list) => list?.map((c) => (c.id === p.conversation.id
        ? { ...c, botPaused: p.conversation.botPaused ?? c.botPaused, status: p.conversation.status ?? c.status }
        : c)) ?? list);
      if (p.conversation.id === sel) void loadRuns(sel);
    };
    sock.on('message:new', onNew);
    sock.on('conversation:updated', onUpdated);
    return () => { sock.off('message:new', onNew); sock.off('conversation:updated', onUpdated); };
  }, [sel]);

  async function setAutomation(paused: boolean) {
    if (!sel) return;
    try {
      await api.patch(`/conversations/${sel}/automation`, { paused });
      setConvs((list) => list?.map((c) => (c.id === sel ? { ...c, botPaused: paused } : c)) ?? list);
      if (paused) setRuns([]);
      toast(paused ? 'Automação pausada — só humanos respondem nesta conversa' : 'Automação retomada — fluxos e IA voltam a responder');
    } catch (e) { toast(e instanceof Error ? e.message : 'Falha ao alterar'); }
  }

  async function stopRun(runId: string) {
    if (!sel) return;
    try {
      await api.post(`/conversations/${sel}/flow-runs/${runId}/stop`);
      setRuns((r) => r.filter((x) => x.id !== runId));
      toast('Fluxo interrompido nesta conversa');
    } catch (e) { toast(e instanceof Error ? e.message : 'Falha ao parar'); }
  }

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs]);

  async function send() {
    if (!txt.trim() || !sel) return;
    setSending(true);
    try {
      const r = await api.post<{ message: Message }>(`/conversations/${sel}/messages`, { body: txt });
      setMsgs((m) => [...m, r.message]); setTxt('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falha ao enviar');
    } finally { setSending(false); }
  }

  if (!convs) return <Spinner />;
  const current = convs.find((c) => c.id === sel);

  return (
    <div className="fade card" style={{ height: 'calc(100vh - 104px)', display: 'grid', gridTemplateColumns: '320px 1fr', overflow: 'hidden', padding: 0 }}>
      <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)', fontWeight: 800 }}>Conversas</div>
        <div style={{ overflowY: 'auto' }}>
          {convs.length === 0 && <div className="empty">Nenhuma conversa ainda.<br />Elas aparecem quando chega uma mensagem no WhatsApp.</div>}
          {convs.map((cv) => (
            <div key={cv.id} onClick={() => setSel(cv.id)} style={{ display: 'flex', gap: 11, padding: '12px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: cv.id === sel ? 'var(--surface-2)' : 'transparent' }}>
              <Avatar name={cv.contactName} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}><b style={{ fontSize: 13.5 }}>{cv.contactName}</b>
                  {cv.unreadCount > 0 && <span style={{ background: 'var(--primary)', color: '#fff', borderRadius: 20, fontSize: 11, fontWeight: 800, padding: '1px 7px' }}>{cv.unreadCount}</span>}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{cv.contactPhone}</div>
                <div className="row" style={{ marginTop: 6, gap: 6 }}>
                  <span className={`pill ${stageColor[cv.stage]}`} style={{ height: 20, fontSize: 10.5 }}>{stageLabel[cv.stage]}</span>
                  {cv.botPaused && <span className="pill" style={{ height: 20, fontSize: 10.5 }} title="Automação pausada nesta conversa">🙋 humano</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!current ? <div className="center muted">Selecione uma conversa</div> : <>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <Avatar name={current.contactName} />
            <div style={{ flex: 1, minWidth: 0 }}><b>{current.contactName}</b><div className="faint" style={{ fontSize: 12 }}>{current.contactPhone}</div></div>
            <span className="row" style={{ gap: 8 }} title="Quando desligada, fluxos e agentes de IA não respondem esta conversa">
              <span style={{ fontSize: 12.5, fontWeight: 700, color: current.botPaused ? 'var(--accent)' : 'var(--success)' }}>
                {current.botPaused ? '🙋 Atendimento humano' : '🤖 Automação ativa'}
              </span>
              <Switch on={!current.botPaused} onClick={() => setAutomation(!current.botPaused)} />
            </span>
          </div>
          {runs.length > 0 && (
            <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 8, background: 'var(--surface)' }}>
              {runs.map((r) => (
                <span key={r.id} className="pill teal" style={{ height: 28, paddingRight: 4 }}>
                  <Icon name="flow" size={13} />{r.flowName} · {runLabel[r.status] ?? r.status}
                  <button className="btn sm ghost" style={{ height: 22, padding: '0 8px', fontSize: 11.5 }} onClick={() => stopRun(r.id)}>Parar</button>
                </span>
              ))}
            </div>
          )}
          <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: 18, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {msgs.map((m) => (
              <div key={m.id} style={{ maxWidth: '72%', alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start' }}>
                <div style={{ padding: '9px 13px', borderRadius: 14, fontSize: 13.5, lineHeight: 1.45, boxShadow: 'var(--shadow)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(m.direction === 'out' ? { background: 'var(--primary)', color: '#fff', borderBottomRightRadius: 4 } : { background: 'var(--surface)', borderBottomLeftRadius: 4 }) }}>
                  {m.mediaUrl && (
                    <a href={m.mediaUrl} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, marginBottom: m.body ? 4 : 0, textDecoration: 'underline' }}>
                      <Icon name="paperclip" size={14} />{m.type === 'image' ? 'Imagem' : m.type === 'video' ? 'Vídeo' : m.type === 'audio' ? 'Áudio' : 'Arquivo'}
                    </a>
                  )}
                  {m.body}
                </div>
                <div className="faint" style={{ fontSize: 10.5, marginTop: 3, textAlign: m.direction === 'out' ? 'right' : 'left' }}>
                  {new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} {m.direction === 'out' && <span style={m.status === 'failed' ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>· {msgStatus[m.status] ?? m.status}</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="row" style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', gap: 8 }}>
            <input className="input" placeholder="Escreva uma mensagem…" value={txt}
              onChange={(e) => setTxt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button className="btn primary icon" onClick={send} disabled={sending}><Icon name="send" /></button>
          </div>
        </>}
      </div>
    </div>
  );
}
