import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { toast } from '../components/ui';

interface Cfg {
  configured: boolean; clientId: string; hasSecret: boolean; currency: string;
  currencies: { id: string; label: string }[]; last30?: { charges: number; paid: number };
}

/** Conexão com a XPag: cobranças em pesos mexicanos (SPEI/OXXO), pesos colombianos, Pix, USDT e USDC. */
export function XpagCard() {
  const { accountId, accounts } = useAuth();
  const canEdit = accounts.find((a) => a.id === accountId)?.role !== 'agent';
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [currency, setCurrency] = useState('MXN');
  const [busy, setBusy] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ currency: string; available: number }[] | null>(null);

  const load = async () => {
    try { const r = await api.get<Cfg>('/payments/xpag'); setCfg(r); setClientId(r.clientId); setCurrency(r.currency); }
    catch { setCfg(null); }
  };
  useEffect(() => { void load(); }, []);

  async function save(disconnect = false) {
    setBusy(disconnect ? 'off' : 'save');
    try {
      const r = await api.put<Cfg>('/payments/xpag', disconnect ? { clientId: '', disconnect: true } : { clientId: clientId.trim(), currency, ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
      setCfg((c) => ({ ...(c ?? r), ...r })); setSecret(''); setBalances(null);
      if (disconnect) setClientId('');
      toast(r.configured ? 'XPag conectada' : 'XPag desconectada');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); }
    setBusy(null);
  }
  async function test() {
    setBusy('test');
    try { const r = await api.post<{ balances: { currency: string; available: number }[]; sandbox: boolean }>('/payments/xpag/test'); setBalances(r.balances); toast(r.sandbox ? 'Chave de teste (sandbox) funcionando' : 'A XPag aceitou a chave'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não deu certo'); }
    setBusy(null);
  }

  if (!cfg) return null;
  const dirty = clientId.trim() !== cfg.clientId || !!secret.trim();
  return (
    <section className="st-card ip-card" data-testid="xpag-card">
      <div className="ip-hd">
        <span className="ip-logo" aria-hidden><Icon name="globe" size={18} /></span>
        <div>
          <b>XPag · outras moedas</b>
          <small>Receba em <b>pesos mexicanos</b> (SPEI e OXXO), pesos colombianos (Nequi e Bre-B), Pix, USDT e USDC com o bloco <b>Pagamento XPag</b> dos fluxos.</small>
        </div>
        <span className={`pill ${cfg.configured ? 'green' : ''}`} data-testid="xpag-status">{cfg.configured ? 'Conectada' : 'Não conectada'}</span>
      </div>
      <div className="ip-grid">
        <div>
          <label className="label">Client ID</label>
          <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID da XPag" autoComplete="off" disabled={!canEdit} data-testid="xpag-client-id" />
        </div>
        <div>
          <label className="label">Client Secret</label>
          <input className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.hasSecret ? '•••••••• (salvo)' : 'Client Secret da XPag'} disabled={!canEdit} data-testid="xpag-secret" />
        </div>
      </div>
      <div className="ip-info">
        <Icon name="info" size={14} />
        <span>Gere a chave no painel da XPag, em <b>Integrações › API</b>, com permissão de <b>cobrança</b>. O Converza confere a chave antes de salvar. Cada cobrança leva o endereço de aviso do Converza; quando o cliente paga, a XPag avisa com assinatura, a venda vira <b>aprovada</b> na moeda da cobrança e aparece no Dashboard. A moeda precisa estar liberada na sua conta XPag.</span>
      </div>
      {cfg.last30 && cfg.configured && <div className="faint" style={{ fontSize: 12.5 }} data-testid="xpag-stats">Últimos 30 dias: {cfg.last30.charges} cobrança(s) · {cfg.last30.paid} paga(s)</div>}
      {balances && <div className="ip-test" data-testid="xpag-balances">Saldo disponível: {balances.length ? balances.map((b) => `${b.currency} ${b.available.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`).join(' · ') : 'sem saldo'}</div>}
      {canEdit && (
        <div className="ip-acts">
          {cfg.configured && <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void save(true)} data-testid="xpag-disconnect">Desconectar</button>}
          {cfg.configured && <button type="button" className="btn sm" disabled={busy === 'test' || dirty} onClick={() => void test()} data-testid="xpag-test"><Icon name="play" size={13} />{busy === 'test' ? 'Testando…' : 'Testar chave'}</button>}
          <button type="button" className="btn sm primary" disabled={!dirty || busy === 'save' || !clientId.trim() || (!cfg.hasSecret && !secret.trim())} onClick={() => void save()} data-testid="xpag-save">{busy === 'save' ? 'Conferindo…' : 'Salvar'}</button>
        </div>
      )}
    </section>
  );
}
