import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, Switch, toast } from '../components/ui';
import { EmptyBox, Head, LoadError, errMsg, relTime, useLoad } from './common';

interface Device { id: string; endpoint: string; device: string | null; prefs: { sales: boolean }; createdAt: string; lastSentAt: string | null }
interface Resp { configured: boolean; publicKey: string | null; devices: Device[] }

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function deviceName() {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (isIOS && /Macintosh/.test(ua))) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Celular Android' : 'Tablet Android';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` no ${os}` : ''}`;
}
function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Configurações → Notificações no celular: ativar neste aparelho, testar e escolher os avisos. */
export function NotificationsPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/push'), [accountId]);
  const [mine, setMine] = useState<string | null>(null); // endpoint deste aparelho
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => (supported() ? Notification.permission : 'unsupported'));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!supported()) return;
    navigator.serviceWorker.getRegistration('/').then((r) => r?.pushManager.getSubscription()).then((s) => setMine(s?.endpoint ?? null)).catch(() => {});
  }, [data]);

  if (error && !data) return <><Head slug="notificacoes" /><LoadError error={error} onRetry={reload} /></>;
  if (!data) return <><Head slug="notificacoes" /><Spinner /></>;
  const here = data.devices.find((d) => d.endpoint === mine);
  const needsInstall = isIOS && !standalone();

  async function enable() {
    setBusy('enable');
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') { toast(p === 'denied' ? 'As notificações estão bloqueadas neste aparelho. Libere nos ajustes do navegador/celular.' : 'Permissão não concedida'); return; }
      const reg = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'));
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data!.publicKey!) });
      const r = await api.post<{ id: string }>('/push/subscribe', { subscription: sub.toJSON(), device: deviceName(), sales: true });
      setMine(sub.endpoint);
      await reload();
      await api.post(`/push/${r.id}/test`, {}).catch(() => {});
      toast('Pronto: as vendas aprovadas vão chegar neste aparelho');
    } catch (e) { toast(errMsg(e, 'Não foi possível ativar neste aparelho')); } finally { setBusy(null); }
  }
  async function test(d: Device) {
    setBusy(`t${d.id}`);
    try { await api.post(`/push/${d.id}/test`, {}); toast('Notificação de teste enviada'); } catch (e) { toast(errMsg(e, 'Não foi possível enviar')); } finally { setBusy(null); }
  }
  async function toggle(d: Device) {
    try { await api.patch(`/push/${d.id}`, { sales: !d.prefs.sales }); void reload(); } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
  }
  async function remove(d: Device) {
    setBusy(`r${d.id}`);
    try {
      if (d.endpoint === mine) {
        const s = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription();
        await s?.unsubscribe().catch(() => {});
        setMine(null);
      }
      await api.del(`/push/${d.id}`);
      toast('Aparelho removido');
      void reload();
    } catch (e) { toast(errMsg(e, 'Não foi possível remover')); } finally { setBusy(null); }
  }

  return (
    <div data-testid="push-page">
      <Head slug="notificacoes" />
      {!data.configured && (
        <div className="st-banner amber" data-testid="push-not-configured"><Icon name="alert" size={16} />
          <span>As notificações ainda não foram ligadas neste servidor. Quem administra o Converza precisa definir as variáveis <b>VAPID_PUBLIC_KEY</b> e <b>VAPID_PRIVATE_KEY</b>.</span></div>
      )}

      <section className="st-card">
        <div className="st-card-h">
          <span className={here ? 'st-stat-ic green' : 'st-stat-ic gray'}><Icon name="bell" size={18} /></span>
          <div>
            <b>{here ? 'Ativadas neste aparelho' : 'Este aparelho ainda não recebe'}</b>
            <small>{here ? `${here.device ?? deviceName()}: as vendas aprovadas chegam aqui como notificação, mesmo com o Converza fechado.` : 'Ative para receber “💰 Venda aprovada” na hora, como num aplicativo.'}</small>
          </div>
          <span className="spacer" />
          {!here && data.configured && supported() && !needsInstall && perm !== 'denied' && (
            <button type="button" className="btn primary" onClick={() => void enable()} disabled={busy === 'enable'} data-testid="push-enable"><Icon name="bell" size={15} />{busy === 'enable' ? 'Ativando…' : 'Ativar notificações'}</button>
          )}
          {here && <button type="button" className="btn" onClick={() => void test(here)} disabled={busy === `t${here.id}`} data-testid="push-test"><Icon name="send" size={14} />Enviar teste</button>}
        </div>

        {needsInstall && (
          <div className="push-steps" data-testid="push-ios-steps">
            <b>No iPhone, as notificações só funcionam com o Converza na tela de início</b>
            <ol>
              <li>Abra o Converza no <b>Safari</b> (iOS 16.4 ou mais novo).</li>
              <li>Toque em <b>Compartilhar</b> <Icon name="share" size={13} /> e depois em <b>Adicionar à Tela de Início</b>.</li>
              <li>Abra o Converza pelo ícone novo, entre em <b>Configurações → Notificações</b> e toque em <b>Ativar notificações</b>.</li>
            </ol>
            <small className="faint">Já tinha o ícone de antes? Apague e adicione de novo, para ele abrir como app.</small>
          </div>
        )}
        {!needsInstall && !supported() && <div className="st-banner"><Icon name="info" size={16} /><span>Este navegador não recebe notificações. No computador use Chrome, Edge ou Firefox; no Android, o Chrome.</span></div>}
        {perm === 'denied' && !here && <div className="st-banner amber"><Icon name="alert" size={16} /><span>As notificações do Converza estão bloqueadas neste aparelho. Libere nos ajustes do {isIOS ? 'iPhone (Ajustes → Notificações → Converza)' : 'navegador (cadeado ao lado do endereço → Notificações)'} e volte aqui.</span></div>}
      </section>

      <section className="st-card">
        <div className="st-card-h"><div><b>Seus aparelhos</b><small>Cada aparelho em que você ativou, nesta empresa. Os outros membros da equipe ativam nos aparelhos deles.</small></div></div>
        {data.devices.length === 0 ? <EmptyBox icon="bell" title="Nenhum aparelho ainda" text="Ative neste aparelho e em quantos mais quiser (celular, tablet, computador)." /> : (
          <div className="push-list">
            {data.devices.map((d) => (
              <div key={d.id} className="push-dev" data-testid="push-device">
                <span className="st-stat-ic gray"><Icon name={/iPhone|Android|iPad/.test(d.device ?? '') ? 'phone' : 'globe'} size={16} /></span>
                <div className="push-dev-t">
                  <b>{d.device ?? 'Aparelho'}{d.endpoint === mine && <span className="pill mini teal">este aparelho</span>}</b>
                  <small className="faint">ativado {relTime(d.createdAt)}{d.lastSentAt ? ` · último aviso ${relTime(d.lastSentAt)}` : ''}</small>
                </div>
                <label className="push-pref" data-testid="push-pref-sales"><Switch on={d.prefs.sales} onClick={() => void toggle(d)} /><span>Vendas aprovadas</span></label>
                <button type="button" className="btn sm" onClick={() => void test(d)} disabled={busy === `t${d.id}`}>Testar</button>
                <button type="button" className="btn sm icon" onClick={() => void remove(d)} disabled={busy === `r${d.id}`} title="Parar de receber neste aparelho" data-testid="push-remove"><Icon name="trash" size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
