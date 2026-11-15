import { ProductsManager } from '../components/Products';
import { Head } from './common';
import { InfinitePayCard } from './InfinitePay';

export function ProductsPage() {
  return (
    <div data-testid="products-page">
      <Head slug="produtos" />
      <InfinitePayCard />
      <section className="st-card">
        <p className="muted" style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          O bloco <b>Cartão (InfinitePay)</b> gera o link de pagamento com o preço do produto. Os blocos <b>Venda aprovada</b> e <b>Pagamento</b> usam o nome e o link cadastrados aqui. O custo entra no lucro do Dashboard.
        </p>
        <ProductsManager />
      </section>
    </div>
  );
}
