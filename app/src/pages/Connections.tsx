import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Field, Spinner, toast } from '../components/ui';
import { loadFbSdk, launchEmbeddedSignup } from '../metaSdk';
import type { Connection } from '../types';

interface ESConfig { configured: boolean; appId: string; configId: string; graphVersion: string; }

export function Connections() {
  const [list, setList] = useState<Connection[] | null>(null);
  const [es, setEs] = useState<ESConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', phoneNumberId: '', wabaId: '', displayPhone: '', accessToken: '' });

  const load = () => api.get<{ connections: Connection[] }>('/connections').then((r) => setList(r.connections));
  useEffect(() => {
    load();
    api.get<ESConfig>('/connections/embedded-signup/config').then(setEs).catch(() => setEs({ configured: false } as ESConfig));
  }, []);

  async function connectEmbedded() {
    if (!es?.configured) { setOpen(true); return; }
    setBusy(true);
    try {
      await loadFbSdk(es.appId, es.graphVersion);
      const r = await launchEmbeddedSignup(es.configId);
      if (!r.phoneNumberId || !r.wabaId) {
        toast('Não recebi os dados do número da Meta. Tente de novo.');
        return;
      }
      await api.post('/connections/embedded-signup/exchange', { code: r.code, phoneNumberId: r.phoneNumberId, wabaId: r.wabaId });
      await load();
      toast('WhatsApp conectado ✓');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Falha ao conectar');
    } finally { setBusy(false); }
  }

  async function createManual() {
    try {
      await api.post('/connections', form);
      setOpen(false); setForm({ name: '', phoneNumberId: '', wabaId: '', displayPhone: '', accessToken: '' });
      load(); toast('Conexão adicionada');
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }
  async function remove(id: string) { await api.del(`/connections/${id}`); load(); }

  if (!list) return <Spinner />;

  return (
    <div className="fade grid">
      <div className="row">
        <div className="spacer" />
        {es?.configured && <button className="btn sm ghost" onClick={() => setOpen(true)}>Conectar manualmente</button>}
        <button className="btn primary" onClick={connectEmbedded} disabled={busy}>
          <Icon name="plug" size={16} />{busy ? 'Conectando…' : 'Conectar WhatsApp'}
        </button>
      </div>

      {!es?.configured && (
        <div className="card pad" style={{ background: 'var(--accent-50)', borderColor: 'transparent' }}>
          <div className="row" style={{ gap: 10 }}><Icon name="bolt" size={18} />
            <div><b>Conexão em um clique (Embedded Signup)</b>
              <div className="muted" style={{ fontSize: 12.5 }}>Configure <code>META_APP_ID</code>, <code>META_APP_SECRET</code> e <code>META_EMBEDDED_SIGNUP_CONFIG_ID</code> no servidor para seus clientes conectarem o WhatsApp sem lidar com tokens. Sem isso, use o modo manual.</div></div></div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {list.map((c) => (
          <div className="card pad" key={c.id}>
            <div className="row"><div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--success-50)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="phone" size={20} /></div>
              <div className="spacer" /><span className={`pill ${c.status === 'connected' ? 'green' : 'red'} dot`}>{c.status === 'connected' ? 'conectado' : 'desconectado'}</span></div>
            <b style={{ fontSize: 15, display: 'block', marginTop: 12 }}>{c.name}</b>
            <div className="muted" style={{ fontSize: 13 }}>{c.displayPhone ?? c.phoneNumberId}</div>
            <div className="row" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div className="spacer" /><button className="btn sm" onClick={() => remove(c.id)}>Remover</button></div>
          </div>
        ))}
        {list.length === 0 && <div className="empty" style={{ gridColumn: 'span 3' }}>Nenhuma conexão ainda. Conecte um número do WhatsApp.</div>}
      </div>

      {open && (
        <Modal title="Conectar manualmente (Cloud API)" onClose={() => setOpen(false)}
          footer={<><button className="btn" onClick={() => setOpen(false)}>Cancelar</button><button className="btn primary" onClick={createManual}>Conectar</button></>}>
          <div className="grid" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Use quando o número já tem token próprio (Meta for Developers &gt; WhatsApp &gt; API Setup).</p>
            <Field label="Nome da conexão"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Vendas 01" /></Field>
            <Field label="Phone Number ID"><input className="input" value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} /></Field>
            <Field label="Número exibido"><input className="input" value={form.displayPhone} onChange={(e) => setForm({ ...form, displayPhone: e.target.value })} placeholder="+55 11 4002-8922" /></Field>
            <Field label="WABA ID (opcional)"><input className="input" value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} /></Field>
            <Field label="Access Token"><input className="input" type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
