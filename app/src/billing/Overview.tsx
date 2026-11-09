import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import { CancelModal, InstancesModal, SubscribeModal, TokensModal } from './modals';
import { InvoiceTable } from './InvoiceList';
import { fmtDate, fmtInt, fmtMoney, methodLabel, pl, type Summary } from './types';
import { openInvoice } from './actions';

const STATUS_PILL: Record<Summary['status']['key'], string> = {
  none: '', pending: 'amber', active: 'green', canceling: 'amber', past_due: 'red', canceled: 'red',
};

type ModalKind = 'subscribe' | 'instances' | 'cancel' | 'tokens' | null;

function Box({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
  return <div className="bl-box" data-testid={testId}><small>{label}</small><b>{value}</b></div>;
}

function Info({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return <div className="bl-info-row" data-testid={testId}><span>{label}</span><b>{children}</b></div>;
}

/** Conta da casa: a empresa do próprio dono do Converza (HOUSE_EMAILS) — nada a pagar, tokens sem limite. */
function HouseOverview({ s }: { s: Summary }) {
  const sub = s.subscription;
  return (
    <div className="fade bl-page" data-testid="billing-page">
      <section className="card bl-sub" data-testid="bl-house">
        <div className="bl-sub-head">
          <span className="bl-sub-ic"><Icon name="building" size={20} /></span>
          <div className="bl-sub-t">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b>Conta da casa</b>
              <span className="pill dot green" data-testid="bl-status">Ativa · sem cobrança</span>
            </div>
            <p>Esta empresa é do dono do Converza (e-mail em HOUSE_EMAILS no servidor): não gera faturas, as instâncias são liberadas pelo servidor e os tokens de IA não acabam. O uso continua sendo contado em Configurações › Uso da IA.</p>
          </div>
          <div className="bl-price"><strong>{fmtMoney(0, sub.currency)}</strong><small>por mês</small></div>
        </div>
        <div className="bl-boxes">
          <Box label="Instâncias liberadas" value={fmtInt(sub.instances)} testId="bl-box-instances" />
          <Box label="Em uso" value={fmtInt(sub.inUse)} testId="bl-house-inuse" />
          <Box label="Tokens de IA" value="Sem limite" testId="bl-house-tokens" />
          <Box label="Tokens usados" value={fmtInt(s.tokens.used)} testId="bl-house-used" />
        </div>
        <div className="hint"><Icon name="info" size={14} />Precisa de mais números? Aumente HOUSE_INSTANCES no Render (converza-api › Environment): ao salvar, o Render reinicia a API e o novo limite vale em cerca de 1 minuto.</div>
      </section>
    </div>
  );
}

export function Overview() {
  const { accountId } = useAuth();
  const [params, setParams] = useSearchParams();
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const prev = useRef<Summary | null>(null);

  const load = useCallback(() => api.get<Summary>('/billing/summary').then((r) => { setS(r); setErr(null); })
    .catch((e) => setErr(e instanceof Error ? e.message : 'Erro')), []);
  useEffect(() => { void load(); }, [load, accountId]);

  // pagamento confirmado pelo gateway → a tela atualiza sozinha
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 350); };
    sock.on('billing:changed', on);
    sock.on('tokens:update', on);
    return () => { sock.off('billing:changed', on); sock.off('tokens:update', on); if (t) clearTimeout(t); };
  }, [load, accountId]);

  // avisa o que o pagamento liberou e fecha a janela de "aguardando pagamento"
  useEffect(() => {
    const a = prev.current; prev.current = s;
    if (!a || !s) return;
    if (a.status.key !== 'active' && s.status.key === 'active' && s.subscription.renewing) {
      toast(`Pagamento confirmado: ${pl(s.subscription.instances, 'instância liberada', 'instâncias liberadas')}`);
      if (modal === 'subscribe') setModal(null);
    } else if (s.subscription.instances > a.subscription.instances && a.status.key === 'active') {
      toast(`Pagamento confirmado: agora são ${pl(s.subscription.instances, 'instância', 'instâncias')}`);
      if (modal === 'instances') setModal(null);
    }
    if (s.tokens.balance > a.tokens.balance) {
      toast(`${pl(s.tokens.balance - a.tokens.balance, 'token adicionado', 'tokens adicionados')} ao saldo`);
      if (modal === 'tokens') setModal(null);
    }
  }, [s, modal]);

  // volta da página de pagamento da Paddle
  useEffect(() => {
    if (params.get('pago') === '1') {
      // espera o aviso da barra do topo montar (ele é montado depois desta tela)
      setTimeout(() => toast('Pagamento recebido. A confirmação chega em instantes.'), 300);
      params.delete('pago'); setParams(params, { replace: true });
    }
  }, [params, setParams]);

  if (err && !s) {
    return <div className="ag-empty"><Icon name="alert" size={30} /><b>Não foi possível carregar a cobrança</b><span>{err}</span>
      <button type="button" className="btn" onClick={() => void load()}>Tentar de novo</button></div>;
  }
  if (!s) return <Spinner />;
  if (s.house) return <HouseOverview s={s} />;

  const sub = s.subscription;
  const cur = sub.currency;
  const active = sub.status === 'active';
  const scheduled = sub.renewing && sub.pendingInstances !== null && sub.pendingInstances !== sub.instances ? sub.pendingInstances : null;
  const openSub = s.openInvoices.find((i) => i.kind === 'subscription');
  const openInst = s.openInvoices.find((i) => i.kind === 'instances');
  const subscribeLabel = sub.status === 'active' && sub.cancelAtPeriodEnd ? 'Assinar de novo' : openSub ? 'Escolher de novo' : 'Assinar agora';
  const country = sub.billingCountry === 'INTL' ? 'Exterior' : 'Brasil';
  // só mostra mensalidade quando há cobrança recorrente de verdade (cancelada ou sem renovação = nada a pagar)
  const price = sub.renewing ? (scheduled !== null ? sub.currentMonthly : sub.monthly) : 0;

  return (
    <div className="fade bl-page" data-testid="billing-page">
      <section className="card bl-sub" data-testid="bl-sub">
        <div className="bl-sub-head">
          <span className="bl-sub-ic"><Icon name="card" size={20} /></span>
          <div className="bl-sub-t">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b>Assinatura Converza</b>
              <span className={`pill dot ${STATUS_PILL[s.status.key]}`} data-testid="bl-status">{s.status.label}</span>
            </div>
            <p data-testid="bl-status-text">{s.status.text}</p>
          </div>
          <div className="bl-price" data-testid="bl-price"><strong>{fmtMoney(price, cur)}</strong><small>{active && !sub.renewing ? 'não renova' : 'por mês'}</small></div>
        </div>
        <div className="bl-boxes">
          <Box label="Instâncias contratadas" value={fmtInt(sub.instances)} testId="bl-box-instances" />
          <Box label="Cliente ativo desde" value={active ? fmtDate(sub.startedAt) : '—'} testId="bl-box-since" />
          <Box label="Próximo vencimento" value={fmtDate(sub.nextDueDate)} testId="bl-box-due" />
          <Box label="Forma de pagamento" value={active || openSub ? methodLabel(sub.paymentMethod, sub.gateway) : '—'} testId="bl-box-method" />
        </div>

        {s.canEdit && s.openInvoices.length > 0 && (
          <div className="bl-due" data-testid="bl-open-invoice">
            <Icon name="alert" size={16} />
            <span>
              {s.openInvoices.length === 1
                ? <>Fatura <b>#{s.openInvoices[0].number}</b> de <b>{fmtMoney(s.openInvoices[0].amount, s.openInvoices[0].currency)}</b> {s.openInvoices[0].status === 'overdue' ? 'vencida' : 'em aberto'}{s.openInvoices[0].dueDate ? ` (vence ${fmtDate(s.openInvoices[0].dueDate)})` : ''} — {s.openInvoices[0].description}.</>
                : <>{s.openInvoices.length} faturas em aberto.</>}
            </span>
            <button type="button" className="btn sm primary" onClick={() => void openInvoice(openInst ?? openSub ?? s.openInvoices[0])} data-testid="bl-pay-open">Pagar fatura</button>
          </div>
        )}
        {scheduled !== null && (
          <div className="hint" data-testid="bl-scheduled"><Icon name="clock" size={14} />
            A partir de {fmtDate(sub.pendingFrom)}: {pl(scheduled, 'instância', 'instâncias')} por {fmtMoney(sub.monthly, cur)}/mês.
          </div>
        )}
        {s.canEdit && (sub.renewing || sub.status === 'past_due') && (
          <div className="bl-sub-actions">
            {sub.canChange && <button type="button" className="btn sm" onClick={() => setModal('instances')} data-testid="bl-change">Alterar instâncias</button>}
            <button type="button" className="btn sm ghost danger" onClick={() => setModal('cancel')} data-testid="bl-cancel">Cancelar assinatura</button>
          </div>
        )}
      </section>

      <div className="bl-cards">
        <section className="card bl-card" data-testid="bl-instances">
          <div className="bl-card-h"><Icon name="plug" size={16} /><b>Instâncias</b></div>
          <div className="bl-big"><strong data-testid="bl-in-use">{fmtInt(sub.inUse)} / {fmtInt(sub.instances)}</strong><span>em uso</span></div>
          <div className="bl-split">
            <div><small>Contratadas</small><b>{fmtInt(sub.instances)}</b></div>
            <div><small>Livres</small><b data-testid="bl-free">{fmtInt(sub.free)}</b></div>
          </div>
          <p className="bl-note">{fmtMoney(sub.billingCountry === 'INTL' ? s.pricing.instanceUSD : s.pricing.instanceBRL, cur)} por instância/mês · cada instância é uma conexão de WhatsApp.</p>
          {s.canEdit && (sub.canChange
            ? <button type="button" className="btn primary bl-card-btn" onClick={() => setModal('instances')} data-testid="bl-change-2">Alterar instâncias</button>
            : sub.status !== 'past_due' && <button type="button" className="btn primary bl-card-btn" onClick={() => setModal('subscribe')} data-testid="bl-subscribe">{subscribeLabel}</button>)}
          {s.canEdit && sub.status === 'past_due' && <button type="button" className="btn primary bl-card-btn" onClick={() => setModal('subscribe')} data-testid="bl-subscribe">Assinar de novo</button>}
        </section>

        <section className="card bl-card" data-testid="bl-tokens">
          <div className="bl-card-h"><Icon name="bolt" size={16} /><b>Tokens</b></div>
          <div className="bl-big"><strong data-testid="bl-tok-balance">{fmtInt(s.tokens.balance)}</strong><span>disponíveis</span></div>
          <div className="bl-split">
            <div><small>Usados</small><b data-testid="bl-tok-used">{fmtInt(s.tokens.used)}</b></div>
            <div><small>Última recarga</small><b>{fmtDate(s.tokens.lastPurchaseAt)}</b></div>
          </div>
          <p className="bl-note">Compra avulsa, vale para a conta inteira · separado da assinatura.</p>
          {s.canEdit && <button type="button" className="btn bl-card-btn" onClick={() => setModal('tokens')} data-testid="bl-add-tokens"><Icon name="plus" size={15} />Adicionar tokens</button>}
        </section>

        <section className="card bl-card" data-testid="bl-account">
          <div className="bl-card-h"><Icon name="user" size={16} /><b>Informações da conta</b></div>
          <div className="bl-info">
            <Info label="ID da conta" testId="bl-account-id">
              <span className="bl-mono">{s.account.number ?? '—'}</span>
              {s.account.number && <button type="button" className="btn icon sm ghost" aria-label="Copiar ID da conta"
                onClick={() => { void navigator.clipboard?.writeText(String(s.account.number)); toast('ID da conta copiado'); }}><Icon name="copy" size={13} /></button>}
            </Info>
            <Info label="Titular">{sub.billingName || s.account.ownerName || '—'}</Info>
            {s.canEdit && <Info label="E-mail">{s.account.ownerEmail ?? '—'}</Info>}
            {s.canEdit && sub.taxId && <Info label="CPF/CNPJ">{sub.taxId}</Info>}
            <Info label="Recorrência">{sub.renewing ? 'Mensal' : '—'}</Info>
            <Info label="Próximo vencimento">{fmtDate(sub.nextDueDate)}</Info>
            <Info label="País de cobrança">{active || openSub ? country : '—'}</Info>
          </div>
        </section>
      </div>

      <section className="card bl-history" data-testid="bl-history">
        <div className="bl-history-h">
          <div><b>Histórico de faturas</b><small>Histórico financeiro completo da sua conta</small></div>
          {s.canEdit && (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn sm" to="/billing/reembolsos" data-testid="bl-refunds-link"><Icon name="rotateCcw" size={14} />Reembolsos</Link>
              <Link className="btn sm" to="/billing/faturas" data-testid="bl-invoices-link">Ver todas</Link>
            </div>
          )}
        </div>
        {s.canEdit
          ? <InvoiceTable rows={s.invoices} empty={<><Icon name="file" size={26} /><b>Nenhuma fatura ainda</b><span>As faturas aparecem aqui quando você assinar ou comprar tokens.</span></>} />
          : <div className="bl-empty"><Icon name="lock" size={22} /><span>Só o dono e os administradores da conta veem as faturas.</span></div>}
      </section>

      <section className="card bl-support" data-testid="bl-support">
        <span className="bl-sub-ic"><Icon name="headset" size={20} /></span>
        <div><b>Precisando de suporte?</b><small>Dúvidas sobre faturamento, assinatura, pagamentos ou liberação de instâncias com nosso time.</small></div>
        {s.supportUrl
          ? <a className="btn" href={s.supportUrl} target="_blank" rel="noreferrer" data-testid="bl-support-btn">Falar com Suporte</a>
          : <button type="button" className="btn" disabled title="O canal de suporte ainda não foi configurado" data-testid="bl-support-btn">Falar com Suporte</button>}
      </section>

      {modal === 'subscribe' && <SubscribeModal s={s} onClose={() => { setModal(null); void load(); }} />}
      {modal === 'instances' && <InstancesModal s={s} onClose={() => { setModal(null); void load(); }} />}
      {modal === 'cancel' && <CancelModal s={s} onClose={() => { setModal(null); void load(); }} />}
      {modal === 'tokens' && <TokensModal s={s} onClose={() => { setModal(null); void load(); }} />}
    </div>
  );
}
