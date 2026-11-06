import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Field, Spinner, toast, cx } from '../components/ui';

interface Account { id: string; name: string; timezone: string; }
interface Tag { id: string; name: string; color: string; }
interface Product { id: string; name: string; price: string; }

export function Settings() {
  const [tab, setTab] = useState<'conta' | 'etiquetas' | 'produtos'>('conta');
  return (
    <div className="fade grid" style={{ gridTemplateColumns: '200px 1fr', alignItems: 'start' }}>
      <div className="card pad" style={{ padding: 8 }}>
        {(['conta', 'etiquetas', 'produtos'] as const).map((t) => (
          <button key={t} className="navitem" style={{ color: 'var(--text)', background: tab === t ? 'var(--surface-2)' : 'transparent', textTransform: 'capitalize' }} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="card pad">
        {tab === 'conta' && <AccountTab />}
        {tab === 'etiquetas' && <TagsTab />}
        {tab === 'produtos' && <ProductsTab />}
      </div>
    </div>
  );
}

function AccountTab() {
  const [acc, setAcc] = useState<Account | null>(null);
  useEffect(() => { api.get<{ account: Account }>('/settings/account').then((r) => setAcc(r.account)); }, []);
  if (!acc) return <Spinner />;
  async function save() { if (!acc) return; await api.patch('/settings/account', { name: acc.name, timezone: acc.timezone }); toast('Salvo'); }
  return (
    <div className="grid" style={{ maxWidth: 460, gap: 12 }}>
      <b className="title">Dados da empresa</b>
      <Field label="Nome da operação"><input className="input" value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} /></Field>
      <Field label="Fuso horário"><input className="input" value={acc.timezone} onChange={(e) => setAcc({ ...acc, timezone: e.target.value })} /></Field>
      <button className="btn primary" style={{ width: 'fit-content' }} onClick={save}>Salvar</button>
    </div>
  );
}

function TagsTab() {
  const [list, setList] = useState<Tag[] | null>(null);
  const [name, setName] = useState('');
  const load = () => api.get<{ tags: Tag[] }>('/settings/tags').then((r) => setList(r.tags));
  useEffect(() => { load(); }, []);
  async function add() { if (!name.trim()) return; await api.post('/settings/tags', { name }); setName(''); load(); }
  async function del(id: string) { await api.del(`/settings/tags/${id}`); load(); }
  if (!list) return <Spinner />;
  return (
    <div>
      <b className="title">Etiquetas</b>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
        {list.map((t) => <span key={t.id} className="pill" style={{ cursor: 'pointer' }} onClick={() => del(t.id)}>{t.name} <Icon name="close" size={12} /></span>)}
        {list.length === 0 && <span className="faint">Nenhuma etiqueta ainda.</span>}
      </div>
      <div className="row" style={{ maxWidth: 360 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova etiqueta" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn primary" onClick={add}><Icon name="plus" size={15} /></button>
      </div>
    </div>
  );
}

function ProductsTab() {
  const [list, setList] = useState<Product[] | null>(null);
  const [name, setName] = useState(''); const [price, setPrice] = useState('');
  const load = () => api.get<{ products: Product[] }>('/settings/products').then((r) => setList(r.products));
  useEffect(() => { load(); }, []);
  async function add() { if (!name.trim()) return; await api.post('/settings/products', { name, price: Number(price) || 0 }); setName(''); setPrice(''); load(); }
  async function del(id: string) { await api.del(`/settings/products/${id}`); load(); }
  if (!list) return <Spinner />;
  return (
    <div>
      <b className="title">Produtos</b>
      <div className="card" style={{ overflow: 'hidden', margin: '12px 0' }}>
        <table><thead><tr><th>Produto</th><th>Preço</th><th /></tr></thead>
          <tbody>{list.map((p) => <tr key={p.id}><td><b>{p.name}</b></td><td>{money(Number(p.price))}</td>
            <td><button className={cx('btn', 'icon', 'sm', 'ghost')} onClick={() => del(p.id)}><Icon name="close" size={15} /></button></td></tr>)}</tbody>
        </table>
        {list.length === 0 && <div className="empty">Nenhum produto.</div>}
      </div>
      <div className="row" style={{ maxWidth: 460 }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do produto" />
        <input className="input" style={{ maxWidth: 120 }} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Preço" type="number" />
        <button className="btn primary" onClick={add}><Icon name="plus" size={15} /></button>
      </div>
    </div>
  );
}
