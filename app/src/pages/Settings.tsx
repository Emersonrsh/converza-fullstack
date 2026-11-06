import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Field, Spinner, toast } from '../components/ui';
import { ProductsManager } from '../components/Products';

interface Account { id: string; name: string; timezone: string; }
interface Tag { id: string; name: string; color: string; }

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
  return (
    <div>
      <b className="title">Produtos e links de pagamento</b>
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 14px', lineHeight: 1.5 }}>
        O bloco <b>Pagamento</b> dos fluxos envia o link do produto ao cliente e espera a confirmação da venda.
      </p>
      <ProductsManager />
    </div>
  );
}
