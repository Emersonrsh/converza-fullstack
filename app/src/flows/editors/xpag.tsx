import { Link } from 'react-router-dom';
import { Icon } from '../../icons';
import { Field, RichText, ToggleCard, VarInput } from './fields';
import type { EditorProps } from './types';

/** Moedas e trilhos que o Converza cobra pela XPag (o primeiro trilho é o padrão). */
export const XPAG_CURRENCIES: { id: string; label: string; methods: [string, string][] }[] = [
  { id: 'MXN', label: 'Peso mexicano (MXN)', methods: [['SPEI', 'SPEI (transferência)'], ['OXXO', 'OXXO (dinheiro na loja)']] },
  { id: 'COP', label: 'Peso colombiano (COP)', methods: [['NEQUI_QR', 'Nequi (QR)'], ['NEQUI_PUSH', 'Nequi (aviso no app)'], ['BREB', 'Bre-B']] },
  { id: 'BRL', label: 'Real (BRL) · Pix', methods: [] },
  { id: 'USDT', label: 'USDT (rede TRON)', methods: [] },
  { id: 'USDC', label: 'USDC (rede Solana)', methods: [] },
];
const SYMBOL: Record<string, string> = { MXN: 'MX$', COP: 'COL$', BRL: 'R$', USDT: 'USDT', USDC: 'USDC' };

/** Pagamento XPag: cobra em pesos mexicanos, pesos colombianos, Pix ou stablecoins e espera o pagamento. */
export function XpagEditor({ d, set, vars, lookups, openProducts }: EditorProps) {
  const cur = XPAG_CURRENCIES.find((c) => c.id === d.currency) ?? XPAG_CURRENCIES[0];
  return (
    <>
      <div className="fx-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, padding: '10px 12px', borderRadius: 10, background: 'var(--primary-50)', color: 'var(--text)' }}>
        <Icon name="globe" size={15} />
        <span>Cria uma cobrança na <b>XPag</b> na moeda escolhida e manda as instruções ao cliente (CLABE do SPEI, ficha do OXXO, link do Nequi, Pix copia e cola ou endereço da carteira). Quando ele paga, a venda é aprovada nessa moeda, o <b>Pixel</b> recebe a compra e o fluxo segue por <b>Pago</b>. Conecte a XPag em <Link to="/settings/produtos">Configurações › Produtos</Link>.</span>
      </div>
      <div className="fx-row" style={{ display: 'grid', gridTemplateColumns: cur.methods.length ? '1fr 1fr' : '1fr', gap: 10 }}>
        <Field label="Moeda">
          <select className="select" value={cur.id} onChange={(e) => set({ currency: e.target.value, method: '' })} data-testid="xpag-currency">
            {XPAG_CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </Field>
        {cur.methods.length > 0 && (
          <Field label="Forma de pagamento">
            <select className="select" value={d.method || cur.methods[0][0]} onChange={(e) => set({ method: e.target.value })} data-testid="xpag-method">
              {cur.methods.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label="Produto" right={<button type="button" className="linkbtn" onClick={openProducts}><Icon name="dollar" size={12} />Gerenciar produtos</button>}>
        <select className="select" value={d.productId ?? ''} data-testid="xpag-product" onChange={(e) => {
          // a moeda do produto manda: o bloco passa a cobrar nela
          const p = lookups.products.find((x) => x.id === e.target.value);
          const pc = p?.currency ?? 'BRL';
          set(p && XPAG_CURRENCIES.some((c) => c.id === pc) && pc !== d.currency ? { productId: e.target.value, currency: pc, method: '' } : { productId: e.target.value });
        }}>
          <option value="">Valor personalizado</option>
          {lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.currency ?? 'BRL'} {Number(p.price).toFixed(2)}</option>)}
        </select>
      </Field>
      {d.productId
        ? <small className="faint" style={{ display: 'block', marginTop: -4 }}>Cobra o valor padrão do produto em {cur.id}: {SYMBOL[cur.id]} {Number(lookups.products.find((p) => p.id === d.productId)?.price ?? 0).toFixed(2)}.</small>
        : <>
          <Field label={`Valor (${cur.id})`}><VarInput value={d.amount ?? ''} onChange={(amount) => set({ amount })} vars={vars} placeholder={cur.id === 'MXN' ? '499,00 ou {{valor}}' : '97,00 ou {{valor}}'} testId="xpag-amount" /></Field>
          <Field label="Descrição"><VarInput value={d.description ?? ''} onChange={(description) => set({ description })} vars={vars} placeholder="Ex.: Consultoría individual" testId="xpag-description" /></Field>
        </>}
      {d.method === 'OXXO' && <small className="faint" style={{ display: 'block' }}>No OXXO, o valor precisa ficar entre 10 e 10.000 MXN, e a ficha vale 12 dias.</small>}
      <Field label="Mensagem"><RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={[...vars, 'instrucoes', 'link', 'produto', 'preco']} rows={3} /></Field>
      <small className="faint" style={{ display: 'block', marginTop: -4 }}>{'{{instrucoes}}'} traz os dados para pagar; se a mensagem não tiver, eles vão no fim.</small>
      <ToggleCard title="Aguardar o pagamento" desc="Saídas “Pago” e “Não pago”. A confirmação chega direto da XPag." checked={!!d.wait} onChange={(wait) => set({ wait })} />
      {d.wait && <Field label="Tempo limite (minutos)"><input className="input" type="number" min={5} value={d.timeoutMinutes ?? 60} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })} /></Field>}
    </>
  );
}
