import { Link } from 'react-router-dom';
import { Icon } from '../../icons';
import { money } from '../../api';
import { Field, RichText, ToggleCard, VarInput } from './fields';
import type { EditorProps } from './types';

/** Cartão (InfinitePay): gera um link de checkout com o valor certo para cada cliente e espera o pagamento. */
export function CardEditor({ d, set, vars, lookups, openProducts }: EditorProps) {
  return (
    <>
      <div className="fx-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, padding: '10px 12px', borderRadius: 10, background: 'var(--primary-50)', color: 'var(--text)' }}>
        <Icon name="card" size={15} />
        <span>Gera um link do <b>checkout da InfinitePay</b> (cartão de crédito em até 12x e Pix) para este cliente. Quando ele paga, a venda é aprovada, o <b>Pixel</b> recebe a compra e o fluxo segue por <b>Pago</b>. Configure a sua InfiniteTag em <Link to="/settings/produtos">Configurações › Produtos</Link>.</span>
      </div>
      <Field label="Produto" right={<button type="button" className="linkbtn" onClick={openProducts}><Icon name="dollar" size={12} />Gerenciar produtos</button>}>
        <select className="select" value={d.productId ?? ''} onChange={(e) => set({ productId: e.target.value })} data-testid="card-product">
          <option value="">Valor personalizado</option>
          {lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name} — {money(Number(p.price))}</option>)}
        </select>
      </Field>
      {!d.productId && <>
        <Field label="Valor (R$)"><VarInput value={d.amount ?? ''} onChange={(amount) => set({ amount })} vars={vars} placeholder="97,00 ou {{valor}}" testId="card-amount" /></Field>
        <Field label="Descrição no checkout"><VarInput value={d.description ?? ''} onChange={(description) => set({ description })} vars={vars} placeholder="Ex.: Consultoria individual" testId="card-description" /></Field>
      </>}
      <Field label="Mensagem"><RichText value={d.text ?? ''} onChange={(text) => set({ text })} vars={[...vars, 'link', 'produto', 'preco']} rows={3} /></Field>
      <ToggleCard title="Aguardar o pagamento" desc="Saídas “Pago” e “Não pago”. A confirmação chega direto da InfinitePay." checked={!!d.wait} onChange={(wait) => set({ wait })} />
      {d.wait && <Field label="Tempo limite (minutos)"><input className="input" type="number" min={5} value={d.timeoutMinutes ?? 60} onChange={(e) => set({ timeoutMinutes: Number(e.target.value) })} /></Field>}
    </>
  );
}
