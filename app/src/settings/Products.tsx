import { ProductsManager } from '../components/Products';
import { Head } from './common';

export function ProductsPage() {
  return (
    <div data-testid="products-page">
      <Head slug="produtos" />
      <section className="st-card">
        <p className="muted" style={{ fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          O bloco <b>Pagamento</b> dos fluxos manda o link do produto para o cliente e espera a confirmação da venda (pelo webhook da plataforma de pagamento). O custo entra no lucro do Dashboard.
        </p>
        <ProductsManager />
      </section>
    </div>
  );
}
