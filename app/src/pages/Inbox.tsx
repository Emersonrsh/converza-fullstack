import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Avatar, Spinner, toast } from '../components/ui';
import type { Conversation, Message } from '../types';

const stageColor: Record<string, string> = { new: 'blue', in_service: 'amber', negotiating: 'teal', won: 'green', lost: 'red' };
const stageLabel: Record<string, string> = { new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido' };

export function Inbox() {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [txt, setTxt] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = () => api.get<{ conversations: Conversation[] }>('/conversations').then((r) => {
    setConvs(r.conversations);
    setSel((cur) => cur ?? r.conversations[0]?.id ?? null);
  });

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!sel) return;
    api.get<{ messages: Message[] }>(`/conversations/${sel}/messages`).then((r) => setMsgs(r.messages));
  }, [sel]);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const onNew = (p: { conversationId: string; message: Message }) => {
      if (p.conversationId === sel) setMsgs((m) => [...m, p.message]);
      load();
    };
    sock.on('message:new', onNew);
    return () => { sock.off('message:new', onNew); };
  }, [sel]);

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
                  {cv.unreadCount > 0 && <span className="badge" style={{ background: 'var(--primary)', color: '#fff' }}>{cv.unreadCount}</span>}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{cv.contactPhone}</div>
                <div style={{ marginTop: 6 }}><span className={`pill ${stageColor[cv.stage]}`} style={{ height: 20, fontSize: 10.5 }}>{stageLabel[cv.stage]}</span></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!current ? <div className="center muted">Selecione uma conversa</div> : <>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <Avatar name={current.contactName} />
            <div><b>{current.contactName}</b><div className="faint" style={{ fontSize: 12 }}>{current.contactPhone}</div></div>
          </div>
          <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: 18, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {msgs.map((m) => (
              <div key={m.id} style={{ maxWidth: '72%', alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start' }}>
                <div style={{ padding: '9px 13px', borderRadius: 14, fontSize: 13.5, lineHeight: 1.45, boxShadow: 'var(--shadow)', ...(m.direction === 'out' ? { background: 'var(--primary)', color: '#fff', borderBottomRightRadius: 4 } : { background: 'var(--surface)', borderBottomLeftRadius: 4 }) }}>{m.body}</div>
                <div className="faint" style={{ fontSize: 10.5, marginTop: 3, textAlign: m.direction === 'out' ? 'right' : 'left' }}>
                  {new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} {m.direction === 'out' && `· ${m.status}`}
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
