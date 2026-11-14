import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, cx, toast } from '../components/ui';

interface Device {
  id: string; device: string | null; service: string; prefs: { sales: boolean }; createdAt: string; lastSentAt: string | null;
  userId: string; userName: string; userEmail: string; accountId: string; accountName: string; customTemplate: boolean;
}
interface Resp { configured: boolean; publicKey: string | null; subject: string | null; totals: { total: number; users: number; accounts: number; sent24: number }; devices: Device[] }
interface Result { devices: number; sent: number; failed: { id: string; error: string }[]; removed: number }
type Target = { target: 'device' | 'user' | 'account'; id: string; label: string };

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora'; if (s < 3600) return `há ${Math.floor(s / 60)} min`; if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('pt-BR');
};

/** Painel da plataforma → Notificações: estado do Web Push, aparelhos inscritos e envios de teste. */
export function PlatformPush() {
  const [data, setData] = useState<Resp | null>(null);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [title, setTitle] = useState('🔔 Teste do Converza');
  const [body, setBody] = useState('Se você está vendo isto, as notificações estão funcionando.');
  const [sale, setSale] = useState({ amount: '47', product: 'Ebook Novena', customer: 'Maria Lúcia' });
  const [saleAcc, setSaleAcc] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ what: string; r: Result } | null>(null);

  const load = useCallback(() => api.get<Resp>(`/platform/push?q=${encodeURIComponent(q.trim())}`).then(setData).catch((e) => toast((e as Error).message)), [q]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  const accounts = data ? [...new Map(data.devices.map((d) => [d.accountId, d.accountName])).entries()] : [];
  useEffect(() => { if (!saleAcc && accounts.length) setSaleAcc(accounts[0][0]); }, [accounts, saleAcc]);

  async function send() {
    if (!target) return;
    setBusy('send');
    try {
      const r = await api.post<Result>('/platform/push/test', { target: target.target, id: target.id, title, body });
      setResult({ what: `Teste para ${target.label}`, r }); void load();
    } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  }
  async function simulate() {
    setBusy('sale');
    try {
      const r = await api.post<Result>('/platform/push/simulate-sale', { accountId: saleAcc, amount: Number(sale.amount.replace(',', '.')) || 0, product: sale.product, customer: sale.customer });
      setResult({ what: `Venda simulada em ${accounts.find((a) => a[0] === saleAcc)?.[1] ?? 'empresa'}`, r }); void load();
    } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  }

  if (!data) return <div className="card pad"><Spinner /></div>;
  const t = data.totals;
  return (
    <div className="pfp" data-testid="pf-push">
      <div className="card pad pfp-status">
        <span className={cx('pfp-dot', data.configured ? 'on' : 'off')} />
        <div>
          <b data-testid="pf-push-status">{data.configured ? 'Notificações ligadas no servidor' : 'Notificações desligadas no servidor'}</b>
          <small>{data.configured ? `Chave pública ${data.publicKey}${data.subject ? ` · remetente ${data.subject}` : ''}` : 'Defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY nas variáveis da API (veja o DEPLOY.md).'}</small>
        </div>
        <span className="spacer" />
        <div className="pfp-nums">
          <span><b>{t.total}</b>aparelhos</span><span><b>{t.users}</b>pessoas</span><span><b>{t.accounts}</b>empresas</span><span><b>{t.sent24}</b>receberam em 24h</span>
        </div>
      </div>

      <div className="pfp-grid">
        <div className="card pad">
          <div className="pf-card-h"><b>Enviar notificação de teste</b><small>escolha o destino na lista abaixo: um aparelho, a pessoa ou a empresa inteira</small></div>
          <div className="pfp-target" data-testid="pf-push-target">{target ? <><Icon name="bell" size={14} /><span>{target.label}</span><button type="button" className="btn sm ghost" onClick={() => setTarget(null)}>trocar</button></> : <span className="faint">Nenhum destino escolhido</span>}</div>
          <label className="pfp-f"><span>Título</span><input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} data-testid="pf-push-title" /></label>
          <label className="pfp-f"><span>Texto</span><textarea className="input" rows={2} value={body} maxLength={300} onChange={(e) => setBody(e.target.value)} data-testid="pf-push-body" /></label>
          <button type="button" className="btn primary" disabled={!target || !title.trim() || !!busy || !data.configured} onClick={() => void send()} data-testid="pf-push-send"><Icon name="send" size={14} />{busy === 'send' ? 'Enviando…' : 'Enviar teste'}</button>
        </div>
        <div className="card pad">
          <div className="pf-card-h"><b>Simular venda aprovada</b><small>cada pessoa da empresa recebe no formato que escolheu; nenhuma venda é criada</small></div>
          <label className="pfp-f"><span>Empresa</span>
            <select className="select" value={saleAcc} onChange={(e) => setSaleAcc(e.target.value)} data-testid="pf-push-sale-account">
              {accounts.length ? accounts.map(([id, n]) => <option key={id} value={id}>{n}</option>) : <option value="">ninguém ativou ainda</option>}
            </select></label>
          <div className="pfp-row">
            <label className="pfp-f"><span>Valor (R$)</span><input className="input" value={sale.amount} onChange={(e) => setSale({ ...sale, amount: e.target.value })} data-testid="pf-push-sale-amount" /></label>
            <label className="pfp-f"><span>Produto</span><input className="input" value={sale.product} onChange={(e) => setSale({ ...sale, product: e.target.value })} /></label>
            <label className="pfp-f"><span>Cliente</span><input className="input" value={sale.customer} onChange={(e) => setSale({ ...sale, customer: e.target.value })} /></label>
          </div>
          <button type="button" className="btn primary" disabled={!saleAcc || !!busy || !data.configured} onClick={() => void simulate()} data-testid="pf-push-simulate"><Icon name="dollar" size={14} />{busy === 'sale' ? 'Enviando…' : 'Simular venda'}</button>
        </div>
      </div>

      {result && (
        <div className={cx('card pad pfp-result', result.r.sent ? 'ok' : 'bad')} data-testid="pf-push-result">
          <b>{result.what}: {result.r.sent} de {result.r.devices} {result.r.devices === 1 ? 'aparelho recebeu' : 'aparelhos receberam'}</b>
          {result.r.removed > 0 && <small>{result.r.removed} {result.r.removed === 1 ? 'aparelho tinha desinstalado e saiu da lista' : 'aparelhos tinham desinstalado e saíram da lista'}.</small>}
          {result.r.failed.map((f) => <small key={f.id} className="pfp-err">Falhou: {f.error}</small>)}
        </div>
      )}

      <div className="card ct-card pf-table-card">
        <div className="pf-table-top">
          <div className="fl-search ct-search"><Icon name="search" size={16} />
            <input className="input" placeholder="Buscar por pessoa, e-mail ou empresa" value={q} onChange={(e) => setQ(e.target.value)} data-testid="pf-push-search" /></div>
        </div>
        {data.devices.length === 0 ? (
          <div className="pf-empty"><Icon name="bell" size={22} /><b>Nenhum aparelho inscrito</b><span>Os aparelhos aparecem aqui quando alguém ativa em Configurações → Notificações no celular.</span></div>
        ) : (
          <div className="ct-scroll">
            <table className="ct-table pf-table" data-testid="pf-push-table">
              <thead><tr><th>Pessoa</th><th>Empresa</th><th>Aparelho</th><th>Vendas</th><th>Ativado</th><th>Último aviso</th><th>Testar</th></tr></thead>
              <tbody>
                {data.devices.map((d) => (
                  <tr key={d.id} data-testid="pf-push-row">
                    <td><b>{d.userName}</b><small className="pf-sub">{d.userEmail}</small></td>
                    <td>{d.accountName}</td>
                    <td>{d.device ?? '—'}<small className="pf-sub">{d.service}</small></td>
                    <td>{d.prefs?.sales === false ? <span className="faint">desligado</span> : d.customTemplate ? 'personalizada' : 'padrão'}</td>
                    <td>{ago(d.createdAt)}</td>
                    <td>{ago(d.lastSentAt)}</td>
                    <td className="pfp-acts">
                      <button type="button" className="btn sm" onClick={() => setTarget({ target: 'device', id: d.id, label: `${d.device ?? 'aparelho'} de ${d.userName}` })} data-testid="pf-push-pick-device">Aparelho</button>
                      <button type="button" className="btn sm ghost" onClick={() => setTarget({ target: 'user', id: d.userId, label: `todos os aparelhos de ${d.userName}` })}>Pessoa</button>
                      <button type="button" className="btn sm ghost" onClick={() => setTarget({ target: 'account', id: d.accountId, label: `todos os aparelhos da ${d.accountName}` })}>Empresa</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
