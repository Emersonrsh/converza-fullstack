import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Switch, toast } from '../components/ui';

interface Cfg { configured: boolean; handle: string; hasApiKey: boolean; pix: boolean; webhookUrl?: string; last30?: { links: number; paid: number } }

/** Configuração do checkout da InfinitePay (cartão em até 12x e Pix). */
export function InfinitePayCard() {
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [handle, setHandle] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pix, setPix] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState<string | null>(null);

  const load = async () => {
    try { const r = await api.get<Cfg>('/payments/infinitepay'); setCfg(r); setHandle(r.handle); setPix(r.pix); } catch { setCfg({ configured: false, handle: '', hasApiKey: false, pix: true }); }
  };
  useEffect(() => { void load(); }, []);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy('save');
    try {
      const r = await api.put<Cfg>('/payments/infinitepay', { handle, pix, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...extra });
      setCfg((c) => ({ ...(c ?? r), ...r })); setApiKey(''); setTestUrl(null);
      toast(r.configured ? 'InfinitePay salva' : 'InfinitePay desligada');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); }
    setBusy(null);
  }
  async function test() {
    setBusy('test');
    try { const r = await api.post<{ url: string }>('/payments/infinitepay/test'); setTestUrl(r.url); toast('A InfinitePay aceitou a InfiniteTag'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não deu certo'); }
    setBusy(null);
  }

  if (!cfg) return null;
  const dirty = handle.replace(/^\$/, '').trim() !== cfg.handle || pix !== cfg.pix || !!apiKey.trim();
  return (
    <section className="st-card ip-card" data-testid="infinitepay-card">
      <div className="ip-hd">
        <span className="ip-logo" aria-hidden><Icon name="card" size={18} /></span>
        <div>
          <b>Checkout InfinitePay</b>
          <small>Receba no cartão de crédito em até 12x (e Pix) com o bloco <b>Cartão (InfinitePay)</b> dos fluxos.</small>
        </div>
        <span className={`pill ${cfg.configured ? 'green' : ''}`} data-testid="ip-status">{cfg.configured ? 'Conectada' : 'Não conectada'}</span>
      </div>
      <div className="ip-grid">
        <div>
          <label className="label">InfiniteTag</label>
          <div className="ip-tag"><span>$</span><input className="input" value={handle.replace(/^\$/, '')} onChange={(e) => setHandle(e.target.value)} placeholder="sua_infinitetag" disabled={!canEdit} data-testid="ip-handle" /></div>
          <small className="faint">No app da InfinitePay, é o seu nome de usuário que começa com $ (sem o $ aqui).</small>
        </div>
        <div>
          <label className="label">Chave de API <span className="lbl-hint">· opcional</span></label>
          <input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg.hasApiKey ? '•••••••• (salva)' : 'Só se quiser escolher as formas de pagamento'} disabled={!canEdit} data-testid="ip-apikey" />
          {cfg.hasApiKey && canEdit && <button type="button" className="linkbtn" onClick={() => void save({ clearApiKey: true })}>Remover chave</button>}
        </div>
      </div>
      <label className="ip-toggle">
        <Switch on={pix} onClick={() => canEdit && setPix(!pix)} />
        <span><b>Aceitar Pix no checkout</b><small>{cfg.hasApiKey || apiKey ? 'Desligado, o checkout aceita só cartão de crédito.' : 'Para desligar o Pix, a InfinitePay exige a chave de API.'}</small></span>
      </label>
      <div className="ip-info">
        <Icon name="info" size={14} />
        <span>Quando o cliente paga, a InfinitePay avisa o Converza, que confere o pagamento direto com ela antes de valer. A venda vira <b>aprovada</b>, o <b>Pixel do Facebook</b> recebe a compra (configure o pixel em Facebook › Pixel) e você recebe o aviso no celular. O checkout da InfinitePay aceita cartão de <b>crédito</b>; débito não está disponível nele.</span>
      </div>
      {cfg.last30 && cfg.configured && <div className="faint" style={{ fontSize: 12.5 }} data-testid="ip-stats">Últimos 30 dias: {cfg.last30.links} link(s) gerado(s) · {cfg.last30.paid} pago(s)</div>}
      {testUrl && <div className="ip-test" data-testid="ip-test-url">Link de teste de R$ 1,00: <a href={testUrl} target="_blank" rel="noreferrer">{testUrl}</a></div>}
      {canEdit && (
        <div className="ip-acts">
          {cfg.configured && <button type="button" className="btn sm" disabled={busy === 'test' || dirty} onClick={() => void test()} data-testid="ip-test"><Icon name="play" size={13} />{busy === 'test' ? 'Testando…' : 'Testar InfiniteTag'}</button>}
          <button type="button" className="btn sm primary" disabled={!dirty || busy === 'save'} onClick={() => void save()} data-testid="ip-save">{busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
        </div>
      )}
    </section>
  );
}
