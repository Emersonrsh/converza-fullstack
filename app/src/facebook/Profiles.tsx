import { useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Avatar, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { loadFbSdk, loginForAds } from '../metaSdk';
import { ago } from '../webhooks/util';
import type { AdAccount, MetaProfile, Overview } from './types';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
const dateBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

function daysLeft(iso: string | null) {
  if (!iso) return null;
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000);
}

function StatusPill({ p }: { p: MetaProfile }) {
  const left = daysLeft(p.tokenExpiresAt);
  if (p.status === 'expired' || (left !== null && left < 0)) return <span className="pill red dot" data-testid="fb-profile-status">Login vencido</span>;
  if (p.status === 'error') return <span className="pill amber dot" data-testid="fb-profile-status">Com erro</span>;
  return (
    <>
      <span className="pill green dot" data-testid="fb-profile-status">Conectado</span>
      {left !== null && <span className={cx('pill', left <= 7 && 'amber')} title="O login da Meta vale cerca de 60 dias; reconecte antes de vencer" data-testid="fb-profile-expiry">
        {left <= 0 ? 'Login vence hoje' : `Login vence em ${left} ${left === 1 ? 'dia' : 'dias'}`}</span>}
    </>
  );
}

export function Profiles({ overview, onChanged }: { overview: Overview; onChanged: () => void }) {
  const { login, profiles, canEdit } = overview;
  const [busy, setBusy] = useState<string | null>(null);
  const [remove, setRemove] = useState<MetaProfile | null>(null);

  async function connect(who: string) {
    setBusy(who);
    try {
      await loadFbSdk(login.appId, login.graphVersion);
      const r = await loginForAds(login.configId);
      const res = await api.post<{ profile: MetaProfile; reconnected: boolean }>('/meta/profiles', r);
      toast(res.reconnected ? `Perfil ${res.profile.name} reconectado ✓` : `Perfil ${res.profile.name} conectado — escolha as contas que entram no painel`);
      onChanged();
    } catch (e) { toast(errMsg(e)); }
    setBusy(null);
  }
  async function refresh(p: MetaProfile) {
    setBusy(p.id);
    try { await api.post(`/meta/profiles/${p.id}/refresh`); toast('Contas atualizadas'); onChanged(); }
    catch (e) { toast(errMsg(e)); onChanged(); }
    setBusy(null);
  }
  async function toggle(a: AdAccount) {
    setBusy(a.id);
    try {
      await api.patch(`/meta/ad-accounts/${a.id}`, { selected: !a.selected });
      toast(a.selected ? `${a.name} saiu do painel` : `${a.name} entrou no painel — puxando o gasto dos últimos 90 dias`);
      onChanged();
    } catch (e) { toast(errMsg(e)); }
    setBusy(null);
  }

  return (
    <div className="card fbm-section" data-testid="fb-profiles">
      <div className="fbm-section-h">
        <div>
          <b>Meta (Facebook/Instagram)</b>
          <span>Conecte um ou mais perfis Meta e escolha quais contas de anúncios entram no dashboard.</span>
        </div>
        {canEdit && (
          <button type="button" className="btn primary" disabled={!login.configured || !!busy} onClick={() => void connect('connect')} data-testid="fb-connect">
            <Icon name="login" size={16} />{busy === 'connect' ? 'Abrindo a Meta…' : 'Conectar novo perfil'}
          </button>
        )}
      </div>
      <div className="fbm-info" data-testid="fb-profiles-info">
        Conecte um ou mais perfis Facebook/Instagram (um login por perfil). Cada perfil traz suas próprias contas de anúncios; escolha quais entram no dashboard.
        Para outro login, use “Conectar novo perfil” e entre com o outro usuário quando a Meta pedir autenticação de novo.
      </div>
      {!login.configured && (
        <div className="hint warn" data-testid="fb-not-configured"><Icon name="alert" size={14} />
          O login da Meta ainda não está configurado no servidor: faltam META_APP_ID e META_APP_SECRET (veja o DEPLOY.md).</div>
      )}

      {profiles.length === 0 ? (
        <div className="fbm-empty" data-testid="fb-profiles-empty">
          <Icon name="megaphone" size={34} />
          <b>Nenhum perfil Meta conectado</b>
          <span>Faça login com sua conta Meta para listar suas contas de anúncios.</span>
          {canEdit && <button type="button" className="btn" disabled={!login.configured || !!busy} onClick={() => void connect('connect')} data-testid="fb-connect-empty"><Icon name="login" size={15} />Conectar novo perfil</button>}
        </div>
      ) : (
        <div className="fbm-profile-list">
          {profiles.map((p) => {
            const on = p.adAccounts.filter((a) => a.selected).length;
            return (
              <div key={p.id} className="fbm-profile" data-testid="fb-profile">
                <div className="fbm-profile-h">
                  {p.picture ? <img className="fbm-avatar" src={p.picture} alt="" /> : <Avatar name={p.name} size={40} />}
                  <div className="fbm-profile-n">
                    <b data-testid="fb-profile-name">{p.name}</b>
                    <small>ID {p.fbUserId} · conectado em {dateBR(p.createdAt)}</small>
                  </div>
                  <StatusPill p={p} />
                  <span className="spacer" />
                  {canEdit && <>
                    <button type="button" className="btn sm" disabled={!!busy} onClick={() => void refresh(p)} data-testid="fb-profile-refresh"><Icon name="refresh" size={14} />{busy === p.id ? 'Lendo…' : 'Atualizar contas'}</button>
                    <button type="button" className="btn sm" disabled={!!busy || !login.configured} onClick={() => void connect(`re-${p.id}`)} title="Entrar de novo com este perfil (renova o login)" data-testid="fb-profile-reconnect"><Icon name="login" size={14} />Reconectar</button>
                    <button type="button" className="btn sm icon danger" onClick={() => setRemove(p)} aria-label="Remover perfil" data-testid="fb-profile-remove"><Icon name="trash" size={14} /></button>
                  </>}
                </div>
                {p.lastError && p.status !== 'connected' && <div className="hint warn"><Icon name="alert" size={14} />{p.lastError}</div>}
                {p.status === 'connected' && p.canManageAds === false && (
                  <div className="hint" data-testid="fb-profile-readonly"><Icon name="info" size={14} /><span>Este perfil só autorizou <b>ler</b> os anúncios. Para criar campanhas e pausar ou mudar orçamentos pelo Converza, clique em <b>Reconectar</b> e aceite a permissão de gerenciar anúncios.</span></div>
                )}
                {p.adAccounts.length === 0 ? (
                  <div className="empty" style={{ padding: 18 }}>Este perfil não tem contas de anúncios (ou não deu acesso a elas no login).</div>
                ) : (
                  <table className="fbm-acc">
                    <thead><tr><th style={{ width: 70 }}>No painel</th><th>Conta de anúncios</th><th>Empresa</th><th>Moeda</th><th>Situação</th><th>Gasto no Dashboard</th></tr></thead>
                    <tbody>
                      {p.adAccounts.map((a) => {
                        const blocked = !canEdit || !!a.selectedElsewhere || (!a.available && !a.selected) || busy === a.id;
                        return (
                          <tr key={a.id} className={cx(!a.available && 'off')} data-testid="fb-adaccount">
                            <td>
                              <button type="button" className={cx('switch', a.selected && 'on')} disabled={blocked} aria-pressed={a.selected}
                                aria-label={`${a.name} no painel`} title={a.selectedElsewhere ? `Já está no painel pelo perfil ${a.selectedElsewhere}` : undefined}
                                onClick={() => void toggle(a)} data-testid="fb-adaccount-toggle"><i /></button>
                            </td>
                            <td><b>{a.name}</b><small className="fbm-sub">{a.actId.replace('act_', 'ID ')}
                              {a.selectedElsewhere && <> · <span className="fbm-warn" data-testid="fb-elsewhere">já está no painel pelo perfil {a.selectedElsewhere}</span></>}
                              {!a.available && <> · <span className="fbm-warn">este perfil não enxerga mais a conta</span></>}</small></td>
                            <td>{a.business ?? <span className="faint">—</span>}</td>
                            <td>{a.currency}</td>
                            <td><span className={cx('pill mini', a.status.ok ? 'green' : 'amber')}>{a.status.label}</span></td>
                            <td data-testid="fb-adaccount-sync">{!a.selected ? <span className="faint">—</span>
                              : a.lastError ? <span className="fbm-warn" title={a.lastError}>Falhou: {a.lastError}</span>
                                : a.lastSyncAt ? <span>Atualizado {ago(a.lastSyncAt)}</span> : <span className="faint">Puxando…</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <small className="faint fbm-profile-foot" data-testid="fb-profile-count">{on} de {p.adAccounts.length} {p.adAccounts.length === 1 ? 'conta entra' : 'contas entram'} no painel</small>
              </div>
            );
          })}
        </div>
      )}

      {remove && (
        <ConfirmModal title="Remover perfil" confirm="Remover" danger onClose={() => setRemove(null)} onConfirm={async () => {
          try {
            const r = await api.del<{ removedFromDashboard: number }>(`/meta/profiles/${remove.id}`);
            toast(r.removedFromDashboard ? `Perfil removido e ${r.removedFromDashboard} ${r.removedFromDashboard === 1 ? 'conta saiu' : 'contas saíram'} do painel` : 'Perfil removido');
            setRemove(null); onChanged();
          } catch (e) { toast(errMsg(e)); }
        }}>
          Remover <b>{remove.name}</b>? As contas de anúncios dele saem do Gerenciador e o gasto delas sai do Dashboard. Você pode conectar de novo quando quiser.
        </ConfirmModal>
      )}
    </div>
  );
}
