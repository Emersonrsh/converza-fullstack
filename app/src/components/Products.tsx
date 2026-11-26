import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Spinner, toast } from './ui';
import { ALL_CURRENCIES, currencyName } from '../lib/currencies';
import type { Product } from '../types';

/** "97,90" | "1.297,00" | "2.500" (milhar) | "97.9" → número */
export function parsePrice(s: string): number {
  const t = s.trim().replace(/[R$\s]/g, '');
  if (!t) return NaN;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') // "2.500" e "1.500.000" = separador de milhar
      : t;
  const n = Number(norm);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
}
const priceText = (p: string | number) => Number(p).toFixed(2).replace('.', ',');
const validUrl = (u: string) => u.trim() === '' || /^https?:\/\/\S+$/i.test(u.trim());
const fmt = (v: number, currency = 'BRL') => {
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency }); } catch { return `${currency} ${v.toFixed(2)}`; }
};

interface Draft { name: string; currency: string; min: string; max: string; price: string; cost: string; checkoutUrl: string; slug: string; courseIds: string[] }
const emptyDraft: Draft = { name: '', currency: 'BRL', min: '', max: '', price: '', cost: '', checkoutUrl: '', slug: '', courseIds: [] };
const toDraft = (p: Product): Draft => ({
  name: p.name, currency: p.currency || 'BRL',
  min: p.minPrice != null ? priceText(p.minPrice) : '', max: p.maxPrice != null ? priceText(p.maxPrice) : '',
  price: Number(p.price) > 0 ? priceText(p.price) : '', cost: Number(p.cost ?? 0) ? priceText(p.cost ?? 0) : '', checkoutUrl: p.checkoutUrl ?? '', slug: p.membersSlug ?? '', courseIds: p.membersCourseIds ?? [],
});

/** Erros do formulário por campo (o mesmo que o servidor confere). */
function problems(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (!d.name.trim()) e.name = 'Informe o nome do produto';
  const min = parsePrice(d.min); const max = parsePrice(d.max); const price = parsePrice(d.price);
  if (Number.isNaN(min)) e.min = 'Informe o preço mínimo';
  if (Number.isNaN(max)) e.max = 'Informe o preço máximo';
  else if (!Number.isNaN(min) && min > max) e.max = 'O máximo precisa ser maior ou igual ao mínimo';
  if (Number.isNaN(price) || price <= 0) e.price = 'O valor padrão deve ser maior que zero';
  else if (!e.min && !e.max && (price < min || price > max)) e.price = 'O valor padrão precisa ficar entre o mínimo e o máximo';
  if (d.cost.trim() && Number.isNaN(parsePrice(d.cost))) e.cost = 'Custo inválido (ex.: 20,00)';
  if (!validUrl(d.checkoutUrl)) e.checkoutUrl = 'O link precisa começar com https://';
  if (d.slug && !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(d.slug)) e.slug = 'De 3 a 40 letras minúsculas, números ou hífens';
  return e;
}

const slugify = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
const appHost = () => window.location.origin.replace(/^https?:\/\//, '');

/** Endereço próprio da área de membros do produto e os cursos que aparecem nela. */
function MembersAreaField({ d, set, err, saved }: { d: Draft; set: (p: Partial<Draft>) => void; err: React.ReactNode; saved: string | null }) {
  const [courses, setCourses] = useState<{ id: string; title: string; productId: string | null; published: boolean }[] | null>(null);
  const [on, setOn] = useState(!!d.slug);
  useEffect(() => { api.get<{ courses: { id: string; title: string; productId: string | null; published: boolean }[] }>('/members/courses').then((r) => setCourses(r.courses)).catch(() => setCourses([])); }, []);
  const url = `${window.location.origin}/m/${saved ?? d.slug}`;
  return (
    <div className="pm-area" data-testid="pm-area">
      <label className="pm-area-hd">
        <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); set(e.target.checked ? { slug: d.slug || slugify(d.name) } : { slug: '' }); }} data-testid="pm-area-on" />
        <span><b>Área de membros própria</b><small>Um endereço só deste produto, com o nome dele e só os cursos escolhidos.</small></span>
      </label>
      {on && (
        <>
          <div className="pm-slug">
            <span>{appHost()}/m/</span>
            <input className="input" value={d.slug} maxLength={40} placeholder="natal-lucrativo" onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} data-testid="pm-slug" />
          </div>
          {err}
          <div className="label" style={{ marginTop: 8 }}>Cursos nesta área</div>
          {!courses ? <Spinner /> : !courses.length ? <div className="cf-hint">Nenhum curso criado ainda na Converza Members.</div> : (
            <div className="pm-courses">
              {courses.map((c) => (
                <label key={c.id} className="pm-course" data-testid="pm-course">
                  <input type="checkbox" checked={d.courseIds.includes(c.id)} onChange={(e) => set({ courseIds: e.target.checked ? [...d.courseIds, c.id] : d.courseIds.filter((x) => x !== c.id) })} />
                  <span>{c.title}{!c.published && <small> · rascunho</small>}</span>
                </label>
              ))}
            </div>
          )}
          <div className="cf-hint">Sem nenhum marcado, aparecem os cursos ligados a este produto. Os links de acesso dos cursos daqui já levam para este endereço.</div>
          {saved && saved === d.slug && (
            <div className="pm-area-link">
              <a href={url} target="_blank" rel="noreferrer" data-testid="pm-area-link">{url.replace(/^https?:\/\//, '')}</a>
              <button type="button" className="btn sm ghost" onClick={() => { void navigator.clipboard?.writeText(url); toast('Link copiado'); }}><Icon name="copy" size={13} />Copiar</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [d, setD] = useState<Draft>(product ? toDraft(product) : emptyDraft);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const errs = problems(d);
  const show = (k: keyof Draft) => (tried && errs[k] ? <div className="pm-err" data-testid={`pm-err-${k}`}>{errs[k]}</div> : null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  async function save() {
    setTried(true);
    if (Object.keys(errs).length) return;
    const body = {
      name: d.name.trim(), currency: d.currency, minPrice: parsePrice(d.min), maxPrice: parsePrice(d.max), price: parsePrice(d.price),
      cost: d.cost.trim() ? parsePrice(d.cost) : 0, checkoutUrl: d.checkoutUrl.trim(),
      membersSlug: d.slug, membersCourseIds: d.courseIds,
    };
    setBusy(true);
    try {
      if (product) await api.patch(`/settings/products/${product.id}`, body);
      else await api.post('/settings/products', body);
      await onSaved();
      toast(product ? 'Produto salvo ✓' : 'Produto criado ✓');
      onClose();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title={product ? 'Editar produto' : 'Novo produto'} subtitle="Cadastre produtos com faixa de preço e valor padrão para vendas e integrações." onClose={onClose} width={520}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="pm-save">{busy ? 'Salvando…' : product ? 'Salvar' : 'Criar'}</button>
      </>}>
      <div className="grid pm-form" style={{ gap: 14 }}>
        <div>
          <label className="label">Nome <span className="req">*</span></label>
          <input className="input" autoFocus value={d.name} maxLength={160} placeholder="Ex.: Plano Premium" onChange={(e) => set({ name: e.target.value })} data-testid="pm-name" />
          {show('name')}
        </div>
        <div>
          <label className="label">Moeda <span className="req">*</span></label>
          <select className="select" value={d.currency} onChange={(e) => set({ currency: e.target.value })} data-testid="pm-currency">
            {[...new Set(['BRL', 'USD', 'EUR', d.currency, ...ALL_CURRENCIES])].map((c) => <option key={c} value={c}>{c} · {currencyName(c)}</option>)}
          </select>
          <div className="cf-hint">Os preços mínimo, máximo e padrão serão interpretados nesta moeda.</div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="label">Preço mínimo <span className="req">*</span></label>
            <input className="input" inputMode="decimal" placeholder="0,00" value={d.min} onChange={(e) => set({ min: e.target.value })} data-testid="pm-min" />
            {show('min')}
          </div>
          <div>
            <label className="label">Preço máximo <span className="req">*</span></label>
            <input className="input" inputMode="decimal" placeholder="0,00" value={d.max} onChange={(e) => set({ max: e.target.value })} data-testid="pm-max" />
            {show('max')}
          </div>
        </div>
        <div>
          <label className="label">Valor padrão (fallback) <span className="req">*</span></label>
          <input className="input" inputMode="decimal" placeholder="0,00" value={d.price} onChange={(e) => set({ price: e.target.value })} data-testid="pm-price" />
          {show('price')}
          <div className="cf-hint">Usado quando não houver outro valor definido (venda do fluxo sem valor, ou com valor fora da faixa) e nos links de pagamento. Deve ser maior que zero.</div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <div>
            <label className="label">Custo por venda</label>
            <input className="input" inputMode="decimal" placeholder="0,00" value={d.cost} onChange={(e) => set({ cost: e.target.value })} data-testid="pm-cost" />
            {show('cost')}
          </div>
          <div>
            <label className="label">Link de pagamento</label>
            <input className="input" placeholder="https://pay.hotmart.com/..." value={d.checkoutUrl} onChange={(e) => set({ checkoutUrl: e.target.value })} data-testid="pm-link" />
            {show('checkoutUrl')}
          </div>
        </div>
        <MembersAreaField d={d} set={set} err={show('slug')} saved={product?.membersSlug ?? null} />
        <div className="cf-hint" style={{ marginTop: -4 }}>
          A faixa confere o valor das vendas: no bloco <b>Registrar venda</b> um valor fora dela vira o valor padrão, a IA pode recusar
          comprovante fora da faixa e uma venda de webhook sem produto reconhecido é ligada ao produto cuja faixa cobre o valor.
        </div>
      </div>
    </Modal>
  );
}

/**
 * Cadastro de produtos: moeda, faixa de preço (mínimo e máximo), valor padrão, custo e link de pagamento.
 * Usado pelos blocos de pagamento e de venda dos fluxos, pela validação de comprovante e pelas vendas do dashboard.
 */
export function ProductsManager({ onChange }: { onChange?: (list: Product[]) => void }) {
  const [list, setList] = useState<Product[] | null>(null);
  const [modal, setModal] = useState<Product | 'new' | null>(null);

  const load = async () => {
    const r = await api.get<{ products: Product[] }>('/settings/products');
    setList(r.products);
    onChange?.(r.products);
    window.dispatchEvent(new Event('converza:products')); // menu "Dashboards" da barra lateral
  };
  useEffect(() => { load().catch((e) => toast((e as Error).message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(p: Product) {
    if (!confirm(`Excluir o produto “${p.name}”? Blocos de pagamento que usam ele vão parar de funcionar.`)) return;
    try { await api.del(`/settings/products/${p.id}`); await load(); } catch (e) { toast((e as Error).message); }
  }

  if (!list) return <Spinner />;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card" style={{ overflow: 'hidden', boxShadow: 'none' }}>
        <table>
          <thead><tr><th>Produto</th><th>Faixa de preço</th><th style={{ width: 120 }}>Valor padrão</th><th style={{ width: 100 }} title="Custo por venda — usado no lucro do dashboard">Custo</th><th>Link de pagamento</th><th style={{ width: 80 }} /></tr></thead>
          <tbody>
            {list.map((p) => {
              const cur = p.currency || 'BRL';
              return (
                <tr key={p.id} data-testid="product-row">
                  <td><b>{p.name}</b>{cur !== 'BRL' && <span className="pill" style={{ marginLeft: 6 }}>{cur}</span>}</td>
                  <td>{p.minPrice != null && p.maxPrice != null ? `${fmt(Number(p.minPrice), cur)} a ${fmt(Number(p.maxPrice), cur)}` : <span className="pill amber" title="Edite para definir o mínimo e o máximo">sem faixa</span>}</td>
                  <td>{fmt(Number(p.price), cur)}</td>
                  <td className="muted">{Number(p.cost ?? 0) ? fmt(Number(p.cost), cur) : '—'}</td>
                  <td style={{ maxWidth: 260 }}>
                    {p.checkoutUrl
                      ? <a href={p.checkoutUrl} target="_blank" rel="noreferrer" className="faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.checkoutUrl}</a>
                      : <span className="pill amber">sem link</span>}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 2 }}>
                      <button type="button" className="btn icon sm ghost" aria-label="Editar" onClick={() => setModal(p)}><Icon name="edit" size={15} /></button>
                      <button type="button" className="btn icon sm ghost" aria-label="Excluir" onClick={() => remove(p)}><Icon name="trash" size={15} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty" style={{ padding: 24 }}>Nenhum produto ainda. Clique em <b>Novo produto</b> para cadastrar.</div>}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn primary" onClick={() => setModal('new')} data-testid="product-new"><Icon name="plus" size={15} />Novo produto</button>
      </div>
      <div className="cf-hint" style={{ marginTop: -4 }}>
        Para o fluxo saber quando o cliente pagou, configure o webhook da plataforma de pagamento em <b>Webhooks</b>.
      </div>
      {modal && <ProductModal product={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={load} />}
    </div>
  );
}
