import { useEffect, useState } from 'react';
import { api, num } from '../api';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Field, Spinner, toast } from '../components/ui';
import type { Campaign, Connection } from '../types';

const statusCol: Record<string, string> = { sending: 'teal', scheduled: 'amber', done: 'green', draft: '', canceled: 'red' };

export function Dispatch() {
  const [list, setList] = useState<Campaign[] | null>(null);
  const [conns, setConns] = useState<Connection[]>([]);
  const [form, setForm] = useState({ name: '', message: '', connectionId: '', audience: 'all' });

  const load = () => api.get<{ campaigns: Campaign[] }>('/dispatch').then((r) => setList(r.campaigns));
  useEffect(() => {
    load();
    api.get<{ connections: Connection[] }>('/connections').then((r) => setConns(r.connections));
  }, []);

  useEffect(() => {
    const sock = getSocket(); if (!sock) return;
    const onProg = () => load();
    sock.on('campaign:progress', onProg); sock.on('campaign:done', onProg);
    return () => { sock.off('campaign:progress', onProg); sock.off('campaign:done', onProg); };
  }, []);

  async function create() {
    if (!form.name.trim() || !form.message.trim()) { toast('Preencha nome e mensagem'); return; }
    try {
      await api.post('/dispatch', {
        name: form.name, message: form.message,
        connectionId: form.connectionId || undefined,
        audience: form.audience === 'all' ? { all: true } : { stage: form.audience },
      });
      setForm({ name: '', message: '', connectionId: '', audience: 'all' });
      load(); toast('Disparo criado');
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
      <div className="card pad">
        <b className="title">Campanhas</b>
        <div className="grid" style={{ marginTop: 12, gap: 10 }}>
          {list.map((c) => (
            <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 13 }}>
              <div className="row"><b>{c.name}</b><div className="spacer" /><span className={`pill ${statusCol[c.status]} dot`}>{c.status}</span></div>
              <div className="row" style={{ margin: '10px 0 6px', fontSize: 12 }}>
                <span className="muted">{num(c.sentCount)} / {num(c.totalCount)} enviados</span></div>
              <div className="progress"><i style={{ width: `${c.totalCount ? (c.sentCount / c.totalCount) * 100 : 0}%` }} /></div>
            </div>
          ))}
          {list.length === 0 && <div className="empty">Nenhuma campanha ainda.</div>}
        </div>
      </div>

      <div className="card pad" style={{ height: 'fit-content' }}>
        <b className="title">Novo disparo</b>
        <div className="grid" style={{ gap: 12, marginTop: 14 }}>
          <Field label="Nome da campanha"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Público">
            <select className="select" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
              <option value="all">Todos os contatos</option>
              <option value="new">Etapa: Novo</option>
              <option value="negotiating">Etapa: Negociação</option>
              <option value="won">Etapa: Ganho</option>
            </select>
          </Field>
          <Field label="Conexão de envio">
            <select className="select" value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
              <option value="">Selecione…</option>
              {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Mensagem">
            <textarea className="input" rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Olá {{name}}, tudo bem? 👋" />
          </Field>
          <button className="btn primary" style={{ width: '100%' }} onClick={create}><Icon name="send" size={16} />Disparar</button>
        </div>
      </div>
    </div>
  );
}
