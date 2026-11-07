import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner, toast } from '../components/ui';
import { Badge, EmptyBox, Head, LoadError, errMsg, useLoad, useSocketEvent } from './common';

interface Conn {
  id: string; name: string; displayPhone: string | null; status: string;
  welcomeFlowId: string | null; offHoursFlowId: string | null; fallbackFlowId: string | null; hoursEnabled: boolean;
}
interface Resp { connections: Conn[]; flows: { id: string; name: string; status: string }[]; canEdit: boolean }
type Slot = 'welcomeFlowId' | 'offHoursFlowId' | 'fallbackFlowId';

const SLOTS: { key: Slot; icon: string; title: string; desc: string }[] = [
  { key: 'welcomeFlowId', icon: 'smile', title: 'Boas-vindas', desc: 'Primeira mensagem de um contato novo, quando nenhum fluxo tem gatilho para ela.' },
  { key: 'offHoursFlowId', icon: 'moon', title: 'Fora do horário', desc: 'Responde fora dos horários de trabalho do número (no máximo uma vez a cada 12 horas por contato). Quando responde, nada mais roda.' },
  { key: 'fallbackFlowId', icon: 'reply', title: 'Resposta padrão', desc: 'Quando nada mais respondeu: nenhum fluxo e nenhum agente de IA (no máximo uma vez por hora por contato).' },
];
const STATUS_TXT: Record<string, string> = { draft: 'rascunho', paused: 'pausado', active: 'ativo' };

function ConnCard({ c, flows, canEdit, onSaved }: { c: Conn; flows: Resp['flows']; canEdit: boolean; onSaved: () => void }) {
  const [v, setV] = useState({ welcomeFlowId: c.welcomeFlowId, offHoursFlowId: c.offHoursFlowId, fallbackFlowId: c.fallbackFlowId });
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV({ welcomeFlowId: c.welcomeFlowId, offHoursFlowId: c.offHoursFlowId, fallbackFlowId: c.fallbackFlowId }); }, [c]);
  const dirty = v.welcomeFlowId !== c.welcomeFlowId || v.offHoursFlowId !== c.offHoursFlowId || v.fallbackFlowId !== c.fallbackFlowId;
  async function save() {
    setBusy(true);
    try { await api.put(`/default-flows/${c.id}`, v); toast(`Fluxos padrões de ${c.name} salvos`); onSaved(); }
    catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  return (
    <section className="st-card" data-testid="df-card">
      <div className="st-card-h">
        <span className="st-stat-ic"><Icon name="phone" size={18} /></span>
        <div><b>{c.name}</b><small>{c.displayPhone ?? 'sem telefone confirmado'}</small></div>
        <Badge tone={c.status === 'connected' ? 'green' : 'amber'}>{c.status === 'connected' ? 'Conectado' : 'Desconectado'}</Badge>
        <span className="spacer" />
        {canEdit && <button type="button" className="btn primary sm" disabled={!dirty || busy} onClick={save} data-testid="df-save"><Icon name="save" size={14} />Salvar</button>}
      </div>
      <div className="stack" style={{ gap: 12 }}>
        {SLOTS.map((s) => {
          const f = flows.find((x) => x.id === v[s.key]);
          return (
            <div key={s.key} className="st-toggle-row" style={{ alignItems: 'flex-start' }}>
              <Icon name={s.icon} size={18} />
              <div>
                <b>{s.title}</b><small>{s.desc}</small>
                {s.key === 'offHoursFlowId' && v.offHoursFlowId && !c.hoursEnabled && (
                  <small style={{ color: 'var(--accent)' }}>Os horários de trabalho deste número estão desligados: este fluxo não vai rodar. <Link to="/settings/empresa">Ligar em Empresa › Horários</Link></small>
                )}
                {f && f.status === 'paused' && <small style={{ color: 'var(--accent)' }}>Esse fluxo está pausado: não vai rodar até você ativar (rascunho pode).</small>}
              </div>
              <select className="select" style={{ width: 260 }} disabled={!canEdit} value={v[s.key] ?? ''} onChange={(e) => setV({ ...v, [s.key]: e.target.value || null })} data-testid={`df-${s.key}`}>
                <option value="">Nenhum</option>
                {flows.map((x) => <option key={x.id} value={x.id}>{x.name}{x.status !== 'active' ? ` (${STATUS_TXT[x.status] ?? x.status})` : ''}</option>)}
              </select>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DefaultFlowsPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/default-flows'), [accountId]);
  useSocketEvent(['default-flows:changed', 'hours:changed'], () => void reload());
  if (error && !data) return <><Head slug="fluxos-padroes" /><LoadError error={error} onRetry={reload} /></>;
  if (!data) return <><Head slug="fluxos-padroes" /><Spinner /></>;
  return (
    <div data-testid="default-flows-page">
      <Head slug="fluxos-padroes" />
      <div className="hint" style={{ marginBottom: 16 }}>
        <Icon name="info" size={14} />
        <span>Ordem quando o cliente escreve: <b>1)</b> fluxo com palavra-chave · <b>2)</b> fora do horário · <b>3)</b> boas-vindas (contato novo) · <b>4)</b> outros gatilhos · <b>5)</b> agente de IA · <b>6)</b> resposta padrão. Conversas com atendimento humano não recebem nada automático.</span>
      </div>
      {data.connections.length === 0
        ? <div className="st-card"><EmptyBox icon="plug" title="Nenhum número conectado" text="Os fluxos padrões são por número de WhatsApp. Conecte um número em Conexões." /></div>
        : data.connections.map((c) => <ConnCard key={c.id} c={c} flows={data.flows} canEdit={data.canEdit} onSaved={() => void reload()} />)}
    </div>
  );
}
