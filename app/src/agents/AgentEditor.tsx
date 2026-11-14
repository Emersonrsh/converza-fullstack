import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, Switch, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { AgentAvatar } from './AgentAvatar';
import { LimitModal, ShareAgentModal, isLimitError } from './modals';
import { ago, emptyDraft, sameDraft, toDraft } from './util';
import type { Agent, AgentDraft, AgentOptions, AgentRun, AgentTemplate, KbSummary, Sector } from './types';
import { StepProfile } from './wizard/StepProfile';
import { StepBehavior } from './wizard/StepBehavior';
import { StepKnowledge } from './wizard/StepKnowledge';
import { StepSkills } from './wizard/StepSkills';
import { StepStages } from './wizard/StepStages';
import { StepActivate } from './wizard/StepActivate';
import type { StepProps } from './wizard/common';

const STEPS = [
  { key: 'perfil', label: 'Perfil', icon: 'user' },
  { key: 'comportamento', label: 'Comportamento', icon: 'chat' },
  { key: 'conhecimento', label: 'Conhecimento', icon: 'book' },
  { key: 'habilidades', label: 'Habilidades', icon: 'bolt' },
  { key: 'fluxo', label: 'Etapas', icon: 'flow' },
  { key: 'ativacao', label: 'Teste e ativação', icon: 'play' },
] as const;

/** O que falta para sair de cada etapa (null = pode seguir). */
function blocker(step: number, d: AgentDraft): string | null {
  if (step === 0 && !d.name.trim()) return 'Dê um nome ao agente';
  if (step === 3) {
    for (const a of d.automations) {
      if (a.trigger === 'intent' && !a.when?.trim()) return 'Diga quando cada automação personalizada acontece';
      if (a.action === 'flow' && !a.flowId) return 'Escolha o fluxo das automações que disparam fluxo';
      if (a.action === 'tag' && !a.tag?.trim()) return 'Escolha a etiqueta das automações que marcam etiqueta';
      if (a.action === 'reply' && !a.message?.trim()) return 'Escreva a mensagem das automações com mensagem pronta';
    }
  }
  if (step === 4 && d.stages.some((s) => !s.name.trim())) return 'Dê um nome para cada etapa';
  return null;
}

export function AgentEditor() {
  const { id = 'novo' } = useParams();
  const isNew = id === 'novo';
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [opt, setOpt] = useState<AgentOptions | null>(null);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [bases, setBases] = useState<KbSummary[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [initial, setInitial] = useState<AgentDraft | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [recent, setRecent] = useState<AgentRun[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<null | 'share' | 'delete' | 'leave' | { limit: string }>(null);
  const stepParam = STEPS.findIndex((s) => s.key === params.get('etapa'));
  const [step, setStepState] = useState(stepParam >= 0 ? stepParam : 0);
  const [reached, setReached] = useState(isNew ? 0 : STEPS.length - 1);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [o, t, kb] = await Promise.all([
          api.get<AgentOptions>('/agents/options'),
          api.get<{ templates: AgentTemplate[]; sectors: Sector[] }>('/agents/templates'),
          api.get<{ bases: KbSummary[] }>('/knowledge-bases'),
        ]);
        if (!alive) return;
        setOpt(o); setSectors(t.sectors ?? []); setBases(kb.bases);
        if (isNew) {
          let d = emptyDraft(o.defaultModel);
          const modelo = params.get('modelo');
          const tpl = modelo ? t.templates.find((x) => x.id === modelo) : null;
          if (tpl) d = { ...d, name: tpl.name, role: tpl.role, avatar: tpl.avatar, description: tpl.description, tone: tpl.tone, systemPrompt: tpl.systemPrompt, rules: tpl.rules, flowWhen: tpl.flowWhen, handoffWhen: tpl.handoffWhen, handoffMessage: tpl.handoffMessage, automations: d.automations.map((a) => (a.trigger === 'handoff' ? { ...a, message: tpl.handoffMessage } : a)) };
          else d = { ...d, name: '' };
          setAgent(null); setInitial(null); setDraft(d); setRecent([]); setReached(0);
        } else {
          const r = await api.get<{ agent: Agent; recent: AgentRun[] }>(`/agents/${id}`);
          if (!alive) return;
          setAgent(r.agent); setInitial(toDraft(r.agent)); setDraft(toDraft(r.agent)); setRecent(r.recent); setReached(STEPS.length - 1);
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
  const patch = (p: Partial<AgentDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.wz-step.on');
    const bar = el?.parentElement;
    if (el && bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: el.offsetLeft - bar.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' });
  }, [step, draft === null]);
  const block = useMemo(() => (draft ? blocker(step, draft) : null), [draft, step]);

  function goto(i: number) {
    if (!draft) return;
    if (i > step) {
      for (let s = step; s < i; s++) { const b = blocker(s, draft); if (b) { setStepState(s); toast(b); return; } }
    }
    setStepState(i);
    setReached((r) => Math.max(r, i));
    const next = new URLSearchParams(params); next.set('etapa', STEPS[i].key); setParams(next, { replace: true });
    document.querySelector('.main')?.scrollTo?.({ top: 0 });
    window.scrollTo?.({ top: 0 });
  }

  async function save() {
    if (!draft) return;
    for (let s = 0; s < STEPS.length; s++) { const b = blocker(s, draft); if (b) { goto(s); toast(b); return; } }
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post<{ agent: Agent }>('/agents', draft);
        setInitial(toDraft(r.agent)); setAgent(r.agent); setDraft(toDraft(r.agent));
        toast(r.agent.enabled ? 'Agente criado e atendendo' : 'Agente criado — ative quando estiver pronto');
        nav(`/agents/${r.agent.id}?etapa=ativacao`, { replace: true });
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
  const last = step === STEPS.length - 1;
  const props: StepProps = { draft, set, patch, opt, ro, isNew, agent, sectors, bases, setBases, recent };

  return (
    <div className="fade wz" data-testid="agent-editor">
      <div className="card wz-head">
        <button type="button" className="btn icon ghost" onClick={back} aria-label="Voltar para agentes" data-testid="ed-back"><Icon name="arrowLeft" size={17} /></button>
        <AgentAvatar avatar={draft.avatar} size={38} />
        <div className="wz-who">
          <b>{draft.name.trim() || (isNew ? 'Novo agente de IA' : 'Sem nome')}</b>
          <small>{isNew ? `Etapa ${step + 1} de ${STEPS.length} — ainda não salvo` : dirty ? 'Alterações não salvas' : `Salvo ${ago(agent?.updatedAt)}`}</small>
        </div>
        <span className="spacer" />
        {!isNew && (
          <label className={cx('ag-ed-on', draft.enabled && 'on')} title={draft.enabled ? 'Respondendo no WhatsApp' : 'Pausado'}>
            <Switch on={draft.enabled} onClick={() => !ro && set('enabled', !draft.enabled)} /><span data-testid="ed-enabled-label">{draft.enabled ? 'Ativo' : 'Pausado'}</span>
          </label>
        )}
        {!isNew && canEdit && <div className="wz-head-acts">
          <button type="button" className="btn sm" onClick={() => setModal('share')} data-testid="ed-share"><Icon name="share" size={14} /><span>Compartilhar</span></button>
          <button type="button" className="btn sm" onClick={() => void duplicate()}><Icon name="copy" size={14} /><span>Duplicar</span></button>
          <button type="button" className="btn sm ghost danger" onClick={() => setModal('delete')} data-testid="ed-delete" aria-label="Excluir agente"><Icon name="trash" size={14} /></button>
          <button type="button" className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()} data-testid="ed-save">{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>}
      </div>
      {!opt.aiEnabled && <div className="hint"><Icon name="alert" size={14} />A IA não está configurada no servidor: o agente não vai responder nem dá para testar.</div>}

      <nav className="wz-steps" aria-label="Etapas" data-testid="wz-steps">
        {STEPS.map((s, i) => {
          const done = i < step || (!isNew && i !== step);
          return (
            <button type="button" key={s.key} className={cx('wz-step', i === step && 'on', done && 'done')} disabled={i > reached && i > step + 1}
              onClick={() => goto(i)} aria-current={i === step ? 'step' : undefined} data-testid={`wz-step-${s.key}`}>
              <span className="wz-dot">{i < step && isNew ? <Icon name="check" size={13} /> : i + 1}</span>
              <span className="wz-lbl">{s.label}</span>
            </button>
          );
        })}
      </nav>

      <fieldset className="wz-body" disabled={ro && step !== 5} data-testid={`wz-body-${STEPS[step].key}`}>
        {step === 0 && <StepProfile {...props} />}
        {step === 1 && <StepBehavior {...props} />}
        {step === 2 && <StepKnowledge {...props} />}
        {step === 3 && <StepSkills {...props} />}
        {step === 4 && <StepStages {...props} />}
        {step === 5 && <StepActivate {...props} />}
      </fieldset>

      <div className="wz-foot">
        {step > 0 ? <button type="button" className="btn ghost" onClick={() => goto(step - 1)} data-testid="wz-prev"><Icon name="chevronLeft" size={15} />Voltar</button> : <span />}
        <span className="wz-foot-hint">{block}</span>
        {!last && <button type="button" className="btn primary" onClick={() => goto(step + 1)} data-testid="wz-next">Avançar<Icon name="chevronRight" size={15} /></button>}
        {last && canEdit && (isNew
          ? <button type="button" className="btn primary" disabled={saving} onClick={() => void save()} data-testid="wz-create">{saving ? 'Criando…' : draft.enabled ? 'Criar e ativar agente' : 'Criar agente'}</button>
          : <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()} data-testid="wz-save">{saving ? 'Salvando…' : 'Salvar alterações'}</button>)}
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
          {isNew ? 'O agente ainda não foi criado. Se sair agora, o que você preencheu se perde.' : 'Você mudou este agente e ainda não salvou. Se sair agora, essas alterações se perdem.'}
        </ConfirmModal>
      )}
      {modal && typeof modal === 'object' && <LimitModal limit={null} message={modal.limit} onClose={() => setModal(null)} />}
    </div>
  );
}
