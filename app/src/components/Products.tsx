import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from './ui';
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

interface Draft { name: string; price: string; cost: string; checkoutUrl: string; }
const emptyDraft: Draft = { name: '', price: '', cost: '', checkoutUrl: '' };

/**
 * Cadastro de produtos com link de pagamento (Hotmart, Kiwify, Mercado Pago…),
 * usado pelo bloco Pagamento dos fluxos e pelas vendas do dashboard.
 */
export function ProductsManager({ onChange }: { onChange?: (list: Product[]) => void }) {
  const [list, setList] = useState<Product[] | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get<{ products: Product[] }>('/settings/products');
    setList(r.products);
    onChange?.(r.products);
  };
  useEffect(() => { load().catch((e) => toast((e as Error).message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function check(d: Draft): string | null {
    if (!d.name.trim()) return 'Informe o nome do produto';
    if (Number.isNaN(parsePrice(d.price))) return 'Preço inválido (ex.: 97,00)';
    if (d.cost.trim() && Number.isNaN(parsePrice(d.cost))) return 'Custo inválido (ex.: 20,00)';
    if (!validUrl(d.checkoutUrl)) return 'O link precisa começar com https://';
    return null;
  }

  async function add() {
    const err = check(draft);
    if (err) { toast(err); return; }
    setBusy(true);
    try {
      await api.post('/settings/products', { name: draft.name.trim(), price: parsePrice(draft.price), cost: draft.cost.trim() ? parsePrice(draft.cost) : 0, checkoutUrl: draft.checkoutUrl.trim() });
      setDraft(emptyDraft);
      await load();
      toast('Produto adicionado ✓');
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  async function save(id: string) {
    const err = check(edit);
    if (err) { toast(err); return; }
    setBusy(true);
    try {
      await api.patch(`/settings/products/${id}`, { name: edit.name.trim(), price: parsePrice(edit.price), cost: edit.cost.trim() ? parsePrice(edit.cost) : 0, checkoutUrl: edit.checkoutUrl.trim() });
      setEditing(null);
      await load();
      toast('Produto salvo ✓');
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(p: Product) {
    if (!confirm(`Excluir o produto “${p.name}”? Blocos de pagamento que usam ele vão parar de funcionar.`)) return;
    try { await api.del(`/settings/products/${p.id}`); await load(); } catch (e) { toast((e as Error).message); }
  }

  if (!list) return <Spinner />;

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card" style={{ overflow: 'hidden', boxShadow: 'none' }}>
        <table>
          <thead><tr><th>Produto</th><th style={{ width: 110 }}>Preço</th><th style={{ width: 100 }} title="Custo por venda — usado no lucro do dashboard">Custo</th><th>Link de pagamento</th><th style={{ width: 84 }} /></tr></thead>
          <tbody>
            {list.map((p) => editing === p.id ? (
              <tr key={p.id}>
                <td><input className="input sm" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></td>
                <td><input className="input sm" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></td>
                <td><input className="input sm" value={edit.cost} placeholder="0,00" onChange={(e) => setEdit({ ...edit, cost: e.target.value })} /></td>
                <td><input className="input sm" value={edit.checkoutUrl} placeholder="https://..." onChange={(e) => setEdit({ ...edit, checkoutUrl: e.target.value })} /></td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <button type="button" className="btn icon sm primary" disabled={busy} onClick={() => save(p.id)} aria-label="Salvar"><Icon name="check" size={15} /></button>
                    <button type="button" className="btn icon sm ghost" onClick={() => setEditing(null)} aria-label="Cancelar"><Icon name="close" size={15} /></button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td>{money(Number(p.price))}</td>
                <td className="muted">{Number(p.cost ?? 0) ? money(Number(p.cost)) : '—'}</td>
                <td style={{ maxWidth: 260 }}>
                  {p.checkoutUrl
                    ? <a href={p.checkoutUrl} target="_blank" rel="noreferrer" className="faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.checkoutUrl}</a>
                    : <span className="pill amber">sem link</span>}
                </td>
                <td>
                  <div className="row" style={{ gap: 2 }}>
                    <button type="button" className="btn icon sm ghost" aria-label="Editar"
                      onClick={() => { setEditing(p.id); setEdit({ name: p.name, price: priceText(p.price), cost: Number(p.cost ?? 0) ? priceText(p.cost ?? 0) : '', checkoutUrl: p.checkoutUrl ?? '' }); }}><Icon name="edit" size={15} /></button>
                    <button type="button" className="btn icon sm ghost" aria-label="Excluir" onClick={() => remove(p)}><Icon name="trash" size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty" style={{ padding: 24 }}>Nenhum produto ainda. Cadastre abaixo com o link de checkout.</div>}
      </div>

      <div className="row prod-form" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 160px' }} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Nome do produto" />
        <input className="input" style={{ flex: '0 0 110px' }} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="Preço 97,00" inputMode="decimal" />
        <input className="input" style={{ flex: '0 0 110px' }} value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} placeholder="Custo 0,00" inputMode="decimal" title="Custo por venda (lucro do dashboard)" />
        <input className="input" style={{ flex: '2 1 220px' }} value={draft.checkoutUrl} onChange={(e) => setDraft({ ...draft, checkoutUrl: e.target.value })}
          placeholder="Link de pagamento (https://pay.hotmart.com/...)" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className="btn primary" disabled={busy} onClick={add}><Icon name="plus" size={15} />Adicionar</button>
      </div>
      <div className="cf-hint" style={{ marginTop: -4 }}>
        Para o fluxo saber quando o cliente pagou, configure o webhook da plataforma de pagamento em <b>Webhooks</b>.
      </div>
    </div>
  );
}
