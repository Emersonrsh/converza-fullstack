import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Modal, Spinner, TopbarActions, cx, toast } from '../components/ui';
import { SubscriptionAlert } from '../components/SubscriptionAlert';
import { NewConnectionModal } from '../connections/NewConnectionModal';
import { ConnectionDrawer, DeleteConnectionModal } from '../connections/ConnectionDrawer';
import { QUALITY_TONE, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, type ConnListResp, type ConnPlan, type ConnStatus, type ConnectionFull } from '../connections/types';

const SOURCE_ICON: Record<string, string> = { manual: 'gear', embedded: 'bolt', coexistence: 'phone' };

const ago = (iso: string | null) => {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'ontem' : `há ${d} dias`;
};
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

type Gate = 'no_plan' | 'connection_limit';
type ModalState = null | 'new' | { gate: Gate } | { rename: ConnectionFull } | { del: ConnectionFull };

function PlanGateModal({ gate, plan, onClose }: { gate: Gate; plan: ConnPlan; onClose: () => void }) {
  const nav = useNavigate();
  const inst = (n: number) => `${n} ${n === 1 ? 'instância' : 'instâncias'}`;
  return (
    <Modal title={gate === 'no_plan' ? 'Assine para conectar' : 'Limite de conexões'} icon="plug" width={440} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Agora não</button>
      <button type="button" className="btn primary" onClick={() => nav('/billing')} data-testid="gate-billing">{gate === 'no_plan' ? 'Assinar agora' : plan.scheduledInstances !== null ? 'Ver cobrança' : 'Contratar mais instâncias'}</button>
    </>}>
      <div style={{ fontSize: 13.5, lineHeight: 1.55 }} data-testid="plan-gate">
        {gate === 'no_plan'
          ? 'Sua assinatura está inativa. Assine para conectar seus números de WhatsApp: cada instância contratada é um número.'
          : plan.scheduledInstances !== null
            ? <>Você agendou a redução para <b>{inst(plan.scheduledInstances)}</b> na próxima renovação e já usa {plan.used}. Desfaça a redução em Cobranças e assinaturas para conectar outro número.</>
            : <>Você contratou <b>{inst(plan.instances)}</b> e já usa {plan.used}. Cada instância é um número de WhatsApp: contrate mais para conectar outro — ou exclua uma conexão que não usa mais.</>}
      </div>
    </Modal>
  );
}

function RenameModal({ c, onClose, onDone }: { c: ConnectionFull; onClose: () => void; onDone: (c: ConnectionFull) => void }) {
  const [name, setName] = useState(c.name);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const r = await api.patch<{ connection: ConnectionFull }>(`/connections/${c.id}`, { name }); onDone(r.connection); toast('Nome salvo'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(false);
  };
  return (
    <Modal title="Renomear conexão" width={420} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!name.trim() || name.trim() === c.name || busy} onClick={() => void save()} data-testid="rename-save">Salvar</button>
    </>}>
      <label className="label">Nome</label>
      <input className="input" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save(); }} data-testid="rename-input" />
      <small className="faint">Só para a sua equipe: aparece nos filtros do Chats ao vivo, nos agentes e nos disparos.</small>
    </Modal>
  );
}

function ConnCard({ c, canEdit, checking, menuOpen, onCheck, onOpen, onMenu, onRename, onDelete }: {
  c: ConnectionFull; canEdit: boolean; checking: boolean; menuOpen: boolean;
  onCheck: () => void; onOpen: () => void; onMenu: () => void; onRename: () => void; onDelete: () => void;
}) {
  const warn = c.lastError ?? c.warnings[0] ?? null;
  const more = c.warnings.length - (c.lastError ? 0 : 1);
  return (
    <div className={cx('card cn-card', c.status)} data-testid="conn-card">
      <div className="cn-card-top">
        <span className={cx('cn-ic', c.status)}><Icon name="phone" size={19} /></span>
        <button type="button" className="cn-card-who" onClick={onOpen}>
          <b>{c.name}</b>
          <span>{c.displayPhone ?? c.phoneNumberId ?? 'sem número'}{c.verifiedName ? ` · ${c.verifiedName}` : ''}</span>
        </button>
        <span className={cx('pill dot', STATUS_TONE[c.status])} data-testid="conn-status">{STATUS_LABEL[c.status]}</span>
      </div>
      <div className="ag-chips">
        <span className="ag-chip" title="Como foi conectada"><Icon name={SOURCE_ICON[c.source] ?? 'plug'} size={12} />{SOURCE_LABEL[c.source] ?? c.source}</span>
        {c.labels.quality && <span className={cx('ag-chip', `q-${QUALITY_TONE[c.qualityRating ?? ''] ?? 'none'}`)} title="Qualidade do número na Meta" data-testid="conn-quality">Qualidade {c.labels.quality.toLowerCase()}</span>}
        {c.labels.limit && <span className="ag-chip" title="Conversas iniciadas por você por dia">{c.labels.limit}</span>}
      </div>
      {warn && (
        <div className={cx('hint', c.lastError || c.status === 'disconnected' ? 'bad' : 'warn')} data-testid="conn-warning">
          <Icon name={c.lastError ? 'alert' : 'info'} size={14} />
          <span>{warn}{more > 0 ? <b> (+{more})</b> : null}</span>
        </div>
      )}
      <div className="cn-meta">
        <div><b>{(c.conversations ?? 0).toLocaleString('pt-BR')}</b><span>conversas</span></div>
        <div><b>{ago(c.lastInboundAt)}</b><span>última mensagem</span></div>
        <div><b>{ago(c.lastCheckedAt)}</b><span>verificada</span></div>
      </div>
      <div className="ag-card-foot">
        <button type="button" className="btn sm ghost" disabled={checking} onClick={onCheck} data-testid="conn-check"><Icon name="refresh" size={13} />{checking ? 'Verificando…' : 'Verificar'}</button>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onOpen} data-testid="conn-open"><Icon name="gear" size={14} />Detalhes</button>
        {canEdit && (
          <div className="menu-wrap">
            <button type="button" className="btn icon sm ghost" onClick={onMenu} aria-label={`Ações de ${c.name}`} data-testid="conn-menu"><Icon name="dots" size={15} /></button>
            {menuOpen && (
              <div className="menu fade">
                <button type="button" onClick={onRename} data-testid="conn-rename"><Icon name="edit" size={15} />Renomear</button>
                <div className="sep" />
                <button type="button" className="danger" onClick={onDelete} data-testid="conn-delete"><Icon name="trash" size={15} />Excluir</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Connections() {
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [data, setData] = useState<ConnListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | ConnStatus>('');
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());

  const load = useCallback(() => api.get<ConnListResp>('/connections').then((r) => { setData(r); setErr(null); })
    .catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);

  /** Junta uma conexão atualizada na lista (mantém a contagem de conversas). */
  const merge = useCallback((c: ConnectionFull) => setData((d) => {
    if (!d) return d;
    const has = d.connections.some((x) => x.id === c.id);
    const connections = has ? d.connections.map((x) => (x.id === c.id ? { ...x, ...c, conversations: c.conversations ?? x.conversations } : x)) : [...d.connections, { ...c, conversations: c.conversations ?? 0 }];
    return { ...d, connections, plan: { ...d.plan, used: connections.length } };
  }), []);
  const drop = useCallback((id: string) => setData((d) => {
    if (!d) return d;
    const connections = d.connections.filter((x) => x.id !== id);
    return { ...d, connections, plan: { ...d.plan, used: connections.length } };
  }), []);

  // tempo real: verificação periódica, falha de envio, número desconectado pela Meta…
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const up = (p: { connection?: ConnectionFull }) => { if (p?.connection?.id) merge(p.connection); else void load(); };
    const del = (p: { id: string }) => { drop(p.id); setOpen((o) => (o === p.id ? null : o)); };
    sock.on('connection:updated', up);
    sock.on('connection:deleted', del);
    return () => { sock.off('connection:updated', up); sock.off('connection:deleted', del); };
  }, [merge, drop, load]);

  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) setMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  const list = data?.connections ?? [];
  const counts = useMemo(() => ({
    connected: list.filter((c) => c.status === 'connected').length,
    disconnected: list.filter((c) => c.status !== 'connected').length,
  }), [list]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const td = digits(t);
    return list.filter((c) => {
      if (status && c.status !== status) return false;
      if (!t) return true;
      return c.name.toLowerCase().includes(t) || (c.verifiedName ?? '').toLowerCase().includes(t)
        || (td.length >= 3 && (digits(c.displayPhone).includes(td) || (c.phoneNumberId ?? '').includes(td)));
    });
  }, [list, q, status]);

  const plan = data?.plan;
  const full = !!plan && plan.max !== null && plan.used >= plan.max;
  const startNew = () => {
    if (!plan) return;
    if (!plan.active) setModal({ gate: 'no_plan' });
    else if (full) setModal({ gate: 'connection_limit' });
    else setModal('new');
  };
  async function check(c: ConnectionFull) {
    setChecking((s) => new Set(s).add(c.id));
    try {
      const r = await api.post<{ connection: ConnectionFull }>(`/connections/${c.id}/check`);
      merge(r.connection);
      toast(r.connection.status === 'connected' ? `${c.name}: conectada ✓` : `${c.name}: ${STATUS_LABEL[r.connection.status].toLowerCase()} — veja os detalhes`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setChecking((s) => { const n = new Set(s); n.delete(c.id); return n; });
  }

  if (err && !data) return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar as conexões</b><span>{err}</span><button type="button" className="btn" onClick={() => void load()}>Tentar de novo</button></div>;
  if (!data || !plan) return <Spinner />;
  const anyFilter = !!(q.trim() || status);

  return (
    <div className="fade cn-page" data-testid="connections-page">
      {canEdit && (
        <TopbarActions>
          <button type="button" className="btn primary" onClick={startNew} data-testid="new-connection"><Icon name="plus" size={16} />Nova Conexão</button>
        </TopbarActions>
      )}

      <SubscriptionAlert status={plan.status} />
      {plan.active && plan.max !== null && plan.used > plan.max && (
        <div className="hint warn" data-testid="over-limit"><Icon name="alert" size={14} />
          <span>Você contratou {plan.max} {plan.max === 1 ? 'instância' : 'instâncias'} e tem {plan.used} números conectados. Exclua {plan.used - plan.max === 1 ? 'uma conexão' : `${plan.used - plan.max} conexões`} ou contrate mais instâncias para continuar com todas.</span>
        </div>
      )}

      <div className="cn-stats">
        <div className="card cn-stat" data-testid="stat-connected"><span className="cn-dot green" /><div><small>Conectadas</small><b>{counts.connected}</b></div></div>
        <div className="card cn-stat" data-testid="stat-disconnected"><span className="cn-dot red" /><div><small>Desconectadas</small><b>{counts.disconnected}</b></div></div>
      </div>

      <div className="ct-bar">
        <div className="fl-search ct-search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="Buscar por nome ou número" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conexão" data-testid="conn-search" />
        </div>
        <select className={cx('select', status && 'on')} value={status} onChange={(e) => setStatus(e.target.value as '' | ConnStatus)} aria-label="Status" data-testid="conn-status-filter">
          <option value="">Todos os status</option>
          <option value="connected">Conectadas</option>
          <option value="disconnected">Desconectadas</option>
          <option value="pending">Aguardando</option>
        </select>
        <span className="spacer" />
        {plan.active && (
          <span className={cx('ag-limit', full && 'full')} data-testid="conn-limit">
            {`${plan.used} de ${plan.max ?? plan.instances} ${(plan.max ?? plan.instances) === 1 ? 'instância' : 'instâncias'} em uso`}
          </span>
        )}
      </div>

      {list.length === 0 ? (
        <div className="card cn-empty" data-testid="connections-empty">
          <span className="cn-empty-ic"><Icon name="plug" size={26} /></span>
          <b>Nenhuma conexão criada</b>
          <span>Crie sua primeira conexão para começar</span>
          {canEdit ? <button type="button" className="btn primary" onClick={startNew} data-testid="create-first-connection"><Icon name="plus" size={15} />Criar Primeira Conexão</button>
            : <small className="faint">Peça para o dono ou um administrador da conta conectar o WhatsApp.</small>}
        </div>
      ) : shown.length === 0 ? (
        <div className="card cn-empty" data-testid="connections-none">
          <span className="cn-empty-ic"><Icon name="search" size={24} /></span>
          <b>Nenhuma conexão encontrada</b>
          <span>Nada combina com a busca{status ? ` e o status “${STATUS_LABEL[status]}”` : ''}.</span>
          {anyFilter && <button type="button" className="btn" onClick={() => { setQ(''); setStatus(''); }}>Limpar filtros</button>}
        </div>
      ) : (
        <div className="cn-grid">
          {shown.map((c) => (
            <ConnCard key={c.id} c={c} canEdit={canEdit} checking={checking.has(c.id)} menuOpen={menu === c.id}
              onCheck={() => void check(c)} onOpen={() => setOpen(c.id)} onMenu={() => setMenu(menu === c.id ? null : c.id)}
              onRename={() => { setMenu(null); setModal({ rename: c }); }} onDelete={() => { setMenu(null); setModal({ del: c }); }} />
          ))}
        </div>
      )}

      {modal === 'new' && (
        <NewConnectionModal signup={data.signup} webhook={data.webhook} onClose={() => setModal(null)} onDone={(c, msg) => {
          setModal(null); merge(c); toast(msg ?? 'Conexão adicionada');
          if (c.lastError || c.warnings.length) setOpen(c.id);
        }} />
      )}
      {modal && typeof modal === 'object' && 'gate' in modal && <PlanGateModal gate={modal.gate} plan={plan} onClose={() => setModal(null)} />}
      {modal && typeof modal === 'object' && 'rename' in modal && <RenameModal c={modal.rename} onClose={() => setModal(null)} onDone={(c) => { merge(c); setModal(null); }} />}
      {modal && typeof modal === 'object' && 'del' in modal && <DeleteConnectionModal c={modal.del} onClose={() => setModal(null)} onDeleted={() => { drop(modal.del.id); setModal(null); }} />}
      {open && (
        <ConnectionDrawer id={open} live={list.find((x) => x.id === open)} canEdit={canEdit} webhook={data.webhook} signup={data.signup} onClose={() => setOpen(null)} onChanged={merge}
          onDeleted={() => { drop(open); setOpen(null); }} />
      )}
    </div>
  );
}
