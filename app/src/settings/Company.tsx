import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Avatar, Field, Modal, Spinner, Switch, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import {
  Badge, ColorPill, EmptyBox, Head, Kebab, LoadError, PRESET_COLORS, SearchBox, Tabs, errMsg, fmtNum, useLoad, useSocketEvent,
} from './common';
import { InviteMemberModal, ROLE_TONE, type TeamResp } from './Team';

interface AccountResp {
  account: {
    id: string; number: number; name: string; description: string; slug: string; timezone: string; notifyInstanceEmail: boolean;
    createdAt: string; subscriptionStatus: string; instances: number; members: number;
  };
  role: string; canEdit: boolean; isOwner: boolean; support: boolean; emailConfigured: boolean;
}

const TIMEZONES: [string, string][] = [
  ['America/Sao_Paulo', 'Brasília (São Paulo, Rio, BH, Sul)'], ['America/Manaus', 'Manaus (AM)'], ['America/Cuiaba', 'Cuiabá (MT)'],
  ['America/Campo_Grande', 'Campo Grande (MS)'], ['America/Porto_Velho', 'Porto Velho (RO)'], ['America/Boa_Vista', 'Boa Vista (RR)'],
  ['America/Rio_Branco', 'Rio Branco (AC)'], ['America/Belem', 'Belém (PA)'], ['America/Fortaleza', 'Fortaleza (CE)'], ['America/Recife', 'Recife (PE)'],
  ['America/Bahia', 'Salvador (BA)'], ['America/Noronha', 'Fernando de Noronha'], ['Europe/Lisbon', 'Lisboa (Portugal)'],
  ['America/Argentina/Buenos_Aires', 'Buenos Aires'], ['America/Santiago', 'Santiago'], ['America/Bogota', 'Bogotá'], ['America/Mexico_City', 'Cidade do México'],
  ['America/New_York', 'Nova York'], ['America/Chicago', 'Chicago'], ['America/Los_Angeles', 'Los Angeles'], ['Europe/London', 'Londres'],
  ['Europe/Madrid', 'Madri'], ['UTC', 'UTC'],
];

const SUB_LABEL: Record<string, [string, string]> = {
  active: ['Ativa', 'green'], past_due: ['Pagamento pendente', 'amber'], canceled: ['Cancelada', 'red'], inactive: ['Sem assinatura', ''],
};

const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* ---------------------------------------------------------- nova conta */

function NewAccountModal({ onClose }: { onClose: () => void }) {
  const { reloadAccounts, switchAccount } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!slugTouched) setSlug(slugify(name)); }, [name, slugTouched]);

  async function create() {
    if (name.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ account: { id: string; name: string } }>('/accounts', { name: name.trim(), description: description.trim(), slug: slug.trim() });
      await reloadAccounts(open ? r.account.id : null);
      if (open) { switchAccount(r.account.id); nav('/billing'); toast(`Você está na ${r.account.name}. Assine para ativar os números.`); }
      else toast(`Empresa ${r.account.name} criada — troque no seletor do menu`);
      onClose();
    } catch (e) { toast(errMsg(e, 'Não foi possível criar a empresa')); }
    setBusy(false);
  }

  return (
    <Modal title="Nova Conta" subtitle="Uma empresa nova, com equipe, números e assinatura próprios" icon="building" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={name.trim().length < 2 || busy} onClick={create} data-testid="new-account-save">{busy ? 'Criando…' : 'Criar conta'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Nome *"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Ex.: Loja Centro" data-testid="new-account-name" /></Field>
        <Field label="Descrição"><textarea className="input" rows={2} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="Para que serve esta conta (opcional)" /></Field>
        <div>
          <Field label="Slug"><input className="input" value={slug} maxLength={60} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }} placeholder="loja-centro" data-testid="new-account-slug" /></Field>
          <div className="st-help">Identificador único da empresa (letras minúsculas, números e hífens). Deixe em branco para gerar automaticamente.</div>
        </div>
        <label className="row" style={{ gap: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} style={{ accentColor: 'var(--primary)' }} data-testid="new-account-open" />
          Conta ativa — entrar nela agora
        </label>
        <div className="hint"><Icon name="info" size={14} />Você vira o proprietário. A conta nova começa sem assinatura: os números de WhatsApp, a IA e os disparos funcionam depois de assinar em Cobranças e assinaturas (cada empresa tem a sua).</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------ dados da empresa */

function CompanyData() {
  const { accountId, reloadAccounts, user } = useAuth();
  const nav = useNavigate();
  const { data, error, reload, setData } = useLoad(() => api.get<AccountResp>('/settings/account'), [accountId]);
  const team = useLoad(() => api.get<TeamResp>('/team'), [accountId]);
  useSocketEvent('team:changed', () => void team.reload());
  const [form, setForm] = useState<AccountResp['account'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  useEffect(() => { if (data) setForm(data.account); }, [data]);

  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data || !form) return <Spinner />;
  const ro = !data.canEdit;
  const dirty = ['name', 'description', 'slug', 'timezone', 'notifyInstanceEmail'].some((k) => (form as Record<string, unknown>)[k] !== (data.account as Record<string, unknown>)[k]);
  const [subLabel, subTone] = SUB_LABEL[data.account.subscriptionStatus] ?? SUB_LABEL.inactive;
  const tzKnown = TIMEZONES.some(([v]) => v === form.timezone);

  async function save() {
    if (!form || busy) return;
    if (form.name.trim().length < 2) { toast('O nome da empresa precisa de pelo menos 2 letras'); return; }
    setBusy(true);
    try {
      await api.patch('/settings/account', { name: form.name.trim(), description: form.description.trim(), slug: form.slug.trim(), timezone: form.timezone, notifyInstanceEmail: form.notifyInstanceEmail });
      setData({ ...data!, account: { ...data!.account, ...form, name: form.name.trim() } });
      toast('Empresa salva');
      void reloadAccounts();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }

  async function leave() {
    try {
      await api.post('/settings/leave');
      toast('Você saiu da empresa');
      setLeaving(false);
      await reloadAccounts();
      nav('/');
    } catch (e) { toast(errMsg(e)); }
  }

  async function destroy() {
    try {
      await api.del('/settings/account', { confirm: confirmName });
      toast('Empresa excluída');
      setDeleting(false);
      await reloadAccounts();
      nav('/');
    } catch (e) { toast(errMsg(e, 'Não foi possível excluir')); }
  }

  const members = team.data?.members ?? [];
  return (
    <div data-testid="company-data">
      <section className="st-card">
        <div className="st-card-h">
          <span className="st-stat-ic"><Icon name="building" size={18} /></span>
          <div><b>Dados da Empresa</b><small>ID {data.account.number} · criada em {new Date(data.account.createdAt).toLocaleDateString('pt-BR')}</small></div>
          <Badge tone={subTone}>{subLabel}</Badge>
          <span className="spacer" />
          {data.isOwner && !data.support && (
            <button type="button" className="btn icon sm ghost" style={{ color: 'var(--danger)' }} title="Excluir empresa" aria-label="Excluir empresa" onClick={() => { setConfirmName(''); setDeleting(true); }} data-testid="delete-company"><Icon name="trash" size={16} /></button>
          )}
        </div>
        <div className="st-form">
          <Field label="Nome *"><input className="input" disabled={ro} value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="company-name" /></Field>
          <div>
            <Field label="Slug"><input className="input" disabled={ro} value={form.slug} maxLength={60} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} data-testid="company-slug" /></Field>
            <div className="st-help">Identificador único da empresa: letras minúsculas, números e hífens.</div>
          </div>
          <div className="full">
            <Field label="Descrição"><textarea className="input" rows={2} disabled={ro} value={form.description} maxLength={300} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="O que a empresa faz (opcional)" data-testid="company-desc" /></Field>
          </div>
          <div>
            <Field label="Fuso horário">
              <select className="select" disabled={ro} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} data-testid="company-tz">
                {!tzKnown && <option value={form.timezone}>{form.timezone}</option>}
                {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <div className="st-help">Vale para os horários de trabalho, os relatórios e as variáveis de data e hora dos fluxos ({'{{hora}}'}, {'{{saudacao}}'}…).</div>
          </div>
          <div className="full">
            <div className="st-toggle-row">
              <Icon name="bell" size={18} />
              <div>
                <b>Notificações por e-mail de instâncias</b>
                <small>Avisa o proprietário e os administradores por e-mail quando um número desconectar ou for restringido pela Meta.{!data.emailConfigured && ' (O envio de e-mails ainda não está configurado neste servidor.)'}</small>
              </div>
              <Switch on={form.notifyInstanceEmail} onClick={() => !ro && setForm({ ...form, notifyInstanceEmail: !form.notifyInstanceEmail })} />
            </div>
          </div>
        </div>
        {!ro && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            {dirty && <button type="button" className="btn ghost" onClick={() => setForm(data.account)}>Descartar</button>}
            <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save} data-testid="company-save"><Icon name="save" size={15} />{busy ? 'Salvando…' : 'Salvar empresa'}</button>
          </div>
        )}
      </section>

      <section className="st-card">
        <div className="st-card-h">
          <span className="st-stat-ic blue"><Icon name="users" size={18} /></span>
          <div><b>Membros da equipe</b><small>{fmtNum(members.length)} {members.length === 1 ? 'pessoa' : 'pessoas'} com acesso a esta empresa</small></div>
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={() => nav('/settings/equipe')}>Ver equipe</button>
          {team.data?.canManage && <button type="button" className="btn sm primary" onClick={() => setInviting(true)} data-testid="company-invite"><Icon name="plus" size={14} />Convidar membro</button>}
        </div>
        <div className="stack" style={{ gap: 2 }}>
          {members.slice(0, 6).map((m) => (
            <div key={m.membershipId} className="st-who" style={{ padding: '7px 2px' }}>
              <Avatar name={m.name} size={30} />
              <div style={{ flex: 1 }}><b>{m.name}{m.userId === user?.id && <span className="pill mini teal">você</span>}</b><small>{m.email}</small></div>
              <Badge tone={ROLE_TONE[m.role]}>{m.roleLabel}</Badge>
            </div>
          ))}
          {members.length > 6 && <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => nav('/settings/equipe')}>+ {members.length - 6} pessoa(s)</button>}
        </div>
      </section>

      {!data.support && (
        <section className="st-card danger">
          <div className="st-row-between">
            <div>
              <b style={{ fontSize: 14 }}>Sair da Empresa</b>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                {data.isOwner ? 'O proprietário não sai da empresa: para encerrar, exclua a empresa (ícone vermelho acima).' : 'Você perde o acesso a esta empresa. As conversas com você voltam para a fila.'}
              </div>
            </div>
            <button type="button" className="btn danger" disabled={data.isOwner} onClick={() => setLeaving(true)} data-testid="leave-company"><Icon name="logout" size={15} />Sair da Empresa</button>
          </div>
        </section>
      )}

      {inviting && team.data && <InviteMemberModal departments={team.data.departments} isOwner={data.isOwner} emailConfigured={team.data.emailConfigured} onClose={() => setInviting(false)} onDone={() => void team.reload()} />}
      {leaving && (
        <ConfirmModal title="Sair da empresa" confirm="Sair" danger onClose={() => setLeaving(false)} onConfirm={leave}>
          Sair da <b>{data.account.name}</b>? Para voltar, alguém da equipe precisa te convidar de novo.
        </ConfirmModal>
      )}
      {deleting && (
        <Modal title="Excluir empresa" icon="alert" onClose={() => setDeleting(false)} footer={<>
          <button type="button" className="btn" onClick={() => setDeleting(false)}>Cancelar</button>
          <button type="button" className="btn danger" disabled={confirmName.trim().toLowerCase() !== data.account.name.trim().toLowerCase()} onClick={destroy} data-testid="delete-company-confirm">Excluir para sempre</button>
        </>}>
          <div className="stack" style={{ gap: 12, fontSize: 13.5, lineHeight: 1.55 }}>
            <div className="st-banner red"><Icon name="alert" size={16} /><span>Isso apaga <b>tudo</b> da empresa: contatos, conversas, fluxos, agentes, conexões, vendas e a equipe. Não dá para desfazer.</span></div>
            <div>Se a assinatura ainda estiver sendo cobrada, cancele antes em Cobranças e assinaturas.</div>
            <Field label={`Digite o nome da empresa para confirmar: ${data.account.name}`}>
              <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={data.account.name} data-testid="delete-company-name" />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* --------------------------------------------------------- departamentos */

interface DeptRow { id: string; name: string; color: string; createdAt: string; members: number; waiting: number }
const COLOR_NAMES: Record<string, string> = {
  '#3b82f6': 'Azul', '#0e9488': 'Verde-azulado', '#22c55e': 'Verde', '#eab308': 'Amarelo', '#f97316': 'Laranja',
  '#ef4444': 'Vermelho', '#ec4899': 'Rosa', '#8b5cf6': 'Roxo', '#64748b': 'Cinza',
};

function DeptModal({ dept, team, onClose, onSaved }: { dept: DeptRow | null; team: TeamResp | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(dept?.name ?? '');
  const [color, setColor] = useState(dept?.color ?? PRESET_COLORS[0]);
  const initial = useMemo(() => new Set((team?.members ?? []).filter((m) => dept && m.departmentId === dept.id).map((m) => m.membershipId)), [team, dept]);
  const [chosen, setChosen] = useState<Set<string>>(initial);
  const [busy, setBusy] = useState(false);
  const deptName = (id: string | null) => team?.departments.find((d) => d.id === id)?.name;

  async function save() {
    if (name.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      const r = dept
        ? await api.patch<{ department: DeptRow }>(`/departments/${dept.id}`, { name: name.trim(), color })
        : await api.post<{ department: DeptRow }>('/departments', { name: name.trim(), color });
      const id = r.department.id;
      for (const m of team?.members ?? []) {
        const want = chosen.has(m.membershipId);
        if (want && m.departmentId !== id) await api.patch(`/team/${m.membershipId}`, { departmentId: id });
        if (!want && m.departmentId === id) await api.patch(`/team/${m.membershipId}`, { departmentId: null });
      }
      toast(dept ? 'Setor atualizado' : `Setor ${name.trim()} criado`);
      onSaved(); onClose();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }

  return (
    <Modal title={dept ? 'Editar Departamento' : 'Novo Departamento'} icon="grid" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={name.trim().length < 2 || busy} onClick={save} data-testid="dept-save">{busy ? 'Salvando…' : 'Salvar'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Nome"><input className="input" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Comercial" data-testid="dept-name" /></Field>
        <Field label="Cor">
          <select className="select" value={color} onChange={(e) => setColor(e.target.value)} data-testid="dept-color">
            {PRESET_COLORS.map((c) => <option key={c} value={c}>{COLOR_NAMES[c] ?? c}</option>)}
          </select>
        </Field>
        <div>
          <label className="label">Visualização</label>
          <div className="st-preview"><ColorPill name={name.trim() || 'Nome do setor'} color={color} /> é assim que o setor aparece nas conversas e na equipe.</div>
        </div>
        {team && team.members.length > 0 && (
          <Field label="Quem faz parte">
            <div className="stack" style={{ gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {team.members.map((m) => {
                const other = m.departmentId && m.departmentId !== dept?.id ? deptName(m.departmentId) : null;
                return (
                  <label key={m.membershipId} className={cx('st-check', chosen.has(m.membershipId) && 'on')} style={{ alignItems: 'center', padding: '7px 10px' }}>
                    <input type="checkbox" checked={chosen.has(m.membershipId)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(m.membershipId); else n.delete(m.membershipId); return n; })} data-testid="dept-member" />
                    <div style={{ flex: 1 }}><b>{m.name}</b><small>{m.roleLabel}{other ? ` · hoje em ${other} (muda para este)` : ''}</small></div>
                  </label>
                );
              })}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function Departments() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ departments: DeptRow[]; canEdit: boolean }>('/departments'), [accountId]);
  const team = useLoad(() => api.get<TeamResp>('/team'), [accountId]);
  useSocketEvent(['departments:changed', 'team:changed', 'conversation:updated'], () => { void reload(); void team.reload(); });
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<DeptRow | null | 'new'>(null);
  const [del, setDel] = useState<DeptRow | null>(null);
  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  const list = data.departments.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div data-testid="departments">
      <div className="st-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Buscar setor" testId="dept-search" />
        <span className="spacer" />
        {data.canEdit && <button type="button" className="btn primary" onClick={() => setEditing('new')} data-testid="new-dept"><Icon name="plus" size={15} />Novo Departamento</button>}
      </div>
      {data.departments.length === 0 ? (
        <div className="st-card"><EmptyBox icon="grid" title="Nenhum departamento ainda" text={<>Crie setores (Comercial, Suporte, Financeiro…) e coloque as pessoas neles. Quando um fluxo, agente ou alguém da equipe mandar uma conversa para um setor, ela fica em <b>Aguardando</b> só para quem é daquele setor — quem pegar primeiro atende.</>}
          action={data.canEdit && <button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />Novo Departamento</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Setor</th><th>Pessoas</th><th>Aguardando atendimento</th><th className="acts" /></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} data-testid="dept-row">
                  <td><ColorPill name={d.name} color={d.color} /></td>
                  <td>{d.members}</td>
                  <td>{d.waiting > 0 ? <Badge tone="amber">{d.waiting} na fila</Badge> : <span className="faint">—</span>}</td>
                  <td className="acts">{data.canEdit && <Kebab items={[
                    { label: 'Editar', icon: 'edit', onClick: () => setEditing(d) },
                    { label: 'Excluir', icon: 'trash', danger: true, onClick: () => setDel(d) },
                  ]} />}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={4}><div className="empty" style={{ padding: 20 }}>Nenhum setor com esse nome.</div></td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint"><Icon name="info" size={14} />Como funciona a fila do setor: a conversa fica em “Aguardando” para as pessoas do setor (e para o proprietário e os administradores, que veem tudo). Quem não é do setor não vê a conversa na fila. Depois que alguém atende, ela segue normal.</div>
      {editing && <DeptModal dept={editing === 'new' ? null : editing} team={team.data} onClose={() => setEditing(null)} onSaved={() => { void reload(); void team.reload(); }} />}
      {del && (
        <ConfirmModal title="Excluir setor" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/departments/${del.id}`); toast('Setor excluído'); setDel(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>
          Excluir o setor <b>{del.name}</b>? {del.members ? `${del.members} pessoa(s) ficam sem setor. ` : ''}{del.waiting ? `${del.waiting} conversa(s) na fila voltam para a fila geral.` : ''}
        </ConfirmModal>
      )}
    </div>
  );
}

/* ------------------------------------------------------ horários de trabalho */

interface Interval { start: string; end: string }
type Schedule = Record<string, Interval[]>;
interface HoursConn { id: string; name: string; displayPhone: string | null; status: string; enabled: boolean; schedule: Schedule; saved: boolean; now: { open: boolean; text: string } }
const DAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

function WorkHours() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<{ timezone: string; connections: HoursConn[]; canEdit: boolean }>('/business-hours'), [accountId]);
  const [connId, setConnId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [sched, setSched] = useState<Schedule>({});
  const [busy, setBusy] = useState(false);
  const conn = data?.connections.find((c) => c.id === connId) ?? data?.connections[0];
  useEffect(() => {
    if (!conn) return;
    setConnId(conn.id); setEnabled(conn.enabled); setSched(JSON.parse(JSON.stringify(conn.schedule)));
  }, [conn?.id, data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return <Spinner />;
  if (!data.connections.length) {
    return <div className="st-card"><EmptyBox icon="plug" title="Nenhum número conectado" text="Os horários de trabalho são por número de WhatsApp. Conecte um número em Conexões para configurar." /></div>;
  }
  const ro = !data.canEdit;
  const setDay = (d: number, list: Interval[]) => setSched((s) => ({ ...s, [d]: list }));

  async function save() {
    if (!conn || busy) return;
    setBusy(true);
    try {
      const r = await api.put<{ now: { open: boolean; text: string } }>(`/business-hours/${conn.id}`, { enabled, schedule: sched });
      toast(`Horários salvos · ${r.now.text}`);
      void reload();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  const copyToWeek = (from: number) => setSched((s) => {
    const n: Schedule = { ...s };
    for (const d of [1, 2, 3, 4, 5]) n[d] = JSON.parse(JSON.stringify(s[from] ?? []));
    return n;
  });

  return (
    <div data-testid="work-hours">
      <section className="st-card">
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Field label="WhatsApp">
              <select className="select" value={conn?.id ?? ''} onChange={(e) => setConnId(e.target.value)} data-testid="hours-conn">
                {data.connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` · ${c.displayPhone}` : ''}</option>)}
              </select>
            </Field>
          </div>
          <div>
            <label className="label">Status</label>
            <div className="row" style={{ height: 38 }}>
              <Switch on={enabled} onClick={() => !ro && setEnabled(!enabled)} />
              <b style={{ fontSize: 13.5 }} data-testid="hours-status">{enabled ? 'Ativo' : 'Desligado'}</b>
            </div>
          </div>
          {!ro && <button type="button" className="btn primary" disabled={busy} onClick={save} data-testid="hours-save"><Icon name="save" size={15} />{busy ? 'Salvando…' : 'Salvar'}</button>}
        </div>
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          {conn?.saved && conn.enabled
            ? <Badge tone={conn.now.open ? 'green' : 'amber'}>{conn.now.text}</Badge>
            : <Badge>Desligado: o número atende a qualquer hora</Badge>}
          <span className="st-mini">Fuso: {data.timezone} (muda em Dados Corporativos)</span>
        </div>
      </section>

      <section className="st-card" style={{ opacity: enabled ? 1 : 0.7 }}>
        <div className="st-card-h"><b>Semana</b><span className="spacer" />{!ro && <button type="button" className="btn sm ghost" onClick={() => copyToWeek(1)} title="Copia o horário de segunda para terça a sexta">Copiar segunda para os dias úteis</button>}</div>
        <div className="st-days">
          {ORDER.map((d) => {
            const list = sched[d] ?? [];
            const on = list.length > 0;
            return (
              <div key={d} className={cx('st-day', !on && 'off')} data-testid="hours-day">
                <div className="st-day-name">
                  <Switch on={on} onClick={() => !ro && setDay(d, on ? [] : [{ start: '09:00', end: '18:00' }])} />
                  {DAYS[d]}
                </div>
                <div className="st-ints">
                  {!on && <span className="faint" style={{ fontSize: 13, lineHeight: '32px' }}>Fechado</span>}
                  {list.map((it, i) => (
                    <div className="st-int" key={i}>
                      <input type="time" value={it.start} disabled={ro} onChange={(e) => setDay(d, list.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} aria-label="Começa" />
                      <span className="faint">até</span>
                      <input type="time" value={it.end === '24:00' ? '23:59' : it.end} disabled={ro} onChange={(e) => setDay(d, list.map((x, j) => (j === i ? { ...x, end: e.target.value === '23:59' ? '24:00' : e.target.value } : x)))} aria-label="Termina" />
                      {!ro && <button type="button" className="btn icon sm ghost" style={{ width: 26, height: 26 }} onClick={() => setDay(d, list.filter((_, j) => j !== i))} aria-label="Remover horário"><Icon name="close" size={12} /></button>}
                    </div>
                  ))}
                  {on && !ro && list.length < 3 && (
                    <button type="button" className="btn sm ghost" onClick={() => {
                      const last = list[list.length - 1]?.end ?? '08:00';
                      const next = last <= '12:00' ? { start: '13:00', end: '18:00' } : { start: last === '24:00' ? '23:00' : last, end: '24:00' };
                      setDay(d, [...list, next]);
                    }}><Icon name="plus" size={13} />Intervalo</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <div className="hint"><Icon name="info" size={14} />Fora do horário, quem responde é o fluxo “Fora do horário” deste número (Configurações › Fluxos Padrões), uma vez a cada 12 horas por contato. A condição “Horário de atendimento” dos fluxos também usa estes horários. Para um horário que vira a noite, use dois dias (ex.: 22:00–23:59 e 00:00–02:00).</div>
    </div>
  );
}

/* ------------------------------------------------------------- página */

export function CompanyPage() {
  const { accounts, accountId } = useAuth();
  const [tab, setTab] = useState<'dados' | 'setores' | 'horarios'>('dados');
  const [creating, setCreating] = useState(false);
  const support = accounts.find((a) => a.id === accountId)?.support;
  return (
    <div data-testid="company-page">
      <Head slug="empresa" actions={!support && <button type="button" className="btn" onClick={() => setCreating(true)} data-testid="new-account"><Icon name="plus" size={15} />Nova Conta</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[['dados', 'Dados Corporativos', 'building'], ['setores', 'Departamentos', 'grid'], ['horarios', 'Horários de Trabalho', 'clock']]} />
      {tab === 'dados' && <CompanyData />}
      {tab === 'setores' && <Departments />}
      {tab === 'horarios' && <WorkHours />}
      {creating && <NewAccountModal onClose={() => setCreating(false)} />}
    </div>
  );
}
