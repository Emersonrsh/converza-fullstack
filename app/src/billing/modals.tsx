import { useState, type ReactNode } from 'react';
import { ApiError, api } from '../api';
import { Icon } from '../icons';
import { Modal, cx, toast } from '../components/ui';
import {
  docValid, fmtDate, fmtInt, fmtMoney, maskDoc, normDoc, openPayment, pl, type CheckoutResult, type Summary,
} from './types';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado');

/** Depois de abrir a cobrança: o link fica aqui (caso o navegador bloqueie a aba nova) e a tela espera o pagamento. */
export function PaymentOpened({ url, what, gateway }: { url: string; what: string; gateway: 'asaas' | 'paddle' }) {
  return (
    <div className="bl-opened" data-testid="bl-payment-opened">
      <span className="bl-opened-ic"><Icon name="lock" size={22} /></span>
      <b>Cobrança criada</b>
      <p>{what} Abrimos a página segura {gateway === 'paddle' ? 'da Paddle' : 'da Asaas'} numa aba nova (se ela não abriu, use o botão). Assim que o pagamento for confirmado, esta tela atualiza sozinha.</p>
      <a className="btn primary" href={url} target="_blank" rel="noreferrer" data-testid="bl-payment-link"><Icon name="link" size={15} />Abrir página de pagamento</a>
      <small className="faint">Pix costuma confirmar em segundos. Cartão, em até alguns minutos.</small>
    </div>
  );
}

function Stepper({ value, min, max, onChange, testId }: { value: number; min: number; max: number; onChange: (n: number) => void; testId: string }) {
  return (
    <div className="bl-stepper" data-testid={testId}>
      <button type="button" className="btn icon sm" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="Menos" data-testid={`${testId}-minus`}><Icon name="minus" size={15} /></button>
      <input className="input" inputMode="numeric" value={value} aria-label="Quantidade de instâncias" data-testid={`${testId}-input`}
        onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n || min))); }} />
      <button type="button" className="btn icon sm" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="Mais" data-testid={`${testId}-plus`}><Icon name="plus" size={15} /></button>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange, testId }: {
  value: T; onChange: (v: T) => void; testId: string;
  options: { v: T; label: ReactNode; disabled?: boolean; title?: string }[];
}) {
  return (
    <div className="bl-choice" role="radiogroup" data-testid={testId}>
      {options.map((o) => (
        <button type="button" key={o.v} role="radio" aria-checked={value === o.v} className={cx(value === o.v && 'on')} disabled={o.disabled}
          title={o.title} onClick={() => onChange(o.v)} data-testid={`${testId}-${o.v}`}>{o.label}</button>
      ))}
    </div>
  );
}

/** CPF/CNPJ e nome de quem paga (a Asaas exige para emitir a cobrança). */
function PayerFields({ doc, setDoc, name, setName, saved }: {
  doc: string; setDoc: (v: string) => void; name: string; setName: (v: string) => void; saved: string | null;
}) {
  // 12 e 13 caracteres: ainda digitando um CNPJ (não acusa erro no meio)
  const n = normDoc(doc).length;
  const bad = (n === 11 || n >= 14) && !docValid(doc);
  return (
    <div className="bl-payer">
      <div>
        <label className="label">CPF ou CNPJ</label>
        {/* teclado com letras: o CNPJ emitido desde 31/07/2026 pode ter letras */}
        <input className={cx('input', bad && 'bad')} value={doc} onChange={(e) => setDoc(maskDoc(e.target.value))} inputMode="text" autoCapitalize="characters"
          autoComplete="off" spellCheck={false} placeholder={saved ? `Cadastrado: ${saved}` : '000.000.000-00'} data-testid="bl-doc" />
        {bad && <small className="bl-err">CPF ou CNPJ inválido. Confira os números.</small>}
        {saved && !doc && <small className="faint">Deixe em branco para usar o já cadastrado.</small>}
      </div>
      <div>
        <label className="label">Nome ou razão social</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Como sai na nota da cobrança" data-testid="bl-name" />
      </div>
    </div>
  );
}

/** Erro "falta CPF/CNPJ" vira o campo aparecendo, em vez de só uma mensagem. */
const needsDoc = (e: unknown) => e instanceof ApiError && (e.data.code === 'need_tax_id' || e.data.code === 'invalid_tax_id');

/* ------------------------------------------------------------ Assinar agora */

export function SubscribeModal({ s, onClose }: { s: Summary; onClose: () => void }) {
  const sub = s.subscription;
  const min = Math.max(1, sub.inUse);
  const [n, setN] = useState(Math.max(min, sub.instances || 1));
  const asaasOk = s.gateways.asaas;
  const paddleOk = s.gateways.paddleSubscriptions;
  const [country, setCountry] = useState<'BR' | 'INTL'>(asaasOk || !paddleOk ? 'BR' : 'INTL');
  const [method, setMethod] = useState<'card' | 'pix'>(sub.paymentMethod === 'pix' ? 'pix' : 'card');
  const [doc, setDoc] = useState('');
  const [name, setName] = useState(sub.billingName ?? s.account.ownerName ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const continuing = sub.status === 'active' && sub.cancelAtPeriodEnd;
  const unit = country === 'BR' ? s.pricing.instanceBRL : s.pricing.instanceUSD;
  const cur = country === 'BR' ? 'BRL' : 'USD';
  const p = s.pricing.perInstance;
  const docMissing = country === 'BR' && !sub.hasTaxId && !docValid(doc);
  const docBad = country === 'BR' && !!doc && !docValid(doc);

  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<CheckoutResult>('/billing/subscribe', {
        instances: n, country, method: country === 'BR' ? method : undefined,
        taxId: country === 'BR' && doc ? doc : undefined, name: country === 'BR' ? name : undefined,
      });
      if (r.url) { openPayment(r.url); setOpened(r.url); }
      else { toast(r.message ?? 'Pronto'); onClose(); }
    } catch (e) {
      setErr(errMsg(e));
    } finally { setBusy(false); }
  }

  if (opened) {
    return (
      <Modal title="Assinar agora" icon="card" width={520} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
        <PaymentOpened url={opened} gateway={country === 'BR' ? 'asaas' : 'paddle'}
          what={continuing ? `Assinatura de ${pl(n, 'instância', 'instâncias')} a partir de ${fmtDate(sub.currentPeriodEnd)}.` : `${pl(n, 'instância', 'instâncias')} por ${fmtMoney(n * unit, cur)}/mês.`} />
      </Modal>
    );
  }

  return (
    <Modal title={continuing ? 'Assinar de novo' : 'Assinar agora'} icon="card" width={560} onClose={onClose}
      subtitle="Escolha quantas instâncias deseja contratar. A cobrança mensal é recorrente por instância."
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={busy || (country === 'BR' ? !asaasOk || docMissing || docBad : !paddleOk)} onClick={() => void go()} data-testid="bl-subscribe-go">
          {busy ? 'Abrindo…' : 'Ir para o pagamento'}
        </button>
      </>}>
      <div className="bl-form" data-testid="bl-subscribe-modal">
        <div className="bl-qty">
          <div>
            <b>Instâncias</b>
            <small>{fmtMoney(unit, cur)} por instância · <b data-testid="bl-subscribe-total">{fmtMoney(n * unit, cur)}/mês</b></small>
          </div>
          <Stepper value={n} min={min} max={s.pricing.maxInstances} onChange={setN} testId="bl-qty" />
        </div>
        <div className="bl-includes">
          <Icon name="checkCircle" size={15} />
          <span>Cada instância: 1 número de WhatsApp, {p.agents} agentes de IA, {fmtInt(p.dispatches)} disparos por ciclo e {fmtInt(p.webhookEvents)} eventos de webhook por mês.</span>
        </div>
        {sub.inUse > 0 && <small className="faint">Você já tem {pl(sub.inUse, 'número conectado', 'números conectados')}, então o mínimo é {min}.</small>}
        {continuing && <div className="hint"><Icon name="info" size={14} />Sua assinatura atual vale até {fmtDate(sub.currentPeriodEnd)}. A nova começa nesse dia — nada é cobrado antes.</div>}

        <div>
          <label className="label">País de cobrança</label>
          <Choice value={country} onChange={setCountry} testId="bl-country" options={[
            { v: 'BR', label: <><span className="bl-flag">BR</span>Brasil</>, disabled: !asaasOk, title: asaasOk ? undefined : 'Asaas não configurada neste servidor' },
            { v: 'INTL', label: <><Icon name="globe" size={14} />Exterior</>, disabled: !paddleOk, title: paddleOk ? undefined : 'Paddle não configurada neste servidor' },
          ]} />
          <small className="faint">{country === 'BR'
            ? 'Cobrança em reais pela Asaas. Você escolhe entre Pix e cartão.'
            : 'Cobrança em dólar pela Paddle (cartão, PayPal e outras formas, conforme o país).'}</small>
        </div>

        {country === 'BR' && (
          <>
            <div>
              <label className="label">Forma de pagamento</label>
              <Choice value={method} onChange={setMethod} testId="bl-method" options={[
                { v: 'card', label: <><Icon name="card" size={14} />Cartão</> },
                { v: 'pix', label: <><span className="bl-pix">PIX</span>Pix</> },
              ]} />
              <small className="faint">{method === 'card'
                ? 'Você digita o cartão na página segura da Asaas; as próximas mensalidades são cobradas no mesmo cartão.'
                : 'Todo mês chega uma cobrança Pix por e-mail (e aparece aqui) no dia do vencimento.'}</small>
            </div>
            <PayerFields doc={doc} setDoc={setDoc} name={name} setName={setName} saved={sub.taxId} />
          </>
        )}

        <div className="bl-secure"><Icon name="lock" size={14} />Os dados do cartão são digitados direto na página do gateway de pagamento — não passam pelo Converza.</div>
        {country === 'BR' && !asaasOk && <div className="hint bad" data-testid="bl-asaas-off"><Icon name="alert" size={14} />A cobrança por Pix e cartão ainda não está configurada neste servidor.</div>}
        {country === 'INTL' && !paddleOk && <div className="hint bad"><Icon name="alert" size={14} />A cobrança internacional ainda não está configurada neste servidor.</div>}
        {err && <div className="hint bad" data-testid="bl-error"><Icon name="alert" size={14} />{err}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ Alterar instâncias */

/** Mesma conta do servidor: dias que faltam até o vencimento (sobre 30), mínimo de R$ 5,00. */
function prorataPreview(extra: number, unit: number, periodEnd: string | null) {
  if (extra <= 0) return 0;
  const days = periodEnd ? Math.max(1, Math.min(30, Math.ceil((new Date(periodEnd).getTime() - Date.now()) / 86_400_000))) : 30;
  return Math.max(5, Math.round(((extra * unit * days) / 30) * 100) / 100);
}

export function InstancesModal({ s, onClose }: { s: Summary; onClose: () => void }) {
  const sub = s.subscription;
  const current = sub.instances;
  const scheduled = sub.pendingInstances !== null && sub.pendingInstances !== current ? sub.pendingInstances : null;
  const [n, setN] = useState(scheduled ?? current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const paddle = sub.gateway === 'paddle';
  const cur = sub.currency;
  const unit = sub.unitPrice;
  const min = Math.max(1, sub.inUse);
  const extra = n - current;
  const now = prorataPreview(extra, unit, sub.currentPeriodEnd);
  const same = n === current && scheduled === null;
  const until = fmtDate(sub.currentPeriodEnd);

  let text: ReactNode;
  if (same) text = 'Essa é a quantidade contratada hoje.';
  else if (n === current) text = <>Desfaz a redução agendada: a mensalidade continua <b>{fmtMoney(current * unit, cur)}</b>.</>;
  else if (extra > 0) {
    text = paddle
      ? <>A Paddle cobra agora a diferença proporcional até {until}, no cartão salvo. Depois, a mensalidade passa a <b>{fmtMoney(n * unit, cur)}</b>.</>
      : <>Você paga agora <b data-testid="bl-prorata">{fmtMoney(now, cur)}</b> (proporcional aos dias até {until}). As instâncias entram assim que o pagamento cair; depois, a mensalidade passa a <b>{fmtMoney(n * unit, cur)}</b>.</>;
  } else {
    text = paddle
      ? <>A redução vale na hora e a diferença vira crédito na próxima fatura da Paddle. Mensalidade nova: <b>{fmtMoney(n * unit, cur)}</b>.</>
      : <>A redução vale a partir de <b>{until}</b>: até lá você continua com {pl(current, 'instância', 'instâncias')}. Mensalidade nova: <b>{fmtMoney(n * unit, cur)}</b>.</>;
  }

  async function go() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<CheckoutResult>('/billing/instances', { instances: n });
      if (r.url) { openPayment(r.url); setOpened(r.url); }
      else { toast(r.message ?? 'Pronto'); onClose(); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }

  if (opened) {
    return (
      <Modal title="Alterar instâncias" icon="plug" width={500} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
        <PaymentOpened url={opened} gateway="asaas" what={`Mais ${pl(extra, 'instância', 'instâncias')} por ${fmtMoney(now, cur)} (proporcional).`} />
      </Modal>
    );
  }
  return (
    <Modal title="Alterar instâncias" icon="plug" width={500} onClose={onClose}
      subtitle={`Hoje: ${pl(current, 'instância', 'instâncias')}${scheduled !== null ? ` · ${scheduled} a partir de ${fmtDate(sub.pendingFrom)}` : ''}`}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={busy || same} onClick={() => void go()} data-testid="bl-instances-go">
          {busy ? 'Salvando…' : extra > 0 && !paddle ? 'Ir para o pagamento' : 'Confirmar'}
        </button>
      </>}>
      <div className="bl-form" data-testid="bl-instances-modal">
        <div className="bl-qty">
          <div><b>Instâncias</b><small>{fmtMoney(unit, cur)} por instância/mês</small></div>
          <Stepper value={n} min={min} max={s.pricing.maxInstances} onChange={setN} testId="bl-iqty" />
        </div>
        <div className="bl-explain" data-testid="bl-instances-text">{text}</div>
        {sub.inUse > 0 && <small className="faint">Para ter menos de {sub.inUse}, desconecte números em Conexões antes.</small>}
        {err && <div className="hint bad" data-testid="bl-error"><Icon name="alert" size={14} />{err}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ Cancelar */

export function CancelModal({ s, onClose }: { s: Summary; onClose: () => void }) {
  const sub = s.subscription;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pastDue = sub.status === 'past_due';
  async function go() {
    setBusy(true); setErr(null);
    try { const r = await api.post<CheckoutResult>('/billing/cancel'); toast(r.message ?? 'Assinatura cancelada'); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Cancelar assinatura" icon="alert" width={460} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Voltar</button>
      <button type="button" className="btn primary danger" disabled={busy} onClick={() => void go()} data-testid="bl-cancel-go">{busy ? 'Cancelando…' : 'Cancelar assinatura'}</button>
    </>}>
      <div className="bl-form" data-testid="bl-cancel-modal">
        <p style={{ margin: 0, lineHeight: 1.55 }}>
          {pastDue
            ? 'A mensalidade está atrasada, então a assinatura acaba agora e a cobrança em aberto é retirada.'
            : <>Nada mais é cobrado. Tudo continua funcionando até <b>{fmtDate(sub.currentPeriodEnd)}</b>; depois disso, os números param de enviar mensagens e os disparos, agentes de IA e webhooks param.</>}
        </p>
        <small className="faint">Suas conversas, contatos, fluxos e tokens continuam salvos. Você pode assinar de novo quando quiser.</small>
        {err && <div className="hint bad" data-testid="bl-error"><Icon name="alert" size={14} />{err}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ Tokens */

export function TokensModal({ s, onClose }: { s: Summary; onClose: () => void }) {
  const pr = s.pricing;
  const [tokens, setTokens] = useState(10_000);
  const [text, setText] = useState(fmtInt(10_000));
  const [busy, setBusy] = useState<'asaas' | 'paddle' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [askDoc, setAskDoc] = useState(false);
  const [doc, setDoc] = useState('');
  const [name, setName] = useState(s.subscription.billingName ?? s.account.ownerName ?? '');
  const [opened, setOpened] = useState<{ url: string; gateway: 'asaas' | 'paddle' } | null>(null);
  const valid = tokens >= pr.tokensMin && tokens <= pr.tokensMax && tokens % pr.tokensStep === 0;
  const brl = Math.round((tokens / 1000) * pr.tokensPer1000BRL * 100) / 100;
  const usd = Math.round((tokens / 1000) * pr.tokensPer1000USD * 100) / 100;
  // a barra vai até 1 milhão; acima disso, digite
  const sliderMax = Math.min(pr.tokensMax, 1_000_000);

  const set = (v: number) => { setTokens(v); setText(fmtInt(v)); };
  async function buy(gateway: 'asaas' | 'paddle') {
    if (gateway === 'asaas' && !s.subscription.hasTaxId && !docValid(doc)) { setAskDoc(true); setErr(doc ? 'CPF ou CNPJ inválido. Confira os números.' : null); return; }
    setBusy(gateway); setErr(null);
    try {
      const r = await api.post<CheckoutResult>('/billing/tokens', {
        tokens, gateway, taxId: gateway === 'asaas' && doc ? doc : undefined, name: gateway === 'asaas' ? name : undefined,
      });
      if (r.url) { openPayment(r.url); setOpened({ url: r.url, gateway }); }
    } catch (e) {
      if (needsDoc(e)) setAskDoc(true);
      setErr(errMsg(e));
    } finally { setBusy(null); }
  }

  if (opened) {
    return (
      <Modal title="Adicionar tokens" icon="bolt" width={500} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Fechar</button>}>
        <PaymentOpened url={opened.url} gateway={opened.gateway}
          what={`${pl(tokens, 'token', 'tokens')} por ${opened.gateway === 'asaas' ? fmtMoney(brl) : fmtMoney(usd, 'USD')}. Os tokens entram no saldo assim que o pagamento for confirmado.`} />
      </Modal>
    );
  }
  return (
    <Modal title="Adicionar tokens" icon="bolt" width={520} onClose={onClose}
      subtitle="Compra avulsa de tokens, válida para a conta inteira. Não altera sua assinatura mensal."
      footer={<button type="button" className="btn" onClick={onClose}>Cancelar</button>}>
      <div className="bl-form" data-testid="bl-tokens-modal">
        <div className="bl-tok-top">
          <input type="range" min={pr.tokensMin} max={sliderMax} step={pr.tokensStep} value={Math.min(tokens, sliderMax)}
            onChange={(e) => set(Number(e.target.value))} aria-label="Quantidade de tokens" data-testid="bl-tok-range" />
          <input className="input bl-tok-input" value={text} inputMode="numeric" data-testid="bl-tok-input"
            onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 8); setText(d ? fmtInt(Number(d)) : ''); setTokens(Number(d) || 0); }}
            onBlur={() => { if (tokens > 0) { const r = Math.min(pr.tokensMax, Math.max(pr.tokensMin, Math.round(tokens / pr.tokensStep) * pr.tokensStep)); set(r); } }} />
        </div>
        <small className="faint">{fmtInt(1000)} tokens = {fmtMoney(pr.tokensPer1000BRL)}. Arraste a barra ou digite (de {fmtInt(pr.tokensMin)} a {fmtInt(pr.tokensMax)}, de mil em mil).</small>
        <div className="bl-tok-pay" data-testid="bl-tok-price">Você paga <b>{fmtMoney(brl)}</b>{s.gateways.paddle && <span className="faint"> · ou {fmtMoney(usd, 'USD')} pela Paddle</span>}</div>
        {!valid && tokens > 0 && <small className="bl-err">Escolha de {fmtInt(pr.tokensMin)} a {fmtInt(pr.tokensMax)} tokens, de mil em mil.</small>}
        {askDoc && <PayerFields doc={doc} setDoc={setDoc} name={name} setName={setName} saved={s.subscription.taxId} />}
        <div className="bl-tok-btns">
          <button type="button" className="btn primary" disabled={!valid || !!busy || !s.gateways.asaas} onClick={() => void buy('asaas')} data-testid="bl-tok-asaas"
            title={s.gateways.asaas ? undefined : 'Asaas não configurada neste servidor'}>
            <span className="bl-flag">BR</span>{busy === 'asaas' ? 'Abrindo…' : 'Pix ou cartão'}
          </button>
          <button type="button" className="btn" disabled={!valid || !!busy || !s.gateways.paddle} onClick={() => void buy('paddle')} data-testid="bl-tok-paddle"
            title={s.gateways.paddle ? undefined : 'Paddle não configurada neste servidor'}>
            <Icon name="globe" size={14} />{busy === 'paddle' ? 'Abrindo…' : 'Paddle (internacional)'}
          </button>
        </div>
        <small className="faint">Pix e cartão em reais, ou checkout internacional pela Paddle. Os tokens não vencem e só são gastos com a assinatura ativa.</small>
        {!s.gateways.asaas && !s.gateways.paddle && <div className="hint bad"><Icon name="alert" size={14} />A cobrança ainda não está configurada neste servidor.</div>}
        {err && <div className="hint bad" data-testid="bl-error"><Icon name="alert" size={14} />{err}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ Disparos extras (usado na tela de Disparos) */

export function DispatchPackModal({ pack, gateway, hasTaxId, onClose }: {
  pack: { id: string; quantity: number; price: number; priceUSD: number }; gateway: 'asaas' | 'paddle'; hasTaxId: boolean; onClose: () => void;
}) {
  const [doc, setDoc] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [askDoc, setAskDoc] = useState(gateway === 'asaas' && !hasTaxId);
  const price = gateway === 'asaas' ? fmtMoney(pack.price) : fmtMoney(pack.priceUSD, 'USD');
  async function go() {
    if (askDoc && !docValid(doc)) { setErr('Informe um CPF ou CNPJ válido.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post<CheckoutResult>('/billing/dispatch', { packId: pack.id, gateway, taxId: askDoc ? doc : undefined, name: askDoc ? name : undefined });
      if (r.url) { openPayment(r.url); setOpened(r.url); }
    } catch (e) { if (needsDoc(e)) setAskDoc(true); setErr(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <Modal title="Comprar disparos extras" icon="send" width={480} onClose={onClose}
      footer={opened ? <button type="button" className="btn" onClick={onClose}>Fechar</button> : <>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void go()} data-testid="ds-pack-go">{busy ? 'Abrindo…' : 'Ir para o pagamento'}</button>
      </>}>
      {opened ? <PaymentOpened url={opened} gateway={gateway} what={`${pl(pack.quantity, 'disparo extra', 'disparos extras')} por ${price}. O saldo extra entra assim que o pagamento for confirmado.`} /> : (
        <div className="bl-form" data-testid="ds-pack-modal">
          <div className="bl-explain"><b>{pl(pack.quantity, 'disparo extra', 'disparos extras')}</b> por <b>{price}</b> — {gateway === 'asaas' ? 'Pix ou cartão pela Asaas' : 'checkout internacional pela Paddle'}. O saldo extra não vence.</div>
          {askDoc && <PayerFields doc={doc} setDoc={setDoc} name={name} setName={setName} saved={null} />}
          {err && <div className="hint bad" data-testid="bl-error"><Icon name="alert" size={14} />{err}</div>}
        </div>
      )}
    </Modal>
  );
}
