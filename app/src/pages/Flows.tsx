import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import type { Flow } from '../types';

const nextStatus: Record<string, 'draft' | 'active' | 'paused'> = { draft: 'active', active: 'paused', paused: 'active' };
const col: Record<string, string> = { active: 'green', paused: 'amber', draft: '' };
const label: Record<string, string> = { active: 'ativo', paused: 'pausado', draft: 'rascunho' };

export function Flows() {
  const [list, setList] = useState<Flow[] | null>(null);
  const load = () => api.get<{ flows: Flow[] }>('/flows').then((r) => setList(r.flows));
  useEffect(() => { load(); }, []);

  async function create() {
    await api.post('/flows', { name: 'Novo fluxo', trigger: { type: 'inbound_message' } });
    load(); toast('Fluxo criado');
  }
  async function toggle(f: Flow) { await api.put(`/flows/${f.id}`, { status: nextStatus[f.status] }); load(); }
  async function rename(f: Flow) {
    const name = prompt('Nome do fluxo', f.name); if (!name) return;
    await api.put(`/flows/${f.id}`, { name }); load();
  }
  async function remove(id: string) { await api.del(`/flows/${id}`); load(); }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={create}><Icon name="plus" size={16} />Novo fluxo</button></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
        {list.map((f) => (
          <div className="card pad" key={f.id}>
            <div className="row">
              <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--primary-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}><Icon name="flow" size={20} /></div>
              <div style={{ flex: 1 }}><b>{f.name}</b><div className="faint" style={{ fontSize: 12 }}>{f.graph?.nodes?.length ?? 0} blocos</div></div>
              <span className={`pill ${col[f.status]} dot`}>{label[f.status]}</span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <button className="btn sm" onClick={() => toggle(f)}><Icon name={f.status === 'active' ? 'pause' : 'play'} size={14} />{f.status === 'active' ? 'Pausar' : 'Ativar'}</button>
              <button className="btn sm" onClick={() => rename(f)}>Renomear</button>
              <div className="spacer" />
              <button className="btn sm ghost" onClick={() => remove(f.id)}><Icon name="close" size={15} /></button>
            </div>
          </div>
        ))}
        {list.length === 0 && <div className="empty" style={{ gridColumn: 'span 2' }}>Nenhum fluxo. Crie o primeiro para automatizar as conversas.</div>}
      </div>
      <div className="card pad" style={{ background: 'var(--info-50)', borderColor: 'transparent' }}>
        <div className="row" style={{ gap: 10 }}><Icon name="flow" size={20} />
          <div><b>Editor visual</b><div className="muted" style={{ fontSize: 12.5 }}>O grafo (nós e conexões) fica salvo em cada fluxo e é executado pelo motor do backend ao receber mensagens. O construtor arrastar-e-soltar é o próximo passo da interface.</div></div></div>
      </div>
    </div>
  );
}
