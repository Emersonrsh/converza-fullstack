import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, Switch, toast } from '../components/ui';
import { TagPicker } from '../components/TagPicker';
import { ConfirmModal } from '../kanban/modals';
import {
  Badge, CopyField, DaySpark, Drawer, EmptyBox, Head, Kebab, LoadError, SearchBox, StatTile, copyText, errMsg, fmtDateTime, fmtMoney, fmtNum,
  relTime, useLoad, useSocketEvent,
} from './common';

interface TLink {
  id: string; name: string; slug: string; code: string; message: string; text: string; connectionId: string | null; connectionName: string | null;
  phone: string | null; source: string; campaign: string; tags: string[]; active: boolean; clicks: number; createdAt: string; url: string; whatsappUrl: string | null;
  clicks30: number; contacts: number; sales: number; revenue: number;
}
interface Resp {
  links: TLink[]; totals: { links: number; clicks: number; contacts: number; sales: number; revenue: number };
  connections: { id: string; name: string; phone: string | null; ready: boolean }[]; canEdit: boolean; base: string;
}
interface Detail {
  link: TLink; clicksByDay: { day: string; n: number }[]; arrivalsByDay: { day: string; n: number }[];
  contacts: { id: string; name: string; phone: string; trackedAt: string; sales: number; revenue: number }[];
  recentClicks: { createdAt: string; referer: string | null; query: Record<string, string> }[];
}

function LinkModal({ link, data, onClose, onSaved }: { link: TLink | null; data: Resp; onClose: () => void; onSaved: () => void }) {
  const ready = data.connections.filter((c) => c.ready);
  const [name, setName] = useState(link?.name ?? '');
  const [connectionId, setConn] = useState(link?.connectionId ?? ready[0]?.id ?? '');
  const [message, setMessage] = useState(link?.message ?? 'Olá! Quero saber mais 😊');
  const [slug, setSlug] = useState(link?.slug ?? '');
  const [source, setSource] = useState(link?.source ?? '');
  const [campaign, setCampaign] = useState(link?.campaign ?? '');
  const [tags, setTags] = useState<string[]>(link?.tags ?? []);
  const [active, setActive] = useState(link?.active ?? true);
  const [busy, setBusy] = useState(false);
  const ok = name.trim() && connectionId && message.trim();
  async function save() {
    if (!ok || busy) return;
    setBusy(true);
    const body = { name: name.trim(), connectionId, message: message.trim(), slug: slug.trim(), source: source.trim(), campaign: campaign.trim(), tags, active };
    try {
      if (link) await api.patch(`/tracking/${link.id}`, body);
      else {
        const r = await api.post<{ link: TLink }>('/tracking', body);
        await copyText(r.link.url, 'Link criado e copiado');
      }
      if (link) toast('Link salvo');
      onSaved(); onClose();
    } catch (e) { toast(errMsg(e, 'Não foi possível salvar')); }
    setBusy(false);
  }
  return (
    <Modal title={link ? 'Editar link rastreável' : 'Novo link rastreável'} icon="link" width={600} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ok || busy} onClick={save} data-testid="tl-save">{busy ? 'Salvando…' : link ? 'Salvar' : 'Criar link'}</button>
    </>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="st-form">
          <Field label="Nome"><input className="input" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Bio do Instagram" data-testid="tl-name" /></Field>
          <Field label="Número de WhatsApp">
            <select className="select" value={connectionId} onChange={(e) => setConn(e.target.value)} data-testid="tl-conn">
              {data.connections.map((c) => <option key={c.id} value={c.id} disabled={!c.ready}>{c.name}{c.phone ? ` · ${c.phone}` : ' (sem telefone confirmado)'}</option>)}
            </select>
          </Field>
        </div>
        <div>
          <Field label="Mensagem que o cliente vai mandar"><textarea className="input" rows={3} value={message} maxLength={600} onChange={(e) => setMessage(e.target.value)} data-testid="tl-message" /></Field>
          <div className="st-help">O WhatsApp abre com essa mensagem pronta e um código no final ({link ? <b>#{link.code}</b> : 'ex.: #K7Q2MX'}). É pelo código que o Converza sabe de onde a pessoa veio — se ela apagar o código antes de enviar, a origem não é marcada.</div>
        </div>
        <div>
          <label className="label">Endereço do link</label>
          <div className="qr-sc"><span style={{ position: 'static', paddingRight: 6, whiteSpace: 'nowrap', fontWeight: 700 }} className="st-mini">{data.base}</span><input className="input" style={{ paddingLeft: 12 }} value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="gerado automaticamente" data-testid="tl-slug" /></div>
        </div>
        <div className="st-form">
          <Field label="Origem (opcional)"><input className="input" value={source} maxLength={60} onChange={(e) => setSource(e.target.value)} placeholder="instagram, google, panfleto…" /></Field>
          <Field label="Campanha (opcional)"><input className="input" value={campaign} maxLength={80} onChange={(e) => setCampaign(e.target.value)} placeholder="black-friday" /></Field>
        </div>
        <Field label="Etiquetas para quem chegar por este link"><TagPicker value={tags} onChange={setTags} allowCreate={false} testId="tl-tags" /></Field>
        <label className="row" style={{ gap: 10, fontSize: 13.5, fontWeight: 600 }}><Switch on={active} onClick={() => setActive(!active)} />{active ? 'Link ativo' : 'Link pausado (mostra "Link indisponível")'}</label>
      </div>
    </Modal>
  );
}

function LinkDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useLoad(() => api.get<Detail>(`/tracking/${id}`), [id]);
  return (
    <Drawer title={data?.link.name ?? 'Link'} onClose={onClose}>
      {error && <div className="hint"><Icon name="alert" size={14} />{error}</div>}
      {!data && !error && <Spinner />}
      {data && (
        <div className="stack" style={{ gap: 14 }} data-testid="tl-detail">
          <CopyField value={data.link.url} />
          <div className="st-stats" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 0 }}>
            <StatTile icon="cursor" value={fmtNum(data.link.clicks)} label="Cliques (total)" />
            <StatTile icon="users" tone="blue" value={fmtNum(data.contacts.length)} label="Contatos" />
          </div>
          <section className="st-card" style={{ marginBottom: 0 }}>
            <div className="st-card-h"><b>Últimos 30 dias</b><span className="spacer" /><span className="st-mini"><span className="st-dot" style={{ background: 'var(--primary)' }} /> cliques <span className="st-dot" style={{ background: 'var(--accent)', marginLeft: 8 }} /> chegaram no WhatsApp</span></div>
            <DaySpark days={30} series={[data.clicksByDay, data.arrivalsByDay]} />
          </section>
          <div>
            <div className="st-section-t" style={{ marginTop: 0 }}>Contatos que chegaram</div>
            {data.contacts.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>Ninguém mandou a mensagem com o código ainda.</div> : (
              <div className="stack" style={{ gap: 6 }}>
                {data.contacts.map((c) => (
                  <div key={c.id} className="st-file" data-testid="tl-contact">
                    <div style={{ flex: 1, minWidth: 0 }}><b>{c.name}</b><span className="st-mini">{c.phone} · {fmtDateTime(c.trackedAt)}</span></div>
                    {c.sales > 0 ? <Badge tone="green">{c.sales} venda(s) · {fmtMoney(c.revenue)}</Badge> : <span className="st-mini">sem venda</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {data.recentClicks.length > 0 && (
            <div>
              <div className="st-section-t">Cliques recentes</div>
              <div className="stack" style={{ gap: 4, fontSize: 12.5 }}>
                {data.recentClicks.slice(0, 12).map((c, i) => (
                  <div key={i} className="row" style={{ gap: 8 }}>
                    <span className="muted" style={{ width: 120 }}>{relTime(c.createdAt)}</span>
                    <span>{c.referer || 'acesso direto'}</span>
                    {c.query.utm_source && <Badge>{c.query.utm_source}</Badge>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export function TrackingPage() {
  const { accountId } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<Resp>('/tracking'), [accountId]);
  useSocketEvent(['tracking:click', 'contacts:changed', 'sale:changed'], () => void reload());
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<TLink | null | 'new'>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [del, setDel] = useState<TLink | null>(null);
  const head = <Head slug="trackeamento" actions={data?.canEdit && <button type="button" className="btn primary" disabled={!data.connections.some((c) => c.ready)} onClick={() => setEditing('new')} data-testid="tl-new"><Icon name="plus" size={15} />Novo link</button>} />;
  if (error && !data) return <>{head}<LoadError error={error} onRetry={reload} /></>;
  if (!data) return <>{head}<Spinner /></>;
  const list = data.links.filter((l) => !q.trim() || `${l.name} ${l.slug} ${l.source} ${l.campaign}`.toLowerCase().includes(q.trim().toLowerCase()));
  const t = data.totals;

  async function toggle(l: TLink) {
    try { await api.patch(`/tracking/${l.id}`, { active: !l.active }); toast(l.active ? 'Link pausado' : 'Link ativado'); void reload(); }
    catch (e) { toast(errMsg(e)); }
  }

  return (
    <div data-testid="tracking-page">
      {head}
      <div className="st-stats">
        <StatTile icon="link" value={t.links} label="Links" />
        <StatTile icon="cursor" tone="blue" value={fmtNum(t.clicks)} label="Cliques" testId="tl-total-clicks" />
        <StatTile icon="users" tone="green" value={fmtNum(t.contacts)} label="Contatos que chegaram" />
        <StatTile icon="dollar" tone="amber" value={fmtMoney(t.revenue)} label={`${fmtNum(t.sales)} venda(s)`} />
      </div>
      {!data.connections.some((c) => c.ready) && <div className="st-banner amber"><Icon name="alert" size={16} /><span>Para criar links, conecte um número de WhatsApp com o telefone confirmado pela Meta em <Link to="/connections">Conexões</Link>.</span></div>}
      <div className="st-toolbar"><SearchBox value={q} onChange={setQ} placeholder="Buscar link, origem ou campanha" testId="tl-search" /></div>
      {data.links.length === 0 ? (
        <div className="st-card"><EmptyBox icon="target" title="Nenhum link rastreável ainda" text="Crie um link para cada lugar onde você divulga o WhatsApp (bio do Instagram, Google, panfleto, influenciador…). O Converza conta os cliques, marca a origem de quem chega e mostra quantas vendas cada link trouxe."
          action={data.canEdit && data.connections.some((c) => c.ready) && <button type="button" className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />Novo link</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Link</th><th>Origem</th><th>Cliques</th><th>Contatos</th><th>Vendas</th><th>Status</th><th className="acts" /></tr></thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id} data-testid="tl-row">
                  <td>
                    <button type="button" className="linkbtn" style={{ padding: 0, textDecoration: 'none' }} onClick={() => setViewing(l.id)}><b>{l.name}</b></button>
                    <div className="row" style={{ gap: 6 }}><span className="st-mini mono">{l.url.replace(/^https?:\/\//, '')}</span><button type="button" className="btn icon sm ghost" style={{ width: 22, height: 22 }} onClick={() => void copyText(l.url, 'Link copiado')} aria-label="Copiar link"><Icon name="copy" size={12} /></button></div>
                  </td>
                  <td className="muted">{[l.source, l.campaign].filter(Boolean).join(' · ') || '—'}</td>
                  <td><b>{fmtNum(l.clicks)}</b><div className="st-mini">{fmtNum(l.clicks30)} em 30 dias</div></td>
                  <td>{fmtNum(l.contacts)}</td>
                  <td>{l.sales ? <><b>{fmtMoney(l.revenue)}</b><div className="st-mini">{l.sales} venda(s)</div></> : <span className="faint">—</span>}</td>
                  <td><Badge tone={l.active ? 'green' : ''}>{l.active ? 'Ativo' : 'Pausado'}</Badge></td>
                  <td className="acts">
                    <Kebab items={[
                      { label: 'Ver detalhes', icon: 'eye', onClick: () => setViewing(l.id) },
                      { label: 'Copiar link', icon: 'copy', onClick: () => void copyText(l.url, 'Link copiado') },
                      { label: 'Testar no WhatsApp', icon: 'phone', onClick: () => l.whatsappUrl && window.open(l.whatsappUrl, '_blank', 'noopener'), hidden: !l.whatsappUrl },
                      { label: 'Editar', icon: 'edit', onClick: () => setEditing(l), hidden: !data.canEdit },
                      { label: l.active ? 'Pausar' : 'Ativar', icon: l.active ? 'pause' : 'play', onClick: () => void toggle(l), hidden: !data.canEdit },
                      { label: 'Excluir', icon: 'trash', danger: true, onClick: () => setDel(l), hidden: !data.canEdit },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint"><Icon name="info" size={14} />Cliques de robôs que geram a prévia do link (WhatsApp, Facebook, Telegram…) não contam. As vendas contam a partir da chegada pelo link (o último link usado vale). O IP de quem clica não é guardado — só um código embaralhado.</div>
      {editing && <LinkModal link={editing === 'new' ? null : editing} data={data} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      {viewing && <LinkDrawer id={viewing} onClose={() => setViewing(null)} />}
      {del && (
        <ConfirmModal title="Excluir link" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/tracking/${del.id}`); toast('Link excluído'); setDel(null); void reload(); }
          catch (e) { toast(errMsg(e)); }
        }}>Excluir <b>{del.name}</b>? Quem abrir o link vê “Link indisponível”. Os contatos continuam, mas sem a marca da origem.</ConfirmModal>
      )}
    </div>
  );
}
