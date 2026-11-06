import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Field, Spinner, toast } from '../components/ui';
import type { Webhook } from '../types';

export function Webhooks() {
  const [list, setList] = useState<Webhook[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const load = () => api.get<{ webhooks: Webhook[] }>('/webhooks').then((r) => setList(r.webhooks));
  useEffect(() => { load(); }, []);

  async function create() {
    if (!name.trim()) return;
    await api.post('/webhooks', { name, events: [] });
    setName(''); setOpen(false); load(); toast('Webhook criado');
  }
  async function remove(id: string) { await api.del(`/webhooks/${id}`); load(); }
  function copy(url: string) { navigator.clipboard?.writeText(url).then(() => toast('URL copiada')); }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} />Novo webhook</button></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead><tr><th>Nome</th><th>URL de entrada</th><th>Recebidos</th><th /></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id}>
                <td><b>{w.name}</b></td>
                <td><code style={{ background: 'var(--surface-2)', padding: '3px 8px', borderRadius: 7, fontSize: 12 }}>{w.url ?? w.token}</code></td>
                <td><b>{w.hits}</b></td>
                <td><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                  <button className="btn icon sm ghost" onClick={() => copy(w.url ?? w.token)}><Icon name="copy" size={16} /></button>
                  <button className="btn icon sm ghost" onClick={() => remove(w.id)}><Icon name="close" size={16} /></button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">Nenhum webhook. Crie um para receber eventos de Hotmart, Kiwify, Cartpanda, etc.</div>}
      </div>

      {open && (
        <Modal title="Novo webhook de entrada" onClose={() => setOpen(false)}
          footer={<><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" onClick={create}>Criar</button></>}>
          <Field label="Nome"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout — Hotmart" /></Field>
          <p className="muted" style={{ fontSize: 12.5 }}>Depois de criar, copie a URL gerada e cole na plataforma externa. Cada evento recebido cria/atualiza o contato e registra a venda.</p>
        </Modal>
      )}
    </div>
  );
}
