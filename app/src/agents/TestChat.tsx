import { useEffect, useRef, useState } from 'react';
import { api, apiFetch } from '../api';
import { Icon } from '../icons';
import { cx, toast } from '../components/ui';
import { AgentAvatar } from './AgentAvatar';
import type { AgentDraft, TestResp, TestTurn } from './types';

/** Conversa de teste: usa o que está no editor (mesmo sem salvar). Nada vai para o WhatsApp. */
export function TestChat({ agentId, draft, aiEnabled, voiceEnabled }: { agentId: string | null; draft: AgentDraft; aiEnabled: boolean; voiceEnabled: boolean }) {
  const [turns, setTurns] = useState<TestTurn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState(0);
  const [playing, setPlaying] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' }); }, [turns.length, busy]);
  useEffect(() => () => { audio.current?.pause(); }, []);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    const next: TestTurn[] = [...turns, { from: 'client', text: t }];
    setTurns(next); setText(''); setBusy(true);
    try {
      const r = await api.post<TestResp>('/agents/test', { agentId, draft, messages: next.map((x) => ({ from: x.from, text: x.text })) });
      setTokens((n) => n + r.tokens);
      const note = r.action === 'flow' ? `Dispararia o fluxo “${r.flowName}”${r.flowActive ? '' : ' (que está pausado — ative em Fluxos)'}`
        : r.action === 'handoff' ? 'Passaria a conversa para a equipe e pararia de responder' : undefined;
      const replies: TestTurn[] = r.messages.map((m, i) => ({ from: 'agent', text: m, ...(i === r.messages.length - 1 ? { action: r.action, reason: r.reason, note } : {}) }));
      if (!replies.length && note) replies.push({ from: 'agent', text: '', action: r.action, reason: r.reason, note });
      setTurns([...next, ...replies]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Não foi possível testar');
      setTurns(turns);
      setText(t);
    }
    setBusy(false);
  }

  async function listen(i: number, t: string) {
    if (!agentId) return;
    audio.current?.pause();
    if (playing === i) { setPlaying(null); return; }
    setPlaying(i);
    try {
      const res = await apiFetch(`/agents/${agentId}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, voiceId: draft.voiceId }) });
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      audio.current = a;
      a.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
      await a.play();
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível gerar o áudio'); setPlaying(null); }
  }

  return (
    <div className="card ag-test" data-testid="agent-test">
      <div className="ag-test-head">
        <AgentAvatar avatar={draft.avatar} size={34} />
        <div><b>Testar {draft.name || 'agente'}</b><small>Usa o que está no editor, mesmo sem salvar. Nada vai para o WhatsApp.</small></div>
        <span className="spacer" />
        {turns.length > 0 && <button type="button" className="btn sm ghost" onClick={() => { setTurns([]); setTokens(0); }} data-testid="test-reset"><Icon name="rotateCcw" size={13} />Recomeçar</button>}
      </div>
      <div className="ag-test-body" ref={box}>
        {!turns.length && (
          <div className="ag-test-empty">
            <Icon name="chat" size={22} />
            <span>Escreva como se fosse um cliente. Experimente perguntar o preço, dizer que quer comprar ou pedir para falar com uma pessoa.</span>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={cx('ag-bub-wrap', t.from)}>
            {t.text && (
              <div className={cx('ag-bub', t.from)} data-testid={t.from === 'agent' ? 'test-agent-msg' : 'test-client-msg'}>
                {t.text}
                {t.from === 'agent' && voiceEnabled && agentId && (
                  <button type="button" className="ag-bub-listen" onClick={() => void listen(i, t.text)} title="Ouvir na voz do agente (gasta tokens)" aria-label="Ouvir"><Icon name={playing === i ? 'pause' : 'play'} size={12} /></button>
                )}
              </div>
            )}
            {t.note && <div className={cx('ag-act', t.action === 'handoff' ? 'handoff' : 'flow')} data-testid="test-action"><Icon name={t.action === 'handoff' ? 'headset' : 'flow'} size={13} />{t.note}{t.reason ? <small>Motivo: {t.reason}</small> : null}</div>}
          </div>
        ))}
        {busy && <div className="ag-bub-wrap agent"><div className="ag-bub agent typing"><i /><i /><i /></div></div>}
      </div>
      <div className="ag-test-foot">
        <input className="input" value={text} disabled={!aiEnabled} placeholder={aiEnabled ? 'Mensagem do cliente…' : 'A IA não está configurada no servidor'} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} data-testid="test-input" />
        <button type="button" className="btn primary icon" disabled={!text.trim() || busy || !aiEnabled} onClick={() => void send()} aria-label="Enviar" data-testid="test-send"><Icon name="send" size={16} /></button>
      </div>
      <small className="faint ag-test-cost">Cada resposta gasta tokens{tokens ? ` · neste teste: ${tokens.toLocaleString('pt-BR')}` : ''}.</small>
    </div>
  );
}
