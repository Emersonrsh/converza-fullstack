import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, api, getAccountId, getToken } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../icons';
import { Field, Modal, Spinner, toast } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import { Badge, Drawer, EmptyBox, Head, LoadError, SearchBox, errMsg, relTime, useLoad } from './common';

interface TplButton { type: string; text: string; url: string | null; hasVar: boolean; example: string | null }
interface Tpl {
  id: string; name: string; language: string; category: string; status: string; paramFormat: 'positional' | 'named';
  header: { format: string; text: string | null; vars: string[]; example: string | null } | null;
  body: string; bodyVars: string[]; bodyExamples: string[]; footer: string | null; buttons: TplButton[];
  rejectedReason: string | null; quality: string | null;
}
interface Waba { id: string; name: string; wabaId: string; displayPhone: string | null }

export const TPL_STATUS: Record<string, [string, string]> = {
  APPROVED: ['Aprovado', 'green'], PENDING: ['Em análise', 'amber'], IN_APPEAL: ['Em recurso', 'amber'], REJECTED: ['Rejeitado', 'red'],
  PAUSED: ['Pausado', 'amber'], DISABLED: ['Desativado', 'red'], PENDING_DELETION: ['Excluindo', ''], LIMIT_EXCEEDED: ['Limite excedido', 'red'], ARCHIVED: ['Arquivado', ''],
};
const CAT: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação' };
const LANGS: [string, string][] = [
  ['pt_BR', 'Português (Brasil)'], ['pt_PT', 'Português (Portugal)'], ['en_US', 'Inglês (EUA)'], ['en_GB', 'Inglês (Reino Unido)'],
  ['es', 'Espanhol'], ['es_ES', 'Espanhol (Espanha)'], ['es_MX', 'Espanhol (México)'], ['es_AR', 'Espanhol (Argentina)'], ['fr', 'Francês'], ['it', 'Italiano'], ['de', 'Alemão'],
];
const langLabel = (l: string) => LANGS.find(([v]) => v === l)?.[1] ?? l;
const QUALITY: Record<string, [string, string]> = { GREEN: ['Alta', 'green'], YELLOW: ['Média', 'amber'], RED: ['Baixa', 'red'], UNKNOWN: ['Sem dados', ''] };
const REJECT: Record<string, string> = {
  INVALID_FORMAT: 'formato inválido', ABUSIVE_CONTENT: 'conteúdo considerado abusivo', PROMOTIONAL: 'conteúdo promocional em categoria errada',
  TAG_CONTENT_MISMATCH: 'o conteúdo não bate com a categoria', SCAM: 'parece golpe', INCORRECT_CATEGORY: 'categoria incorreta',
};

const fill = (text: string, ex: string[]) => text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => ex[Number(n) - 1]?.trim() || `{{${n}}}`);
const varsOf = (text: string) => [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

function Preview({ header, headerFile, body, examples, footer, buttons }: {
  header: { format: string; text?: string | null; example?: string | null } | null; headerFile?: string | null; body: string; examples: string[];
  footer?: string | null; buttons: { type: string; text: string }[];
}) {
  return (
    <div className="st-tpl-prev" data-testid="tpl-preview">
      <div className="st-tpl-bub">
        {header && header.format === 'TEXT' && header.text && <div className="hd">{fill(header.text, [header.example ?? ''])}</div>}
        {header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format) && (
          <div className="st-tpl-media"><Icon name={header.format === 'IMAGE' ? 'image' : header.format === 'VIDEO' ? 'play' : 'file'} size={26} />{headerFile && <span style={{ marginLeft: 8, fontSize: 12 }}>{headerFile}</span>}</div>
        )}
        {fill(body || 'O texto do modelo aparece aqui.', examples)}
        {footer && <div className="ft">{footer}</div>}
      </div>
      {buttons.map((b, i) => (
        <div key={i} className="st-tpl-btn"><Icon name={b.type === 'URL' ? 'link' : b.type === 'PHONE_NUMBER' ? 'phone' : 'reply'} size={13} /> {b.text || 'Botão'}</div>
      ))}
    </div>
  );
}

type Btn = { type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'; text: string; url?: string; example?: string; phone?: string };

function CreateModal({ waba, onClose, onCreated }: { waba: Waba; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>('UTILITY');
  const [language, setLanguage] = useState('pt_BR');
  const [hFormat, setHFormat] = useState<'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'>('NONE');
  const [hText, setHText] = useState('');
  const [hExample, setHExample] = useState('');
  const [hHandle, setHHandle] = useState<string | null>(null);
  const [hFile, setHFile] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<Btn[]>([]);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const vars = useMemo(() => varsOf(body), [body]);
  useEffect(() => { setExamples((e) => vars.map((_, i) => e[i] ?? '')); }, [vars.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function addVar() {
    const n = (vars[vars.length - 1] ?? 0) + 1;
    const el = bodyRef.current; const token = `{{${n}}}`;
    const s = el?.selectionStart ?? body.length; const e = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, s) + token + body.slice(e));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + token.length, s + token.length); });
  }

  async function uploadSample(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'x-file-type': f.type || (f.name.endsWith('.pdf') ? 'application/pdf' : '') };
      const t = getToken(); const a = getAccountId();
      if (t) headers.Authorization = `Bearer ${t}`;
      if (a) headers['x-account-id'] = a;
      const res = await fetch(`${API_BASE}/templates/sample?connectionId=${waba.id}&format=${hFormat}&filename=${encodeURIComponent(f.name)}`, { method: 'POST', headers, body: f });
      const d = await res.json().catch(() => ({})) as { handle?: string; error?: string };
      if (!res.ok || !d.handle) throw new Error(d.error ?? `Erro ${res.status}`);
      setHHandle(d.handle); setHFile(f.name);
    } catch (e) { toast(errMsg(e, 'Não foi possível enviar a amostra')); }
    setUploading(false);
  }

  const header = hFormat === 'NONE' ? { format: 'NONE' as const }
    : hFormat === 'TEXT' ? { format: 'TEXT' as const, text: hText, ...(varsOf(hText).length ? { example: hExample } : {}) }
      : { format: hFormat, handle: hHandle ?? '' };
  const ready = /^[a-z0-9_]{1,512}$/.test(name) && body.trim() && (hFormat === 'NONE' || (hFormat === 'TEXT' ? hText.trim() : !!hHandle))
    && examples.every((x) => x.trim()) && buttons.every((b) => b.text.trim() && (b.type !== 'URL' || b.url?.trim()) && (b.type !== 'PHONE_NUMBER' || b.phone?.trim()));

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const r = await api.post<{ template: { status: string } }>('/templates', {
        connectionId: waba.id, name, category, language, header, body, bodyExamples: examples, footer: footer.trim() || undefined,
        buttons: buttons.map((b) => (b.type === 'QUICK_REPLY' ? { type: b.type, text: b.text } : b.type === 'URL' ? { type: b.type, text: b.text, url: b.url, ...(b.example ? { example: b.example } : {}) } : { type: b.type, text: b.text, phone: b.phone })),
      });
      toast(`Modelo enviado para a Meta (${TPL_STATUS[r.template.status]?.[0] ?? r.template.status})`);
      onCreated();
    } catch (e) { toast(errMsg(e, 'A Meta não aceitou o modelo')); }
    setBusy(false);
  }

  const setBtn = (i: number, patch: Partial<Btn>) => setButtons((l) => l.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <Modal title="Criar modelo" subtitle={`Conta ${waba.name}${waba.displayPhone ? ` · ${waba.displayPhone}` : ''} — a Meta analisa antes de liberar`} icon="file" width={940} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ready || busy || uploading} onClick={submit} data-testid="tpl-submit">{busy ? 'Enviando…' : 'Enviar para análise'}</button>
    </>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20 }}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="st-form">
            <div className="full">
              <Field label="Nome do modelo"><input className="input" autoFocus value={name} maxLength={512} onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))} placeholder="pedido_confirmado" data-testid="tpl-name" /></Field>
              <div className="st-help">Só letras minúsculas, números e _. Não dá para mudar depois.</div>
            </div>
            <Field label="Categoria">
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value as 'MARKETING' | 'UTILITY')} data-testid="tpl-category">
                <option value="UTILITY">Utilidade (pedido, entrega, lembrete)</option>
                <option value="MARKETING">Marketing (ofertas, novidades)</option>
              </select>
            </Field>
            <Field label="Idioma">
              <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="tpl-language">
                {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Cabeçalho (opcional)">
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'] as const).map((f) => (
                <button type="button" key={f} className={hFormat === f ? 'active' : ''} onClick={() => { setHFormat(f); setHHandle(null); setHFile(null); }}>
                  {({ NONE: 'Nenhum', TEXT: 'Texto', IMAGE: 'Imagem', VIDEO: 'Vídeo', DOCUMENT: 'Documento' })[f]}
                </button>
              ))}
            </div>
          </Field>
          {hFormat === 'TEXT' && (
            <div className="st-form">
              <Field label="Texto do cabeçalho"><input className="input" value={hText} maxLength={60} onChange={(e) => setHText(e.target.value)} placeholder="Seu pedido saiu!" /></Field>
              {varsOf(hText).length > 0 && <Field label="Exemplo de {{1}}"><input className="input" value={hExample} onChange={(e) => setHExample(e.target.value)} /></Field>}
            </div>
          )}
          {['IMAGE', 'VIDEO', 'DOCUMENT'].includes(hFormat) && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <button type="button" className="btn" disabled={uploading} onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} />{uploading ? 'Enviando para a Meta…' : hFile ? 'Trocar amostra' : 'Enviar amostra'}</button>
                {hFile && <span className="st-mini"><Icon name="check" size={12} /> {hFile}</span>}
              </div>
              <input ref={fileRef} type="file" hidden accept={hFormat === 'IMAGE' ? 'image/jpeg,image/png' : hFormat === 'VIDEO' ? 'video/mp4' : 'application/pdf'} onChange={(e) => { void uploadSample(e.target.files?.[0]); e.target.value = ''; }} />
              <span className="st-help">A Meta exige um exemplo para analisar. Na hora de enviar o modelo, você escolhe o arquivo de verdade.</span>
            </div>
          )}

          <div>
            <div className="st-row-between"><label className="label">Corpo da mensagem</label><button type="button" className="btn sm ghost" onClick={addVar} data-testid="tpl-add-var"><Icon name="plus" size={13} />Variável</button></div>
            <textarea ref={bodyRef} className="input" rows={5} value={body} maxLength={1024} onChange={(e) => setBody(e.target.value)} placeholder="Olá {{1}}, seu pedido {{2}} foi confirmado e chega em até 3 dias úteis." data-testid="tpl-body" />
            <div className="st-help">Variáveis em ordem: {'{{1}}'}, {'{{2}}'}… e nunca no começo nem no fim do texto. {body.length}/1024</div>
          </div>
          {vars.length > 0 && (
            <div className="st-form">
              {vars.map((n, i) => (
                <Field key={n} label={`Exemplo de {{${n}}}`}><input className="input" value={examples[i] ?? ''} onChange={(e) => setExamples((l) => l.map((x, j) => (j === i ? e.target.value : x)))} placeholder={n === 1 ? 'Maria' : '#1234'} data-testid="tpl-example" /></Field>
              ))}
            </div>
          )}
          <Field label="Rodapé (opcional)"><input className="input" value={footer} maxLength={60} onChange={(e) => setFooter(e.target.value)} placeholder="Responda SAIR para não receber mais" /></Field>

          <div>
            <label className="label">Botões (opcional)</label>
            <div className="stack" style={{ gap: 8 }}>
              {buttons.map((b, i) => (
                <div key={i} className="st-action" style={{ padding: 10 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone="teal">{b.type === 'QUICK_REPLY' ? 'Resposta' : b.type === 'URL' ? 'Link' : 'Ligar'}</Badge>
                    <input className="input sm" value={b.text} maxLength={25} onChange={(e) => setBtn(i, { text: e.target.value })} placeholder="Texto do botão" />
                    <button type="button" className="btn icon sm ghost" onClick={() => setButtons((l) => l.filter((_, j) => j !== i))} aria-label="Remover botão"><Icon name="trash" size={14} /></button>
                  </div>
                  {b.type === 'URL' && (
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <input className="input sm" value={b.url ?? ''} onChange={(e) => setBtn(i, { url: e.target.value })} placeholder="https://loja.com/pedido/{{1}}" />
                      {/\{\{\s*1\s*\}\}$/.test(b.url ?? '') && <input className="input sm" value={b.example ?? ''} onChange={(e) => setBtn(i, { example: e.target.value })} placeholder="Exemplo completo do link" />}
                    </div>
                  )}
                  {b.type === 'PHONE_NUMBER' && <input className="input sm" style={{ marginTop: 8 }} value={b.phone ?? ''} onChange={(e) => setBtn(i, { phone: e.target.value.replace(/[^\d+]/g, '') })} placeholder="+5511999999999" />}
                </div>
              ))}
            </div>
            {buttons.length < 10 && (
              <div className="st-addbar" style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={() => setButtons((l) => [...l, { type: 'QUICK_REPLY', text: '' }])}><Icon name="reply" size={13} />Resposta rápida</button>
                <button type="button" className="btn sm" disabled={buttons.filter((b) => b.type === 'URL').length >= 2} onClick={() => setButtons((l) => [...l, { type: 'URL', text: '', url: '' }])}><Icon name="link" size={13} />Link</button>
                <button type="button" className="btn sm" disabled={buttons.some((b) => b.type === 'PHONE_NUMBER')} onClick={() => setButtons((l) => [...l, { type: 'PHONE_NUMBER', text: '', phone: '' }])}><Icon name="phone" size={13} />Ligar</button>
              </div>
            )}
          </div>
        </div>
        <div>
          <label className="label">Prévia</label>
          <Preview header={hFormat === 'NONE' ? null : { format: hFormat, text: hText, example: hExample }} headerFile={hFile} body={body} examples={examples} footer={footer} buttons={buttons} />
          <div className="st-help" style={{ marginTop: 10 }}>A análise da Meta costuma levar de minutos a algumas horas. O status atualiza aqui quando você sincronizar.</div>
        </div>
      </div>
    </Modal>
  );
}

export function TemplatesPage() {
  const { accountId } = useAuth();
  const wabas = useLoad(() => api.get<{ wabas: Waba[]; canEdit: boolean }>('/templates/wabas'), [accountId]);
  const [connId, setConnId] = useState('');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [fresh, setFresh] = useState(0);
  const waba = wabas.data?.wabas.find((w) => w.id === connId) ?? wabas.data?.wabas[0];
  const list = useLoad(() => (waba
    ? api.get<{ templates: Tpl[]; counts: Record<string, number>; syncedAt: string }>(`/templates?connectionId=${waba.id}&status=${status}${fresh ? '&fresh=1' : ''}`)
    : Promise.resolve(null)), [waba?.id, status, fresh]);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<Tpl | null>(null);
  const [del, setDel] = useState<Tpl | null>(null);

  const canEdit = !!wabas.data?.canEdit;
  const head = <Head slug="templates" actions={waba && <>
    <button type="button" className="btn" onClick={() => setFresh((n) => n + 1)} disabled={!list.data && !list.error} data-testid="tpl-sync"><Icon name="refresh" size={15} />Sincronizar</button>
    {canEdit && <button type="button" className="btn primary" onClick={() => setCreating(true)} data-testid="tpl-new"><Icon name="plus" size={15} />Criar modelo</button>}
  </>} />;

  if (wabas.error && !wabas.data) return <>{head}<LoadError error={wabas.error} onRetry={wabas.reload} /></>;
  if (!wabas.data) return <>{head}<Spinner /></>;
  if (!waba) {
    return <>{head}<div className="st-card"><EmptyBox icon="file" title="Nenhuma conta do WhatsApp Business" text="Os modelos ficam na conta do WhatsApp Business (WABA) do seu número. Conecte um número em Conexões para ver e criar modelos." /></div></>;
  }
  const items = (list.data?.templates ?? []).filter((t) => !q.trim() || t.name.includes(q.trim().toLowerCase()) || t.body.toLowerCase().includes(q.trim().toLowerCase()));
  const counts = list.data?.counts ?? {};

  return (
    <div data-testid="templates-page">
      {head}
      <div className="st-toolbar">
        {wabas.data.wabas.length > 1 && (
          <select className="select" value={waba.id} onChange={(e) => setConnId(e.target.value)} aria-label="Conta do WhatsApp" data-testid="tpl-waba">
            {wabas.data.wabas.map((w) => <option key={w.id} value={w.id}>{w.name}{w.displayPhone ? ` · ${w.displayPhone}` : ''}</option>)}
          </select>
        )}
        {wabas.data.wabas.length === 1 && <Badge tone="teal"><Icon name="phone" size={11} />{waba.name}{waba.displayPhone ? ` · ${waba.displayPhone}` : ''}</Badge>}
        <SearchBox value={q} onChange={setQ} placeholder="Buscar modelo" testId="tpl-search" />
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" data-testid="tpl-status">
          <option value="all">Todos os status</option>
          {['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED'].map((s) => <option key={s} value={s}>{TPL_STATUS[s][0]}{counts[s] ? ` (${counts[s]})` : ''}</option>)}
        </select>
        {list.data && <span className="st-mini">sincronizado {relTime(list.data.syncedAt)}</span>}
      </div>
      {list.error ? <LoadError error={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : items.length === 0 ? (
        <div className="st-card"><EmptyBox icon="file" title={q || status !== 'all' ? 'Nenhum modelo com esses filtros' : 'Nenhum modelo nesta conta'} text="Modelos são mensagens aprovadas pela Meta: são o único jeito de falar com quem não te escreveu nas últimas 24 horas (disparos, lembretes, recuperação de carrinho)."
          action={canEdit && !q && status === 'all' && <button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Criar modelo</button>} /></div>
      ) : (
        <div className="st-tbl">
          <table>
            <thead><tr><th>Modelo</th><th>Idioma</th><th>Categoria</th><th>Status</th><th>Qualidade</th><th className="acts" /></tr></thead>
            <tbody>
              {items.map((t) => {
                const [label, tone] = TPL_STATUS[t.status] ?? [t.status, ''];
                const [ql, qt] = QUALITY[t.quality ?? ''] ?? ['—', ''];
                return (
                  <tr key={`${t.name}-${t.language}`} data-testid="tpl-row" style={{ cursor: 'pointer' }} onClick={() => setViewing(t)}>
                    <td><b className="mono">{t.name}</b><div className="st-mini" style={{ maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.body}</div></td>
                    <td className="muted">{langLabel(t.language)}</td>
                    <td>{CAT[t.category] ?? t.category}</td>
                    <td><Badge tone={tone}>{label}</Badge>{t.rejectedReason && <div className="st-mini" style={{ color: 'var(--danger)' }}>{REJECT[t.rejectedReason] ?? t.rejectedReason}</div>}</td>
                    <td>{t.quality ? <Badge tone={qt}>{ql}</Badge> : <span className="faint">—</span>}</td>
                    <td className="acts" onClick={(e) => e.stopPropagation()}>
                      {canEdit && <button type="button" className="btn icon sm ghost" onClick={() => setDel(t)} aria-label="Excluir" data-testid="tpl-del"><Icon name="trash" size={14} /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint"><Icon name="info" size={14} />Os modelos são da Meta: criar, aprovar e excluir acontece na conta do WhatsApp Business. Depois de aprovado, use o modelo no Chats ao vivo, nos disparos em massa e nos webhooks.</div>

      {creating && <CreateModal waba={waba} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setStatus('all'); setFresh((n) => n + 1); }} />}
      {viewing && (
        <Drawer title={viewing.name} onClose={() => setViewing(null)}>
          <div className="stack" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Badge tone={(TPL_STATUS[viewing.status] ?? ['', ''])[1]}>{(TPL_STATUS[viewing.status] ?? [viewing.status])[0]}</Badge>
              <Badge>{CAT[viewing.category] ?? viewing.category}</Badge><Badge>{langLabel(viewing.language)}</Badge>
            </div>
            <Preview header={viewing.header} body={viewing.body} examples={viewing.bodyExamples} footer={viewing.footer} buttons={viewing.buttons} />
            {viewing.bodyVars.length > 0 && <div className="st-help">Variáveis: {viewing.bodyVars.map((v) => `{{${v}}}`).join(', ')} — preenchidas na hora de enviar.</div>}
          </div>
        </Drawer>
      )}
      {del && (
        <ConfirmModal title="Excluir modelo" confirm="Excluir" danger onClose={() => setDel(null)} onConfirm={async () => {
          try { await api.del(`/templates/${del.name}?connectionId=${waba.id}&id=${del.id}`); toast('Modelo excluído na Meta'); setDel(null); setFresh((n) => n + 1); }
          catch (e) { toast(errMsg(e)); }
        }}>
          Excluir <b>{del.name}</b> ({langLabel(del.language)}) na Meta? Disparos e webhooks que usam este modelo param de funcionar. A Meta não deixa criar outro com o mesmo nome por 30 dias.
        </ConfirmModal>
      )}
    </div>
  );
}

