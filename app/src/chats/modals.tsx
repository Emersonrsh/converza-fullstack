import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { QuickRepliesManager } from '../settings/QuickReplies';
import { Avatar, Field, Modal, Spinner, cx, toast } from '../components/ui';
import { firstName, fmtPhone } from './util';
import type { ChatConnection, ChatDepartment, QuickReply, TeamMember, TemplatePayload, WaTemplate } from './types';

/* ------------------------------------------------------------ nova conversa */

export interface ContactLite { id: string; name: string; phone: string; }

export function NewChatModal({ connections, onClose, onCreated, initial }: {
  connections: ChatConnection[]; onClose: () => void; onCreated: (conversationId: string) => void; initial?: ContactLite | null;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [mode, setMode] = useState<'contact' | 'number'>('contact');
  const [q, setQ] = useState(initial?.name ?? '');
  const [results, setResults] = useState<ContactLite[] | null>(initial ? [initial] : null);
  const [picked, setPicked] = useState<ContactLite | null>(initial ?? null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'contact') return;
    let alive = true;
    const t = setTimeout(() => {
      api.get<{ contacts: ContactLite[] }>(`/contacts${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
        .then((r) => alive && setResults(r.contacts.slice(0, 8))).catch(() => alive && setResults([]));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, mode]);

  const digits = phone.replace(/\D/g, '');
  const canSubmit = !!connectionId && (mode === 'contact' ? !!picked : digits.length >= 10 && digits.length <= 15);

  async function submit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ conversation: { id: string } }>('/conversations',
        mode === 'contact' ? { connectionId, contactId: picked!.id } : { connectionId, phone, name: name.trim() || undefined });
      onCreated(r.conversation.id);
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível iniciar a conversa'); setBusy(false); }
  }

  if (connections.length === 0) {
    return (
      <Modal title="Nova conversa" onClose={onClose}>
        <div className="empty" style={{ padding: '18px 8px' }}>
          <Icon name="plug" size={30} />
          <div style={{ marginTop: 8 }}><b>Conecte um número de WhatsApp primeiro</b></div>
          <div className="muted" style={{ fontSize: 13, margin: '6px 0 14px' }}>As conversas saem pelo número conectado em Conexões.</div>
          <Link to="/connections" className="btn primary sm" onClick={onClose}>Ir para Conexões</Link>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Nova conversa" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!canSubmit || busy} onClick={submit} data-testid="start-chat">{busy ? 'Abrindo…' : 'Iniciar conversa'}</button>
    </>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Enviar pelo número">
          <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} data-testid="new-connection">
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.displayPhone ? ` · ${c.displayPhone}` : ''}</option>)}
          </select>
        </Field>
        <div className="seg">
          <button type="button" className={cx(mode === 'contact' && 'active')} onClick={() => setMode('contact')}>Contato salvo</button>
          <button type="button" className={cx(mode === 'number' && 'active')} onClick={() => { setMode('number'); setPicked(null); }} data-testid="mode-number">Novo número</button>
        </div>
        {mode === 'contact' ? (
          <div>
            <input className="input" autoFocus={!initial} placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} data-testid="new-search" />
            <div className="nc-results">
              {results === null && <div style={{ height: 60 }}><Spinner /></div>}
              {results?.length === 0 && <div className="faint" style={{ padding: 10, fontSize: 13 }}>Nenhum contato encontrado. Use “Novo número”.</div>}
              {results?.map((c) => (
                <button type="button" key={c.id} className={cx('nc-item', picked?.id === c.id && 'on')} onClick={() => setPicked(c)} data-testid="new-result">
                  <Avatar name={c.name || c.phone} size={30} /><span><b>{c.name}</b><small>{fmtPhone(c.phone)}</small></span>
                  {picked?.id === c.id && <Icon name="check" size={16} />}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <Field label="WhatsApp (com DDD)">
              <input className="input" autoFocus inputMode="tel" placeholder="(11) 98888-7777 ou +1 555 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="new-phone" />
            </Field>
            <Field label="Nome (opcional)">
              <input className="input" placeholder="Como o contato vai aparecer" value={name} onChange={(e) => setName(e.target.value)} data-testid="new-name" />
            </Field>
          </>
        )}
        <div className="hint"><Icon name="info" size={14} />Pelas regras do WhatsApp, a primeira mensagem para quem não te chamou nas últimas 24h precisa ser um <b>modelo aprovado</b>. Ao iniciar, você escolhe o modelo.</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- transferir */

export function TransferModal({ members, departments = [], currentId, currentDept = null, meId, onClose, onConfirm, onDepartment }: {
  members: TeamMember[]; departments?: ChatDepartment[]; currentId: string | null; currentDept?: string | null; meId: string;
  onClose: () => void; onConfirm: (userId: string) => Promise<void>; onDepartment?: (departmentId: string | null) => Promise<void>;
}) {
  const options = members.filter((m) => m.userId !== currentId);
  const [mode, setMode] = useState<'person' | 'dept'>('person');
  const [sel, setSel] = useState<string>(options[0]?.userId ?? '');
  const [dept, setDept] = useState<string>(departments.find((d) => d.id !== currentDept)?.id ?? '');
  const [busy, setBusy] = useState(false);
  const ROLE: Record<string, string> = { owner: 'Dono', admin: 'Admin', agent: 'Atendente' };
  const canDept = departments.length > 0 && !!onDepartment;
  async function go() {
    setBusy(true);
    if (mode === 'person') await onConfirm(sel);
    else await onDepartment?.(dept || null);
    setBusy(false);
  }
  return (
    <Modal title="Transferir conversa" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={busy || (mode === 'person' ? !sel : false)} onClick={go} data-testid="confirm-transfer">{mode === 'dept' ? 'Mandar para o setor' : 'Transferir'}</button>
    </>}>
      {canDept && (
        <div className="seg" style={{ marginBottom: 12, width: '100%' }}>
          <button type="button" style={{ flex: 1 }} className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')} data-testid="transfer-mode-person">Para uma pessoa</button>
          <button type="button" style={{ flex: 1 }} className={mode === 'dept' ? 'active' : ''} onClick={() => setMode('dept')} data-testid="transfer-mode-dept">Para um setor</button>
        </div>
      )}
      {mode === 'dept' ? (
        <div className="stack" style={{ gap: 6 }}>
          {departments.map((d) => (
            <label key={d.id} className={cx('nc-item', dept === d.id && 'on')} data-testid="transfer-dept">
              <input type="radio" name="dept" checked={dept === d.id} onChange={() => setDept(d.id)} hidden />
              <span className="st-dot" style={{ background: d.color, width: 12, height: 12 }} />
              <span><b>{d.name}{d.id === currentDept ? ' (setor atual)' : ''}</b><small>Fica em “Aguardando” para quem é do setor</small></span>
              {dept === d.id && <Icon name="check" size={16} />}
            </label>
          ))}
          <label className={cx('nc-item', dept === '' && 'on')}>
            <input type="radio" name="dept" checked={dept === ''} onChange={() => setDept('')} hidden />
            <span className="st-dot" style={{ background: 'var(--faint)', width: 12, height: 12 }} />
            <span><b>Fila geral</b><small>Sem setor: qualquer pessoa da equipe pode pegar</small></span>
            {dept === '' && <Icon name="check" size={16} />}
          </label>
          <div className="hint"><Icon name="info" size={14} />A conversa sai de quem está atendendo e volta para “Aguardando”, com a automação pausada. Quem do setor pegar primeiro, atende.</div>
        </div>
      ) : options.length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>
          Não há outra pessoa na equipe.<br />
          <Link to="/settings/equipe" onClick={onClose}>Adicionar pessoas na equipe</Link>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {options.map((m) => (
            <label key={m.userId} className={cx('nc-item', sel === m.userId && 'on')} data-testid="transfer-option">
              <input type="radio" name="transfer" checked={sel === m.userId} onChange={() => setSel(m.userId)} hidden />
              <Avatar name={m.name} size={30} />
              <span><b>{m.name}{m.userId === meId ? ' (você)' : ''}</b><small>{ROLE[m.role] ?? m.role} · {m.email}</small></span>
              {sel === m.userId && <Icon name="check" size={16} />}
            </label>
          ))}
          <div className="hint"><Icon name="info" size={14} />A pessoa passa a ser a responsável e a conversa fica em “Atendendo”. Fica registrado no histórico.</div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------- modelo (template) */

const CAT: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' };
const MEDIA_LABEL: Record<string, string> = { IMAGE: 'imagem', VIDEO: 'vídeo', DOCUMENT: 'documento', LOCATION: 'localização' };
const fillNamed = (text: string, vals: Record<string, string>) =>
  text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, n: string) => vals[n]?.trim() || `{{${n}}}`);
const isNameVar = (v: string, i: number, positional: boolean) => (positional ? i === 0 : /nome|name/i.test(v));
const httpsUrl = (u: string) => /^https:\/\/\S+\.\S+/i.test(u.trim());

export function TemplateModal({ connectionId, contactName, onClose, onSend }: {
  connectionId: string; contactName: string; onClose: () => void;
  onSend: (payload: TemplatePayload) => Promise<boolean>;
}) {
  const [list, setList] = useState<WaTemplate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<WaTemplate | null>(null);
  const [bodyVals, setBodyVals] = useState<Record<string, string>>({});
  const [headerVals, setHeaderVals] = useState<Record<string, string>>({});
  const [mediaLink, setMediaLink] = useState('');
  const [mediaName, setMediaName] = useState('');
  const [btnVals, setBtnVals] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<{ templates: WaTemplate[] }>(`/connections/${connectionId}/templates`)
      .then((r) => { if (alive) setList(r.templates); })
      .catch((e) => { if (alive) { setErr(e instanceof Error ? e.message : 'Não foi possível carregar os modelos'); setList([]); } });
    return () => { alive = false; };
  }, [connectionId]);

  function pick(t: WaTemplate) {
    const positional = t.paramFormat === 'positional';
    const first = firstName(contactName || '');
    setSel(t);
    setBodyVals(Object.fromEntries(t.bodyVars.map((v, i) => [v, isNameVar(v, i, positional) ? first : ''])));
    setHeaderVals(Object.fromEntries((t.header?.vars ?? []).map((v, i) => [v, isNameVar(v, i, positional) ? first : ''])));
    setMediaLink(''); setMediaName(''); setBtnVals({});
  }

  const shown = (list ?? []).filter((t) => `${t.name} ${t.body}`.toLowerCase().includes(q.trim().toLowerCase()));
  const media = sel?.header && sel.header.format !== 'TEXT' ? sel.header.format : null;
  const varButtons = (sel?.buttons ?? []).map((b, index) => ({ ...b, index })).filter((b) => b.hasVar);
  const unsupported = sel ? (media === 'LOCATION' ? 'Modelos com cabeçalho de localização ainda não podem ser enviados por aqui.'
    : sel.category === 'AUTHENTICATION' ? 'Modelos de autenticação (código de acesso) são enviados pelo seu sistema, não pelo chat.' : null) : null;

  const headerText = sel?.header?.format === 'TEXT' && sel.header.text ? fillNamed(sel.header.text, headerVals) : null;
  const bodyText = sel ? fillNamed(sel.body, bodyVals) : '';
  const preview = [headerText ? `*${headerText}*` : '', bodyText, sel?.footer ? `_${sel.footer}_` : ''].filter(Boolean).join('\n\n');
  const missing = !sel || !!unsupported
    || sel.bodyVars.some((v) => !bodyVals[v]?.trim())
    || (sel.header?.vars ?? []).some((v) => !headerVals[v]?.trim())
    || (!!media && !httpsUrl(mediaLink))
    || varButtons.some((b) => !btnVals[b.index]?.trim());

  async function send() {
    if (!sel || missing) return;
    const named = sel.paramFormat === 'named';
    const payload: TemplatePayload = {
      name: sel.name, language: sel.language, preview,
      body: sel.bodyVars.map((v) => ({ ...(named ? { name: v } : {}), value: bodyVals[v].trim() })),
      header: media
        ? { type: media.toLowerCase() as 'image' | 'video' | 'document', link: mediaLink.trim(), ...(media === 'DOCUMENT' && mediaName.trim() ? { filename: mediaName.trim() } : {}) }
        : sel.header?.vars.length ? { type: 'text', ...(named ? { name: sel.header.vars[0] } : {}), value: headerVals[sel.header.vars[0]].trim() } : undefined,
      buttons: varButtons.map((b) => ({ index: b.index, subType: b.type === 'COPY_CODE' ? 'copy_code' as const : 'url' as const, value: btnVals[b.index].trim() })),
    };
    setBusy(true);
    const ok = await onSend(payload);
    setBusy(false);
    if (ok) onClose();
  }

  const varLabel = (v: string) => `{{${v}}}`;

  return (
    <Modal title={sel ? `Modelo: ${sel.name}` : 'Enviar modelo de mensagem'} onClose={onClose} footer={sel ? <>
      <button type="button" className="btn" onClick={() => setSel(null)}>Voltar</button>
      <button type="button" className="btn primary" disabled={missing || busy} data-testid="send-template" onClick={send}>
        <Icon name="send" size={14} />{busy ? 'Enviando…' : 'Enviar modelo'}
      </button>
    </> : undefined}>
      {list === null && <div style={{ height: 120 }}><Spinner /></div>}
      {err && (
        <div className="empty" style={{ padding: 14 }}>
          <Icon name="alert" size={26} />
          <div style={{ margin: '8px 0 4px' }}><b>{err}</b></div>
          <div className="muted" style={{ fontSize: 12.5 }}>Os modelos são criados e aprovados no Gerenciador do WhatsApp da Meta e aparecem aqui automaticamente.</div>
        </div>
      )}
      {list && !err && !sel && (
        <>
          <input className="input" placeholder="Buscar modelo" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} data-testid="template-search" />
          {shown.length === 0 && <div className="empty" style={{ padding: 14 }}>{list.length === 0 ? 'Nenhum modelo aprovado nesta conta do WhatsApp. Crie um no Gerenciador do WhatsApp (Meta Business) e aguarde a aprovação.' : 'Nenhum modelo com esse nome.'}</div>}
          <div className="tpl-list">
            {shown.map((t) => (
              <button type="button" key={`${t.name}-${t.language}`} className="tpl-item" onClick={() => pick(t)} data-testid="template-item">
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <b>{t.name}</b><span className="pill">{t.language}</span><span className="pill teal">{CAT[t.category] ?? t.category}</span>
                  {t.header && t.header.format !== 'TEXT' && <span className="pill blue">com {MEDIA_LABEL[t.header.format] ?? 'mídia'}</span>}
                </div>
                <span className="tpl-body">{t.body}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {sel && (
        <div className="stack" style={{ gap: 12 }}>
          {unsupported && <div className="hint"><Icon name="alert" size={14} />{unsupported}</div>}
          {media && media !== 'LOCATION' && (
            <>
              <Field label={`Link público da ${MEDIA_LABEL[media]} do cabeçalho (https://)`}>
                <input className="input" placeholder="https://seusite.com/arquivo" value={mediaLink} onChange={(e) => setMediaLink(e.target.value)} data-testid="template-media" />
              </Field>
              {media === 'DOCUMENT' && (
                <Field label="Nome do arquivo (opcional)">
                  <input className="input" placeholder="proposta.pdf" value={mediaName} onChange={(e) => setMediaName(e.target.value)} />
                </Field>
              )}
            </>
          )}
          {(sel.header?.vars ?? []).map((v) => (
            <Field key={`h-${v}`} label={`Cabeçalho ${varLabel(v)}`}>
              <input className="input" maxLength={60} value={headerVals[v] ?? ''} onChange={(e) => setHeaderVals((o) => ({ ...o, [v]: e.target.value }))}
                placeholder={sel.header?.example ?? 'Texto'} data-testid="template-header-param" />
            </Field>
          ))}
          {sel.bodyVars.map((v, i) => (
            <Field key={`b-${v}`} label={`Variável ${varLabel(v)}`}>
              <input className="input" value={bodyVals[v] ?? ''} onChange={(e) => setBodyVals((o) => ({ ...o, [v]: e.target.value }))}
                placeholder={sel.bodyExamples[i] ? `Ex.: ${sel.bodyExamples[i]}` : 'Texto'} data-testid="template-param" />
            </Field>
          ))}
          {varButtons.map((b) => (
            <Field key={`btn-${b.index}`} label={b.type === 'COPY_CODE' ? 'Código do cupom (botão copiar código)' : `Final do link do botão “${b.text}” (${b.url ?? ''})`}>
              <input className="input" value={btnVals[b.index] ?? ''} onChange={(e) => setBtnVals((o) => ({ ...o, [b.index]: e.target.value }))}
                placeholder={b.example ? `Ex.: ${b.example}` : 'Texto'} data-testid="template-button-param" />
            </Field>
          ))}
          <div>
            <label className="label">Prévia</label>
            <div className="tpl-preview" data-testid="template-preview">
              {media === 'IMAGE' && httpsUrl(mediaLink) && <img src={mediaLink.trim()} alt="" className="tpl-media" />}
              {media && !(media === 'IMAGE' && httpsUrl(mediaLink)) && <span className="tpl-media-ph">{media === 'VIDEO' ? '🎬' : media === 'DOCUMENT' ? '📄' : media === 'IMAGE' ? '🖼️' : '📍'} {MEDIA_LABEL[media]} do cabeçalho</span>}
              {headerText && <b>{headerText}</b>}
              <span>{bodyText}</span>
              {sel.footer && <small>{sel.footer}</small>}
              {sel.buttons.length > 0 && <div className="tpl-btns">{sel.buttons.map((b, i) => <span key={i}>{b.text}</span>)}</div>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------- respostas rápidas */

export function QuickRepliesModal({ onClose, onChange }: {
  items?: QuickReply[]; onClose: () => void; onChange: (items: QuickReply[]) => void;
}) {
  return (
    <Modal title="Respostas rápidas" subtitle="Também ficam em Configurações › Respostas Rápidas" icon="bolt" width={860} onClose={onClose}>
      <QuickRepliesManager onChange={onChange} />
    </Modal>
  );
}
