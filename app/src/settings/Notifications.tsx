import { useEffect, useRef, useState } from 'react';
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

      <SaleTemplateCard hasDevice={data.devices.length > 0} />

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

/* ------------------------------------------------------------- mensagem da venda */

interface Tpl { title: string; body: string }
interface TplResp { template: Tpl | null; default: Tpl; vars: [string, string][]; sample: Record<string, string> }

/** Mesma regra do servidor: troca {variavel} e limpa separadores de variáveis vazias. */
export function renderTpl(tpl: string, vars: Record<string, string>, max: number) {
  let out = tpl.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (k.toLowerCase() in vars ? vars[k.toLowerCase()] : m));
  out = out.split('\n').map((line) => line
    .replace(/(\s*[·|•\-–]\s*){2,}/g, ' · ')
    .replace(/^\s*[·|•\-–]\s*/, '').replace(/\s*[·|•\-–]\s*$/, '')
    .replace(/\s{2,}/g, ' ').trim()).filter((l) => l).join('\n');
  return out.slice(0, max);
}

const PRESETS: [string, Tpl][] = [
  ['Padrão', { title: '💰 Venda aprovada · {valor}', body: '{produto} · {cliente}' }],
  ['Com o dia', { title: '🔥 +{valor} no caixa!', body: '{produto} · {cliente}\nHoje: {vendas_hoje} vendas · {faturamento_hoje}' }],
  ['Discreta', { title: 'Nova venda', body: '{valor} · {produto}' }],
  ['De onde veio', { title: '💸 Venda aprovada ({origem})', body: '{valor} · {produto} · {cliente}' }],
];

function SaleTemplateCard({ hasDevice }: { hasDevice: boolean }) {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<TplResp>('/push/template'), [accountId]);
  const [t, setT] = useState<Tpl | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const last = useRef<'title' | 'body'>('body');
  const refs = { title: useRef<HTMLInputElement>(null), body: useRef<HTMLTextAreaElement>(null) };
  useEffect(() => { if (data) setT(data.template ?? data.default); }, [data]);
  if (error && !data) return <section className="st-card"><LoadError error={error} onRetry={reload} /></section>;
  if (!data || !t) return <section className="st-card"><Spinner /></section>;

  const saved = data.template ?? data.default;
  const dirty = t.title !== saved.title || t.body !== saved.body;
  const pvTitle = renderTpl(t.title || data.default.title, data.sample, 120) || 'Venda aprovada';
  const pvBody = renderTpl(t.body, data.sample, 300);

  function insert(v: string) {
    const f = last.current; const el = refs[f].current;
    const cur = t![f]; const tok = `{${v}}`;
    const a = el?.selectionStart ?? cur.length; const b = el?.selectionEnd ?? cur.length;
    const next = cur.slice(0, a) + tok + cur.slice(b);
    setT({ ...t!, [f]: next });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + tok.length, a + tok.length); });
  }
  async function save(v: Tpl | null) {
    setBusy('save');
    try { await api.put('/push/template', { template: v }); await reload(); toast(v ? 'Mensagem salva' : 'Mensagem padrão restaurada'); } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); } finally { setBusy(null); }
  }
  async function test() {
    setBusy('test');
    try {
      if (dirty) await api.put('/push/template', { template: t });
      await api.post('/push/template/test', {}); await reload();
      toast('Enviada para os seus aparelhos, com dados de exemplo');
    } catch (e) { toast(errMsg(e, 'Não foi possível enviar')); } finally { setBusy(null); }
  }

  return (
    <section className="st-card" data-testid="push-template">
      <div className="st-card-h"><div><b>Mensagem da venda aprovada</b><small>Como o aviso aparece nos seus aparelhos. Só você vê esta versão; cada pessoa da equipe escolhe a dela.</small></div></div>
      <div className="pt-grid">
        <div className="pt-form">
          <div className="pt-presets">{PRESETS.map(([n, p]) => <button type="button" key={n} className="btn sm ghost" onClick={() => setT(p)} data-testid={`pt-preset-${n}`}>{n}</button>)}</div>
          <label className="pt-f"><span>Título</span>
            <input ref={refs.title} className="input" value={t.title} maxLength={120} onFocus={() => { last.current = 'title'; }} onChange={(e) => setT({ ...t, title: e.target.value })} data-testid="pt-title" /></label>
          <label className="pt-f"><span>Texto</span>
            <textarea ref={refs.body} className="input" rows={3} value={t.body} maxLength={300} onFocus={() => { last.current = 'body'; }} onChange={(e) => setT({ ...t, body: e.target.value })} data-testid="pt-body" /></label>
          <div className="pt-vars"><small className="faint">Toque para inserir no {last.current === 'title' ? 'título' : 'texto'}:</small>
            {data.vars.map(([k, l]) => <button type="button" key={k} className="pt-var" title={l} onClick={() => insert(k)} data-testid={`pt-var-${k}`}>{`{${k}}`}</button>)}
          </div>
          <small className="faint">Variável sem valor numa venda (por exemplo, sem nome do cliente) some da mensagem, junto com o “·” ao lado.</small>
        </div>
        <div className="pt-preview" data-testid="pt-preview">
          <small className="faint">Prévia (dados de exemplo)</small>
          <div className="pt-phone">
            <div className="pt-notif">
              <img src="/icon-192.png" alt="" />
              <div><div className="pt-n-h"><b>CONVERZA</b><span>agora</span></div><b className="pt-n-t" data-testid="pt-pv-title">{pvTitle}</b>{pvBody && <span className="pt-n-b" data-testid="pt-pv-body">{pvBody}</span>}</div>
            </div>
          </div>
        </div>
      </div>
      <div className="pt-actions">
        <button type="button" className="btn ghost" onClick={() => void save(null)} disabled={!!busy || !data.template} data-testid="pt-reset">Restaurar padrão</button>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => void test()} disabled={!!busy || !hasDevice} title={hasDevice ? undefined : 'Ative em um aparelho primeiro'} data-testid="pt-test"><Icon name="send" size={14} />{busy === 'test' ? 'Enviando…' : 'Testar no meu aparelho'}</button>
        <button type="button" className="btn primary" onClick={() => void save(t)} disabled={!!busy || !dirty} data-testid="pt-save">{busy === 'save' ? 'Salvando…' : 'Salvar mensagem'}</button>
      </div>
    </section>
  );
}
