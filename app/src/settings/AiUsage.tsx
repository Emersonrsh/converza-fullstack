import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Spinner } from '../components/ui';
import { Badge, DaySpark, Drawer, EmptyBox, Head, LoadError, SearchBox, StatTile, fmtDateTime, fmtNum, relTime, useDebounced, useLoad, useSocketEvent } from './common';

interface Session {
  key: string; type: 'conversation' | 'tool'; title: string; conversationId: string | null;
  contact: { id: string; name: string | null; phone: string | null } | null;
  kinds: { kind: string; label: string }[]; calls: number; tokens: number; firstAt: string; lastAt: string;
}
interface Resp {
  days: number;
  totals: { tokens: number; calls: number; conversations: number; conversationTokens: number; toolTokens: number; perConversation: number };
  byKind: { kind: string; label: string; tokens: number; calls: number; inConversation: boolean }[];
  byDay: { day: string; tokens: number }[];
  sessions: Session[]; balance: number; usedTotal: number; house?: boolean;
}
interface Detail {
  key: string; type: string; title: string; conversationId: string | null; tokens: number;
  items: { id: string; kind: string; kindLabel: string; label: string; tokens: number; createdAt: string; agent: { id: string; name: string | null } | null; flow: { id: string; name: string | null } | null }[];
}

const KIND_ICON: Record<string, string> = {
  agent_reply: 'bot', agent_voice: 'mic', transcription: 'mic', flow_ai: 'flow', agent_test: 'bot', agent_create: 'sparkles',
  flow_generate: 'sparkles', flow_simulate: 'play', flow_translate: 'translate', voice_preview: 'mic', dictation: 'mic', other: 'bolt',
};

function SessionDrawer({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const { data, error } = useLoad(() => api.get<Detail>(`/ai-usage/session?key=${encodeURIComponent(sessionKey)}`), [sessionKey]);
  return (
    <Drawer title={data?.title ?? 'Uso da IA'} onClose={onClose} actions={data?.conversationId && <Link className="btn sm" to={`/inbox?c=${data.conversationId}`}><Icon name="chats" size={14} />Abrir conversa</Link>}>
      {error && <div className="hint"><Icon name="alert" size={14} />{error}</div>}
      {!data && !error && <Spinner />}
      {data && (
        <div data-testid="usage-detail">
          <div className="st-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <StatTile icon="bolt" tone="amber" value={fmtNum(data.tokens)} label="Tokens nesta sessão" />
            <StatTile icon="history" value={data.items.length} label="Cobranças" />
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {data.items.map((i) => (
              <div key={i.id} className="st-file" style={{ alignItems: 'flex-start' }} data-testid="usage-item">
                <span className="st-stat-ic" style={{ width: 32, height: 32 }}><Icon name={KIND_ICON[i.kind] ?? 'bolt'} size={15} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{i.label || i.kindLabel}</b>
                  <div className="st-mini">{i.kindLabel}{i.agent?.name ? ` · agente ${i.agent.name}` : ''}{i.flow?.name ? ` · fluxo ${i.flow.name}` : ''} · {fmtDateTime(i.createdAt)}</div>
                </div>
                <b style={{ whiteSpace: 'nowrap' }}>{fmtNum(i.tokens)}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function AiUsagePage() {
  const { accountId } = useAuth();
  const [days, setDays] = useState(30);
  const [scope, setScope] = useState('all');
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const qs = `days=${days}&scope=${scope}&sort=${sort}${dq.trim() ? `&q=${encodeURIComponent(dq.trim())}` : ''}`;
  const { data, error, reload } = useLoad(() => api.get<Resp>(`/ai-usage?${qs}`), [accountId, qs]);
  useSocketEvent('tokens:update', () => void reload());
  const [open, setOpen] = useState<string | null>(null);

  const head = <Head slug="uso-ia" actions={
    <div className="seg" role="tablist">
      {[7, 30, 90].map((d) => <button type="button" key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)} data-testid={`usage-days-${d}`}>{d} dias</button>)}
    </div>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const t = data.totals;
  const maxKind = Math.max(1, ...data.byKind.map((k) => k.tokens));

  return (
    <div data-testid="ai-usage-page">
      {head}
      <div className="st-stats">
        <StatTile icon="bolt" tone="amber" value={fmtNum(t.tokens)} label={`Tokens em ${days} dias`} testId="usage-total" />
        <StatTile icon="chats" value={fmtNum(t.conversations)} label="Conversas com IA" />
        <StatTile icon="trend" tone="blue" value={fmtNum(t.perConversation)} label="Média por conversa" />
        <StatTile icon="sparkles" tone="green" value={data.house ? '∞' : fmtNum(data.balance)} label={data.house ? 'Saldo (conta da casa)' : 'Saldo atual'} />
      </div>

      <div className="st-grid2" style={{ marginBottom: 16 }}>
        <section className="st-card" style={{ marginBottom: 0 }}>
          <div className="st-card-h"><b>Por tipo de uso</b></div>
          {data.byKind.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>Nada gasto no período.</div> : (
            <div className="st-bars">
              {data.byKind.map((k) => (
                <div className="st-bar" key={k.kind} data-testid="usage-kind">
                  <span className="row" style={{ gap: 7 }}><Icon name={KIND_ICON[k.kind] ?? 'bolt'} size={14} />{k.label}</span>
                  <span className="track"><i style={{ width: `${(k.tokens / maxKind) * 100}%`, background: k.inConversation ? 'var(--primary)' : 'var(--accent)' }} /></span>
                  <span className="v">{fmtNum(k.tokens)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="st-mini" style={{ marginTop: 10 }}><span className="st-dot" style={{ background: 'var(--primary)' }} /> dentro de conversas · <span className="st-dot" style={{ background: 'var(--accent)' }} /> testes e ferramentas</div>
        </section>
        <section className="st-card" style={{ marginBottom: 0 }}>
          <div className="st-card-h"><b>Por dia</b><span className="spacer" /><small className="faint">{fmtNum(t.conversationTokens)} em conversas · {fmtNum(t.toolTokens)} em ferramentas</small></div>
          <DaySpark days={days} series={[data.byDay.map((d) => ({ day: d.day, n: d.tokens }))]} testId="usage-spark" />
          <div className="st-mini" style={{ marginTop: 8 }}>Tradução de fluxo tem a própria página, com o que foi reservado e devolvido: <Link to="/settings/traducoes">Traduções de fluxo</Link>.</div>
        </section>
      </div>

      <div className="st-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Buscar contato, telefone ou uso" testId="usage-search" />
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Mostrar" data-testid="usage-scope">
          <option value="all">Conversas e ferramentas</option>
          <option value="conversations">Só conversas</option>
          <option value="tools">Só testes e ferramentas</option>
        </select>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
          <option value="recent">Mais recentes</option>
          <option value="tokens">Mais tokens</option>
        </select>
      </div>

      {data.sessions.length === 0 ? (
        <div className="st-card"><EmptyBox icon="sparkles" title="Nenhum uso de IA no período" text="Cada resposta de agente, bloco de IA dos fluxos, áudio falado ou transcrito aparece aqui, agrupado por conversa. Testes no editor e o gerador de fluxos aparecem como ferramentas." /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Sessão</th><th>O que usou</th><th>Cobranças</th><th>Tokens</th><th>Última vez</th></tr></thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.key} style={{ cursor: 'pointer' }} onClick={() => setOpen(s.key)} data-testid="usage-session">
                  <td>
                    <div className="st-who">
                      <span className={s.type === 'conversation' ? 'st-stat-ic' : 'st-stat-ic amber'} style={{ width: 32, height: 32 }}><Icon name={s.type === 'conversation' ? 'chats' : 'sparkles'} size={15} /></span>
                      <div><b>{s.title}</b><small>{s.type === 'conversation' ? (s.contact?.phone ?? 'conversa') : 'teste / ferramenta'}</small></div>
                    </div>
                  </td>
                  <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{s.kinds.map((k) => <Badge key={k.kind} tone={s.type === 'conversation' ? 'teal' : 'amber'}>{k.label}</Badge>)}</div></td>
                  <td>{s.calls}</td>
                  <td><b>{fmtNum(s.tokens)}</b></td>
                  <td className="muted">{relTime(s.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint"><Icon name="info" size={14} />O valor é o que foi debitado do saldo de tokens (1.000 tokens = R$ 1). Se o saldo acabar no meio, conta só o que foi debitado. O histórico começou a ser registrado com esta versão — gastos anteriores não aparecem aqui.</div>
      {open && <SessionDrawer sessionKey={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
