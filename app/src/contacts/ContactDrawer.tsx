import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, money } from '../api';
import { Icon } from '../icons';
import { Avatar, Field, Spinner, cx, toast, useBackdrop } from '../components/ui';
import { TagPicker } from '../components/TagPicker';
import { parsePrice } from '../components/Products';
import { ConfirmModal } from '../kanban/modals';
import { ContactKanban } from '../kanban/ContactKanban';
import { timeAgo } from '../kanban/util';
import { fmtPhone } from '../chats/util';
import { CustomFieldsEditor, useContactFields } from './CustomFields';
import { ORIGIN_ICON, ORIGIN_LABEL, STAGES, dateTimeBR } from './util';
import type { ContactDetail } from './types';

interface Form { name: string; phone: string; email: string; stage: string; value: string; tags: string[]; notes: string; custom: Record<string, string>; }
const SALE: Record<string, [string, string]> = { approved: ['Aprovada', 'green'], pending: ['Pendente', 'amber'], refused: ['Recusada', 'red'], refunded: ['Reembolsada', ''] };
const valueText = (n: number) => (n ? n.toFixed(2).replace('.', ',') : '');
const digitsOf = (s: string) => s.replace(/\D/g, '');

function Sec({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return <section className="cd-sec"><div className="cd-sec-h"><b>{title}</b>{right}</div>{children}</section>;
}

/** Ficha do contato (painel lateral): editar dados, etiquetas, campos, Kanban, anotações; ver vendas e origem. */
export function ContactDrawer({ id, canDelete, onClose, onChanged, onDeleted }: {
  id: string; canDelete: boolean; onClose: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const nav = useNavigate();
  const fields = useContactFields();
  const [d, setD] = useState<ContactDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [initial, setInitial] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState<null | (() => void)>(null);
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<ContactDetail>(`/contacts/${id}`);
      const c = r.contact;
      const f: Form = { name: c.name, phone: fmtPhone(c.phone), email: c.email ?? '', stage: c.stage, value: valueText(c.value), tags: c.tags, notes: c.notes ?? '', custom: { ...c.custom } };
      setD(r); setForm(f); setInitial(f); setErr(null); setDup(null);
    } catch (e) { setErr(e instanceof ApiError && e.status === 404 ? 'Este contato não existe mais.' : e instanceof Error ? e.message : 'Não foi possível abrir'); }
  }, [id]);
  useEffect(() => { setD(null); setForm(null); void load(); }, [load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const dirty = useMemo(() => !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const valueBad = !!form?.value.trim() && Number.isNaN(parsePrice(form.value));
  const set = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));

  async function save() {
    if (!form || !initial || busy || valueBad) return;
    const patch: Record<string, unknown> = {};
    if (form.name.trim() !== initial.name) patch.name = form.name.trim();
    if (digitsOf(form.phone) !== digitsOf(initial.phone)) patch.phone = form.phone.trim();
    if (form.email.trim() !== initial.email) patch.email = form.email.trim() || null;
    if (form.stage !== initial.stage) patch.stage = form.stage;
    if (form.value !== initial.value) patch.value = form.value.trim() ? parsePrice(form.value) : 0;
    if (JSON.stringify(form.tags) !== JSON.stringify(initial.tags)) patch.tags = form.tags;
    if (form.notes !== initial.notes) patch.notes = form.notes.trim() ? form.notes : null;
    const custom: Record<string, string> = {};
    for (const k of new Set([...Object.keys(form.custom), ...Object.keys(initial.custom)])) if ((form.custom[k] ?? '') !== (initial.custom[k] ?? '')) custom[k] = form.custom[k] ?? '';
    if (Object.keys(custom).length) patch.custom = custom;
    if (!patch.name && form.name.trim() === '') { toast('Informe o nome'); return; }
    setBusy(true);
    try {
      await api.patch(`/contacts/${id}`, patch);
      toast('Contato salvo');
      await load();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // telefone de outro contato
        const r = await fetchDup(form.phone);
        setDup(r);
      }
      toast(e instanceof Error ? e.message : 'Não foi possível salvar');
    }
    setBusy(false);
  }

  async function fetchDup(phone: string) {
    try {
      const r = await api.get<{ contacts: { id: string; name: string; phone: string }[] }>(`/contacts?q=${encodeURIComponent(phone.replace(/\D/g, ''))}&limit=3`);
      const m = r.contacts.find((x) => x.id !== id);
      return m ? { id: m.id, name: m.name } : null;
    } catch { return null; }
  }

  async function remove() {
    try { await api.del(`/contacts/${id}`); toast('Contato excluído'); onDeleted(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível excluir'); }
  }

  // fechar/sair com alterações não salvas pede confirmação em vez de perder o que foi digitado
  const leave = (go: () => void) => { if (dirty) setConfirmLeave(() => go); else go(); };
  const bg = useBackdrop(() => leave(onClose));
  const c = d?.contact;
  return (
    <div className="cd-bg" {...bg}>
      <aside className="cd fade" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ficha do contato" data-testid="contact-drawer">
        {err ? (
          <div className="cv-empty" style={{ flex: 1 }}>
            <div className="cv-empty-ic warn"><Icon name="alert" size={26} /></div>
            <b>Não foi possível abrir</b><span>{err}</span>
            <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={onClose}>Fechar</button>
          </div>
        ) : !c || !form ? <div className="center"><Spinner /></div> : (
          <>
            <header className="cd-hd">
              <Avatar name={c.name || c.phone} size={44} />
              <div className="cd-who"><b>{c.name}</b><span>{fmtPhone(c.phone)}{c.email ? ` · ${c.email}` : ''}</span></div>
              <span className="spacer" />
              {d.conversation
                ? <button type="button" className="btn sm" onClick={() => leave(() => nav(`/inbox?c=${d.conversation!.id}`))} data-testid="drawer-open-chat"><Icon name="chats" size={14} />Abrir conversa{d.conversation.unreadCount ? ` (${d.conversation.unreadCount})` : ''}</button>
                : <button type="button" className="btn sm" onClick={() => leave(() => nav(`/inbox?novo=${c.id}`))} data-testid="drawer-start-chat"><Icon name="send" size={14} />Iniciar conversa</button>}
              {canDelete && <button type="button" className="btn icon sm ghost" onClick={() => setConfirmDel(true)} aria-label="Excluir contato" title="Excluir contato" data-testid="drawer-delete"><Icon name="trash" size={15} /></button>}
              <button type="button" className="btn icon sm ghost" onClick={() => leave(onClose)} aria-label="Fechar"><Icon name="close" size={16} /></button>
            </header>

            <div className="cd-body">
              {c.optedOutAt && (
                <div className="hint warn" style={{ marginTop: 12 }} data-testid="cd-optout">
                  <Icon name="alert" size={14} />
                  <span style={{ flex: 1 }}>Não recebe disparos em massa: pediu para sair em {new Date(c.optedOutAt).toLocaleDateString('pt-BR')}.</span>
                  <button type="button" className="linkbtn" data-testid="cd-optin" onClick={async () => {
                    try { await api.patch(`/contacts/${id}`, { optedOut: false }); toast('Voltou a receber disparos'); await load(); onChanged(); }
                    catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
                  }}>Voltar a receber</button>
                </div>
              )}
              <Sec title="Dados">
                <div className="cd-grid">
                  <Field label="Nome"><input className="input" maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} data-testid="drawer-name" /></Field>
                  <Field label="WhatsApp"><input className="input" inputMode="tel" value={form.phone} onChange={(e) => { set({ phone: e.target.value }); setDup(null); }} data-testid="drawer-phone" /></Field>
                  <Field label="E-mail"><input className="input" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} placeholder="nome@exemplo.com" data-testid="drawer-email" /></Field>
                  <Field label="Etapa do funil">
                    <select className="select" value={form.stage} onChange={(e) => set({ stage: e.target.value })} data-testid="drawer-stage">
                      {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </Field>
                  <Field label="Valor da negociação (R$)"><input className={cx('input', valueBad && 'bad')} inputMode="decimal" placeholder="0,00" value={form.value} onChange={(e) => set({ value: e.target.value })} data-testid="drawer-value" /></Field>
                </div>
                {dup && <div className="hint" style={{ marginTop: 8 }}><Icon name="alert" size={14} />Esse telefone já é de <b>{dup.name}</b>.<button type="button" className="linkbtn" onClick={() => nav(`/contacts?id=${dup.id}`)}>Abrir esse contato</button></div>}
                {initial && digitsOf(form.phone) !== digitsOf(initial.phone) && d.conversation && <div className="hint" style={{ marginTop: 8 }}><Icon name="info" size={14} />As próximas mensagens desta conversa vão para o número novo.</div>}
              </Sec>

              <Sec title="Etiquetas">
                <TagPicker value={form.tags} onChange={(tags) => set({ tags })} testId="drawer-tags" />
              </Sec>

              <Sec title="Campos personalizados" right={<Link to="/settings/campos" className="cd-link">Gerenciar campos</Link>}>
                {fields === null ? <div className="faint" style={{ fontSize: 12.5 }}>Carregando…</div>
                  : fields.length === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>Nenhum campo criado. Crie em <Link to="/settings/campos" className="cd-link">Configurações › Campos</Link> (ex.: CPF, cidade, plano).</div>
                    : <CustomFieldsEditor fields={fields} values={form.custom} onChange={(custom) => set({ custom })} />}
              </Sec>

              <Sec title="Anotações">
                <textarea className="input" rows={3} maxLength={5000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Informações sobre o cliente (só a equipe vê)" data-testid="drawer-notes" />
              </Sec>

              <Sec title="Kanban"><ContactKanban contactId={c.id} /></Sec>

              <Sec title="Vendas" right={d.revenue > 0 ? <small className="ok" style={{ fontWeight: 800 }}>{money(d.revenue)} · {d.purchases} compra{d.purchases === 1 ? '' : 's'}</small> : undefined}>
                {d.sales.length === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>Nenhuma venda registrada.</div> : (
                  <div className="cp-sales">
                    {d.sales.map((s) => (
                      <div key={s.id} className="cp-sale">
                        <div><b>{s.productName ?? 'Venda'}</b><small>{new Date(s.createdAt).toLocaleDateString('pt-BR')}</small></div>
                        <div style={{ textAlign: 'right' }}><b>{money(s.amount)}</b><span className={cx('pill', SALE[s.status]?.[1])}>{SALE[s.status]?.[0] ?? s.status}</span></div>
                      </div>
                    ))}
                  </div>
                )}
              </Sec>

              <Sec title="Informações">
                <div className="cp-rows">
                  <div><span>Origem</span><b><Icon name={ORIGIN_ICON[c.origin] ?? 'user'} size={13} /> {ORIGIN_LABEL[c.origin] ?? c.origin}{c.sourceUrl ? <> · <a href={c.sourceUrl} target="_blank" rel="noreferrer">ver anúncio ↗</a></> : null}</b></div>
                  {d.connectionName && <div><span>Chegou pelo número</span><b>{d.connectionName}</b></div>}
                  <div><span>Criado em</span><b>{dateTimeBR(c.createdAt)}</b></div>
                  <div><span>Última conversa</span><b>{c.lastContactAt ? `${dateTimeBR(c.lastContactAt)} (${timeAgo(c.lastContactAt)})` : '—'}</b></div>
                  {d.conversation && <div><span>Atendimento</span><b>{d.conversation.status === 'resolved' ? 'Resolvido' : d.conversation.assignedName ? `Com ${d.conversation.assignedName}` : 'Na fila'}</b></div>}
                </div>
              </Sec>
            </div>

            <footer className="cd-ft">
              {dirty ? <span className="faint" style={{ fontSize: 12.5 }}>Alterações não salvas</span> : <span />}
              <span className="spacer" />
              <button type="button" className="btn" onClick={() => (dirty && initial ? setForm(initial) : onClose())}>{dirty ? 'Descartar' : 'Fechar'}</button>
              <button type="button" className="btn primary" disabled={!dirty || busy || valueBad || !form.name.trim()} onClick={save} data-testid="drawer-save">{busy ? 'Salvando…' : 'Salvar alterações'}</button>
            </footer>
          </>
        )}
        {confirmLeave && (
          <ConfirmModal title="Descartar alterações?" confirm="Descartar" danger onClose={() => setConfirmLeave(null)} onConfirm={async () => { const go = confirmLeave; setConfirmLeave(null); go(); }}>
            Você mudou dados deste contato e ainda não salvou. Se sair agora, essas alterações se perdem.
          </ConfirmModal>
        )}
        {confirmDel && c && (
          <ConfirmModal title="Excluir contato" confirm="Excluir contato" danger onClose={() => setConfirmDel(false)} onConfirm={remove}>
            Excluir <b>{c.name}</b>? A conversa, as mensagens e os cards do Kanban dele também são apagados. As vendas continuam no histórico.
          </ConfirmModal>
        )}
      </aside>
    </div>
  );
}
