import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, Switch, cx, toast } from '../components/ui';
import { TagPicker } from '../components/TagPicker';
import { ConfirmModal } from '../kanban/modals';
import { AgentAvatar, AVATAR_KEYS, avatarLabel } from './AgentAvatar';
import { LimitModal, ShareAgentModal, isLimitError } from './modals';
import { TestChat } from './TestChat';
import { OUTCOME_LABEL, REPLY_AUDIO_LABEL, ROLES, ago, emptyDraft, sameDraft, toDraft } from './util';
import type { Agent, AgentDraft, AgentOptions, AgentRun, AgentTemplate, ReplyAudio } from './types';

const DEFAULT_FLOW_WHEN = 'quando a pessoa disser que quer comprar, pedir o link, o Pix ou perguntar como pagar';
const DEFAULT_HANDOFF_WHEN = 'quando a pessoa pedir para falar com alguém da equipe, estiver irritada, reclamar ou perguntar algo que ele não sabe';

function Section({ icon, title, desc, children, testId }: { icon: string; title: string; desc?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="card ag-sec" data-testid={testId}>
      <header><span className="ag-sec-ic"><Icon name={icon} size={16} /></span><div><b>{title}</b>{desc && <small>{desc}</small>}</div></header>
      <div className="ag-sec-body">{children}</div>
    </section>
  );
}

const Lbl = ({ children, hint }: { children: ReactNode; hint?: string }) => <label className="label">{children}{hint && <span className="lbl-hint"> · {hint}</span>}</label>;

export function AgentEditor() {
  const { id = 'novo' } = useParams();
  const isNew = id === 'novo';
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [opt, setOpt] = useState<AgentOptions | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [initial, setInitial] = useState<AgentDraft | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [recent, setRecent] = useState<AgentRun[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<null | 'share' | 'delete' | 'leave' | { limit: string }>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const o = await api.get<AgentOptions>('/agents/options');
        if (!alive) return;
        setOpt(o);
        if (isNew) {
          let d = emptyDraft(o.defaultModel);
          const modelo = params.get('modelo');
          if (modelo) {
            const { templates } = await api.get<{ templates: AgentTemplate[] }>('/agents/templates');
            const t = templates.find((x) => x.id === modelo);
            if (t) d = { ...d, name: t.name, role: t.role, avatar: t.avatar, description: t.description, tone: t.tone, systemPrompt: t.systemPrompt, rules: t.rules, flowWhen: t.flowWhen, handoffWhen: t.handoffWhen, handoffMessage: t.handoffMessage };
          }
          setAgent(null); setInitial(null); setDraft(d); setRecent([]);
        } else {
          const r = await api.get<{ agent: Agent; recent: AgentRun[] }>(`/agents/${id}`);
          if (!alive) return;
          setAgent(r.agent); setInitial(toDraft(r.agent)); setDraft(toDraft(r.agent)); setRecent(r.recent);
        }
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Não foi possível abrir'); }
    })();
    return () => { alive = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = isNew || !sameDraft(draft, initial);
  useEffect(() => {
    if (!dirty || !canEdit) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, canEdit]);

  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const flow = useMemo(() => opt?.flows.find((f) => f.id === draft?.flowId) ?? null, [opt, draft?.flowId]);
  const modelOptions = useMemo(() => {
    const list = opt?.models ?? [];
    return draft && !list.some((m) => m.id === draft.model) ? [...list, { id: draft.model, label: draft.model }] : list;
  }, [opt, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post<{ agent: Agent }>('/agents', draft);
        setInitial(toDraft(r.agent)); setAgent(r.agent); setDraft(toDraft(r.agent));
        toast(r.agent.enabled ? 'Agente criado e atendendo' : 'Agente criado — ative quando estiver pronto');
        nav(`/agents/${r.agent.id}`, { replace: true });
      } else {
        const r = await api.put<{ agent: Agent }>(`/agents/${id}`, draft);
        setAgent(r.agent); setInitial(toDraft(r.agent)); setDraft(toDraft(r.agent));
        toast('Agente salvo');
      }
    } catch (e) {
      if (isLimitError(e)) setModal({ limit: e.message });
      else toast(e instanceof Error ? e.message : 'Não foi possível salvar');
    }
    setSaving(false);
  }

  async function duplicate() {
    if (!agent) return;
    try { const r = await api.post<{ agent: Agent }>(`/agents/${agent.id}/duplicate`); toast('Cópia criada (pausada)'); nav(`/agents/${r.agent.id}`); }
    catch (e) { if (isLimitError(e)) setModal({ limit: e.message }); else toast(e instanceof Error ? e.message : 'Erro'); }
  }

  const back = () => (dirty && canEdit ? setModal('leave') : nav('/agents'));

  if (err) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível abrir</b><span>{err}</span><Link className="btn" to="/agents">Voltar para agentes</Link></div>;
  if (!opt || !draft) return <Spinner />;
  const ro = !canEdit;
  const faq = draft.faq;

  return (
    <div className="fade ag-editor" data-testid="agent-editor">
      <div className="card ag-ed-head">
        <button type="button" className="btn icon ghost" onClick={back} aria-label="Voltar para agentes" data-testid="ed-back"><Icon name="arrowLeft" size={17} /></button>
        <AgentAvatar avatar={draft.avatar} size={40} />
        <div className="ag-ed-who"><b>{draft.name || 'Sem nome'}</b><small>{isNew ? 'Agente novo — ainda não salvo' : dirty ? 'Alterações não salvas' : `Salvo ${ago(agent?.updatedAt)}`}</small></div>
        <span className="spacer" />
        <label className={cx('ag-ed-on', draft.enabled && 'on')} title={draft.enabled ? 'Respondendo no WhatsApp' : 'Pausado'}>
          <Switch on={draft.enabled} onClick={() => !ro && set('enabled', !draft.enabled)} /><span data-testid="ed-enabled-label">{draft.enabled ? 'Ativo' : 'Pausado'}</span>
        </label>
        {!isNew && canEdit && <>
          <button type="button" className="btn sm" onClick={() => setModal('share')} data-testid="ed-share"><Icon name="share" size={14} />Compartilhar</button>
          <button type="button" className="btn sm" onClick={() => void duplicate()}><Icon name="copy" size={14} />Duplicar</button>
          <button type="button" className="btn sm ghost danger" onClick={() => setModal('delete')} data-testid="ed-delete"><Icon name="trash" size={14} /></button>
        </>}
        {canEdit && <button type="button" className="btn primary" disabled={!dirty || saving || !draft.name.trim()} onClick={() => void save()} data-testid="ed-save">{saving ? 'Salvando…' : isNew ? 'Criar agente' : 'Salvar'}</button>}
      </div>
      {!opt.aiEnabled && <div className="hint"><Icon name="alert" size={14} />A IA não está configurada no servidor (OPENAI_API_KEY): o agente não vai responder nem dá para testar.</div>}

      <div className="ag-ed-body">
        <fieldset className="ag-ed-form" disabled={ro}>
          <Section icon="user" title="Perfil" desc="Quem é o atendente" testId="sec-profile">
            <Lbl>Avatar</Lbl>
            <div className="ag-avatars">
              {AVATAR_KEYS.map((k) => (
                <button type="button" key={k} className={cx(draft.avatar === k && 'on')} onClick={() => set('avatar', k)} title={avatarLabel(k)} aria-label={`Avatar ${avatarLabel(k)}`}>
                  <AgentAvatar avatar={k} size={40} />
                </button>
              ))}
            </div>
            <div className="ag-two">
              <div><Lbl>Nome</Lbl><input className="input" maxLength={60} value={draft.name} onChange={(e) => set('name', e.target.value)} data-testid="ed-name" /></div>
              <div><Lbl>Objetivo</Lbl>
                <select className="select" value={draft.role} onChange={(e) => set('role', e.target.value as AgentDraft['role'])} data-testid="ed-role">
                  {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <div><Lbl hint="aparece na lista">Descrição</Lbl><input className="input" maxLength={240} value={draft.description} onChange={(e) => set('description', e.target.value)} placeholder="Ex.: Atende quem chega do anúncio e manda o checkout" data-testid="ed-description" /></div>
            <div><Lbl>Modelo de IA</Lbl>
              <select className="select" value={draft.model} onChange={(e) => set('model', e.target.value)} data-testid="ed-model">
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </Section>

          <Section icon="chat" title="Como ele atende" desc="Jeito de falar, passos e limites" testId="sec-style">
            <div><Lbl>Jeito de falar</Lbl><textarea className="input" rows={2} value={draft.tone} onChange={(e) => set('tone', e.target.value)} placeholder="Ex.: Simpático e direto, frases curtas, uma pergunta por vez, emojis com moderação." data-testid="ed-tone" /></div>
            <div><Lbl hint="um passo por linha">Instruções</Lbl><textarea className="input" rows={6} value={draft.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} placeholder={'1. Cumprimente e pergunte o que a pessoa procura\n2. Tire as dúvidas com base no que ele sabe\n3. Quando a pessoa quiser comprar, dispare o fluxo'} data-testid="ed-instructions" /></div>
            <div><Lbl hint="uma por linha">O que ele nunca deve fazer</Lbl><textarea className="input" rows={3} value={draft.rules} onChange={(e) => set('rules', e.target.value)} placeholder={'Não ofereça desconto\nNão prometa prazo de entrega'} data-testid="ed-rules" /></div>
            <small className="faint">Ele já nunca inventa preço, link ou prazo, e nunca pede senha ou dados de cartão.</small>
          </Section>

          <Section icon="book" title="O que ele sabe" desc="A única fonte dele sobre produtos, preços e condições" testId="sec-knowledge">
            <div>
              <Lbl hint={`${draft.knowledge.length.toLocaleString('pt-BR')} / 30.000`}>Conhecimento</Lbl>
              <textarea className="input" rows={9} maxLength={30000} value={draft.knowledge} onChange={(e) => set('knowledge', e.target.value)}
                placeholder={'Produto, o que inclui e para quem é\nPreço e formas de pagamento (Pix, cartão, parcelas)\nPrazo de entrega/acesso, garantia e trocas\nHorário de atendimento, endereço, contatos'} data-testid="ed-knowledge" />
              {!draft.knowledge.trim() && <small className="faint">Sem conhecimento, ele não fala de preços nem condições — diz que vai confirmar com a equipe.</small>}
            </div>
            <div>
              <Lbl>Perguntas frequentes</Lbl>
              <div className="ag-faq">
                {faq.map((f, i) => (
                  <div key={i} className="ag-faq-row" data-testid="faq-row">
                    <input className="input" value={f.q} placeholder="Pergunta" onChange={(e) => set('faq', faq.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} data-testid="faq-q" />
                    <textarea className="input" rows={2} value={f.a} placeholder="Resposta" onChange={(e) => set('faq', faq.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} data-testid="faq-a" />
                    <button type="button" className="btn icon sm ghost" onClick={() => set('faq', faq.filter((_, j) => j !== i))} aria-label="Remover pergunta"><Icon name="trash" size={14} /></button>
                  </div>
                ))}
                {faq.length < 40 && <button type="button" className="btn sm" onClick={() => set('faq', [...faq, { q: '', a: '' }])} data-testid="faq-add"><Icon name="plus" size={14} />Adicionar pergunta</button>}
              </div>
            </div>
          </Section>

          <Section icon="bolt" title="Ações" desc="Disparar o fluxo e passar para a equipe" testId="sec-actions">
            <div className="ag-act-box">
              <b><Icon name="flow" size={14} />Disparar um fluxo</b>
              <div className="ag-two">
                <div><Lbl>Fluxo</Lbl>
                  <select className="select" value={draft.flowId ?? ''} onChange={(e) => set('flowId', e.target.value || null)} data-testid="ed-flow">
                    <option value="">Nenhum (só conversa)</option>
                    {opt.flows.map((f) => <option key={f.id} value={f.id}>{f.name}{f.status === 'active' ? '' : ' (pausado)'}</option>)}
                  </select>
                </div>
                <div><Lbl hint="opcional">Etiqueta ao disparar</Lbl>
                  <input className="input" list="ag-tags" maxLength={40} value={draft.flowTag ?? ''} onChange={(e) => set('flowTag', e.target.value || null)} placeholder="Ex.: quer comprar" data-testid="ed-flow-tag" />
                </div>
              </div>
              {flow && flow.status !== 'active' && <div className="hint"><Icon name="alert" size={14} />Esse fluxo está pausado: ative em <Link to={`/flows/${flow.id}`}>Fluxos</Link> para o agente conseguir disparar.</div>}
              {draft.flowId && <div><Lbl>Quando disparar</Lbl><input className="input" maxLength={500} value={draft.flowWhen} onChange={(e) => set('flowWhen', e.target.value)} placeholder={DEFAULT_FLOW_WHEN} data-testid="ed-flow-when" /></div>}
              <small className="faint">Ideal para o checkout: o fluxo manda o link ou o Pix e espera o pagamento. O agente não manda links por conta própria.</small>
            </div>
            <div className="ag-act-box">
              <b><Icon name="headset" size={14} />Passar para a equipe</b>
              <div><Lbl>Quando passar</Lbl><input className="input" maxLength={500} value={draft.handoffWhen} onChange={(e) => set('handoffWhen', e.target.value)} placeholder={DEFAULT_HANDOFF_WHEN} data-testid="ed-handoff-when" /></div>
              <div className="ag-two">
                <div><Lbl>Mensagem ao passar</Lbl><input className="input" maxLength={500} value={draft.handoffMessage} onChange={(e) => set('handoffMessage', e.target.value)} placeholder="Vou chamar alguém da equipe, só um instante!" data-testid="ed-handoff-msg" /></div>
                <div><Lbl hint="opcional">Etiqueta ao passar</Lbl><input className="input" list="ag-tags" maxLength={40} value={draft.handoffTag ?? ''} onChange={(e) => set('handoffTag', e.target.value || null)} placeholder="Ex.: atendimento humano" data-testid="ed-handoff-tag" /></div>
              </div>
              {(opt.departments ?? []).length > 0 && (
                <div><Lbl hint="opcional">Mandar para o setor</Lbl>
                  <select className="select" value={draft.handoffDepartmentId ?? ''} onChange={(e) => set('handoffDepartmentId', e.target.value || null)} data-testid="ed-handoff-dept">
                    <option value="">Fila geral (qualquer pessoa da equipe)</option>
                    {(opt.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              )}
              <small className="faint">Ao passar, a conversa vai para “Aguardando” no Chats ao vivo{draft.handoffDepartmentId ? ', só para quem é do setor,' : ''} e o agente para de responder nela.</small>
            </div>
            <datalist id="ag-tags">{opt.tags.map((t) => <option key={t.name} value={t.name} />)}</datalist>
          </Section>

          <Section icon="plug" title="Onde ele atende" desc="Números e público" testId="sec-where">
            <div>
              <Lbl>Conexões</Lbl>
              {opt.connections.length ? (
                <div className="ag-checks">
                  {opt.connections.map((c) => (
                    <label key={c.id} className="ag-check">
                      <input type="checkbox" checked={draft.connectionIds.includes(c.id)} data-testid="ed-conn"
                        onChange={(e) => set('connectionIds', e.target.checked ? [...draft.connectionIds, c.id] : draft.connectionIds.filter((x) => x !== c.id))} />
                      <span>{c.name}{c.displayPhone ? <span className="lbl-hint"> · {c.displayPhone}</span> : null}</span>
                    </label>
                  ))}
                </div>
              ) : <small className="faint">Nenhuma conexão ainda — conecte um número em <Link to="/connections">Conexões</Link>.</small>}
              <small className="faint">{draft.connectionIds.length ? 'Responde só nesses números.' : 'Nenhuma marcada = responde em todos os números.'}</small>
            </div>
            <div>
              <Lbl>Quem ele atende</Lbl>
              <div className="ag-radios">
                {([['all', 'Todos os contatos'], ['ads', 'Só quem chegou por anúncio'], ['tags', 'Só contatos com etiqueta']] as const).map(([v, l]) => (
                  <label key={v} className={cx('ag-radio', draft.audience === v && 'on')}>
                    <input type="radio" name="audience" checked={draft.audience === v} onChange={() => set('audience', v)} data-testid={`ed-audience-${v}`} />{l}
                  </label>
                ))}
              </div>
              {draft.audience === 'tags' && <div style={{ marginTop: 8 }}><TagPicker value={draft.audienceTags} onChange={(v) => set('audienceTags', v)} allowCreate={false} placeholder="Escolha as etiquetas…" testId="ed-audience-picker" /></div>}
            </div>
            <small className="faint">Fluxos com gatilho têm prioridade: o agente responde quando nenhum fluxo tratou a mensagem. Quando alguém da equipe responde, a automação pausa naquela conversa.</small>
          </Section>

          <Section icon="mic" title="Áudio" desc="Responder em mensagem de voz e entender os áudios do cliente" testId="sec-audio">
            {!opt.voiceEnabled && <div className="hint"><Icon name="info" size={14} />Áudio precisa da chave da ElevenLabs no servidor (ELEVENLABS_API_KEY). Por enquanto ele responde em texto.</div>}
            <div className="ag-radios col">
              {(Object.keys(REPLY_AUDIO_LABEL) as ReplyAudio[]).map((v) => (
                <label key={v} className={cx('ag-radio', draft.replyAudio === v && 'on')}>
                  <input type="radio" name="replyAudio" checked={draft.replyAudio === v} onChange={() => set('replyAudio', v)} data-testid={`ed-audio-${v}`} />{REPLY_AUDIO_LABEL[v]}
                </label>
              ))}
            </div>
            {draft.replyAudio !== 'never' && (
              <div><Lbl>Voz</Lbl>
                <select className="select" value={draft.voiceId ?? ''} onChange={(e) => set('voiceId', e.target.value || null)} data-testid="ed-voice">
                  <option value="">Padrão da plataforma</option>
                  {opt.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <small className="faint">Quer a sua voz? <Link to="/agents?aba=vozes">Crie uma voz</Link> com 1 a 3 áudios.</small>
              </div>
            )}
            <label className="ag-switch-row">
              <Switch on={draft.transcribeAudio} onClick={() => !ro && set('transcribeAudio', !draft.transcribeAudio)} />
              <span><b>Entender os áudios do cliente</b><small>Transcreve as mensagens de voz para o agente ler — e a equipe também vê o texto no Chats.</small></span>
            </label>
            <small className="faint">Custo: cerca de {opt.voiceCost.perChar} token{opt.voiceCost.perChar === 1 ? '' : 's'} por letra falada e {opt.voiceCost.perMinute.toLocaleString('pt-BR')} tokens por minuto de áudio transcrito.</small>
          </Section>

          <Section icon="gear" title="Avançado" testId="sec-advanced">
            <div className="ag-two">
              <div><Lbl hint="0 a 60 s">Esperar o cliente terminar de escrever</Lbl>
                <input className="input" type="number" min={0} max={60} value={draft.waitSeconds} onChange={(e) => set('waitSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))} data-testid="ed-wait" />
                <small className="faint">Junta as mensagens seguidas antes de responder.</small>
              </div>
              <div><Lbl hint="por conversa">Respostas por dia</Lbl>
                <input className="input" type="number" min={1} max={500} value={draft.maxRepliesPerDay} onChange={(e) => set('maxRepliesPerDay', Math.max(1, Math.min(500, Number(e.target.value) || 1)))} data-testid="ed-max" />
                <small className="faint">Ao chegar no limite, passa para a equipe.</small>
              </div>
            </div>
          </Section>

          {!isNew && (
            <Section icon="history" title="Atividade recente" testId="sec-activity">
              {recent.length ? (
                <div className="ag-runs">
                  {recent.map((r, i) => (
                    <Link key={i} to={`/inbox?c=${r.conversationId}`} className={cx('ag-run', r.outcome)} data-testid="agent-run">
                      <b>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</b><span>{r.contactName}{r.detail ? ` · ${r.detail}` : ''}</span><small className="faint">{ago(r.createdAt)}</small>
                    </Link>
                  ))}
                </div>
              ) : <small className="faint">Quando ele atender alguém, aparece aqui.</small>}
            </Section>
          )}
        </fieldset>

        <aside className="ag-ed-side">
          <TestChat agentId={agent?.id ?? null} draft={draft} aiEnabled={opt.aiEnabled} voiceEnabled={opt.voiceEnabled} />
        </aside>
      </div>

      {modal === 'share' && agent && <ShareAgentModal agent={agent} onClose={() => setModal(null)} onChange={(code) => setAgent({ ...agent, shareCode: code })} />}
      {modal === 'delete' && agent && (
        <ConfirmModal title="Excluir agente" confirm="Excluir agente" danger onClose={() => setModal(null)} onConfirm={async () => {
          try { await api.del(`/agents/${agent.id}`); toast(`Agente “${agent.name}” excluído`); nav('/agents'); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>Excluir <b>{agent.name}</b>? As conversas que ele atendeu continuam no Chats ao vivo.</ConfirmModal>
      )}
      {modal === 'leave' && (
        <ConfirmModal title="Sair sem salvar?" confirm="Sair sem salvar" danger onClose={() => setModal(null)} onConfirm={() => { nav('/agents'); }}>
          Você mudou este agente e ainda não salvou. Se sair agora, essas alterações se perdem.
        </ConfirmModal>
      )}
      {modal && typeof modal === 'object' && <LimitModal limit={null} message={modal.limit} onClose={() => setModal(null)} />}
    </div>
  );
}
