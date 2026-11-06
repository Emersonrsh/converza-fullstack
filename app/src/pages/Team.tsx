import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Avatar, Modal, Field, Spinner, toast } from '../components/ui';
import type { Member } from '../types';

const roleLabel: Record<string, string> = { owner: 'Dono', admin: 'Admin', agent: 'Atendente' };

export function Team() {
  const [list, setList] = useState<Member[] | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'admin' | 'agent'>('agent');
  const load = () => api.get<{ members: Member[] }>('/team').then((r) => setList(r.members));
  useEffect(() => { load(); }, []);

  async function invite() {
    try { await api.post('/team/invite', { email, role }); setOpen(false); setEmail(''); load(); toast('Membro adicionado'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }
  async function remove(id: string) { try { await api.del(`/team/${id}`); load(); } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); } }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={() => setOpen(true)}><Icon name="plus" size={16} />Adicionar membro</button></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table>
          <thead><tr><th>Pessoa</th><th>E-mail</th><th>Função</th><th /></tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.membershipId}>
                <td><div className="row"><Avatar name={m.name} size={30} /><b>{m.name}</b></div></td>
                <td className="muted">{m.email}</td>
                <td><span className={`pill ${m.role === 'owner' ? 'teal' : ''} dot`}>{roleLabel[m.role]}</span></td>
                <td>{m.role !== 'owner' && <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn icon sm ghost" onClick={() => remove(m.membershipId)}><Icon name="close" size={16} /></button></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal title="Adicionar membro" onClose={() => setOpen(false)}
          footer={<><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" onClick={invite}>Adicionar</button></>}>
          <div className="grid" style={{ gap: 12 }}>
            <Field label="E-mail (precisa já ter cadastro no Converza)"><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Função"><select className="select" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'agent')}>
              <option value="agent">Atendente</option><option value="admin">Admin</option></select></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
