import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Avatar, Modal, Field, Spinner, toast } from '../components/ui';
import type { Contact } from '../types';

const stageColor: Record<string, string> = { new: 'blue', in_service: 'amber', negotiating: 'teal', won: 'green', lost: 'red' };
const stageLabel: Record<string, string> = { new: 'Novo', in_service: 'Em atendimento', negotiating: 'Negociação', won: 'Ganho', lost: 'Perdido' };

export function Contacts() {
  const [list, setList] = useState<Contact[] | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');

  const load = (query = '') => api.get<{ contacts: Contact[] }>(`/contacts${query ? `?q=${encodeURIComponent(query)}` : ''}`)
    .then((r) => setList(r.contacts));

  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setTimeout(() => load(q), 300); return () => clearTimeout(t); }, [q]);

  async function create() {
    if (!name.trim() || !phone.trim()) return;
    try {
      await api.post('/contacts', { name, phone });
      setOpen(false); setName(''); setPhone(''); load(q); toast('Contato criado');
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row">
        <div className="chip" style={{ minWidth: 280, cursor: 'text' }}>
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou telefone"
            style={{ border: 0, background: 'transparent', outline: 'none', fontFamily: 'inherit', fontSize: 13, width: '100%', color: 'var(--text)' }} />
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} />Novo contato</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead><tr><th>Contato</th><th>Etapa</th><th>Etiquetas</th><th>Último contato</th><th>Valor</th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td><div className="row"><Avatar name={c.name} size={30} /><div><b>{c.name}</b><div className="faint" style={{ fontSize: 11.5 }}>{c.phone}</div></div></div></td>
                <td><span className={`pill ${stageColor[c.stage]}`}>{stageLabel[c.stage]}</span></td>
                <td><div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{c.tags.map((t) => <span key={t} className="pill" style={{ height: 20, fontSize: 10.5 }}>{t}</span>)}</div></td>
                <td className="muted">{c.lastContactAt ? new Date(c.lastContactAt).toLocaleDateString('pt-BR') : '—'}</td>
                <td><b>{Number(c.value) ? money(Number(c.value)) : '—'}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">Nenhum contato. Crie o primeiro ou receba uma mensagem no WhatsApp.</div>}
      </div>
      <div className="faint" style={{ fontSize: 12 }}>{list.length} contatos</div>

      {open && (
        <Modal title="Novo contato" onClose={() => setOpen(false)}
          footer={<><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" onClick={create}>Salvar</button></>}>
          <div className="grid" style={{ gap: 12 }}>
            <Field label="Nome"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Telefone (com DDI/DDD)"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+55 11 99999-9999" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
