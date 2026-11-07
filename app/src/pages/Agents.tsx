import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, Switch, TopbarActions, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { AgentAvatar } from '../agents/AgentAvatar';
import { BuildAgentModal, ImportAgentModal, LimitModal, ShareAgentModal, TemplatesModal, isLimitError } from '../agents/modals';
import { VoicesTab } from '../agents/VoicesTab';
import { AUDIENCE_LABEL, ROLE_LABEL, ago, fmtN } from '../agents/util';
import type { Agent, AgentLimit, AgentListResp } from '../agents/types';

type ModalState = null | 'import' | 'templates' | 'build' | { limit: string | null } | { share: Agent } | { del: Agent };

function AgentCard({ a, canEdit, onToggle, onOpen, onMenu, menuOpen, onDuplicate, onShare, onDelete }: {
  a: Agent; canEdit: boolean; onToggle: () => void; onOpen: () => void; onMenu: () => void; menuOpen: boolean;
  onDuplicate: () => void; onShare: () => void; onDelete: () => void;
}) {
  const audio = a.replyAudio === 'never' ? 'Responde em texto' : `${a.replyAudio === 'always' ? 'Sempre em áudio' : 'Áudio quando o cliente manda áudio'} · ${a.voiceName ?? 'voz padrão'}`;
  return (
    <div className={cx('card ag-card', a.enabled && 'on')} data-testid="agent-card">
      <div className="ag-card-top">
        <AgentAvatar avatar={a.avatar} size={46} />
        <div className="ag-card-who">
          <b>{a.name}</b>
          <span><span className="pill">{ROLE_LABEL[a.role] ?? a.role}</span><span className={cx('pill dot', a.enabled ? 'green' : '')} data-testid="agent-status">{a.enabled ? 'ativo' : 'pausado'}</span></span>
        </div>
        {canEdit && <Switch on={a.enabled} onClick={onToggle} />}
      </div>
      <p className="ag-card-desc">{a.description || 'Sem descrição.'}</p>
      <div className="ag-chips">
        <span className={cx('ag-chip', !!a.flowId && !a.flowActive && 'warn')} title="Fluxo que ele dispara">
          <Icon name="flow" size={12} />{a.flowName ? `${a.flowName}${a.flowActive ? '' : ' (pausado)'}` : 'Sem fluxo'}
        </span>
        <span className="ag-chip" title="Quem ele atende"><Icon name="users" size={12} />{a.audience === 'tags' ? `Etiqueta: ${a.audienceTags.join(', ')}` : AUDIENCE_LABEL[a.audience]}</span>
        <span className="ag-chip" title="Como responde"><Icon name="mic" size={12} />{audio}</span>
      </div>
      <div className="ag-stats" title="Últimos 30 dias">
        <div><b>{fmtN(a.stats.conversations)}</b><span>conversas</span></div>
        <div><b>{fmtN(a.stats.replies)}</b><span>respostas</span></div>
        <div><b>{fmtN(a.stats.flows)}</b><span>fluxos</span></div>
        <div><b>{fmtN(a.stats.handoffs)}</b><span>p/ equipe</span></div>
      </div>
      <div className="ag-card-foot">
        <small className="faint">{a.stats.lastAt ? `Agiu ${ago(a.stats.lastAt)}` : 'Ainda não atendeu'} · 30 dias</small>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onOpen} data-testid="agent-open"><Icon name={canEdit ? 'edit' : 'play'} size={14} />{canEdit ? 'Editar' : 'Ver e testar'}</button>
        {canEdit && (
          <div className="menu-wrap">
            <button type="button" className="btn icon sm ghost" onClick={onMenu} aria-label={`Ações de ${a.name}`} data-testid="agent-menu"><Icon name="dots" size={15} /></button>
            {menuOpen && (
              <div className="menu fade">
                <button type="button" onClick={onDuplicate}><Icon name="copy" size={15} />Duplicar</button>
                <button type="button" onClick={onShare}><Icon name="share" size={15} />Compartilhar código</button>
                <div className="sep" />
                <button type="button" className="danger" onClick={onDelete}><Icon name="trash" size={15} />Excluir</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Agents() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('aba') === 'vozes' ? 'vozes' : 'agentes';
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [data, setData] = useState<AgentListResp | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(() => api.get<AgentListResp>('/agents').then(setData).catch((e) => toast(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  const limit: AgentLimit | null = data?.limit ?? null;
  const full = !!limit && limit.max !== null && limit.used >= limit.max;
  /** Abre a criação ou o aviso de limite */
  const guard = (next: ModalState | (() => void)) => {
    if (full) { setModal({ limit: null }); return; }
    if (typeof next === 'function') next(); else setModal(next);
  };

  async function toggle(a: Agent) {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.put<{ agent: Agent }>(`/agents/${a.id}`, { enabled: !a.enabled });
      setData((d) => d && { ...d, agents: d.agents.map((x) => (x.id === a.id ? r.agent : x)) });
      toast(r.agent.enabled ? `${a.name} está atendendo` : `${a.name} foi pausado`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    busy.current = false;
  }
  async function duplicate(a: Agent) {
    setMenu(null);
    try { await api.post(`/agents/${a.id}/duplicate`); toast('Cópia criada (pausada)'); void load(); }
    catch (e) { if (isLimitError(e)) setModal({ limit: e.message }); else toast(e instanceof Error ? e.message : 'Erro'); }
  }

  const setTab = (t: string) => setParams(t === 'agentes' ? {} : { aba: t }, { replace: true });
  if (!data) return <Spinner />;
  const list = data.agents;
  return (
    <div className="fade ag-page" data-testid="agents-page">
      {canEdit && (
        <TopbarActions>
          <button type="button" className="btn" onClick={() => guard('import')} data-testid="open-import-agent"><Icon name="download" size={15} />Importar</button>
          <button type="button" className="btn" onClick={() => guard('templates')} data-testid="open-templates">Modelos</button>
          <button type="button" className="btn" onClick={() => guard('build')} data-testid="open-build"><Icon name="bot" size={15} />Criar com IA</button>
          <button type="button" className="btn primary" onClick={() => guard(() => nav('/agents/novo'))} data-testid="new-agent"><Icon name="plus" size={16} />Novo agente</button>
        </TopbarActions>
      )}

      <div className="ag-head">
        <div className="seg" role="tablist">
          <button type="button" className={cx(tab === 'agentes' && 'active')} onClick={() => setTab('agentes')} role="tab" aria-selected={tab === 'agentes'} data-testid="tab-agents">Agentes</button>
          <button type="button" className={cx(tab === 'vozes' && 'active')} onClick={() => setTab('vozes')} role="tab" aria-selected={tab === 'vozes'} data-testid="tab-voices">Vozes</button>
        </div>
        <span className="spacer" />
        {limit && tab === 'agentes' && (
          <span className={cx('ag-limit', full && 'full')} data-testid="agents-limit">
            {!limit.active ? 'Sem assinatura ativa' : `${limit.used} de ${limit.max ?? 0} agentes · ${limit.perConnection} por instância`}
          </span>
        )}
      </div>

      {tab === 'vozes' ? <VoicesTab canEdit={canEdit} /> : (
        <>
          {!data.aiEnabled && <div className="hint" style={{ marginBottom: 14 }}><Icon name="alert" size={14} />A IA não está configurada no servidor (OPENAI_API_KEY): os agentes não vão responder até isso ser feito.</div>}
          {data.aiEnabled && data.balance <= 0 && list.some((a) => a.enabled) && (
            <div className="hint" style={{ marginBottom: 14 }}><Icon name="alert" size={14} />Sem saldo de tokens de IA: os agentes pararam de responder.
              <button type="button" className="linkbtn" onClick={() => nav('/billing')}>Comprar tokens</button></div>
          )}
          {list.length === 0 ? (
            <div className="ag-empty" data-testid="agents-empty">
              <Icon name="bot" size={34} />
              <b>Nenhum agente ainda</b>
              <span>Crie o primeiro para começar.</span>
              {canEdit && <button type="button" className="btn primary" onClick={() => guard(() => nav('/agents/novo'))} data-testid="create-first-agent"><Icon name="plus" size={15} />Criar o primeiro agente</button>}
            </div>
          ) : (
            <div className="ag-grid">
              {list.map((a) => (
                <AgentCard key={a.id} a={a} canEdit={canEdit} onToggle={() => void toggle(a)} onOpen={() => nav(`/agents/${a.id}`)}
                  onMenu={() => setMenu(menu === a.id ? null : a.id)} menuOpen={menu === a.id}
                  onDuplicate={() => void duplicate(a)} onShare={() => { setMenu(null); setModal({ share: a }); }} onDelete={() => { setMenu(null); setModal({ del: a }); }} />
              ))}
            </div>
          )}
        </>
      )}

      {modal === 'import' && <ImportAgentModal onClose={() => setModal(null)} onLimit={(m) => setModal({ limit: m })} onDone={(ids) => { setModal(null); void load(); if (ids.length === 1) nav(`/agents/${ids[0]}`); }} />}
      {modal === 'templates' && <TemplatesModal onClose={() => setModal(null)} onPick={(id) => { setModal(null); nav(`/agents/novo?modelo=${id}`); }} />}
      {modal === 'build' && <BuildAgentModal onClose={() => setModal(null)} onLimit={(m) => setModal({ limit: m })} onCreated={(a) => { setModal(null); nav(`/agents/${a.id}`); }} />}
      {modal && typeof modal === 'object' && 'limit' in modal && <LimitModal limit={limit} message={modal.limit ?? undefined} onClose={() => setModal(null)} />}
      {modal && typeof modal === 'object' && 'share' in modal && (
        <ShareAgentModal agent={modal.share} onClose={() => setModal(null)} onChange={(code) => setData((d) => d && { ...d, agents: d.agents.map((x) => (x.id === modal.share.id ? { ...x, shareCode: code } : x)) })} />
      )}
      {modal && typeof modal === 'object' && 'del' in modal && (
        <ConfirmModal title="Excluir agente" confirm="Excluir agente" danger onClose={() => setModal(null)} onConfirm={async () => {
          try { await api.del(`/agents/${modal.del.id}`); toast(`Agente “${modal.del.name}” excluído`); setModal(null); void load(); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>
          Excluir <b>{modal.del.name}</b>? As conversas que ele atendeu continuam no Chats ao vivo.
        </ConfirmModal>
      )}
    </div>
  );
}
