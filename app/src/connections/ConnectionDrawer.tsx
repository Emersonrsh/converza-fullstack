import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, cx, toast, useBackdrop } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { WebhookHelp, connectViaMeta } from './NewConnectionModal';
import { QUALITY_TONE, SOURCE_LABEL, STATUS_LABEL, STATUS_TONE, VERTICAL_LABEL, type BusinessProfile, type ConnDetailResp, type ConnectionFull, type SignupConfig, type WebhookInfo } from './types';

const ago = (iso: string | null) => {
  if (!iso) return 'nunca';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

function Row({ k, children, testId }: { k: string; children: ReactNode; testId?: string }) {
  return <div className="cn-row" data-testid={testId}><span>{k}</span><div>{children}</div></div>;
}

function Sec({ title, icon, children, right }: { title: string; icon: string; children: ReactNode; right?: ReactNode }) {
  return <section className="cn-sec"><header><Icon name={icon} size={15} /><b>{title}</b><span className="spacer" />{right}</header>{children}</section>;
}

/** Confirma a exclusão e avisa quais agentes (que atendem só este número) serão pausados. */
export function DeleteConnectionModal({ c, agents, onClose, onDeleted }: {
  c: ConnectionFull; agents?: ConnDetailResp['agents']; onClose: () => void; onDeleted: () => void;
}) {
  const [list, setList] = useState(agents ?? null);
  useEffect(() => {
    if (agents) return;
    api.get<ConnDetailResp>(`/connections/${c.id}`).then((r) => setList(r.agents)).catch(() => setList([]));
  }, [c.id, agents]);
  const exclusive = (list ?? []).filter((a) => a.exclusive && a.enabled);
  return (
    <ConfirmModal title="Excluir conexão" confirm="Excluir conexão" danger onClose={onClose} onConfirm={async () => {
      try {
        const r = await api.del<{ pausedAgents?: { id: string; name: string }[] }>(`/connections/${c.id}`);
        const p = r?.pausedAgents ?? [];
        toast(p.length ? `Conexão “${c.name}” excluída · pausado${p.length > 1 ? 's' : ''}: ${p.map((a) => a.name).join(', ')}` : `Conexão “${c.name}” excluída`);
        onDeleted();
      } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    }}>
      Excluir <b>{c.name}</b>? O número para de receber e enviar pelo Converza. As conversas e o histórico continuam no Chats ao vivo.{c.coexistence ? ' O app do celular continua funcionando normalmente.' : ''}
      {exclusive.length > 0 && <p style={{ margin: '10px 0 0' }} data-testid="delete-agents-note">{exclusive.length === 1 ? 'O agente' : 'Os agentes'} <b>{exclusive.map((a) => a.name).join(', ')}</b> {exclusive.length === 1 ? 'atende' : 'atendem'} só este número e {exclusive.length === 1 ? 'será pausado' : 'serão pausados'}.</p>}
    </ConfirmModal>
  );
}

export function ConnectionDrawer({ id, live, canEdit, webhook, signup, onClose, onChanged, onDeleted }: {
  id: string; live?: ConnectionFull; canEdit: boolean; webhook: WebhookInfo | null; signup: SignupConfig;
  onClose: () => void; onChanged: (c: ConnectionFull) => void; onDeleted: () => void;
}) {
  const [d, setD] = useState<ConnDetailResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [token, setToken] = useState({ accessToken: '', wabaId: '', appSecret: '' });
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [verticals, setVerticals] = useState<string[]>([]);
  const [confirmDel, setConfirmDel] = useState(false);
  const bg = useBackdrop(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const load = () => api.get<ConnDetailResp>(`/connections/${id}`).then((r) => { setD(r); setName(r.connection.name); setToken((t) => ({ ...t, wabaId: r.connection.wabaId ?? '' })); })
    .catch((e) => setErr(e instanceof Error ? e.message : 'Erro'));
  // tempo real (verificação, histórico do celular, desconexão): a versão da lista entra no detalhe
  useEffect(() => {
    if (live) setD((cur) => (cur && cur.connection.id === live.id ? { ...cur, connection: { ...cur.connection, ...live, pin: cur.connection.pin } } : cur));
  }, [live]);
  const loadProfile = () => api.get<{ profile: BusinessProfile | null; verticals: string[]; error: string | null }>(`/connections/${id}/profile`)
    .then((r) => { setVerticals(r.verticals); setProfile(r.profile); setProfileErr(r.profile ? null : r.error ?? 'Não foi possível ler o perfil'); })
    .catch((e) => setProfileErr(e instanceof Error ? e.message : 'Não foi possível ler o perfil'));
  useEffect(() => {
    void load();
    void loadProfile();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(key: string, fn: () => Promise<{ connection: ConnectionFull }>, ok: string) {
    setBusy(key);
    try {
      const r = await fn();
      setD((cur) => (cur ? { ...cur, connection: { ...cur.connection, ...r.connection } } : cur));
      onChanged(r.connection);
      toast(ok);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(null);
  }

  const c = d?.connection;
  const canReconnect = canEdit && signup.configured && !!c && c.source !== 'manual';
  /** Entrar de novo pela Meta (token caiu, desconectado pelo app…): atualiza esta mesma conexão. */
  async function reconnect() {
    if (!c) return;
    setBusy('reconnect');
    try {
      const r = await connectViaMeta(signup, c.coexistence);
      onChanged(r.connection);
      if (r.connection.id === id) setD((cur) => (cur ? { ...cur, connection: { ...cur.connection, ...r.connection } } : cur));
      toast(r.registerError ? `Conectado, mas o registro do número falhou: ${r.registerError}` : r.connection.id === id ? 'Conectado de novo ✓' : 'Esse login trouxe outro número: ele virou uma conexão nova');
    } catch (e) { toast(e instanceof Error ? e.message : 'Falha ao conectar'); }
    setBusy(null);
  }
  const syncOpen = !!c && Date.now() - new Date(c.onboardedAt).getTime() <= 24 * 3600_000;
  return (
    <div className="cd-bg" {...bg}>
      <aside className="cd fade cn-drawer" role="dialog" aria-label="Detalhes da conexão" data-testid="connection-drawer">
        {err ? <div className="cv-empty" style={{ flex: 1 }}><b>Não foi possível abrir</b><span>{err}</span></div> : !c ? <Spinner /> : (
          <>
            <header className="cd-hd">
              <span className={cx('cn-ic', c.status)}><Icon name="phone" size={18} /></span>
              <div className="cd-who"><b>{c.name}</b><span>{c.displayPhone ?? c.phoneNumberId}{c.verifiedName ? ` · ${c.verifiedName}` : ''}</span></div>
              <span className="spacer" />
              <span className={cx('pill dot', STATUS_TONE[c.status])} data-testid="drawer-status">{STATUS_LABEL[c.status]}</span>
              <button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
            </header>
            <div className="cd-body">
              {c.lastError && (
                <div className="hint bad" data-testid="drawer-error">
                  <Icon name="alert" size={14} />
                  <span style={{ flex: 1 }}>{c.lastError}</span>
                  {canReconnect && c.status === 'disconnected' && <button type="button" className="btn sm primary" disabled={busy === 'reconnect'} onClick={() => void reconnect()} data-testid="drawer-reconnect">{busy === 'reconnect' ? 'Conectando…' : 'Conectar de novo'}</button>}
                </div>
              )}
              {c.warnings.map((w) => <div key={w} className="hint warn"><Icon name="info" size={14} />{w}</div>)}

              <Sec title="Saúde do número" icon="checkCircle" right={<button type="button" className="btn sm" disabled={busy === 'check'} onClick={() => void act('check', () => api.post(`/connections/${id}/check`), 'Conexão verificada')} data-testid="drawer-check"><Icon name="refresh" size={13} />{busy === 'check' ? 'Verificando…' : 'Verificar agora'}</button>}>
                <Row k="Qualidade" testId="drawer-quality">{c.labels.quality ? <span className={cx('pill dot', QUALITY_TONE[c.qualityRating ?? ''] ?? '')}>{c.labels.quality}</span> : '—'}</Row>
                <Row k="Limite para iniciar conversas">{c.labels.limit ?? '—'}</Row>
                <Row k="Nome de exibição">{c.verifiedName ?? '—'}{c.labels.name ? <small className="faint"> · {c.labels.name}</small> : null}</Row>
                <Row k="Recebendo mensagens" testId="drawer-webhook">
                  {c.webhookSubscribed === true ? <span className="pill green dot">Sim</span> : c.webhookSubscribed === false ? <span className="pill red dot">Não inscrito</span> : <span className="faint">não verificado</span>}
                  {canEdit && c.wabaId && c.webhookSubscribed !== true && <button type="button" className="linkbtn" disabled={busy === 'sub'} onClick={() => void act('sub', () => api.post(`/connections/${id}/subscribe`), 'Inscrito para receber as mensagens')} data-testid="drawer-subscribe">Receber mensagens</button>}
                </Row>
                <Row k="Última mensagem recebida">{ago(c.lastInboundAt)}</Row>
                <Row k="Última verificação">{ago(c.lastCheckedAt)}</Row>
                <Row k="Como foi conectada">{SOURCE_LABEL[c.source] ?? c.source}{c.coexistence && c.source !== 'coexistence' ? ' · usa o app do celular' : ''}</Row>
                <Row k="IDs"><small className="faint">número {c.phoneNumberId ?? '—'} · WABA {c.wabaId ?? '—'}</small></Row>
              </Sec>

              {c.coexistence && (
                <Sec title="WhatsApp Business do celular" icon="phone">
                  <Row k="Contatos e histórico" testId="drawer-sync">
                    {c.syncRequestedAt ? <>pedido {ago(c.syncRequestedAt)}{c.historyProgress !== null ? ` · histórico ${c.historyProgress}%` : ''}</> : syncOpen ? 'ainda não pedido' : 'prazo de 24h encerrado'}
                    {canEdit && !c.syncRequestedAt && syncOpen && <button type="button" className="linkbtn" disabled={busy === 'sync'} onClick={() => void act('sync', () => api.post(`/connections/${id}/sync`), 'Sincronização pedida')}>Sincronizar agora</button>}
                  </Row>
                  <small className="faint">O que for respondido pelo celular aparece nas conversas com a marca 📱 e pausa a automação daquela conversa.</small>
                </Sec>
              )}

              {canEdit && !c.coexistence && (
                <Sec title="Registro do número" icon="lock">
                  <Row k="PIN de duas etapas">{c.pin ? <><code>{showPin ? c.pin : '••••••'}</code><button type="button" className="linkbtn" onClick={() => setShowPin((x) => !x)}>{showPin ? 'esconder' : 'mostrar'}</button></> : <span className="faint">não definido pelo Converza</span>}</Row>
                  <div className="cn-inline">
                    <input className="input" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="PIN de 6 números" data-testid="drawer-pin" />
                    <button type="button" className="btn sm" disabled={pin.length !== 6 || busy === 'reg'} onClick={() => void act('reg', async () => {
                      const r = await api.post<{ connection: ConnectionFull }>(`/connections/${id}/register`, { pin });
                      setPin('');
                      return { connection: { ...r.connection, pin } };
                    }, 'Número registrado na Cloud API')} data-testid="drawer-register">Registrar número</button>
                  </div>
                  <small className="faint">Use se a Meta pedir o registro de novo. Se o número já tinha verificação em duas etapas, digite o PIN que você definiu.</small>
                </Sec>
              )}

              <Sec title="Perfil do WhatsApp" icon="user">
                {profileErr ? <small className="faint" data-testid="profile-error">{profileErr}</small> : !profile ? <Spinner /> : (
                  <fieldset className="cn-profile" disabled={!canEdit}>
                    {profile.profile_picture_url && <img src={profile.profile_picture_url} alt="" className="cn-photo" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
                    <label className="label">Recado <span className="lbl-hint">· até 139 letras</span></label>
                    <input className="input" maxLength={139} value={profile.about ?? ''} onChange={(e) => setProfile({ ...profile, about: e.target.value })} data-testid="profile-about" />
                    <label className="label">Descrição</label>
                    <textarea className="input" rows={3} maxLength={512} value={profile.description ?? ''} onChange={(e) => setProfile({ ...profile, description: e.target.value })} data-testid="profile-description" />
                    <div className="cn-two">
                      <div><label className="label">E-mail</label><input className="input" value={profile.email ?? ''} onChange={(e) => setProfile({ ...profile, email: e.target.value })} data-testid="profile-email" /></div>
                      <div><label className="label">Categoria</label>
                        <select className="select" value={profile.vertical ?? 'UNDEFINED'} onChange={(e) => setProfile({ ...profile, vertical: e.target.value })} data-testid="profile-vertical">
                          {verticals.map((v) => <option key={v} value={v}>{VERTICAL_LABEL[v] ?? v}</option>)}
                        </select>
                      </div>
                    </div>
                    <label className="label">Endereço</label>
                    <input className="input" maxLength={256} value={profile.address ?? ''} onChange={(e) => setProfile({ ...profile, address: e.target.value })} data-testid="profile-address" />
                    <label className="label">Sites <span className="lbl-hint">· até 2</span></label>
                    {[0, 1].map((i) => (
                      <input key={i} className="input" style={{ marginBottom: 6 }} value={profile.websites?.[i] ?? ''} placeholder="https://"
                        onChange={(e) => { const w = [...(profile.websites ?? [])]; w[i] = e.target.value; setProfile({ ...profile, websites: w }); }} data-testid={`profile-site-${i}`} />
                    ))}
                    {canEdit && <button type="button" className="btn sm primary" disabled={busy === 'profile'} data-testid="profile-save" onClick={async () => {
                      setBusy('profile');
                      try {
                        const r = await api.put<{ profile: BusinessProfile }>(`/connections/${id}/profile`, {
                          about: profile.about ?? '', description: profile.description ?? '', address: profile.address ?? '', email: profile.email ?? '',
                          websites: (profile.websites ?? []).map((w) => w.trim()).filter(Boolean), vertical: profile.vertical ?? 'UNDEFINED',
                        });
                        setProfile(r.profile); toast('Perfil do WhatsApp atualizado');
                      } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
                      setBusy(null);
                    }}>{busy === 'profile' ? 'Salvando…' : 'Salvar perfil'}</button>}
                    <small className="faint">É o que os clientes veem ao tocar no nome da empresa no WhatsApp. A foto se troca pelo Gerenciador do WhatsApp.</small>
                  </fieldset>
                )}
              </Sec>

              <Sec title="Uso nos últimos 30 dias" icon="trend">
                <Row k="Conversas neste número">{d.stats.conversations.toLocaleString('pt-BR')}</Row>
                <Row k="Mensagens recebidas / enviadas">{d.stats.inbound30.toLocaleString('pt-BR')} / {d.stats.outbound30.toLocaleString('pt-BR')}</Row>
                <Row k="Agentes de IA que atendem aqui">{d.agents.length ? d.agents.map((a) => <Link key={a.id} to={`/agents/${a.id}`} className="pill" style={{ marginRight: 4 }}>{a.name}{a.enabled ? '' : ' (pausado)'}</Link>) : <span className="faint">nenhum</span>}</Row>
              </Sec>

              {canEdit && (
                <Sec title="Nome e acesso" icon="gear">
                  <label className="label">Nome da conexão</label>
                  <div className="cn-inline">
                    <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} data-testid="drawer-name" />
                    <button type="button" className="btn sm" disabled={!name.trim() || name === c.name || busy === 'name'} onClick={() => void act('name', () => api.patch(`/connections/${id}`, { name }), 'Nome salvo')} data-testid="drawer-rename">Salvar</button>
                  </div>
                  {c.source === 'manual' ? (
                    <>
                      <label className="label" style={{ marginTop: 10 }}>Trocar token de acesso</label>
                      <div className="cn-inline">
                        <input className="input" type="password" value={token.accessToken} onChange={(e) => setToken({ ...token, accessToken: e.target.value.trim() })} placeholder="Novo token (EAAG…)" data-testid="drawer-token" autoComplete="off" />
                        <button type="button" className="btn sm" disabled={token.accessToken.length < 20 || busy === 'token'} onClick={() => void act('token', async () => {
                          const r = await api.patch<{ connection: ConnectionFull }>(`/connections/${id}`, { accessToken: token.accessToken });
                          setToken((t) => ({ ...t, accessToken: '' }));
                          void loadProfile();
                          return r;
                        }, 'Token atualizado e conferido')} data-testid="drawer-token-save">Trocar</button>
                      </div>
                      <div className="cn-two" style={{ marginTop: 10 }}>
                        <div><label className="label">WABA ID</label><input className="input" value={token.wabaId} onChange={(e) => setToken({ ...token, wabaId: e.target.value.replace(/\D/g, '') })} data-testid="drawer-waba" /></div>
                        <div><label className="label">Chave secreta do app {c.hasAppSecret ? <span className="lbl-hint">· cadastrada</span> : null}</label><input className="input" type="password" value={token.appSecret} onChange={(e) => setToken({ ...token, appSecret: e.target.value.trim() })} placeholder={c.hasAppSecret ? '••••••••' : 'opcional'} autoComplete="off" /></div>
                      </div>
                      <button type="button" className="btn sm" style={{ marginTop: 8 }} disabled={busy === 'ids' || (token.wabaId === (c.wabaId ?? '') && !token.appSecret)}
                        onClick={() => void act('ids', () => api.patch(`/connections/${id}`, { wabaId: token.wabaId, ...(token.appSecret ? { appSecret: token.appSecret } : {}) }), 'Dados salvos')}>Salvar WABA e chave</button>
                      {webhook && <WebhookHelp webhook={webhook} coexistence={c.coexistence} />}
                    </>
                  ) : (
                    <div className="cn-inline" style={{ marginTop: 10 }}>
                      <small className="faint" style={{ flex: 1, margin: 0 }}>Se o acesso cair, entre de novo com a mesma conta da Meta: o Converza atualiza esta conexão (não ocupa outra instância).</small>
                      {signup.configured && <button type="button" className="btn sm" disabled={busy === 'reconnect'} onClick={() => void reconnect()} data-testid="drawer-reconnect-2">{busy === 'reconnect' ? 'Conectando…' : 'Conectar de novo'}</button>}
                    </div>
                  )}
                </Sec>
              )}
            </div>
            {canEdit && (
              <footer className="cd-ft">
                <button type="button" className="btn danger" onClick={() => setConfirmDel(true)} data-testid="drawer-delete"><Icon name="trash" size={14} />Excluir conexão</button>
                <span className="spacer" />
                <button type="button" className="btn" onClick={onClose}>Fechar</button>
              </footer>
            )}
          </>
        )}
        {confirmDel && c && <DeleteConnectionModal c={c} agents={d?.agents} onClose={() => setConfirmDel(false)} onDeleted={onDeleted} />}
      </aside>
    </div>
  );
}
