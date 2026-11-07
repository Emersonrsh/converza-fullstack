import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, apiFetch } from '../api';
import { Icon } from '../icons';
import { Modal, Spinner, cx, toast } from '../components/ui';
import { useRecorder, mmss } from '../components/useRecorder';
import { AgentAvatar } from './AgentAvatar';
import { SearchSelect } from './SearchSelect';
import { ROLE_LABEL, fmtN } from './util';
import type { Agent, AgentLimit, AgentOptions, AgentTemplate } from './types';

export const isLimitError = (e: unknown): e is ApiError => e instanceof ApiError && e.data?.code === 'agent_limit';

/** "Limite de agentes": cada instância contratada libera 2 agentes. */
export function LimitModal({ limit, message, onClose }: { limit: AgentLimit | null; message?: string; onClose: () => void }) {
  const nav = useNavigate();
  const text = message ?? (!limit?.active
    ? `Assine para criar agentes de IA. Cada instância contratada libera ${limit?.perConnection ?? 2} agentes.`
    : limit.scheduledInstances !== null
      ? `Você agendou a redução para ${limit.scheduledInstances} ${limit.scheduledInstances === 1 ? 'instância' : 'instâncias'} na próxima renovação: cabem ${limit.max} agentes e você já tem ${limit.used}. Desfaça a redução em Cobranças e assinaturas para criar mais.`
      : `Cada instância contratada libera ${limit.perConnection} agentes — você já usa ${limit.used} de ${limit.max}. Contrate mais instâncias para criar mais.`);
  return (
    <Modal title="Limite de agentes" icon="alert" width={440} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" onClick={() => nav('/billing')} data-testid="limit-plans">{limit?.active ? 'Contratar instâncias' : 'Assinar agora'}</button>
    </>}>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }} data-testid="limit-text">{text}</p>
    </Modal>
  );
}

/** Importar por código (um ou vários, separados por vírgula ou linha). */
export function ImportAgentModal({ onClose, onDone, onLimit }: { onClose: () => void; onDone: (ids: string[]) => void; onLimit: (msg: string) => void }) {
  const [codes, setCodes] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ imported: { id: string; name: string }[]; notFound: string[]; limited: string[] }>('/agents/import', { codes });
      const parts = [`${r.imported.length} agente${r.imported.length === 1 ? '' : 's'} importado${r.imported.length === 1 ? '' : 's'}`];
      if (r.notFound.length) parts.push(`não achei: ${r.notFound.join(', ')}`);
      if (r.limited.length) parts.push(`sem espaço nas instâncias contratadas: ${r.limited.join(', ')}`);
      toast(parts.join(' · '));
      onDone(r.imported.map((x) => x.id));
    } catch (e) {
      if (isLimitError(e)) onLimit(e.message);
      else if (e instanceof ApiError && e.status === 404) toast('Nenhum agente encontrado com esse código');
      else toast(e instanceof Error ? e.message : 'Não foi possível importar');
    }
    setBusy(false);
  }
  return (
    <Modal title="Importar agente" subtitle="Cole um ou mais códigos. Separe por vírgula ou por linha." icon="download" width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!codes.trim() || busy} onClick={go} data-testid="import-agent-go">{busy ? 'Importando…' : 'Importar'}</button>
    </>}>
      <textarea className="input" rows={4} autoFocus value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'Cole o código do agente\nOu vários, um por linha'} data-testid="import-agent-codes" />
      <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>A cópia chega desativada. Fluxo, voz e números de WhatsApp não vêm junto — você escolhe os seus.</div>
    </Modal>
  );
}

/** Modelos prontos: escolhe o jeito do atendente; depois dá para ligar um fluxo. */
export function TemplatesModal({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const [list, setList] = useState<AgentTemplate[] | null>(null);
  useEffect(() => { api.get<{ templates: AgentTemplate[] }>('/agents/templates').then((r) => setList(r.templates)).catch(() => setList([])); }, []);
  return (
    <Modal title="Modelos prontos" subtitle="Escolha o jeito do atendente. Depois você liga um fluxo e completa o que ele sabe." icon="flow" width={560} onClose={onClose}>
      {!list ? <Spinner /> : (
        <div className="ag-tpls">
          {list.map((t) => (
            <button type="button" key={t.id} className="ag-tpl" onClick={() => onPick(t.id)} data-testid="agent-template">
              <AgentAvatar avatar={t.avatar} size={54} />
              <div><b>{t.name} · {ROLE_LABEL[t.role]}</b><span>{t.description}</span></div>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** "Criar com IA": monta o atendente com o que a conta já tem (fluxo, conversas de uma etiqueta) ou com o site. */
export function BuildAgentModal({ onClose, onCreated, onLimit }: { onClose: () => void; onCreated: (a: Agent) => void; onLimit: (msg: string) => void }) {
  const [opt, setOpt] = useState<AgentOptions | null>(null);
  const [source, setSource] = useState<'internal' | 'site'>('internal');
  const [flowId, setFlowId] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  useEffect(() => { api.get<AgentOptions>('/agents/options').then(setOpt).catch((e) => toast(e instanceof Error ? e.message : 'Erro')); }, []);

  const rec = useRecorder({
    maxSeconds: 120,
    onDone: async (blob) => {
      setTranscribing(true);
      try {
        const res = await apiFetch('/agents/transcribe?language=pt', { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream', 'x-file-type': blob.type || 'audio/webm' } });
        const r = await res.json() as { text: string };
        if (r.text) setNotes((n) => (n.trim() ? `${n.trim()} ${r.text}` : r.text));
        else toast('Não entendi nada no áudio — tente falar mais perto do microfone');
      } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível transcrever'); }
      setTranscribing(false);
    },
  });

  const ready = source === 'internal' ? !!(flowId || tag || notes.trim()) : !!url.trim();
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ agent: Agent }>('/agents/build', { source, flowId: source === 'internal' ? flowId : null, tag: source === 'internal' ? tag : null, url: source === 'site' ? url : null, notes, voiceId: voiceId || null });
      toast('Agente montado — revise e ative quando estiver pronto');
      onCreated(r.agent);
    } catch (e) {
      if (isLimitError(e)) onLimit(e.message);
      else toast(e instanceof Error ? e.message : 'Não foi possível montar o agente');
      setBusy(false);
    }
  }
  return (
    <Modal title="Criar com IA" subtitle="Monta o atendente com o que você já tem. Gasta tokens." icon="sparkles" width={600} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ready || busy || !opt?.aiEnabled} onClick={go} data-testid="build-go">{busy ? 'Montando…' : 'Montar agente'}</button>
    </>}>
      {!opt ? <Spinner /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div>
            <div className="label">De onde vem o conhecimento</div>
            <div className="ag-src">
              <button type="button" className={cx(source === 'internal' && 'on')} onClick={() => setSource('internal')} data-testid="build-internal">
                <span className="ag-src-ic"><Icon name="book" size={17} /></span><b>Conhecimento interno</b><small>Fluxo da oferta e conversas da conta.</small>
              </button>
              <button type="button" className={cx(source === 'site' && 'on')} onClick={() => setSource('site')} data-testid="build-site">
                <span className="ag-src-ic"><Icon name="globe" size={17} /></span><b>Link do site</b><small>Conte o que você vende. O site ajuda.</small>
              </button>
            </div>
          </div>
          {source === 'internal' ? (
            <>
              <div className="ag-info"><b>O que você já tem na conta</b>Escolha um fluxo, uma etiqueta ou os dois. O pagamento fica no fluxo.</div>
              <div className="ag-two">
                <div className="ag-box">
                  <div className="label">Fluxo (opcional)</div>
                  <SearchSelect value={flowId} onChange={setFlowId} placeholder="Buscar fluxo..." testId="build-flow"
                    options={opt.flows.map((f) => ({ value: f.id, label: f.name, hint: f.status === 'active' ? 'ativo' : 'pausado' }))} empty="Nenhum fluxo" />
                  <small className="faint">Quando a pessoa topar pagar, o agente dispara esse fluxo.</small>
                </div>
                <div className="ag-box">
                  <div className="label">Etiqueta (opcional)</div>
                  <SearchSelect value={tag} onChange={setTag} placeholder="Buscar etiqueta..." icon="tag" testId="build-tag"
                    options={opt.tags.map((t) => ({ value: t.name, label: t.name }))} empty="Nenhuma etiqueta" />
                  <small className="faint">Pode ser uma etiqueta de quem pagou: a IA lê as conversas recentes de quem tem essa etiqueta.</small>
                </div>
              </div>
            </>
          ) : (
            <div>
              <div className="label">Link do site</div>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.sualoja.com.br" data-testid="build-url" />
              <small className="faint">A IA lê a página e monta o que o agente sabe. Confira os preços depois.</small>
            </div>
          )}
          <div>
            <div className="label">Algo a mais que ele precisa saber (opcional)</div>
            <div className="ag-notes">
              <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: o Pix da oferta é o mesmo do fluxo, ticket médio de R$ 197" data-testid="build-notes" />
              {rec.supported && opt.voiceEnabled && (
                <button type="button" className={cx('ag-mic', rec.recording && 'rec')} disabled={transcribing} onClick={() => (rec.recording ? rec.stop() : void rec.start())}
                  aria-label={rec.recording ? 'Parar gravação' : 'Falar no microfone'} title={rec.recording ? 'Parar' : 'Falar no microfone'} data-testid="build-mic">
                  {transcribing ? <span className="spin sm" /> : <Icon name={rec.recording ? 'pause' : 'mic'} size={16} />}
                </button>
              )}
            </div>
            <small className="faint">{rec.recording ? `Gravando ${mmss(rec.seconds)} — clique para parar.` : rec.error ?? (opt.voiceEnabled ? 'Fale no microfone. A transcrição gasta tokens.' : 'Escreva o que ele precisa saber.')}</small>
          </div>
          <div>
            <div className="label">Voz dos áudios</div>
            <select className="select" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!opt.voiceEnabled} data-testid="build-voice">
              <option value="">Voz: Padrão da plataforma</option>
              {opt.voices.map((v) => <option key={v.id} value={v.id}>Voz: {v.name}</option>)}
            </select>
            {!opt.voiceEnabled && <small className="faint">Respostas em áudio precisam da voz configurada no servidor.</small>}
          </div>
          {!opt.aiEnabled && <div className="hint"><Icon name="alert" size={14} />A IA não está configurada no servidor (OPENAI_API_KEY).</div>}
          <div className="faint" style={{ fontSize: 12.5 }} data-testid="build-balance">Gasta tokens, como o tradutor de fluxos. Saldo: {fmtN(opt.balance)}</div>
        </div>
      )}
    </Modal>
  );
}

/** Código para outra conta importar uma cópia deste agente. */
export function ShareAgentModal({ agent, onClose, onChange }: { agent: Agent; onClose: () => void; onChange: (code: string | null) => void }) {
  const [code, setCode] = useState<string | null>(agent.shareCode);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (code) return;
    setBusy(true);
    api.post<{ shareCode: string }>(`/agents/${agent.id}/share`).then((r) => { setCode(r.shareCode); onChange(r.shareCode); })
      .catch((e) => toast(e instanceof Error ? e.message : 'Erro')).finally(() => setBusy(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function regen() {
    setBusy(true);
    try { const r = await api.post<{ shareCode: string }>(`/agents/${agent.id}/share?novo=1`); setCode(r.shareCode); onChange(r.shareCode); toast('Código novo gerado — o antigo parou de funcionar'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  }
  async function stop() {
    setBusy(true);
    try { await api.del(`/agents/${agent.id}/share`); onChange(null); toast('O código parou de funcionar'); onClose(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); setBusy(false); }
  }
  return (
    <Modal title="Compartilhar agente" subtitle="Quem tiver o código importa uma cópia" icon="share" width={440} onClose={onClose} footer={<>
      <button type="button" className="btn danger" style={{ marginRight: 'auto' }} disabled={busy || !code} onClick={stop}>Parar de compartilhar</button>
      <button type="button" className="btn" onClick={onClose}>Fechar</button>
    </>}>
      <div className="ag-code" data-testid="share-code">{code ?? '········'}</div>
      <div className="row" style={{ gap: 8, justifyContent: 'center', marginTop: 10 }}>
        <button type="button" className="btn sm" disabled={!code} onClick={() => { void navigator.clipboard?.writeText(code ?? ''); toast('Código copiado'); }}><Icon name="copy" size={14} />Copiar código</button>
        <button type="button" className="btn sm" disabled={busy} onClick={regen}><Icon name="refresh" size={14} />Gerar outro</button>
      </div>
      <p className="faint" style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 0 }}>Vão junto as instruções, o conhecimento e as perguntas frequentes. Fluxo, voz e números de WhatsApp ficam com você.</p>
    </Modal>
  );
}
