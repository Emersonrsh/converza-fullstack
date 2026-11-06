import { useEffect, useState } from 'react';
import { api, num } from '../api';
import { Icon } from '../icons';
import { Switch, Modal, Field, Spinner, toast } from '../components/ui';
import type { Agent } from '../types';

// IDs no formato do OpenRouter (um gateway, uma chave, vários provedores).
const MODELS = [
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-1.5-pro',
  'anthropic/claude-3.5-sonnet',
];

export function Agents() {
  const [list, setList] = useState<Agent[] | null>(null);
  const [edit, setEdit] = useState<Agent | null>(null);
  const load = () => api.get<{ agents: Agent[] }>('/agents').then((r) => setList(r.agents));
  useEffect(() => { load(); }, []);

  async function create() { const { agent } = await api.post<{ agent: Agent }>('/agents', { name: 'Novo agente' }); setEdit(agent); load(); }
  async function toggle(a: Agent) { await api.put(`/agents/${a.id}`, { enabled: !a.enabled }); load(); }
  async function save() {
    if (!edit) return;
    await api.put(`/agents/${edit.id}`, { name: edit.name, model: edit.model, systemPrompt: edit.systemPrompt });
    setEdit(null); load(); toast('Agente salvo');
  }
  async function remove(id: string) { await api.del(`/agents/${id}`); setEdit(null); load(); }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row"><div className="spacer" /><button className="btn primary" onClick={create}><Icon name="plus" size={16} />Novo agente</button></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {list.map((a) => (
          <div className="card pad" key={a.id}>
            <div className="row"><div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--primary-50)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="bot" size={22} /></div>
              <div className="spacer" /><Switch on={a.enabled} onClick={() => toggle(a)} /></div>
            <b style={{ fontSize: 15, display: 'block', marginTop: 12 }}>{a.name}</b>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.45, minHeight: 34 }}>{a.systemPrompt || 'Sem instruções ainda.'}</div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}><span className="pill blue">{a.model}</span></div>
            <div className="row" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <span className={`pill ${a.enabled ? 'green' : ''} dot`}>{a.enabled ? 'ativo' : 'inativo'}</span><div className="spacer" />
              <button className="btn sm" onClick={() => setEdit(a)}><Icon name="gear" size={14} />Configurar</button></div>
          </div>
        ))}
        {list.length === 0 && <div className="empty" style={{ gridColumn: 'span 3' }}>Nenhum agente. Crie um atendente de IA.</div>}
      </div>

      {edit && (
        <Modal title="Configurar agente" onClose={() => setEdit(null)}
          footer={<><button className="btn" style={{ marginRight: 'auto' }} onClick={() => remove(edit.id)}>Excluir</button>
            <button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Salvar</button></>}>
          <div className="grid" style={{ gap: 12 }}>
            <Field label="Nome"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Modelo">
              <select className="select" value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })}>
                {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Instruções (system prompt)">
              <textarea className="input" rows={5} value={edit.systemPrompt} onChange={(e) => setEdit({ ...edit, systemPrompt: e.target.value })}
                placeholder="Você é um closer de vendas. Qualifique o lead, contorne objeções e envie o link de pagamento." />
            </Field>
            <div className="faint" style={{ fontSize: 11.5 }}>A execução do agente usa a chave do provedor de IA configurada no backend.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
