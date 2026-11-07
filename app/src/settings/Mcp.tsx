import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, cx, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { Badge, CodeBlock, CopyField, EmptyBox, Head, Kebab, LoadError, Tabs, errMsg, fmtNum, relTime, useLoad } from './common';

interface Tool { name: string; title: string; description: string; group: string; groupLabel: string; write: boolean }
interface ApiKey { id: string; name: string; prefix: string; tools: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string; createdByName: string | null; calls24h: number }
interface Call { id: string; tool: string; ok: boolean; error: string | null; summary: string; durationMs: number; createdAt: string; keyName: string }
interface Resp { keys: ApiKey[]; tools: Tool[]; groups: Record<string, string>; endpoint: string; rateLimit: number; protocolVersions: string[]; calls: Call[]; canCreate: boolean }

function ToolPicker({ tools, value, onChange }: { tools: Tool[]; value: string[]; onChange: (v: string[]) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Tool[]>();
    for (const t of tools) m.set(t.groupLabel, [...(m.get(t.groupLabel) ?? []), t]);
    return [...m.entries()];
  }, [tools]);
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n]);
  const readOnly = tools.filter((t) => !t.write).map((t) => t.name);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn sm" onClick={() => onChange(readOnly)} data-testid="mcp-only-read">Só consultar</button>
        <button type="button" className="btn sm" onClick={() => onChange(tools.map((t) => t.name))} data-testid="mcp-all">Todas</button>
        <button type="button" className="btn sm ghost" onClick={() => onChange([])}>Nenhuma</button>
        <span className="st-mini">{value.length} de {tools.length} liberadas</span>
      </div>
      {groups.map(([g, list]) => (
        <div key={g}>
          <div className="label">{g}</div>
          <div className="st-checks">
            {list.map((t) => (
              <label key={t.name} className={cx('st-check', value.includes(t.name) && 'on')} data-testid="mcp-tool">
                <input type="checkbox" checked={value.includes(t.name)} onChange={() => toggle(t.name)} />
                <div><b>{t.title} {t.write && <Badge tone="amber">faz alterações</Badge>}</b><small>{t.description}</small></div>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Snippets({ endpoint, secret }: { endpoint: string; secret: string }) {
  const [tab, setTab] = useState<'url' | 'code' | 'cursor' | 'desktop' | 'n8n'>('url');
  const urlWithKey = `${endpoint}/${secret}`;
  return (
    <div>
      <Tabs value={tab} onChange={setTab} tabs={[['url', 'Só URL'], ['code', 'Claude Code'], ['cursor', 'Cursor'], ['desktop', 'Claude Desktop'], ['n8n', 'n8n']]} />
      {tab === 'url' && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="st-help" style={{ marginTop: 0 }}>Para clientes que pedem só o endereço do servidor (conectores personalizados): a chave vai no próprio endereço. Trate como senha.</span>
          <CopyField value={urlWithKey} testId="mcp-url-key" />
        </div>
      )}
      {tab === 'code' && <CodeBlock code={`claude mcp add --transport http converza ${endpoint} --header "Authorization: Bearer ${secret}"`} />}
      {tab === 'cursor' && <CodeBlock code={JSON.stringify({ mcpServers: { converza: { url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2)} />}
      {tab === 'desktop' && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="st-help" style={{ marginTop: 0 }}>No arquivo de configuração do Claude Desktop (precisa do Node.js instalado). O cabeçalho vai pela variável para funcionar também no Windows.</span>
          <CodeBlock code={JSON.stringify({ mcpServers: { converza: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH}'], env: { AUTH: `Bearer ${secret}` } } } }, null, 2)} />
        </div>
      )}
      {tab === 'n8n' && (
        <div className="stack" style={{ gap: 8, fontSize: 13 }}>
          <span>No nó <b>MCP Client</b>: transporte <b>HTTP Streamable</b>, endereço abaixo e autenticação por cabeçalho (<b>Header Auth</b>):</span>
          <CopyField value={endpoint} />
          <CodeBlock code={`Nome: Authorization\nValor: Bearer ${secret}`} />
        </div>
      )}
    </div>
  );
}

function KeyModal({ data, editing, onClose, onDone }: { data: Resp; editing: ApiKey | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [tools, setTools] = useState<string[]>(editing?.tools ?? data.tools.filter((t) => !t.write).map((t) => t.name));
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  async function save() {
    if (!name.trim() || !tools.length || busy) return;
    setBusy(true);
    try {
      if (editing) { await api.patch(`/mcp/keys/${editing.id}`, { name: name.trim(), tools }); toast('Chave atualizada'); onDone(); onClose(); }
      else { const r = await api.post<{ secret: string }>('/mcp/keys', { name: name.trim(), tools }); setSecret(r.secret); onDone(); }
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  if (secret) {
    return (
      <Modal title="Chave criada" icon="key" width={680} onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose} data-testid="mcp-done">Já guardei a chave</button>}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="st-secret">
            <b><Icon name="alert" size={15} />Copie agora: a chave aparece só desta vez</b>
            <CopyField value={secret} testId="mcp-secret" />
            <div className="st-help">O Converza guarda só uma impressão digital da chave. Se perder, revogue e crie outra.</div>
          </div>
          <div><label className="label">Como conectar</label><Snippets endpoint={data.endpoint} secret={secret} /></div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={editing ? 'Ferramentas da chave' : 'Nova chave de API'} icon="key" width={760} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!name.trim() || !tools.length || busy} onClick={save} data-testid="mcp-save">{busy ? 'Salvando…' : editing ? 'Salvar' : 'Criar chave'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="Nome da chave"><input className="input" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Claude do Pedro, Automação n8n" data-testid="mcp-name" /></Field>
        <div><label className="label">O que esta chave pode fazer</label><ToolPicker tools={data.tools} value={tools} onChange={setTools} /></div>
        <div className="hint"><Icon name="info" size={14} />O assistente só vê as ferramentas marcadas. Mensagens só saem dentro da janela de 24h do WhatsApp, como no Chats ao vivo. Limite: {data.rateLimit} chamadas por minuto por chave.</div>
      </div>
    </Modal>
  );
}

export function McpPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/mcp'), [accountId]);
  const [modal, setModal] = useState<ApiKey | 'new' | null>(null);
  const [revoke, setRevoke] = useState<ApiKey | null>(null);
  const head = <Head slug="mcp" actions={data?.canCreate && <button type="button" className="btn primary" onClick={() => setModal('new')} data-testid="mcp-new"><Icon name="plus" size={15} />Nova chave</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const active = data.keys.filter((k) => !k.revokedAt);
  return (
    <div data-testid="mcp-page">
      {head}
      <section className="st-card">
        <div className="st-card-h">
          <span className="st-stat-ic"><Icon name="key" size={18} /></span>
          <div><b>Servidor MCP da sua conta</b><small>MCP é o padrão que assistentes de IA usam para chamar ferramentas. Com uma chave, eles leem contatos e conversas, mandam mensagens e iniciam fluxos — só o que você liberar.</small></div>
        </div>
        <label className="label">Endereço do servidor</label>
        <CopyField value={data.endpoint} testId="mcp-endpoint" />
        <div className="st-help">Transporte HTTP (Streamable), autenticação <code>Authorization: Bearer cvz_…</code>. Versões do protocolo: {data.protocolVersions.join(', ')}.</div>
      </section>

      {!data.canCreate && <div className="st-banner amber"><Icon name="headset" size={16} /><span>O suporte não cria chaves de API: só alguém da própria empresa.</span></div>}

      {data.keys.length === 0 ? (
        <div className="st-card"><EmptyBox icon="key" title="Nenhuma chave ainda" text="Crie uma chave para cada assistente ou automação (assim dá para revogar um sem mexer nos outros)."
          action={data.canCreate && <button type="button" className="btn primary" onClick={() => setModal('new')}><Icon name="plus" size={15} />Nova chave</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Chave</th><th>Ferramentas</th><th>Último uso</th><th>Chamadas (24h)</th><th>Status</th><th className="acts" /></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id} data-testid="mcp-key" style={k.revokedAt ? { opacity: 0.6 } : undefined}>
                  <td><b>{k.name}</b><div className="st-mini mono">{k.prefix} · criada {relTime(k.createdAt)}{k.createdByName ? ` por ${k.createdByName}` : ''}</div></td>
                  <td>{k.tools.length} de {data.tools.length}{k.tools.some((t) => data.tools.find((x) => x.name === t)?.write) && <div className="st-mini" style={{ color: 'var(--accent)' }}>pode fazer alterações</div>}</td>
                  <td className="muted">{k.lastUsedAt ? relTime(k.lastUsedAt) : 'nunca'}</td>
                  <td>{fmtNum(k.calls24h)}</td>
                  <td><Badge tone={k.revokedAt ? 'red' : 'green'}>{k.revokedAt ? 'Revogada' : 'Ativa'}</Badge></td>
                  <td className="acts">{!k.revokedAt && <Kebab items={[
                    { label: 'Mudar ferramentas', icon: 'edit', onClick: () => setModal(k) },
                    { label: 'Revogar', icon: 'close', danger: true, onClick: () => setRevoke(k) },
                  ]} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="st-section-t"><Icon name="history" size={15} />Últimas chamadas <small>({active.length} chave(s) ativa(s))</small></div>
      {data.calls.length === 0 ? (
        <div className="st-card" style={{ padding: 0 }}><EmptyBox icon="history" title="Nenhuma chamada ainda" text="Quando um assistente usar uma ferramenta, ela aparece aqui (sem o conteúdo das mensagens)." /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Quando</th><th>Chave</th><th>Ferramenta</th><th>Resultado</th><th>Tempo</th></tr></thead>
            <tbody>
              {data.calls.map((c) => (
                <tr key={c.id} data-testid="mcp-call">
                  <td className="muted nowrap">{relTime(c.createdAt)}</td>
                  <td className="nowrap">{c.keyName}</td>
                  <td className="nowrap">{data.tools.find((t) => t.name === c.tool)?.title ?? c.tool}</td>
                  <td>{c.ok ? <span className="row" style={{ gap: 6 }}><Badge tone="green">ok</Badge><span className="st-mini">{c.summary}</span></span> : <span className="row" style={{ gap: 6 }}><Badge tone="red">erro</Badge><span className="st-mini">{c.error}</span></span>}</td>
                  <td className="muted nowrap">{c.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && <KeyModal data={data} editing={modal === 'new' ? null : modal} onClose={() => setModal(null)} onDone={() => void reload()} />}
      {revoke && (
        <ConfirmModal title="Revogar chave" confirm="Revogar" danger onClose={() => setRevoke(null)} onConfirm={async () => {
          try { await api.del(`/mcp/keys/${revoke.id}`); toast('Chave revogada'); setRevoke(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>Revogar <b>{revoke.name}</b>? Quem usa essa chave perde o acesso na hora. Não dá para desfazer (crie outra se precisar).</ConfirmModal>
      )}
    </div>
  );
}
