import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, toast, cx, useBackdrop } from '../components/ui';
import { ProductsManager } from '../components/Products';
import type { Flow, FlowFolder, Product } from '../types';

export const FOLDER_COLORS = ['#2f73e0', '#0e9488', '#1a9f52', '#f59e0b', '#ea580c', '#e23b3b', '#db2777', '#8b5cf6', '#64748b', '#0891b2'];

const errMsg = (e: unknown) => (e as Error)?.message ?? 'Algo deu errado';

/* ------------------------------------------------------------ pasta */

export function FolderModal({ folder, onClose, onSaved }: {
  folder?: FlowFolder | null; onClose: () => void; onSaved: (f: FlowFolder) => void;
}) {
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState(folder?.color ?? FOLDER_COLORS[0]);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { toast('Dê um nome para a pasta'); return; }
    setBusy(true);
    try {
      const r = folder
        ? await api.patch<{ folder: FlowFolder }>(`/flow-folders/${folder.id}`, { name: name.trim(), color })
        : await api.post<{ folder: FlowFolder }>('/flow-folders', { name: name.trim(), color });
      onSaved({ ...r.folder, flowCount: folder?.flowCount ?? 0 });
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }

  return (
    <Modal title={folder ? 'Editar pasta' : 'Nova pasta'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={save}>{folder ? 'Salvar' : 'Criar pasta'}</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div>
          <label className="label">Nome</label>
          <input className="input" autoFocus maxLength={60} value={name} placeholder="Ex.: Vendas, Suporte, Lançamento"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div>
          <label className="label">Cor</label>
          <div className="colors">
            {FOLDER_COLORS.map((c) => (
              <button type="button" key={c} className={cx(c === color && 'on')} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Cor ${c}`} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ importar */

export function ImportModal({ folders, folderId, onClose, onImported }: {
  folders: FlowFolder[]; folderId: string | null; onClose: () => void; onImported: (ids: string[]) => void;
}) {
  const [codes, setCodes] = useState('');
  const [target, setTarget] = useState<string>(folderId ?? '');
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState<string[]>([]);

  async function run() {
    if (!codes.trim()) { toast('Cole pelo menos um código'); return; }
    setBusy(true); setNotFound([]);
    try {
      const r = await api.post<{ imported: { id: string; name: string }[]; notFound: string[] }>('/flows/import', { codes, folderId: target || null });
      if (r.notFound.length) setNotFound(r.notFound);
      if (r.imported.length) {
        const ok = r.imported.length === 1 ? `“${r.imported[0].name}” importado ✓` : `${r.imported.length} fluxos importados ✓`;
        toast(r.notFound.length ? `${ok} — não encontrado: ${r.notFound.join(', ')}` : ok);
        onImported(r.imported.map((i) => i.id));
      }
    } catch (e) {
      const nf = (e as { status?: number }).status === 404;
      if (nf) setNotFound(codes.split(/[\s,;]+/).filter(Boolean));
      else toast(errMsg(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Importar fluxos" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={run}><Icon name="download" size={15} />{busy ? 'Importando…' : 'Importar'}</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div className="note"><Icon name="share" size={15} /><span>Peça o <b>código de compartilhamento</b> para quem criou o fluxo (no editor: ⋯ → Compartilhar). Você recebe uma cópia, como rascunho, para editar à vontade.</span></div>
        <div>
          <label className="label">Códigos</label>
          <textarea className="input" rows={3} autoFocus value={codes} placeholder="Ex.: K7M2QX9P, H4WN8RTA"
            onChange={(e) => setCodes(e.target.value.toUpperCase())} style={{ fontFamily: 'ui-monospace,Menlo,Consolas,monospace', letterSpacing: '.06em' }} />
          <div className="cf-hint">Pode colar vários de uma vez, separados por vírgula ou espaço.</div>
        </div>
        <div>
          <label className="label">Salvar na pasta</label>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Sem pasta</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        {notFound.length > 0 && <div className="note err"><Icon name="alert" size={15} /><span>Código não encontrado: <b>{notFound.join(', ')}</b>. Confira se foi digitado certo ou se o compartilhamento foi desativado.</span></div>}
        <div className="cf-hint">Por segurança, conexões de WhatsApp, webhooks, responsáveis e chaves de API não vêm junto — revise esses blocos depois de importar.</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ gerar com IA */

const EXAMPLES = [
  'Clínica odontológica: perguntar o nome, oferecer agendamento de avaliação, tirar dúvidas de preço e transferir para a recepção.',
  'Loja de roupas: menu com Comprar, Trocas e Falar com atendente. Em Comprar, mandar o catálogo e o link de pagamento.',
  'Curso online: perguntar nome e e-mail, mandar o vídeo de apresentação e, 1 hora depois, perguntar se ficou alguma dúvida.',
  'Qualificar leads: perguntar o faturamento da empresa; acima de 50 mil, transferir para um vendedor; abaixo, enviar material gratuito.',
];

const MAX_IMAGES = 4;
const MAX_SIDE = 1800;

/** Reduz a imagem no navegador (lado maior até 1800 px, JPEG) para mandar leve para a IA. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Não deu para abrir ${file.name || 'a imagem'}`));
      el.src = url;
    });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); // PNG transparente vira fundo branco (lê melhor)
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}

type Shot = { id: string; name: string; data: string };

export function GenerateModal({ replacing, onClose, onGenerated }: {
  replacing?: boolean; onClose: () => void; onGenerated: (graph: { nodes: any[]; edges: any[] }, description: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [desc, setDesc] = useState('');
  const [notes, setNotes] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [drag, setDrag] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | File[]) {
    const files = Array.from(list).filter((f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type));
    if (!files.length) { toast('Envie imagens em PNG, JPG, WEBP ou GIF'); return; }
    const room = MAX_IMAGES - shots.length;
    if (room <= 0) { toast(`Até ${MAX_IMAGES} imagens por vez`); return; }
    if (files.length > room) toast(`Só cabem mais ${room} — as outras ficaram de fora`);
    setReading(true);
    try {
      const out: Shot[] = [];
      for (const f of files.slice(0, room)) out.push({ id: Math.random().toString(36).slice(2), name: f.name || 'imagem colada', data: await shrinkImage(f) });
      setShots((cur) => [...cur, ...out].slice(0, MAX_IMAGES));
    } catch (e) { toast(errMsg(e)); }
    setReading(false);
  }

  // Ctrl+V com um print copiado
  useEffect(() => {
    if (mode !== 'image') return;
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) { e.preventDefault(); void addFiles(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    let body: { description: string; images?: string[] };
    let label: string;
    if (mode === 'image') {
      if (!shots.length) { toast('Envie pelo menos uma imagem do fluxo'); return; }
      body = { description: notes.trim(), images: shots.map((x) => x.data) };
      label = notes.trim() || `Fluxo a partir de ${shots.length === 1 ? 'imagem' : `${shots.length} imagens`}`;
    } else {
      if (desc.trim().length < 15) { toast('Descreva com um pouco mais de detalhe o que o fluxo deve fazer'); return; }
      body = { description: desc.trim() };
      label = desc.trim();
    }
    setBusy(true);
    try {
      const r = await api.post<{ graph: { nodes: any[]; edges: any[] } }>('/flows/generate', body);
      await onGenerated(r.graph, label);
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }

  return (
    <Modal title="Criar fluxo com IA" width={560} onClose={() => !busy && onClose()}
      footer={<><button className="btn" disabled={busy} onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || reading} onClick={run} data-testid="gen-run"><Icon name="sparkles" size={15} />
          {busy ? (mode === 'image' ? 'Lendo a imagem e montando…' : 'Montando os blocos…') : 'Gerar fluxo'}</button></>}>
      <div className="grid" style={{ gap: 12 }}>
        <div className="gen-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'text'} className={cx(mode === 'text' && 'on')} disabled={busy} onClick={() => setMode('text')} data-testid="gen-tab-text"><Icon name="edit" size={15} />Descrever</button>
          <button type="button" role="tab" aria-selected={mode === 'image'} className={cx(mode === 'image' && 'on')} disabled={busy} onClick={() => setMode('image')} data-testid="gen-tab-image"><Icon name="image" size={15} />A partir de imagens</button>
        </div>

        {mode === 'text' ? (
          <div>
            <label className="label">O que o fluxo deve fazer?</label>
            <textarea className="input" rows={5} autoFocus maxLength={2000} value={desc} disabled={busy}
              placeholder="Conte o seu negócio, o que perguntar ao cliente, quais opções oferecer e quando chamar um humano."
              onChange={(e) => setDesc(e.target.value)} data-testid="gen-desc" />
            <div className="examples">
              {EXAMPLES.map((ex) => <button type="button" key={ex} disabled={busy} onClick={() => setDesc(ex)}>{ex.split(':')[0]}</button>)}
            </div>
          </div>
        ) : (
          <>
            <div
              className={cx('gen-drop', drag && 'drag', shots.length >= MAX_IMAGES && 'full')}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy) void addFiles(e.dataTransfer.files); }}
              onClick={() => !busy && shots.length < MAX_IMAGES && fileRef.current?.click()}
              role="button" tabIndex={0} data-testid="gen-drop"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
            >
              <span className="gen-drop-ic"><Icon name="upload" size={22} /></span>
              <b>{reading ? 'Preparando as imagens…' : shots.length >= MAX_IMAGES ? `Limite de ${MAX_IMAGES} imagens` : 'Arraste, clique para escolher ou cole (Ctrl+V)'}</b>
              <small>Print de um fluxo (de outra ferramenta ou do Converza), fluxograma, rascunho no papel, roteiro ou prints de uma conversa · até {MAX_IMAGES} imagens</small>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
                onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} data-testid="gen-file" />
            </div>
            {shots.length > 0 && (
              <div className="gen-shots" data-testid="gen-shots">
                {shots.map((x, i) => (
                  <figure key={x.id}>
                    <img src={x.data} alt={x.name} />
                    <figcaption><b>{i + 1}</b>{x.name}</figcaption>
                    <button type="button" aria-label={`Tirar ${x.name}`} disabled={busy} onClick={() => setShots((cur) => cur.filter((y) => y.id !== x.id))}><Icon name="close" size={13} /></button>
                  </figure>
                ))}
              </div>
            )}
            <div>
              <label className="label">Observações (opcional)</label>
              <textarea className="input" rows={2} maxLength={2000} value={notes} disabled={busy} data-testid="gen-notes"
                placeholder="Ex.: troque o nome da loja para Doce Sabor; a pergunta do CPF pode sair; adicione uma etiqueta Lead no fim." onChange={(e) => setNotes(e.target.value)} />
            </div>
          </>
        )}

        {replacing && <div className="note warn"><Icon name="alert" size={15} /><span>Os blocos atuais deste fluxo serão substituídos (dá para desfazer com Ctrl+Z).</span></div>}
        <div className="cf-hint">
          {mode === 'image'
            ? 'A IA copia os textos e a ordem dos blocos da imagem. Arquivos (PDFs, fotos, áudios) entram com o nome — anexe os arquivos depois. Revise e teste no Simulador antes de ativar. Usa tokens de IA da conta.'
            : 'A IA monta os blocos e conexões; revise os textos e teste no Simulador antes de ativar. Usa tokens de IA da conta.'}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ compartilhar */

export function ShareModal({ flowId, onClose, onChange }: { flowId: string; onClose: () => void; onChange?: (code: string | null) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    api.post<{ shareCode: string }>(`/flows/${flowId}/share`)
      .then((r) => { setCode(r.shareCode); onChange?.(r.shareCode); })
      .catch((e) => toast(errMsg(e)))
      .finally(() => setBusy(false));
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function regenerate() {
    if (!confirm('Gerar um novo código? O código atual deixa de funcionar.')) return;
    setBusy(true);
    try { const r = await api.post<{ shareCode: string }>(`/flows/${flowId}/share/regenerate`); setCode(r.shareCode); onChange?.(r.shareCode); toast('Novo código gerado'); }
    catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true);
    try { await api.del(`/flows/${flowId}/share`); onChange?.(null); toast('Compartilhamento desativado'); onClose(); }
    catch (e) { toast(errMsg(e)); setBusy(false); }
  }
  async function copy() {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); toast('Código copiado ✓'); } catch { toast(code); }
  }

  return (
    <Modal title="Compartilhar fluxo" onClose={onClose}
      footer={<><button className="btn danger" disabled={busy || !code} onClick={disable}>Desativar</button><div className="spacer" /><button className="btn" onClick={onClose}>Fechar</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div className="codebox">
          <b data-testid="share-code">{code ?? '········'}</b>
          <button type="button" className="btn sm" disabled={!code} onClick={copy}><Icon name="copy" size={14} />Copiar</button>
        </div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          Quem tiver este código pode importar <b>uma cópia</b> do fluxo em <b>Fluxos → Importar</b> — em qualquer conta Converza. Alterações que você fizer depois não afetam as cópias.
        </div>
        <div className="note"><Icon name="alert" size={15} /><span>Conexões de WhatsApp, webhooks, responsáveis, produtos e valores de cabeçalhos HTTP (chaves de API) <b>não</b> são copiados.</span></div>
        <button type="button" className="btn sm ghost" style={{ width: 'fit-content' }} disabled={busy} onClick={regenerate}><Icon name="refresh" size={14} />Gerar novo código</button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ traduzir */

const LANGS: [string, string][] = [['en', 'Inglês'], ['es', 'Espanhol'], ['pt', 'Português'], ['fr', 'Francês'], ['it', 'Italiano'], ['de', 'Alemão']];

export function TranslateModal({ flowId, onClose, onDone }: { flowId: string; onClose: () => void; onDone: (flow: Flow) => void }) {
  const [lang, setLang] = useState('en');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await api.post<{ flow: Flow }>(`/flows/${flowId}/translate`, { language: lang });
      toast('Cópia traduzida criada ✓');
      onDone(r.flow);
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }
  return (
    <Modal title="Traduzir fluxo" onClose={() => !busy && onClose()}
      footer={<><button className="btn" disabled={busy} onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={run}><Icon name="translate" size={15} />{busy ? 'Traduzindo…' : 'Traduzir'}</button></>}>
      <div className="grid" style={{ gap: 14 }}>
        <div>
          <label className="label">Traduzir para</label>
          <select className="select" value={lang} disabled={busy} onChange={(e) => setLang(e.target.value)}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          A IA traduz todos os textos (mensagens, perguntas, opções de menu e instruções) e cria uma <b>cópia</b> do fluxo como rascunho. O original não muda e variáveis como <code>{'{{nome}}'}</code> são mantidas.
        </div>
        <div className="cf-hint">Usa tokens de IA da conta.</div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ mover */

export function MoveModal({ current, folders, onClose, onMove }: {
  current: string | null; folders: FlowFolder[]; onClose: () => void; onMove: (folderId: string | null) => void;
}) {
  const [target, setTarget] = useState(current ?? '');
  return (
    <Modal title="Mover para pasta" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onMove(target || null)}>Mover</button></>}>
      <div className="grid" style={{ gap: 6 }}>
        {[{ id: '', name: 'Sem pasta', color: 'var(--border-strong)' }, ...folders].map((f) => (
          <button type="button" key={f.id} className={cx('fl-folder', target === f.id && 'active')} onClick={() => setTarget(f.id)}>
            <span className="dot" style={{ background: f.color }} /><span className="nm">{f.name}</span>
            {target === f.id && <Icon name="check" size={15} />}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ pagamentos */

export function ProductsModal({ onClose, onChange }: { onClose: () => void; onChange: (list: Product[]) => void }) {
  const bg = useBackdrop(onClose);
  return (
    <div className="modal-bg" {...bg}>
      <div className="modal wide fade" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <div className="mh">
          <div><b style={{ fontSize: 15 }}>Pagamentos — produtos e links</b>
            <div className="faint" style={{ fontSize: 12, fontWeight: 600 }}>O bloco Pagamento envia o link do produto escolhido</div></div>
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
        </div>
        <div className="mb"><ProductsManager onChange={onChange} /></div>
      </div>
    </div>
  );
}
