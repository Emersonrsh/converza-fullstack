import { useEffect, useState } from 'react';
import { api, num } from '../api';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import { FlowBuilder } from './FlowBuilder';
import type { Flow } from '../types';

const col: Record<string, string> = { active: 'green', paused: 'amber', draft: '' };
const label: Record<string, string> = { active: 'ativo', paused: 'pausado', draft: 'rascunho' };

export function Flows() {
  const [list, setList] = useState<Flow[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const load = () => api.get<{ flows: Flow[] }>('/flows').then((r) => setList(r.flows));
  useEffect(() => { if (!editing) load(); }, [editing]);

  async function create() {
    const r = await api.post<{ flow: Flow }>('/flows', { name: 'Novo fluxo', trigger: { type: 'inbound_message' } });
    setEditing(r.flow.id);
  }
  async function toggle(f: Flow) {
    await api.put(`/flows/${f.id}`, { status: f.status === 'active' ? 'paused' : 'active' });
    load(); toast(f.status === 'active' ? 'Fluxo pausado' : 'Fluxo ativado ✓');
  }
  async function remove(id: string) {
    if (!confirm('Excluir este fluxo?')) return;
    await api.del(`/flows/${id}`); load();
  }

  if (editing) return <FlowBuilder flowId={editing} onBack={() => setEditing(null)} />;
  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={create}><Icon name="plus" size={16} />Novo fluxo</button></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
        {list.map((f) => {
          const blocks = (f.graph?.nodes ?? []).filter((n) => n.type !== 'trigger').length;
          return (
            <div className="card pad" key={f.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(f.id)}>
              <div className="row">
                <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--primary-50)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}><Icon name="flow" size={20} /></div>
                <div style={{ flex: 1, minWidth: 0 }}><b>{f.name}</b>
                  <div className="faint" style={{ fontSize: 12 }}>{blocks} {blocks === 1 ? 'bloco' : 'blocos'} · {num(f.runs ?? 0)} execuções</div></div>
                <span className={`pill ${col[f.status]} dot`}>{label[f.status]}</span>
              </div>
              {blocks === 0 && <div className="pill amber" style={{ marginTop: 10, height: 'auto', padding: '6px 10px' }}>Vazio — clique para montar os blocos</div>}
              <div className="row" style={{ gap: 8, marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }} onClick={(e) => e.stopPropagation()}>
                <button className="btn sm primary" onClick={() => setEditing(f.id)}><Icon name="gear" size={14} />Editar fluxo</button>
                <button className="btn sm" onClick={() => toggle(f)} disabled={blocks === 0 && f.status !== 'active'}>
                  <Icon name={f.status === 'active' ? 'pause' : 'play'} size={14} />{f.status === 'active' ? 'Pausar' : 'Ativar'}
                </button>
                <div className="spacer" />
                <button className="btn sm ghost" onClick={() => remove(f.id)}><Icon name="close" size={15} /></button>
              </div>
            </div>
          );
        })}
        {list.length === 0 && <div className="empty" style={{ gridColumn: 'span 2' }}>Nenhum fluxo ainda. Crie o primeiro e monte os blocos no editor.</div>}
      </div>
    </div>
  );
}
