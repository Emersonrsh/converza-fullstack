import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, num } from '../api';
import { Icon } from '../icons';
import { Spinner, Switch, toast, cx } from '../components/ui';
import { emptyLookups, summary } from '../flows/blocks';
import { FolderModal, GenerateModal, ImportModal, MoveModal, ShareModal, TranslateModal } from '../flows/modals';
import type { Flow, FlowFolder, FlowListItem } from '../types';

type StatusFilter = 'all' | 'active' | 'paused';
type FolderSel = 'all' | 'none' | 'archived' | string;
type ModalState =
  | null
  | { kind: 'folder'; folder?: FlowFolder | null }
  | { kind: 'import' }
  | { kind: 'generate' }
  | { kind: 'share'; flow: FlowListItem }
  | { kind: 'translate'; flow: FlowListItem }
  | { kind: 'move'; flow: FlowListItem };

const DND_FLOW = 'application/converza-flow';
const errMsg = (e: unknown) => (e as Error)?.message ?? 'Algo deu errado';
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora mesmo';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d < 30) return d === 1 ? 'ontem' : `há ${d} dias`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function Flows() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const folderSel: FolderSel = params.get('pasta') ?? 'all';
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [folders, setFolders] = useState<FlowFolder[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [modal, setModal] = useState<ModalState>(null);
  const [cardMenu, setCardMenu] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [f, d] = await Promise.all([
      api.get<{ flows: FlowListItem[] }>('/flows'),
      api.get<{ folders: FlowFolder[] }>('/flow-folders'),
    ]);
    setFlows(f.flows); setFolders(d.folders);
  }, []);
  useEffect(() => { load().catch((e) => { toast(errMsg(e)); setFlows([]); }); }, [load]);

  useEffect(() => {
    if (!cardMenu && !folderMenu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menu-wrap')) { setCardMenu(null); setFolderMenu(null); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [cardMenu, folderMenu]);

  const setFolderSel = (f: FolderSel) => setParams(f === 'all' ? {} : { pasta: f });

  const live = useMemo(() => (flows ?? []).filter((f) => !f.archivedAt), [flows]);
  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    for (const f of live) byFolder.set(f.folderId ?? 'none', (byFolder.get(f.folderId ?? 'none') ?? 0) + 1);
    return { all: live.length, none: byFolder.get('none') ?? 0, archived: (flows ?? []).length - live.length, byFolder };
  }, [flows, live]);

  const inFolder = useMemo(() => {
    const list = flows ?? [];
    if (folderSel === 'archived') return list.filter((f) => f.archivedAt);
    if (folderSel === 'all') return live;
    if (folderSel === 'none') return live.filter((f) => !f.folderId);
    return live.filter((f) => f.folderId === folderSel);
  }, [flows, live, folderSel]);

  const visible = useMemo(() => {
    const term = norm(q.trim());
    return inFolder.filter((f) => {
      if (status === 'active' && f.status !== 'active') return false;
      if (status === 'paused' && f.status === 'active') return false;
      return !term || norm(f.name).includes(term);
    });
  }, [inFolder, q, status]);

  const activeCount = inFolder.filter((f) => f.status === 'active').length;
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const currentFolder = folderById.get(folderSel);

  /* ------------------------------------------------------------ ações */

  const patchFlow = (id: string, patch: Partial<FlowListItem>) =>
    setFlows((list) => (list ?? []).map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function createFlow() {
    if (busy) return;
    setBusy(true);
    try {
      const folderId = currentFolder ? currentFolder.id : null;
      const r = await api.post<{ flow: Flow }>('/flows', { name: 'Novo fluxo', folderId });
      nav(`/flows/${r.flow.id}`);
    } catch (e) { toast(errMsg(e)); setBusy(false); }
  }

  async function createFromAi(graph: { nodes: unknown[]; edges: unknown[] }, description: string) {
    const title = description.split(/[.:;\n]/)[0].trim().slice(0, 60) || 'Fluxo gerado com IA';
    const r = await api.post<{ flow: Flow }>('/flows', { name: title, folderId: currentFolder?.id ?? null, graph });
    toast('Fluxo criado ✓ — revise e teste no Simulador');
    nav(`/flows/${r.flow.id}?organizar=1`);
  }

  async function toggle(f: FlowListItem) {
    const next = f.status === 'active' ? 'paused' : 'active';
    try {
      const r = await api.put<{ flow: Flow }>(`/flows/${f.id}`, { status: next });
      patchFlow(f.id, { status: r.flow.status });
      toast(next === 'active' ? `“${f.name}” ativado ✓` : `“${f.name}” pausado`);
    } catch (e) { toast(errMsg(e)); }
  }

  async function duplicate(f: FlowListItem) {
    try { await api.post(`/flows/${f.id}/duplicate`); await load(); toast('Cópia criada ✓'); } catch (e) { toast(errMsg(e)); }
  }
  async function archive(f: FlowListItem) {
    if (!confirm(`Arquivar “${f.name}”? Ele é pausado e as conversas em andamento nele são encerradas.`)) return;
    try { await api.post(`/flows/${f.id}/archive`); await load(); toast('Fluxo arquivado'); } catch (e) { toast(errMsg(e)); }
  }
  async function unarchive(f: FlowListItem) {
    try { await api.post(`/flows/${f.id}/unarchive`); await load(); toast('Fluxo restaurado'); } catch (e) { toast(errMsg(e)); }
  }
  async function remove(f: FlowListItem) {
    if (!confirm(`Excluir “${f.name}” para sempre? As estatísticas e execuções dele também são apagadas.`)) return;
    try { await api.del(`/flows/${f.id}`); setFlows((l) => (l ?? []).filter((x) => x.id !== f.id)); toast('Fluxo excluído'); }
    catch (e) { toast(errMsg(e)); }
  }
  async function moveFlow(flowId: string, folderId: string | null) {
    try {
      await api.put(`/flows/${flowId}`, { folderId });
      patchFlow(flowId, { folderId });
      setModal(null);
      toast(folderId ? `Movido para “${folderById.get(folderId)?.name ?? 'pasta'}” ✓` : 'Movido para “Sem pasta” ✓');
    } catch (e) { toast(errMsg(e)); }
  }
  async function deleteFolder(f: FlowFolder) {
    if (!confirm(`Excluir a pasta “${f.name}”? Os fluxos dentro dela não são apagados — voltam para “Sem pasta”.`)) return;
    try {
      await api.del(`/flow-folders/${f.id}`);
      if (folderSel === f.id) setFolderSel('all');
      await load();
      toast('Pasta excluída');
    } catch (e) { toast(errMsg(e)); }
  }

  /* arrastar card para uma pasta */
  const folderDrop = (target: string | null) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(DND_FLOW)) { e.preventDefault(); setDropTarget(target ?? 'none'); } },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DND_FLOW);
      setDropTarget(null);
      if (!id) return;
      e.preventDefault();
      const f = flows?.find((x) => x.id === id);
      if (f && (f.folderId ?? null) !== target) void moveFlow(id, target);
    },
  });

  if (!flows) return <Spinner />;

  const folderBtn = ({ id, label, color, count, icon, dropId }: { id: FolderSel; label: string; color?: string; count: number; icon?: string; dropId?: string | null }) => (
    <button type="button" key={id} className={cx('fl-folder', folderSel === id && 'active', dropTarget !== null && dropTarget === (dropId === undefined ? '__' : dropId ?? 'none') && 'drop')}
      onClick={() => setFolderSel(id)} {...(dropId !== undefined ? folderDrop(dropId) : {})} data-testid={`folder-${id}`}>
      {icon ? <Icon name={icon} size={15} /> : <span className="dot" style={{ background: color }} />}
      <span className="nm">{label}</span><span className="ct">{count}</span>
    </button>
  );

  return (
    <div className="fl fade" data-testid="flows-page">
      <aside className="card fl-side">
        {folderBtn({ id: 'all', label: 'Todos os fluxos', icon: 'flow', count: counts.all })}
        {folderBtn({ id: 'none', label: 'Sem pasta', icon: 'inbox', count: counts.none, dropId: null })}
        <h4 style={{ marginTop: 14 }}>Pastas<span className="spacer" />
          <button type="button" className="btn icon sm ghost" style={{ width: 24, height: 24 }} title="Nova pasta" aria-label="Nova pasta"
            onClick={() => setModal({ kind: 'folder' })} data-testid="new-folder"><Icon name="plus" size={14} /></button>
        </h4>
        {folders.map((f) => (
          <div key={f.id} className="menu-wrap">
            <div className={cx('fl-folder', folderSel === f.id && 'active', dropTarget === f.id && 'drop')} role="button" tabIndex={0}
              onClick={() => setFolderSel(f.id)} onKeyDown={(e) => e.key === 'Enter' && setFolderSel(f.id)} {...folderDrop(f.id)}>
              <span className="dot" style={{ background: f.color }} />
              <span className="nm">{f.name}</span>
              <span className="ct">{counts.byFolder.get(f.id) ?? 0}</span>
              <span className={cx('fm', folderMenu === f.id && 'open')} role="button" tabIndex={0} aria-label="Opções da pasta"
                onClick={(e) => { e.stopPropagation(); setFolderMenu(folderMenu === f.id ? null : f.id); }}><Icon name="dots" size={14} /></span>
            </div>
            {folderMenu === f.id && (
              <div className="menu fade" style={{ minWidth: 180 }} onClick={() => setFolderMenu(null)}>
                <button type="button" onClick={() => setModal({ kind: 'folder', folder: f })}><Icon name="edit" size={15} />Renomear / cor</button>
                <button type="button" className="danger" onClick={() => deleteFolder(f)}><Icon name="trash" size={15} />Excluir pasta</button>
              </div>
            )}
          </div>
        ))}
        {folders.length === 0 && (
          <button type="button" className="fl-folder" style={{ color: 'var(--faint)' }} onClick={() => setModal({ kind: 'folder' })}>
            <Icon name="folderPlus" size={15} /><span className="nm">Criar pasta</span>
          </button>
        )}
        <div className="hr" style={{ margin: '10px 4px' }} />
        {folderBtn({ id: 'archived', label: 'Arquivados', icon: 'archive', count: counts.archived })}
        <div className="cf-hint" style={{ padding: '10px 6px 2px' }}>Arraste um fluxo para uma pasta para organizar.</div>
      </aside>

      <section>
        <div className="fl-bar">
          <div className="fl-search">
            <Icon name="search" size={16} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar fluxo pelo nome" data-testid="flow-search" />
          </div>
          <div className="seg" role="tablist">
            {([['all', `Todos ${inFolder.length}`], ['active', `Ativos ${activeCount}`], ['paused', `Pausados ${inFolder.length - activeCount}`]] as [StatusFilter, string][]).map(([v, l]) => (
              <button type="button" key={v} className={cx(status === v && 'active')} onClick={() => setStatus(v)} data-testid={`filter-${v}`}>{l}</button>
            ))}
          </div>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => setModal({ kind: 'import' })} data-testid="import-btn"><Icon name="download" size={16} />Importar</button>
          <button type="button" className="btn" onClick={() => setModal({ kind: 'generate' })}><Icon name="sparkles" size={16} />Criar com IA</button>
          <button type="button" className="btn primary" onClick={createFlow} disabled={busy} data-testid="new-flow"><Icon name="plus" size={16} />Novo fluxo</button>
        </div>

        {currentFolder && (
          <div className="row" style={{ marginBottom: 12, gap: 8 }}>
            <span className="dot" style={{ width: 12, height: 12, borderRadius: 3, background: currentFolder.color }} />
            <b className="title">{currentFolder.name}</b>
          </div>
        )}
        {folderSel === 'archived' && <div className="note" style={{ marginBottom: 12 }}><Icon name="archive" size={15} /><span>Fluxos arquivados não respondem clientes. Restaure para editar e ativar de novo.</span></div>}

        {flows.length === 0 ? (
          <div className="card" style={{ padding: '44px 24px', textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--primary-50)', color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="flow" size={28} /></div>
            <h3 style={{ margin: '14px 0 6px' }}>Crie seu primeiro fluxo</h3>
            <p className="muted" style={{ maxWidth: 460, margin: '0 auto 18px', lineHeight: 1.5 }}>
              Fluxos respondem seus clientes no WhatsApp automaticamente: menus, perguntas, link de pagamento, IA e transferência para um atendente.
            </p>
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" onClick={createFlow}><Icon name="plus" size={16} />Começar do zero</button>
              <button type="button" className="btn" onClick={() => setModal({ kind: 'generate' })}><Icon name="sparkles" size={16} />Criar com IA</button>
              <button type="button" className="btn" onClick={() => setModal({ kind: 'import' })}><Icon name="download" size={16} />Importar por código</button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="card empty">{q ? `Nenhum fluxo com “${q}”.` : 'Nenhum fluxo aqui.'}</div>
        ) : (
          <div className="fl-grid">
            {visible.map((f) => {
              const folder = f.folderId ? folderById.get(f.folderId) : undefined;
              const color = folder?.color ?? 'var(--primary)';
              const pill = f.archivedAt ? ['', 'arquivado'] : f.status === 'active' ? ['green', 'ativo'] : f.status === 'paused' ? ['amber', 'pausado'] : ['', 'rascunho'];
              return (
                <div key={f.id} className="card fcard" draggable={!f.archivedAt} data-testid="flow-card"
                  onDragStart={(e) => { e.dataTransfer.setData(DND_FLOW, f.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onClick={() => nav(`/flows/${f.id}`)}>
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div className="fi" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}><Icon name="flow" size={20} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="nm" title={f.name}>{f.name}</div>
                      <div className="trg">{summary('trigger', f.trigger ?? {}, emptyLookups)}</div>
                    </div>
                    <span className={cx('pill dot', pill[0])}>{pill[1]}</span>
                  </div>
                  <div className="meta">
                    <span><b>{f.blocks}</b> {f.blocks === 1 ? 'bloco' : 'blocos'}</span>
                    <span><b>{num(f.runs)}</b> execuções</span>
                    {f.activeRuns > 0 && <span><b>{num(f.activeRuns)}</b> em andamento</span>}
                    <span>editado {ago(f.updatedAt)}</span>
                  </div>
                  {f.blocks === 0 && !f.archivedAt && <div className="pill amber" style={{ height: 'auto', padding: '6px 10px', width: 'fit-content' }}>Vazio — abra para montar os blocos</div>}
                  <div className="ft" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn sm" onClick={() => nav(`/flows/${f.id}`)}><Icon name="edit" size={14} />Editar</button>
                    {folder && folderSel === 'all' && <span className="folder-tag"><i style={{ background: folder.color }} />{folder.name}</span>}
                    <div className="spacer" />
                    {!f.archivedAt && (
                      <span className="row" style={{ gap: 7 }} title={f.status === 'active' ? 'Pausar' : 'Ativar'}>
                        <span className="faint" style={{ fontSize: 11.5, fontWeight: 700 }}>{f.status === 'active' ? 'Ligado' : 'Desligado'}</span>
                        <Switch on={f.status === 'active'} onClick={() => toggle(f)} />
                      </span>
                    )}
                    <div className="menu-wrap">
                      <button type="button" className="btn icon sm ghost" aria-label="Mais ações" onClick={() => setCardMenu(cardMenu === f.id ? null : f.id)}><Icon name="dots" size={16} /></button>
                      {cardMenu === f.id && (
                        <div className="menu fade" onClick={() => setCardMenu(null)}>
                          {f.archivedAt ? (
                            <button type="button" onClick={() => unarchive(f)}><Icon name="archive" size={15} />Restaurar</button>
                          ) : (<>
                            <button type="button" onClick={() => duplicate(f)}><Icon name="copy" size={15} />Duplicar</button>
                            <button type="button" onClick={() => setModal({ kind: 'move', flow: f })}><Icon name="folder" size={15} />Mover para pasta</button>
                            <button type="button" onClick={() => setModal({ kind: 'share', flow: f })}><Icon name="share" size={15} />Compartilhar (código)</button>
                            <button type="button" onClick={() => setModal({ kind: 'translate', flow: f })}><Icon name="translate" size={15} />Traduzir</button>
                            <button type="button" onClick={() => archive(f)}><Icon name="archive" size={15} />Arquivar</button>
                          </>)}
                          <div className="sep" />
                          <button type="button" className="danger" onClick={() => remove(f)}><Icon name="trash" size={15} />Excluir</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {modal?.kind === 'folder' && (
        <FolderModal folder={modal.folder} onClose={() => setModal(null)}
          onSaved={(f) => { setModal(null); void load(); if (!modal.folder) setFolderSel(f.id); toast(modal.folder ? 'Pasta salva ✓' : 'Pasta criada ✓'); }} />
      )}
      {modal?.kind === 'import' && (
        <ImportModal folders={folders} folderId={currentFolder?.id ?? null} onClose={() => setModal(null)}
          onImported={(ids) => { setModal(null); void load(); if (ids.length === 1) nav(`/flows/${ids[0]}`); }} />
      )}
      {modal?.kind === 'generate' && <GenerateModal onClose={() => setModal(null)} onGenerated={createFromAi} />}
      {modal?.kind === 'share' && (
        <ShareModal flowId={modal.flow.id} onClose={() => setModal(null)} onChange={(c) => patchFlow(modal.flow.id, { shareCode: c })} />
      )}
      {modal?.kind === 'translate' && (
        <TranslateModal flowId={modal.flow.id} onClose={() => setModal(null)} onDone={(f) => { setModal(null); nav(`/flows/${f.id}`); }} />
      )}
      {modal?.kind === 'move' && (
        <MoveModal current={modal.flow.folderId} folders={folders} onClose={() => setModal(null)} onMove={(fid) => moveFlow(modal.flow.id, fid)} />
      )}
    </div>
  );
}
