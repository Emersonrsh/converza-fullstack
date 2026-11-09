import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, money } from '../api';
import { Icon } from '../icons';
import { Avatar, Switch, cx, toast } from '../components/ui';
import { parsePrice } from '../components/Products';
import { fmtPhone } from './util';
import type { AccountTag, ChatContact, ChatDetail, ChatRun, ChatSale } from './types';
import { ContactKanban } from '../kanban/ContactKanban';
import { FieldInput, useContactFields } from '../contacts/CustomFields';

const STAGES: [string, string][] = [['new', 'Novo'], ['in_service', 'Em atendimento'], ['negotiating', 'Negociação'], ['won', 'Ganho'], ['lost', 'Perdido']];
const RUN_LABEL: Record<string, string> = {
  running: 'executando', waiting: 'em espera', waiting_input: 'aguardando resposta', waiting_payment: 'aguardando pagamento',
};
const SALE: Record<ChatSale['status'], [string, string]> = {
  approved: ['Aprovada', 'green'], pending: ['Pendente', 'amber'], refused: ['Recusada', 'red'], refunded: ['Reembolsada', ''],
};
const dateBR = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
const valueText = (v: string | number) => (Number(v) ? Number(v).toFixed(2).replace('.', ',') : '');

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="cp-sec">
      <div className="cp-sec-h"><b>{title}</b>{right}</div>
      {children}
    </section>
  );
}

export function ContactPanel({ detail, tags, refreshKey, onContact, onAutomation, onTagCreated, onClose }: {
  detail: ChatDetail; tags: AccountTag[]; refreshKey: number;
  onContact: (c: ChatContact) => void; onAutomation: (paused: boolean) => void; onTagCreated: (t: AccountTag) => void; onClose: () => void;
}) {
  const c = detail.contact;
  const conv = detail.conversation;
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(c.name);
  const [notes, setNotes] = useState(c.notes ?? '');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [value, setValue] = useState(valueText(c.value));
  const [runs, setRuns] = useState<ChatRun[] | null>(null);
  const [sales, setSales] = useState<ChatSale[] | null>(null);
  const fields = useContactFields();
  const [custom, setCustom] = useState<Record<string, string>>(() => ({ ...(c.custom ?? {}) }));
  const [customState, setCustomState] = useState<'idle' | 'saved'>('idle');
  const [email, setEmail] = useState(c.email ?? '');
  const [editingEmail, setEditingEmail] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [tagQ, setTagQ] = useState('');
  const tagRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setName(c.name); setEditingName(false); }, [c.id, c.name]);
  useEffect(() => { setNotes(c.notes ?? ''); setNotesState('idle'); }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setValue(valueText(c.value)); }, [c.id, c.value]);
  useEffect(() => { setCustom({ ...(c.custom ?? {}) }); setCustomState('idle'); setEmail(c.email ?? ''); setEditingEmail(false); }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    api.get<{ runs: ChatRun[] }>(`/conversations/${conv.id}/flow-runs`).then((r) => alive && setRuns(r.runs)).catch(() => alive && setRuns([]));
    return () => { alive = false; };
  }, [conv.id, conv.botPaused, refreshKey]);
  useEffect(() => {
    let alive = true;
    api.get<{ sales: ChatSale[] }>(`/conversations/${conv.id}/sales`).then((r) => alive && setSales(r.sales)).catch(() => alive && setSales([]));
    return () => { alive = false; };
  }, [conv.id, refreshKey]);

  useEffect(() => {
    if (!tagOpen) return;
    const h = (e: MouseEvent) => { if (!tagRef.current?.contains(e.target as Node)) { setTagOpen(false); setTagQ(''); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [tagOpen]);

  async function patch(p: Partial<{ name: string; stage: string; tags: string[]; value: number; notes: string | null; email: string | null; custom: Record<string, string> }>) {
    try {
      const r = await api.patch<{ contact: ChatContact }>(`/contacts/${c.id}`, p);
      onContact(r.contact);
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); return false; }
  }

  async function saveField(key: string, v: string) {
    if ((c.custom?.[key] ?? '') === v.trim()) return;
    if (await patch({ custom: { [key]: v } })) { setCustomState('saved'); setTimeout(() => setCustomState('idle'), 1800); }
  }

  async function saveEmail() {
    setEditingEmail(false);
    const v = email.trim();
    if (v === (c.email ?? '')) return;
    if (await patch({ email: v || null })) toast(v ? 'E-mail salvo' : 'E-mail removido');
    else setEmail(c.email ?? '');
  }

  async function saveName() {
    const n = name.trim();
    setEditingName(false);
    if (!n || n === c.name) { setName(c.name); return; }
    if (await patch({ name: n })) toast('Nome atualizado');
  }

  async function saveNotes() {
    if ((c.notes ?? '') === notes) return;
    setNotesState('saving');
    const ok = await patch({ notes: notes.trim() ? notes : null });
    setNotesState(ok ? 'saved' : 'idle');
  }

  async function saveValue() {
    const n = value.trim() ? parsePrice(value) : 0;
    if (Number.isNaN(n)) { toast('Valor inválido (ex.: 1.500,00)'); setValue(valueText(c.value)); return; }
    if (n === Number(c.value)) { setValue(valueText(n)); return; }
    if (await patch({ value: n })) { setValue(valueText(n)); toast('Valor da negociação salvo'); }
  }

  const tagColor = useMemo(() => new Map(tags.map((t) => [t.name.toLowerCase(), t.color])), [tags]);
  const available = tags.filter((t) => !c.tags.some((x) => x.toLowerCase() === t.name.toLowerCase())
    && t.name.toLowerCase().includes(tagQ.trim().toLowerCase()));
  const exact = tags.some((t) => t.name.toLowerCase() === tagQ.trim().toLowerCase()) || c.tags.some((x) => x.toLowerCase() === tagQ.trim().toLowerCase());

  async function addTag(nameTag: string) {
    const t = nameTag.trim();
    if (!t) return;
    setTagOpen(false); setTagQ('');
    if (!tags.some((x) => x.name.toLowerCase() === t.toLowerCase())) {
      try {
        const r = await api.post<{ tag?: AccountTag }>('/settings/tags', { name: t });
        if (r.tag) onTagCreated(r.tag);
      } catch { /* a etiqueta ainda pode ser usada no contato */ }
    }
    await patch({ tags: [...c.tags, t] });
  }

  async function stopRun(id: string) {
    try {
      await api.post(`/conversations/${conv.id}/flow-runs/${id}/stop`);
      setRuns((r) => r?.filter((x) => x.id !== id) ?? r);
      toast('Fluxo interrompido nesta conversa');
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível parar'); }
  }

  const approved = (sales ?? []).filter((s) => s.status === 'approved').reduce((a, s) => a + s.amount, 0);
  const closes = detail.windowClosesAt ? new Date(detail.windowClosesAt) : null;

  return (
    <aside className="cp" data-testid="contact-panel">
      <div className="cp-hd">
        <b>Dados do contato</b>
        <button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Fechar painel"><Icon name="close" size={15} /></button>
      </div>
      <div className="cp-body">
        <div className="cp-id">
          <Avatar name={c.name || c.phone} size={64} />
          {editingName ? (
            <input className="input sm" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(c.name); setEditingName(false); } }}
              aria-label="Nome do contato" data-testid="contact-name-input" />
          ) : (
            <button type="button" className="cp-name" onClick={() => setEditingName(true)} title="Editar nome" data-testid="contact-name">
              {c.name || fmtPhone(c.phone)}<Icon name="edit" size={13} />
            </button>
          )}
          <button type="button" className="cp-phone" title="Copiar telefone"
            onClick={() => { void navigator.clipboard?.writeText(`+${c.phone.replace(/\D/g, '')}`).then(() => toast('Telefone copiado')).catch(() => toast(fmtPhone(c.phone))); }}>
            {fmtPhone(c.phone)}<Icon name="copy" size={12} />
          </button>
        </div>

        <div className="cp-rows">
          <div><span>E-mail</span>
            {editingEmail ? (
              <input className="input sm cp-email" autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={saveEmail}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setEmail(c.email ?? ''); setEditingEmail(false); } }} data-testid="contact-email-input" />
            ) : (
              <button type="button" className="cp-inline" onClick={() => setEditingEmail(true)} data-testid="contact-email">{c.email || <span className="faint">adicionar</span>}</button>
            )}
          </div>
          <div><span>Conexão</span><b>{detail.connection ? `${detail.connection.name}${detail.connection.displayPhone ? ` · ${detail.connection.displayPhone}` : ''}` : '—'}</b></div>
          <div><span>Responsável</span><b>{conv.status === 'resolved' ? 'Conversa resolvida' : detail.assignedName ?? 'Ninguém (na fila)'}</b></div>
          <div><span>Janela de 24h</span>
            {detail.connection?.provider === 'web' ? <b className="ok" data-testid="window-web">não se aplica (QR Code)</b> : <b className={detail.windowOpen ? 'ok' : 'off'}>{detail.windowOpen && closes ? `aberta até ${closes.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}${closes.toDateString() !== new Date().toDateString() ? ` de ${closes.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` : ''}` : 'fechada'}</b>}
          </div>
          <div><span>Lead desde</span><b>{dateBR(c.createdAt)}</b></div>
          <div><span>Origem</span><b>{c.sourceId ? (c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noreferrer">Anúncio (Meta) ↗</a> : 'Anúncio (Meta)') : 'Orgânico / direto'}</b></div>
        </div>

        <Section title="Automação">
          <div className="cp-auto">
            <div>
              <b className={conv.botPaused ? 'off' : 'ok'}>{conv.botPaused ? '🙋 Atendimento humano' : '🤖 Fluxos e IA ativos'}</b>
              <small>{conv.botPaused ? 'Fluxos e agentes de IA não respondem esta conversa.' : 'Fluxos e agentes de IA podem responder esta conversa.'}</small>
            </div>
            <Switch on={!conv.botPaused} onClick={() => onAutomation(!conv.botPaused)} />
          </div>
          {runs && runs.length > 0 && (
            <div className="cp-runs">
              {runs.map((r) => (
                <div key={r.id} className="cp-run" data-testid="flow-run">
                  <Icon name="flow" size={14} /><span><b>{r.flowName}</b><small>{RUN_LABEL[r.status] ?? r.status}</small></span>
                  <button type="button" className="btn sm ghost" onClick={() => stopRun(r.id)}>Parar</button>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Funil">
          <label className="label">Etapa</label>
          <select className="select sm" value={c.stage} onChange={(e) => { void patch({ stage: e.target.value }).then((ok) => ok && toast('Etapa atualizada')); }} data-testid="contact-stage">
            {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <label className="label" style={{ marginTop: 10 }}>Valor da negociação (R$)</label>
          <input className="input sm" inputMode="decimal" placeholder="0,00" value={value} onChange={(e) => setValue(e.target.value)} onBlur={saveValue}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} data-testid="contact-value" />
        </Section>

        <Section title="Kanban">
          <ContactKanban contactId={c.id} refreshKey={refreshKey} />
        </Section>

        {fields && fields.length > 0 && (
          <Section title="Campos personalizados" right={customState === 'saved' ? <small className="faint">Salvo ✓</small> : undefined}>
            <div className="cp-fields">
              {fields.map((f) => (
                <div key={f.id} className="cp-field">
                  <label className="label">{f.label}</label>
                  <FieldInput field={f} small value={custom[f.key] ?? ''} onChange={(v) => setCustom((cur) => ({ ...cur, [f.key]: v }))} onCommit={(v) => saveField(f.key, v)} />
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="Etiquetas" right={
          <div className="menu-wrap" ref={tagRef}>
            <button type="button" className="btn sm ghost" onClick={() => setTagOpen((v) => !v)} data-testid="add-tag"><Icon name="plus" size={13} />Adicionar</button>
            {tagOpen && (
              <div className="menu cp-tagpop fade">
                <input className="input sm" autoFocus placeholder="Buscar ou criar etiqueta" value={tagQ} onChange={(e) => setTagQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const qn = tagQ.trim().toLowerCase();
                    const match = available.find((t) => t.name.toLowerCase() === qn);
                    if (match) void addTag(match.name);
                    else if (qn && !exact) void addTag(tagQ);
                  }}
                  data-testid="tag-input" />
                <div className="cp-taglist">
                  {available.slice(0, 12).map((t) => (
                    <button type="button" key={t.id} onClick={() => addTag(t.name)}><i style={{ background: t.color }} />{t.name}</button>
                  ))}
                  {tagQ.trim() && !exact && <button type="button" onClick={() => addTag(tagQ)} data-testid="create-tag"><Icon name="plus" size={12} />Criar “{tagQ.trim()}”</button>}
                  {!tagQ.trim() && available.length === 0 && <div className="faint" style={{ padding: 8, fontSize: 12 }}>Digite para criar uma etiqueta.</div>}
                </div>
              </div>
            )}
          </div>
        }>
          {c.tags.length === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>Nenhuma etiqueta.</div> : (
            <div className="cp-tags">
              {c.tags.map((t) => (
                <span key={t} className="cp-tag" style={{ ['--tc' as string]: tagColor.get(t.toLowerCase()) ?? '#0e9488' }} data-testid="contact-tag">
                  {t}<button type="button" onClick={() => patch({ tags: c.tags.filter((x) => x !== t) })} aria-label={`Remover ${t}`}><Icon name="close" size={11} /></button>
                </span>
              ))}
            </div>
          )}
        </Section>

        <Section title="Anotações" right={notesState !== 'idle' ? <small className="faint">{notesState === 'saving' ? 'Salvando…' : 'Salvo ✓'}</small> : undefined}>
          <textarea className="input cp-notes" rows={4} value={notes} placeholder="Informações sobre o cliente (só a equipe vê). Salva sozinho." maxLength={5000}
            onChange={(e) => { setNotes(e.target.value); setNotesState('idle'); }} onBlur={saveNotes} data-testid="contact-notes" />
        </Section>

        <Section title="Vendas" right={approved > 0 ? <small className="ok" style={{ fontWeight: 800 }}>{money(approved)}</small> : undefined}>
          {sales === null ? <div className="faint" style={{ fontSize: 12.5 }}>Carregando…</div>
            : sales.length === 0 ? <div className="faint" style={{ fontSize: 12.5 }}>Nenhuma venda registrada para este contato.</div>
              : (
                <div className="cp-sales">
                  {sales.map((s) => (
                    <div key={s.id} className="cp-sale">
                      <div><b>{s.productName ?? 'Venda'}</b><small>{dateBR(s.createdAt)}</small></div>
                      <div style={{ textAlign: 'right' }}><b>{money(s.amount)}</b><span className={cx('pill', SALE[s.status][1])}>{SALE[s.status][0]}</span></div>
                    </div>
                  ))}
                </div>
              )}
        </Section>
      </div>
    </aside>
  );
}
