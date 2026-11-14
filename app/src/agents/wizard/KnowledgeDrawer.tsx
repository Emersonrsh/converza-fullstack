import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiFetch } from '../../api';
import { Icon } from '../../icons';
import { Spinner, cx, toast } from '../../components/ui';
import { ConfirmModal } from '../../kanban/modals';
import type { FaqItem, KbFull, KbSummary } from '../types';
import { Lbl } from './common';

type Section = 'sites' | 'docs' | 'faq';
type FaqMode = 'manual' | 'import' | 'ai';

const DOC_ACCEPT = '.pdf,.docx,.txt,.md,.csv,.html,application/pdf,text/plain';
const kchars = (n: number) => (n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil letras` : `${n} letras`);

/** Painel lateral: criar/editar uma base (sites, documentos, perguntas) ou escolher uma que já existe. */
export function KnowledgeDrawer({ baseId, bases, linkedIds, onClose, onLink, onDeleted }: {
  baseId: string | null; bases: KbSummary[]; linkedIds: string[];
  onClose: () => void; onLink: (id: string) => void; onDeleted: (id: string) => void;
}) {
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [base, setBase] = useState<KbFull | null>(null);
  const [loading, setLoading] = useState(!!baseId);
  const [name, setName] = useState('');
  const [faq, setFaq] = useState<FaqItem[]>([]);
  const [section, setSection] = useState<Section>('faq');
  const [mode, setMode] = useState<FaqMode>('manual');
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!baseId) return;
    api.get<{ base: KbFull }>(`/knowledge-bases/${baseId}`)
      .then((r) => { setBase(r.base); setName(r.base.name); setFaq(r.base.faqList); })
      .catch((e) => { toast(e instanceof Error ? e.message : 'Erro'); onClose(); })
      .finally(() => setLoading(false));
  }, [baseId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  /** A base precisa existir para receber sites e documentos: cria na primeira vez. */
  async function ensure(): Promise<KbFull> {
    if (base) return base;
    const r = await api.post<{ base: KbFull }>('/knowledge-bases', { name: name.trim() || 'Base de conhecimento', faq });
    setBase(r.base); if (!name.trim()) setName(r.base.name);
    return r.base;
  }

  async function addSite() {
    if (!url.trim()) return;
    setBusy('site');
    try { const b = await ensure(); const r = await api.post<{ base: KbFull }>(`/knowledge-bases/${b.id}/sites`, { url }); setBase(r.base); setUrl(''); toast('Site lido e guardado'); }
    catch (e) { toast(e instanceof Error ? e.message : 'Não consegui ler o site'); }
    setBusy(null);
  }

  async function addDocs(files: FileList | null) {
    if (!files?.length) return;
    setBusy('doc');
    try {
      let b = await ensure();
      for (const f of Array.from(files)) {
        try {
          const res = await apiFetch(`/knowledge-bases/${b.id}/documents?nome=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } });
          const r = await res.json() as { base: KbFull; cut?: boolean };
          b = r.base; setBase(r.base);
          toast(r.cut ? `“${f.name}” é grande: guardei as primeiras 40 mil letras` : `“${f.name}” lido e guardado`);
        } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'não deu para ler'}`); }
      }
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    if (fileRef.current) fileRef.current.value = '';
    setBusy(null);
  }

  async function removeItem(kind: 'site' | 'doc', key: string) {
    if (!base) return;
    try {
      const body = kind === 'site'
        ? { name: name.trim() || base.name, keepSites: base.siteList.map((s) => s.url).filter((u) => u !== key) }
        : { name: name.trim() || base.name, keepDocuments: base.documentList.map((d) => d.name).filter((n) => n !== key) };
      const r = await api.put<{ base: KbFull }>(`/knowledge-bases/${base.id}`, body);
      setBase(r.base);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
  }

  function addFaq() {
    if (!q.trim() || !a.trim()) return;
    if (editing !== null) { setFaq(faq.map((f, i) => (i === editing ? { q: q.trim(), a: a.trim() } : f))); setEditing(null); }
    else setFaq([{ q: q.trim(), a: a.trim() }, ...faq]);
    setQ(''); setA('');
  }

  async function importCsv(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setBusy('csv');
    try {
      const res = await apiFetch('/knowledge-bases/faq/import', { method: 'POST', body: f, headers: { 'Content-Type': 'text/csv' } });
      const r = await res.json() as { faq: FaqItem[] };
      setFaq([...r.faq, ...faq].slice(0, 200)); toast(`${r.faq.length} pergunta${r.faq.length === 1 ? '' : 's'} importada${r.faq.length === 1 ? '' : 's'}`); setMode('manual');
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    if (csvRef.current) csvRef.current.value = '';
    setBusy(null);
  }

  async function generate() {
    setBusy('ai');
    try {
      const b = await ensure();
      const r = await api.post<{ faq: FaqItem[]; tokens: number }>(`/knowledge-bases/${b.id}/faq/generate`, { notes });
      const known = new Set(faq.map((f) => f.q.toLowerCase()));
      const fresh = r.faq.filter((f) => !known.has(f.q.toLowerCase()));
      setFaq([...fresh, ...faq].slice(0, 200)); setMode('manual');
      toast(`${fresh.length} perguntas criadas (${r.tokens.toLocaleString('pt-BR')} tokens) — confira antes de salvar`);
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
    setBusy(null);
  }

  async function saveAndLink() {
    if (!name.trim()) { toast('Dê um nome para a base'); return; }
    setBusy('save');
    try {
      const r = base
        ? await api.put<{ base: KbFull }>(`/knowledge-bases/${base.id}`, { name: name.trim(), faq })
        : await api.post<{ base: KbFull }>('/knowledge-bases', { name: name.trim(), faq });
      if (!r.base.sites && !r.base.documents && !r.base.faq) toast('Base salva, mas ainda vazia: adicione sites, documentos ou perguntas');
      onLink(r.base.id);
    } catch (e) { toast(e instanceof Error ? e.message : 'Não foi possível salvar'); }
    setBusy(null);
  }

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return faq.map((f, i) => ({ f, i })).filter(({ f }) => !s || f.q.toLowerCase().includes(s) || f.a.toLowerCase().includes(s));
  }, [faq, search]);
  const others = bases.filter((b) => !linkedIds.includes(b.id));

  return (
    <div className="kb-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="kb-drawer" role="dialog" aria-label="Base de conhecimento" data-testid="kb-drawer">
        <div className="kb-hd">
          {baseId ? <b className="kb-title">Editar base</b> : (
            <div className="kb-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'new'} className={cx(tab === 'new' && 'on')} onClick={() => setTab('new')} data-testid="kb-tab-new"><Icon name="plus" size={14} />Criar nova</button>
              <button type="button" role="tab" aria-selected={tab === 'existing'} className={cx(tab === 'existing' && 'on')} onClick={() => setTab('existing')} data-testid="kb-tab-existing"><Icon name="book" size={14} />Usar existente{others.length ? ` (${others.length})` : ''}</button>
            </div>
          )}
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
        </div>

        {loading ? <Spinner /> : tab === 'existing' && !baseId ? (
          <div className="kb-body">
            {others.length === 0 ? <p className="faint">Nenhuma outra base ainda. Crie uma nova na outra aba.</p> : (
              <div className="wz-list">
                {others.map((b) => (
                  <button type="button" key={b.id} className="wz-item kb-pick" onClick={() => onLink(b.id)} data-testid="kb-existing">
                    <span className="wz-item-ic"><Icon name="book" size={16} /></span>
                    <div className="wz-item-main"><b>{b.name}</b><small>{b.sites} sites · {b.documents} documentos · {b.faq} perguntas{b.agents ? ` · em ${b.agents} agente${b.agents === 1 ? '' : 's'}` : ''}</small></div>
                    <Icon name="plus" size={15} />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="kb-body">
              <div>
                <Lbl req>Nome da base</Lbl>
                <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Planos e horários" data-testid="kb-name" />
                <small className="faint">Só para você identificar. A mesma base pode servir a vários agentes.</small>
              </div>

              <div className="kb-sections" role="tablist">
                {([['sites', 'globe', 'Sites', base?.sites ?? 0], ['docs', 'file', 'Documentos', base?.documents ?? 0], ['faq', 'help', 'Perguntas e respostas', faq.length]] as const).map(([k, ic, l, n]) => (
                  <button type="button" key={k} role="tab" aria-selected={section === k} className={cx(section === k && 'on')} onClick={() => setSection(k)} data-testid={`kb-sec-${k}`}>
                    <Icon name={ic} size={14} />{l}{n ? <em>{n}</em> : null}
                  </button>
                ))}
              </div>

              {section === 'sites' && (
                <div className="kb-panel">
                  <p className="faint">Cole o link de uma página (preços, planos, sobre, FAQ). Guardamos o texto dela; se o site mudar, adicione de novo para atualizar.</p>
                  <div className="kb-inline">
                    <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addSite(); } }} placeholder="https://seusite.com.br/planos" data-testid="kb-url" />
                    <button type="button" className="btn primary" disabled={!url.trim() || busy === 'site'} onClick={() => void addSite()} data-testid="kb-url-add">{busy === 'site' ? 'Lendo…' : 'Adicionar'}</button>
                  </div>
                  {(base?.siteList ?? []).map((s) => (
                    <div key={s.url} className="kb-row" data-testid="kb-site">
                      <Icon name="globe" size={14} /><div><b>{s.title || s.url}</b><small>{s.url} · {kchars(s.chars)}</small></div>
                      <button type="button" className="btn icon sm ghost" aria-label="Remover site" onClick={() => void removeItem('site', s.url)}><Icon name="trash" size={13} /></button>
                    </div>
                  ))}
                </div>
              )}

              {section === 'docs' && (
                <div className="kb-panel">
                  <label className={cx('kb-drop', busy === 'doc' && 'busy')} data-testid="kb-drop"
                    onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addDocs(e.dataTransfer.files); }}>
                    <input ref={fileRef} type="file" multiple accept={DOC_ACCEPT} hidden onChange={(e) => void addDocs(e.target.files)} data-testid="kb-file" />
                    <Icon name="upload" size={20} />
                    <b>{busy === 'doc' ? 'Lendo arquivo…' : 'Arraste ou clique para enviar'}</b>
                    <small>PDF, Word (.docx), TXT, CSV ou Markdown · até 15 MB</small>
                  </label>
                  {(base?.documentList ?? []).map((d) => (
                    <div key={d.name} className="kb-row" data-testid="kb-doc">
                      <Icon name="file" size={14} /><div><b>{d.name}</b><small>{kchars(d.chars)} · “{d.preview.slice(0, 70)}…”</small></div>
                      <button type="button" className="btn icon sm ghost" aria-label="Remover documento" onClick={() => void removeItem('doc', d.name)}><Icon name="trash" size={13} /></button>
                    </div>
                  ))}
                  <small className="faint">PDF escaneado (foto) não tem texto para ler: nesse caso, use perguntas e respostas.</small>
                </div>
              )}

              {section === 'faq' && (
                <div className="kb-panel">
                  <div className="kb-modes" role="radiogroup">
                    {([['manual', 'Escrever'], ['import', 'Importar planilha'], ['ai', 'Gerar com IA']] as const).map(([v, l]) => (
                      <label key={v} className={cx('kb-mode', mode === v && 'on')}><input type="radio" checked={mode === v} onChange={() => setMode(v)} data-testid={`kb-mode-${v}`} />{l}</label>
                    ))}
                  </div>
                  {mode === 'manual' && (
                    <div className="kb-form">
                      <div><Lbl req>Pergunta</Lbl><input className="input" maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: Qual é o horário de funcionamento?" data-testid="kb-q" /></div>
                      <div><Lbl req>Resposta</Lbl><textarea className="input" rows={3} maxLength={1000} value={a} onChange={(e) => setA(e.target.value)} placeholder="Ex.: Abrimos de segunda a sexta, das 6h às 22h, e aos sábados das 8h às 14h. Domingos e feriados fechado." data-testid="kb-a" /></div>
                      <small className="faint">Respostas completas funcionam melhor: o agente responde do jeito que estiver aqui.</small>
                      <div className="kb-form-acts">
                        {editing !== null && <button type="button" className="btn ghost sm" onClick={() => { setEditing(null); setQ(''); setA(''); }}>Cancelar</button>}
                        <button type="button" className="btn sm primary" disabled={!q.trim() || !a.trim() || faq.length >= 200} onClick={addFaq} data-testid="kb-faq-add"><Icon name={editing !== null ? 'check' : 'plus'} size={14} />{editing !== null ? 'Atualizar' : 'Adicionar'}</button>
                      </div>
                    </div>
                  )}
                  {mode === 'import' && (
                    <div className="kb-form">
                      <p className="faint">Uma planilha salva em CSV (ou um TXT) com uma pergunta por linha: <code>pergunta;resposta</code>. A primeira linha pode ser o cabeçalho.</p>
                      <input ref={csvRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => void importCsv(e.target.files)} data-testid="kb-csv" />
                      <button type="button" className="btn sm" disabled={busy === 'csv'} onClick={() => csvRef.current?.click()}><Icon name="upload" size={14} />{busy === 'csv' ? 'Lendo…' : 'Escolher arquivo'}</button>
                    </div>
                  )}
                  {mode === 'ai' && (
                    <div className="kb-form">
                      <p className="faint">A IA lê os sites e documentos desta base (e o que você escrever abaixo) e sugere perguntas e respostas. Você confere antes de salvar. Gasta tokens.</p>
                      <textarea className="input" rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional: conte sobre o negócio, preços, horários, regras…" data-testid="kb-ai-notes" />
                      <button type="button" className="btn sm primary" disabled={busy === 'ai'} onClick={() => void generate()} data-testid="kb-ai-go"><Icon name="sparkles" size={14} />{busy === 'ai' ? 'Gerando…' : 'Gerar perguntas'}</button>
                    </div>
                  )}
                  {faq.length > 0 && <>
                    <div className="kb-search"><Icon name="search" size={14} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Pesquisar em ${faq.length} pergunta${faq.length === 1 ? '' : 's'}`} /></div>
                    <div className="kb-faq" data-testid="kb-faq-list">
                      {shown.map(({ f, i }) => (
                        <div key={i} className={cx('kb-row', editing === i && 'on')} data-testid="kb-faq-row">
                          <div><b>{f.q}</b><small>{f.a}</small></div>
                          <button type="button" className="btn icon sm ghost" aria-label="Editar pergunta" onClick={() => { setMode('manual'); setEditing(i); setQ(f.q); setA(f.a); }}><Icon name="edit" size={13} /></button>
                          <button type="button" className="btn icon sm ghost" aria-label="Remover pergunta" onClick={() => setFaq(faq.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
                        </div>
                      ))}
                    </div>
                  </>}
                </div>
              )}
            </div>
            <div className="kb-ft">
              {base && <button type="button" className="btn ghost danger sm" onClick={() => setConfirmDel(true)} data-testid="kb-delete"><Icon name="trash" size={14} />Excluir base</button>}
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
              <button type="button" className="btn primary" disabled={busy === 'save'} onClick={() => void saveAndLink()} data-testid="kb-save">{busy === 'save' ? 'Salvando…' : baseId ? 'Salvar base' : 'Salvar e usar neste agente'}</button>
            </div>
          </>
        )}
      </aside>
      {confirmDel && base && (
        <ConfirmModal title="Excluir base" confirm="Excluir base" danger onClose={() => setConfirmDel(false)} onConfirm={async () => {
          try { await api.del(`/knowledge-bases/${base.id}`); toast('Base excluída'); onDeleted(base.id); }
          catch (e) { toast(e instanceof Error ? e.message : 'Erro'); }
        }}>Excluir <b>{base.name}</b>? Ela sai de todos os agentes que a usam{(bases.find((b) => b.id === base.id)?.agents ?? 0) > 1 ? ` (${bases.find((b) => b.id === base.id)?.agents} agentes)` : ''}.</ConfirmModal>
      )}
    </div>
  );
}
