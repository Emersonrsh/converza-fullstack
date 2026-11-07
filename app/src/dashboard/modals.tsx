import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Spinner, Switch, toast, cx, useBackdrop } from '../components/ui';
import { parsePrice } from '../components/Products';
import { fmtMoney, fmtPhone, todayLocal } from './format';
import type { Achievements, AdSpendEntry, PartnerInfo, SaleRow } from './types';
import type { Contact, Product } from '../types';

const errMsg = (e: unknown) => (e as Error)?.message ?? 'Algo deu errado';
const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const CURRENCIES = ['BRL', 'USD', 'EUR'];
export interface ConnOpt { id: string; name: string; displayPhone: string | null; }

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const moneyInput = (v: number) => v.toFixed(2).replace('.', ',');

/* ----------------------------------------------------------- nova / editar venda */

export function SaleModal({ sale, products, connections, currency, onClose, onSaved }: {
  sale?: SaleRow | null; products: Product[]; connections: ConnOpt[]; currency: string; onClose: () => void; onSaved: () => void;
}) {
  const editing = !!sale;
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Contact[]>([]);
  const [contact, setContact] = useState<{ id: string; name: string; phone: string } | null>(
    sale?.contactId ? { id: sale.contactId, name: sale.customerName ?? '', phone: sale.customerPhone ?? '' } : null);
  const [isNew, setIsNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [productId, setProductId] = useState(sale ? (sale.productId ?? '') : '');
  const [productName, setProductName] = useState(sale && !sale.productId ? sale.productName ?? '' : '');
  const [amount, setAmount] = useState(sale ? moneyInput(sale.amount) : '');
  const [cur, setCur] = useState(sale?.currency ?? currency);
  const [status, setStatus] = useState<SaleRow['status']>(sale?.status ?? 'approved');
  const [date, setDate] = useState(toLocalInput(sale ? new Date(sale.createdAt) : new Date()));
  const [connectionId, setConnectionId] = useState(sale?.connectionId ?? '');
  const [externalId, setExternalId] = useState(sale?.externalId ?? '');
  const [sourceId, setSourceId] = useState(sale?.sourceId ?? '');
  const [state, setState] = useState(sale?.state ?? '');
  const [notes, setNotes] = useState(sale?.notes ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (editing || contact || isNew || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      api.get<{ contacts: Contact[] }>(`/contacts?q=${encodeURIComponent(q.trim())}`).then((r) => setFound(r.contacts.slice(0, 6))).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, editing, contact, isNew]);

  function pickProduct(id: string) {
    setProductId(id);
    const p = products.find((x) => x.id === id);
    if (p && (!amount || !editing)) setAmount(moneyInput(Number(p.price)));
  }

  async function save() {
    const value = parsePrice(amount);
    if (!(value > 0)) { toast('Informe o valor da venda'); return; }
    if (!editing && !contact && !(isNew && newName.trim() && newPhone.replace(/\D/g, '').length >= 10)) {
      toast('Escolha o cliente ou cadastre um novo com nome e telefone (com DDD)'); return;
    }
    if (!productId && !productName.trim()) { toast('Escolha o produto ou digite o nome'); return; }
    const body = {
      ...(editing ? {} : contact ? { contactId: contact.id } : { customerName: newName.trim(), customerPhone: newPhone }),
      productId: productId || null, productName: productId ? null : productName.trim(),
      amount: value, currency: cur, status, date: new Date(date).toISOString(),
      connectionId: connectionId || null, externalId: externalId.trim() || null, sourceId: sourceId.trim() || null,
      state: state || null, notes: notes.trim() || null,
    };
    setBusy(true);
    try {
      if (editing) await api.patch(`/sales/${sale!.id}`, body);
      else await api.post('/sales', body);
      toast(editing ? 'Venda atualizada ✓' : 'Venda registrada ✓');
      onSaved();
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }

  const bg = useBackdrop(onClose);
  return (
    <div className="modal-bg" {...bg}>
      <div className="modal wide fade" onClick={(e) => e.stopPropagation()} data-testid="sale-modal">
        <div className="mh"><b style={{ fontSize: 15 }}>{editing ? 'Editar venda' : 'Nova venda'}</b>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="mb grid" style={{ gap: 14 }}>
          <div>
            <label className="label">Cliente</label>
            {contact ? (
              <div className="row" style={{ border: '1px solid var(--border-strong)', borderRadius: 10, padding: '8px 12px' }}>
                <Icon name="user" size={16} />
                <b style={{ flex: 1 }}>{contact.name}</b><span className="faint">{fmtPhone(contact.phone)}</span>
                {!editing && <button type="button" className="btn sm ghost" onClick={() => { setContact(null); setQ(''); }}>Trocar</button>}
              </div>
            ) : isNew ? (
              <div className="row" style={{ gap: 8 }}>
                <input className="input" placeholder="Nome do cliente" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
                <input className="input" placeholder="Telefone com DDD" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                <button type="button" className="btn sm ghost" onClick={() => setIsNew(false)}>Buscar</button>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <input className="input" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus data-testid="sale-customer" />
                {(found.length > 0 || q.trim().length >= 2) && (
                  <div className="menu" style={{ left: 0, right: 0 }}>
                    {found.map((c) => (
                      <button type="button" key={c.id} onClick={() => { setContact({ id: c.id, name: c.name, phone: c.phone }); setFound([]); }}>
                        <Icon name="user" size={14} /><span style={{ flex: 1 }}>{c.name}</span><span className="faint">{fmtPhone(c.phone)}</span>
                      </button>
                    ))}
                    <button type="button" onClick={() => { setIsNew(true); setNewName(/\d/.test(q) ? '' : q); setNewPhone(/\d/.test(q) ? q : ''); }}>
                      <Icon name="plus" size={14} />Cadastrar novo cliente{q.trim() ? ` “${q.trim()}”` : ''}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr 0.8fr', gap: 10 }}>
            <div>
              <label className="label">Produto</label>
              <select className="select" value={productId} onChange={(e) => pickProduct(e.target.value)} data-testid="sale-product">
                <option value="">Outro (digitar)</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {!productId && <input className="input" style={{ marginTop: 6 }} placeholder="Nome do produto" value={productName} onChange={(e) => setProductName(e.target.value)} />}
            </div>
            <div>
              <label className="label">Valor</label>
              <input className="input" inputMode="decimal" placeholder="497,00" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="sale-amount" />
            </div>
            <div>
              <label className="label">Moeda</label>
              <select className="select" value={cur} onChange={(e) => setCur(e.target.value)}>
                {[...new Set([...CURRENCIES, cur])].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label className="label">Status</label>
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as SaleRow['status'])}>
                <option value="approved">Aprovada</option><option value="pending">Pendente</option>
                <option value="refused">Recusada</option><option value="refunded">Reembolsada</option>
              </select>
            </div>
            <div>
              <label className="label">Data e hora</label>
              <input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">Instância (conexão)</label>
              <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                <option value="">{editing ? 'Sem conexão' : 'Automático (última conversa)'}</option>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` · ${c.displayPhone}` : ''}</option>)}
              </select>
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 0.6fr', gap: 10 }}>
            <div>
              <label className="label">ID da transação (opcional)</label>
              <input className="input" value={externalId} placeholder="HP1234567" onChange={(e) => setExternalId(e.target.value)} />
            </div>
            <div>
              <label className="label">Source ID — anúncio (opcional)</label>
              <input className="input" value={sourceId} placeholder="ID do anúncio" onChange={(e) => setSourceId(e.target.value)} />
            </div>
            <div>
              <label className="label">Estado</label>
              <select className="select" value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">Pelo DDD</option>{UFS.map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Observações</label>
            <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {status === 'approved' && !editing && <div className="cf-hint" style={{ marginTop: -6 }}>Se o cliente estiver num fluxo esperando pagamento, ele segue pelo caminho “Pago”.</div>}
        </div>
        <div className="mf">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy} onClick={save} data-testid="sale-save">{editing ? 'Salvar' : 'Registrar venda'}</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- nota fiscal */

export function InvoiceModal({ sale, onClose, onSaved }: { sale: SaleRow; onClose: () => void; onSaved: () => void }) {
  const [number, setNumber] = useState(sale.invoiceNumber ?? '');
  const [url, setUrl] = useState(sale.invoiceUrl ?? '');
  const [issued, setIssued] = useState(!!sale.invoiceIssuedAt);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.patch(`/sales/${sale.id}/invoice`, { invoiceNumber: number.trim() || null, invoiceUrl: url.trim() || null, issued });
      toast('Nota fiscal salva ✓'); onSaved();
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }
  return (
    <Modal title="Nota fiscal da venda" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={save}>Salvar</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div className="note"><Icon name="file" size={15} /><span><b>{sale.customerName ?? 'Cliente'}</b> · {sale.productName ?? 'Produto'} · {fmtMoney(sale.amount, sale.currency)} · {sale.dateLabel}</span></div>
        <div><label className="label">Número da nota</label><input className="input" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Ex.: 000123" autoFocus /></div>
        <div><label className="label">Link da nota (PDF ou XML)</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." /></div>
        <label className="tgl"><Switch on={issued} onClick={() => setIssued((v) => !v)} /><span>Nota emitida</span></label>
        <div className="cf-hint">Registre aqui a nota emitida no seu sistema fiscal para manter a auditoria das vendas. O número sai no CSV exportado.</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ gasto em anúncios */

export function AdSpendModal({ from, to, currency, onClose, onChanged }: {
  from: string; to: string; currency: string; onClose: () => void; onChanged: () => void;
}) {
  const [list, setList] = useState<AdSpendEntry[] | null>(null);
  const [date, setDate] = useState(to > todayLocal() ? todayLocal() : to);
  const [amount, setAmount] = useState('');
  const [campaign, setCampaign] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get<{ entries: AdSpendEntry[] }>(`/ad-spend?from=${from}&to=${to}`).then((r) => setList(r.entries)).catch((e) => toast(errMsg(e)));
  useEffect(() => { void load(); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    const v = parsePrice(amount);
    if (!(v > 0)) { toast('Informe o valor investido'); return; }
    setBusy(true);
    try {
      await api.post('/ad-spend', { date, amount: v, currency, campaignName: campaign.trim() || null });
      setAmount(''); await load(); onChanged(); toast('Gasto lançado ✓');
    } catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await api.del(`/ad-spend/${id}`); await load(); onChanged(); } catch (e) { toast(errMsg(e)); }
  }
  const total = (list ?? []).filter((e) => e.currency === currency).reduce((s, e) => s + e.amount, 0);
  const bg = useBackdrop(onClose);
  return (
    <div className="modal-bg" {...bg}>
      <div className="modal wide fade" onClick={(e) => e.stopPropagation()} data-testid="adspend-modal">
        <div className="mh">
          <div><b style={{ fontSize: 15 }}>Gasto com anúncios (Meta)</b>
            <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>Usado no ROAS e no lucro · {from.split('-').reverse().join('/')} a {to.split('-').reverse().join('/')}</div></div>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
        </div>
        <div className="mb grid" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="input" type="date" style={{ flex: '0 0 160px' }} value={date} onChange={(e) => setDate(e.target.value)} />
            <input className="input" style={{ flex: '0 0 120px' }} placeholder="150,00" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="adspend-amount" />
            <input className="input" style={{ flex: '1 1 180px' }} placeholder="Campanha (opcional)" value={campaign} onChange={(e) => setCampaign(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="btn primary" disabled={busy} onClick={add} data-testid="adspend-add"><Icon name="plus" size={15} />Lançar</button>
          </div>
          {!list ? <Spinner /> : (
            <div className="card" style={{ boxShadow: 'none', maxHeight: 320, overflow: 'auto' }}>
              <table>
                <thead><tr><th>Data</th><th>Campanha</th><th>Valor</th><th /></tr></thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.id}>
                      <td>{e.date.split('-').reverse().join('/')}</td>
                      <td>{e.campaignName ?? <span className="faint">—</span>}{e.origin !== 'manual' && <span className="pill blue" style={{ marginLeft: 6 }}>Meta</span>}</td>
                      <td><b>{fmtMoney(e.amount, e.currency)}</b></td>
                      <td style={{ width: 40 }}>{e.origin === 'meta'
                        ? <span title="Vem da conta de anúncios da Meta e se atualiza sozinho" className="faint"><Icon name="lock" size={14} /></span>
                        : <button className="btn icon sm ghost" aria-label="Excluir lançamento" onClick={() => remove(e.id)}><Icon name="trash" size={14} /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.length === 0 && <div className="empty" style={{ padding: 22 }}>Nenhum gasto lançado neste período.</div>}
            </div>
          )}
          <div className="row"><span className="muted">Total no período</span><span className="spacer" /><b>{fmtMoney(total, currency)}</b></div>
          <small className="faint" data-testid="adspend-meta-note">Os gastos marcados como <b>Meta</b> vêm das contas de anúncios escolhidas em <Link className="linkbtn" to="/meta/perfis" onClick={onClose}>Facebook › Perfis e contas</Link> e se atualizam sozinhos a cada hora.</small>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- ajustes de lucro */

export function SettingsModal({ initial, onClose, onSaved }: {
  initial: { gatewayFeePercent: number; taxPercent: number }; onClose: () => void; onSaved: () => void;
}) {
  const nav = useNavigate();
  const [fee, setFee] = useState(String(initial.gatewayFeePercent).replace('.', ','));
  const [tax, setTax] = useState(String(initial.taxPercent).replace('.', ','));
  const [busy, setBusy] = useState(false);
  async function save() {
    const f = parsePrice(fee || '0'); const t = parsePrice(tax || '0');
    if (Number.isNaN(f) || Number.isNaN(t) || f > 100 || t > 100) { toast('Use porcentagens entre 0 e 100'); return; }
    setBusy(true);
    try { await api.put('/dashboard/settings', { gatewayFeePercent: f, taxPercent: t }); toast('Ajustes salvos ✓'); onSaved(); }
    catch (e) { toast(errMsg(e)); setBusy(false); }
  }
  return (
    <Modal title="Ajustes do dashboard" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={save} data-testid="settings-save">Salvar</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label className="label">Taxa da plataforma de pagamento (%)</label><input className="input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} data-testid="settings-fee" /></div>
          <div><label className="label">Impostos (%)</label><input className="input" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} data-testid="settings-tax" /></div>
        </div>
        <div className="note"><Icon name="gem" size={15} /><span><b>Lucro</b> = faturamento − custo dos produtos − taxas e impostos (sobre o faturamento) − gasto com anúncios.</span></div>
        <button type="button" className="btn sm" style={{ width: 'fit-content' }} onClick={() => nav('/settings/produtos')}><Icon name="tag" size={14} />Custo de cada produto (Configurações → Produtos)</button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------- trilha de conquistas */

export function TrailModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [data, setData] = useState<Achievements | null>(null);
  useEffect(() => { api.get<Achievements>('/dashboard/achievements').then(setData).catch((e) => toast(errMsg(e))); }, []);
  const bg = useBackdrop(onClose);
  return (
    <div className="modal-bg" {...bg}>
      <div className="modal wide fade" onClick={(e) => e.stopPropagation()} data-testid="trail-modal">
        <div className="mh"><b style={{ fontSize: 15 }}>Trilha de conquistas</b>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        <div className="mb">
          {!data ? <Spinner /> : (
            <div className="grid" style={{ gap: 18 }}>
              <div className="trail-hero">
                <span className="trail-badge"><Icon name="trophy" size={26} /></span>
                <div style={{ flex: 1 }}>
                  <div className="faint" style={{ fontSize: 12, fontWeight: 700 }}>Faturamento total aprovado</div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>{fmtMoney(data.revenue)}</div>
                  <div className="muted" style={{ fontSize: 13, fontWeight: 600 }}>{data.level ? <>Nível atual: <b>{data.level.label}</b></> : 'Faça sua primeira venda para começar a trilha'}</div>
                </div>
              </div>
              {data.next && (
                <div>
                  <div className="row" style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>
                    <span>Próximo: {data.next.label}{data.next.target ? ` · ${fmtMoney(data.next.target)}` : ''}</span>
                    <span className="spacer" /><span className="faint">{data.next.progress}%</span>
                  </div>
                  <div className="progress"><i style={{ width: `${data.next.progress}%` }} /></div>
                </div>
              )}
              <div className="trail-levels">
                {data.levels.map((l) => (
                  <div key={l.key} className={cx('trail-lvl', l.reached && 'on')}>
                    <span className="ic"><Icon name={l.reached ? 'trophy' : 'lock'} size={16} /></span>
                    <b>{l.label}</b>
                    <small>{l.target ? fmtMoney(l.target).replace(',00', '') : '1ª venda'}</small>
                  </div>
                ))}
              </div>
              <div>
                <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Primeiros passos</h4>
                {data.steps.map((s) => (
                  <div key={s.key} className="trail-step">
                    <span className={cx('chk', s.done && 'on')}>{s.done ? <Icon name="check" size={13} stroke={3} /> : null}</span>
                    <span style={{ flex: 1, textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--faint)' : undefined }}>{s.label}</span>
                    {!s.done && <button className="btn sm ghost" onClick={() => { onClose(); nav(s.route); }}>Fazer agora<Icon name="arrowRight" size={13} /></button>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- programa de parceiros */

export function PartnerModal({ info, onClose }: { info: PartnerInfo; onClose: () => void }) {
  async function copy() {
    try { await navigator.clipboard.writeText(info.link ?? ''); toast('Link copiado ✓'); } catch { toast(info.link ?? ''); }
  }
  return (
    <Modal title="Programa de parceiros Converza" onClose={onClose}
      footer={<>{info.contactUrl && <a className="btn" href={info.contactUrl} target="_blank" rel="noreferrer">Falar com o time</a>}<button className="btn primary" onClick={onClose}>Fechar</button></>}>
      <div className="grid" style={{ gap: 16 }} data-testid="partner-modal">
        <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
          Indique o Converza para outros negócios e ganhe até <b>{info.commissionPercent}% de comissão</b> sobre as assinaturas de quem entrar pelo seu link.
        </div>
        <div>
          <label className="label">Seu link de indicação</label>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" readOnly value={info.link ?? ''} onFocus={(e) => e.currentTarget.select()} data-testid="partner-link" />
            <button className="btn primary" onClick={copy}><Icon name="copy" size={15} />Copiar</button>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="card pad" style={{ boxShadow: 'none' }}><div className="faint" style={{ fontSize: 12, fontWeight: 700 }}>Contas indicadas</div><div style={{ fontSize: 22, fontWeight: 800 }}>{info.referrals ?? 0}</div></div>
          <div className="card pad" style={{ boxShadow: 'none' }}><div className="faint" style={{ fontSize: 12, fontWeight: 700 }}>Com assinatura ativa</div><div style={{ fontSize: 22, fontWeight: 800 }}>{info.activeReferrals ?? 0}</div></div>
        </div>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }} className="muted">
          <li>Compartilhe o link com quem vende pelo WhatsApp.</li>
          <li>A pessoa cria a conta pelo link e fica vinculada a você.</li>
          <li>Quando ela assina (e paga a primeira mensalidade), a indicação conta como ativa para a sua comissão.</li>
        </ol>
      </div>
    </Modal>
  );
}
