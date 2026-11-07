import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { getSocket } from '../socket';
import { Icon } from '../icons';
import { Modal, Spinner, cx, toast, useBackdrop } from '../components/ui';
import { ConfirmModal } from '../kanban/modals';
import type { KBoardSummary } from '../kanban/types';
import { ago } from '../webhooks/util';
import { EVENT_STATUS, eventLabel, money, type Pixel, type PixelEvent, type PixelRule, type Platform, type PlatformInfo } from './types';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
interface ConnOpt { id: string; name: string; displayPhone: string | null; wabaId: string | null; status: string }
interface ListResp { pixels: Pixel[]; platforms: PlatformInfo[]; canEdit: boolean }

const PLAT_SHORT: Record<Platform, string> = { meta: 'Meta', meta_whatsapp: 'WhatsApp', tiktok: 'TikTok' };
const PLAT_HELP: Record<Platform, { id: string; token: string; idPh: string }> = {
  meta: {
    id: 'ID do pixel (ou conjunto de dados) no Gerenciador de Eventos da Meta',
    token: 'Gerenciador de Eventos › seu pixel › Configurações › API de Conversões › Gerar token de acesso',
    idPh: 'Ex: 726668042287',
  },
  meta_whatsapp: {
    id: 'Conjunto de dados ligado ao seu WhatsApp Business — o Converza busca para você',
    token: 'Em branco, usa o token da conexão (precisa da permissão whatsapp_business_manage_events)',
    idPh: 'Clique em “Buscar” para preencher',
  },
  tiktok: {
    id: 'Código do pixel em Ferramentas › Eventos › Eventos da Web',
    token: 'Ferramentas › Eventos › seu pixel › Configurações › API de Eventos › Gerar token de acesso',
    idPh: 'Ex: CXXXXXXXXXXXXXXXXXX0',
  },
};
const STATUS: Record<Pixel['status'], [string, string]> = { active: ['Ativo', 'green'], paused: ['Pausado', ''], error: ['Com erro', 'red'] };

function ruleText(r: PixelRule, boards: KBoardSummary[]) {
  if (r.trigger === 'lead') return r.scope === 'all' ? 'Contato novo (WhatsApp ou webhook)' : r.scope === 'whatsapp' ? 'Contato novo no WhatsApp' : 'Contato novo vindo de anúncio';
  if (r.trigger === 'sale') return 'Venda aprovada';
  for (const b of boards) { const c = b.columns.find((x) => x.id === r.columnId); if (c) return `Card em “${c.name}” (${b.name})`; }
  return 'Etapa do Kanban';
}

function useBoards() {
  const [boards, setBoards] = useState<KBoardSummary[]>([]);
  useEffect(() => { api.get<{ boards: KBoardSummary[] }>('/kanban/boards').then((r) => setBoards(r.boards)).catch(() => setBoards([])); }, []);
  return boards;
}

export function Pixels({ canEdit: canEditProp }: { canEdit: boolean }) {
  const { accountId } = useAuth();
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Pixel | null>(null);
  const boards = useBoards();

  const load = useCallback(() => api.get<ListResp>('/pixels').then((r) => { setData(r); setErr(null); })
    .catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); }, [load, accountId]);
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => { if (t) clearTimeout(t); t = setTimeout(() => void load(), 500); };
    sock.on('pixel:changed', on); sock.on('pixel:event', on);
    return () => { sock.off('pixel:changed', on); sock.off('pixel:event', on); if (t) clearTimeout(t); };
  }, [load, accountId]);

  const canEdit = data?.canEdit ?? canEditProp;
  // recém-criado abre na hora (antes de a lista recarregar)
  const current = data?.pixels.find((p) => p.id === open) ?? (fresh && fresh.id === open ? fresh : null);
  const newBtn = (testId: string, label: string, primary = true) => canEdit && (
    <button type="button" className={cx('btn', primary && 'primary')} onClick={() => setCreating(true)} data-testid={testId}><Icon name="plus" size={16} />{label}</button>
  );

  return (
    <div className="card fbm-section" data-testid="fb-pixels">
      <div className="fbm-section-h">
        <div>
          <b>Pixels</b>
          <span>Configure seus pixels para rastrear eventos e conversões em diferentes plataformas de anúncios.</span>
        </div>
        {newBtn('fb-new-pixel', 'Novo Pixel')}
      </div>
      {err && !data && <div className="hint bad"><Icon name="alert" size={14} />{err}</div>}
      {!data ? <Spinner /> : data.pixels.length === 0 ? (
        <div className="fbm-empty" data-testid="fb-pixels-empty">
          <Icon name="barChart" size={36} />
          <b>Nenhum pixel encontrado</b>
          <span>Crie sua primeira configuração de pixel para começar</span>
          {newBtn('fb-create-first-pixel', 'Criar Pixel')}
        </div>
      ) : (
        <>
          <div className="fbm-pixel-grid">
            {data.pixels.map((p) => (
              <button type="button" key={p.id} className="fbm-pixel" onClick={() => setOpen(p.id)} data-testid="fb-pixel">
                <div className="fbm-pixel-h">
                  <span className={cx('fbm-plat', p.platform)}>{PLAT_SHORT[p.platform]}</span>
                  <div className="fbm-pixel-n"><b>{p.name}</b><small>{p.platformLabel} · ID {p.pixelId}</small></div>
                  <span className={cx('pill dot', STATUS[p.status][1])} data-testid="fb-pixel-status">{STATUS[p.status][0]}</span>
                </div>
                <div className="fbm-pixel-rules">
                  {p.rules.length ? p.rules.map((r) => <span key={r.id} className="pill"><span>{ruleText(r, boards)}</span><Icon name="arrowRight" size={11} /><b>{eventLabel(r.event).split(' (')[0]}</b></span>)
                    : <span className="faint">Nenhum evento escolhido</span>}
                </div>
                {p.lastError && <div className="fbm-pixel-err" data-testid="fb-pixel-error"><Icon name="alert" size={13} />{p.lastError}</div>}
                <div className="fbm-pixel-stats" data-testid="fb-pixel-stats">
                  <span><b>{p.stats.sent}</b> enviados</span>
                  <span className={cx(p.stats.failed > 0 && 'bad')}><b>{p.stats.failed}</b> falharam</span>
                  <span><b>{p.stats.skipped}</b> não enviados</span>
                  <small className="faint">{p.lastEventAt ? `último evento ${ago(p.lastEventAt)}` : 'nenhum evento ainda'} · últimos 30 dias</small>
                </div>
              </button>
            ))}
          </div>
          <small className="faint fbm-pixel-note">
            Os eventos saem sozinhos do servidor (API de Conversões da Meta e API de Eventos do TikTok), com os dados do cliente criptografados — não precisa instalar nada no seu site.
          </small>
        </>
      )}

      {creating && data && (
        <PixelModal platforms={data.platforms} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setFresh(p); setOpen(p.id); void load(); toast('Pixel criado ✓ — confira os eventos que ele vai receber'); }} />
      )}
      {current && data && (
        <PixelDrawer pixel={current} platforms={data.platforms} boards={boards} canEdit={canEdit}
          onClose={() => setOpen(null)} onChanged={() => void load()} onDeleted={() => { setOpen(null); void load(); }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ novo pixel */

function SecretInput({ value, onChange, placeholder, testId }: { value: string; onChange: (v: string) => void; placeholder: string; testId: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="fbm-secret">
      <input className="input" type={show ? 'text' : 'password'} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testId} />
      <button type="button" className="btn icon sm ghost" onClick={() => setShow((s) => !s)} aria-label={show ? 'Esconder token' : 'Mostrar token'} data-testid={`${testId}-eye`}>
        <Icon name={show ? 'eyeOff' : 'eye'} size={15} />
      </button>
    </div>
  );
}

function PixelModal({ platforms, onClose, onCreated }: { platforms: PlatformInfo[]; onClose: () => void; onCreated: (p: Pixel) => void }) {
  const [f, setF] = useState({ name: '', platform: '' as Platform | '', pixelId: '', accessToken: '', connectionId: '' });
  const [conns, setConns] = useState<ConnOpt[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  const [err, setErr] = useState<{ field?: string; msg: string } | null>(null);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr(null); };
  useEffect(() => {
    if (f.platform !== 'meta_whatsapp' || conns) return;
    api.get<{ connections: ConnOpt[] }>('/connections').then((r) => {
      setConns(r.connections);
      const withWaba = r.connections.filter((c) => c.wabaId);
      if (withWaba.length === 1) setF((x) => ({ ...x, connectionId: x.connectionId || withWaba[0].id }));
    }).catch(() => setConns([]));
  }, [f.platform, conns]);

  async function findDataset() {
    setFinding(true); setErr(null);
    try {
      const r = await api.post<{ datasetId: string }>('/pixels/whatsapp-dataset', { connectionId: f.connectionId, accessToken: f.accessToken || null });
      set('pixelId', r.datasetId); toast('Conjunto de dados do WhatsApp encontrado');
    } catch (e) { setErr({ msg: errMsg(e) }); }
    setFinding(false);
  }
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ pixel: Pixel }>('/pixels', {
        name: f.name, platform: f.platform, pixelId: f.pixelId, accessToken: f.accessToken || null, connectionId: f.platform === 'meta_whatsapp' ? f.connectionId || null : null,
      });
      onCreated(r.pixel);
    } catch (e) {
      setErr({ field: e instanceof ApiError ? (e.data?.field as string | undefined) : undefined, msg: errMsg(e) });
    }
    setBusy(false);
  }
  const p = f.platform || null;
  const help = p ? PLAT_HELP[p] : null;
  const ok = f.name.trim() && p && (p === 'meta_whatsapp' ? !!f.connectionId : f.pixelId.trim() && f.accessToken.trim().length >= 8);
  const fieldErr = (k: string) => err?.field === k && <small className="fbm-field-err" data-testid={`fb-err-${k}`}>{err.msg}</small>;

  return (
    <Modal title="Novo Pixel" icon="barChart" width={480} onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancelar</button>
      <button type="button" className="btn primary" disabled={!ok || busy} onClick={() => void save()} data-testid="fb-pixel-create">{busy ? 'Conferindo…' : 'Criar'}</button>
    </>}>
      <div className="stack fbm-form" data-testid="fb-pixel-modal">
        <div>
          <label className="label">Nome do Pixel <i className="req">*</i></label>
          <input className="input" maxLength={80} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex: Pixel Principal" data-testid="fb-pixel-name" />
          <small className="fbm-help">Nome identificador para esta configuração de pixel</small>
        </div>
        <div>
          <label className="label">Plataforma <i className="req">*</i></label>
          <select className="select" value={f.platform} onChange={(e) => { set('platform', e.target.value); setF((x) => ({ ...x, pixelId: '' })); }} data-testid="fb-pixel-platform">
            <option value="">Selecione uma plataforma</option>
            {platforms.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
          <small className="fbm-help">Selecione a plataforma de anúncios para este pixel</small>
        </div>
        {p === 'meta_whatsapp' && (
          <div>
            <label className="label">Conexão do WhatsApp <i className="req">*</i></label>
            {!conns ? <small className="faint">Carregando as conexões…</small> : (
              <select className="select" value={f.connectionId} onChange={(e) => { set('connectionId', e.target.value); setF((x) => ({ ...x, pixelId: '' })); }} data-testid="fb-pixel-conn">
                <option value="">Escolha a conexão</option>
                {conns.map((c) => <option key={c.id} value={c.id} disabled={!c.wabaId}>{c.name}{c.displayPhone ? ` (${c.displayPhone})` : ''}{!c.wabaId ? ' — sem WABA' : ''}</option>)}
              </select>
            )}
            <small className="fbm-help">Os eventos vão com o ctwa_clid de quem clicou no anúncio de clique para o WhatsApp — é o que deixa a Meta otimizar por vendas no WhatsApp.</small>
            {fieldErr('connectionId')}
          </div>
        )}
        <div>
          <label className="label">{p === 'meta_whatsapp' ? 'ID do conjunto de dados' : 'ID do Pixel'} {p !== 'meta_whatsapp' && <i className="req">*</i>}</label>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" value={f.pixelId} onChange={(e) => set('pixelId', e.target.value.trim())} placeholder={help?.idPh ?? 'Ex: 726668042287'} data-testid="fb-pixel-id" />
            {p === 'meta_whatsapp' && <button type="button" className="btn" disabled={!f.connectionId || finding} onClick={() => void findDataset()} data-testid="fb-pixel-find">{finding ? 'Buscando…' : 'Buscar'}</button>}
          </div>
          <small className="fbm-help">{help?.id ?? 'ID do pixel da plataforma selecionada'}</small>
          {fieldErr('pixelId')}
        </div>
        <div>
          <label className="label">Access Token {p !== 'meta_whatsapp' && <i className="req">*</i>}</label>
          <SecretInput value={f.accessToken} onChange={(v) => set('accessToken', v)} placeholder={p === 'meta_whatsapp' ? 'Opcional: usa o token da conexão' : 'Cole o Access Token aqui'} testId="fb-pixel-token" />
          <small className="fbm-help">{help?.token ?? 'Access Token para autenticação na API da plataforma selecionada'}</small>
          {fieldErr('accessToken')}
        </div>
        {p === 'tiktok' && <div className="hint"><Icon name="info" size={14} />O TikTok só confere o token no primeiro envio. Depois de criar, use “Testar” com o código de teste do Gerenciador de Eventos.</div>}
        {err && !err.field && <div className="hint bad" data-testid="fb-pixel-modal-error"><Icon name="alert" size={14} />{err.msg}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ pixel aberto */

type DrawerTab = 'rules' | 'history' | 'test' | 'settings';

function PixelDrawer({ pixel, platforms, boards, canEdit, onClose, onChanged, onDeleted }: {
  pixel: Pixel; platforms: PlatformInfo[]; boards: KBoardSummary[]; canEdit: boolean; onClose: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('rules');
  const [del, setDel] = useState(false);
  const bg = useBackdrop(onClose);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  async function setStatus(status: 'active' | 'paused') {
    try { await api.put(`/pixels/${pixel.id}`, { status }); toast(status === 'paused' ? 'Pixel pausado' : 'Pixel ativado'); onChanged(); } catch (e) { toast(errMsg(e)); }
  }
  return (
    <div className="cd-bg" {...bg}>
      <aside className="cd fade fbm-drawer" role="dialog" aria-label={`Pixel ${pixel.name}`} data-testid="fb-pixel-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="cd-hd">
          <span className={cx('fbm-plat', pixel.platform)}>{PLAT_SHORT[pixel.platform]}</span>
          <div className="cd-who"><b>{pixel.name}</b><span>{pixel.platformLabel} · ID {pixel.pixelId}{pixel.remoteName ? ` · “${pixel.remoteName}”` : ''}</span></div>
          <span className="spacer" />
          <span className={cx('pill dot', STATUS[pixel.status][1])} data-testid="fb-drawer-status">{STATUS[pixel.status][0]}</span>
          {canEdit && (pixel.status === 'paused'
            ? <button type="button" className="btn sm" onClick={() => void setStatus('active')} data-testid="fb-pixel-activate"><Icon name="play" size={13} />Ativar</button>
            : <button type="button" className="btn sm" onClick={() => void setStatus('paused')} data-testid="fb-pixel-pause"><Icon name="pause" size={13} />Pausar</button>)}
          <button type="button" className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" size={16} /></button>
        </header>
        {pixel.lastError && <div className="hint warn fbm-drawer-err" data-testid="fb-drawer-error"><Icon name="alert" size={14} /><span>{pixel.lastError}{canEdit && <> <button type="button" className="linkbtn" onClick={() => setTab('settings')}>Trocar o token</button></>}</span></div>}
        <div className="fbm-drawer-tabs seg" role="tablist">
          {([['rules', 'Eventos'], ['history', 'Histórico'], ['test', 'Testar'], ['settings', 'Ajustes']] as [DrawerTab, string][]).map(([k, l]) => (
            <button type="button" key={k} className={cx(tab === k && 'active')} onClick={() => setTab(k)} data-testid={`fb-ptab-${k}`}>{l}</button>
          ))}
        </div>
        <div className="cd-body">
          {tab === 'rules' && <RulesEditor pixel={pixel} platforms={platforms} boards={boards} canEdit={canEdit} onSaved={onChanged} />}
          {tab === 'history' && <History pixel={pixel} canEdit={canEdit} />}
          {tab === 'test' && <TestPanel pixel={pixel} canEdit={canEdit} />}
          {tab === 'settings' && <Settings pixel={pixel} canEdit={canEdit} onSaved={onChanged} onDelete={() => setDel(true)} />}
        </div>
      </aside>
      {del && (
        <ConfirmModal title="Excluir pixel" confirm="Excluir" danger onClose={() => setDel(false)} onConfirm={async () => {
          try { await api.del(`/pixels/${pixel.id}`); toast('Pixel excluído'); setDel(false); onDeleted(); } catch (e) { toast(errMsg(e)); }
        }}>Excluir <b>{pixel.name}</b>? Os eventos param de ir para {pixel.platformLabel} e o histórico deste pixel é apagado. O pixel continua existindo na plataforma.</ConfirmModal>
      )}
    </div>
  );
}

function RulesEditor({ pixel, platforms, boards, canEdit, onSaved }: { pixel: Pixel; platforms: PlatformInfo[]; boards: KBoardSummary[]; canEdit: boolean; onSaved: () => void }) {
  const [rules, setRules] = useState<PixelRule[]>(pixel.rules);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRules(pixel.rules); }, [pixel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = platforms.find((p) => p.id === pixel.platform)?.events ?? [];
  const wa = pixel.platform === 'meta_whatsapp';
  const dirty = JSON.stringify(rules) !== JSON.stringify(pixel.rules);
  const upd = (i: number, patch: Partial<PixelRule>) => setRules((l) => l.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const defEvent = (t: PixelRule['trigger']) => (t === 'sale' ? 'Purchase' : t === 'lead' ? (wa ? 'LeadSubmitted' : 'Lead') : wa ? 'QualifiedLead' : events.includes('Contact') ? 'Contact' : events[0]);
  const add = () => setRules((l) => [...l, { id: `r${Date.now().toString(36)}`, trigger: 'lead', scope: 'ad', event: defEvent('lead') }]);
  async function save() {
    setBusy(true);
    try { await api.put(`/pixels/${pixel.id}`, { rules }); toast('Eventos salvos ✓'); onSaved(); } catch (e) { toast(errMsg(e)); }
    setBusy(false);
  }
  return (
    <div className="cd-sec" data-testid="fb-rules">
      <p className="fbm-p">Quando algo acontecer no Converza, o evento vai para {pixel.platformLabel}. Cada venda ou lead sai uma vez só.</p>
      {wa && <div className="hint"><Icon name="info" size={14} />Pelo WhatsApp, a Meta só aceita eventos de clientes que vieram de um anúncio de clique para o WhatsApp (com o ctwa_clid). Os outros ficam como “não enviado” no histórico.</div>}
      <div className="fbm-rules">
        {rules.map((r, i) => (
          <div key={r.id} className="fbm-rule" data-testid="fb-rule">
            <div className="fbm-rule-row">
            <span className="fbm-rule-k">Quando</span>
            <select className="select" value={r.trigger} disabled={!canEdit} data-testid="fb-rule-trigger"
              onChange={(e) => { const t = e.target.value as PixelRule['trigger']; upd(i, { trigger: t, event: defEvent(t), scope: t === 'lead' ? 'ad' : undefined, columnId: null, boardId: null }); }}>
              <option value="lead">chega um contato novo</option>
              <option value="sale">uma venda é aprovada</option>
              <option value="stage">um card entra numa etapa do Kanban</option>
            </select>
            {r.trigger === 'lead' && (
              <select className="select" value={wa ? 'ad' : r.scope ?? 'ad'} disabled={!canEdit || wa} onChange={(e) => upd(i, { scope: e.target.value as PixelRule['scope'] })} data-testid="fb-rule-scope">
                <option value="ad">vindo de anúncio (clique para o WhatsApp)</option>
                <option value="whatsapp">pelo WhatsApp (qualquer origem)</option>
                <option value="all">pelo WhatsApp ou pelos webhooks</option>
              </select>
            )}
            {r.trigger === 'stage' && (
              <select className="select" value={r.columnId ?? ''} disabled={!canEdit} data-testid="fb-rule-column"
                onChange={(e) => { const col = e.target.value; const b = boards.find((x) => x.columns.some((c) => c.id === col)); upd(i, { columnId: col || null, boardId: b?.id ?? null }); }}>
                <option value="">Escolha a etapa</option>
                {boards.map((b) => <optgroup key={b.id} label={b.name}>{b.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
              </select>
            )}
            </div>
            <div className="fbm-rule-row">
            <span className="fbm-rule-k">Manda</span>
            <select className="select" value={r.event} disabled={!canEdit} onChange={(e) => upd(i, { event: e.target.value })} data-testid="fb-rule-event">
              {events.map((ev) => <option key={ev} value={ev}>{eventLabel(ev)}</option>)}
            </select>
            {r.trigger === 'sale' && <small className="fbm-rule-note">com o valor da venda</small>}
            {canEdit && <button type="button" className="btn icon sm ghost" aria-label="Remover regra" onClick={() => setRules((l) => l.filter((_, j) => j !== i))} data-testid="fb-rule-remove"><Icon name="trash" size={14} /></button>}
            </div>
          </div>
        ))}
        {!rules.length && <div className="empty" style={{ padding: 16 }}>Nenhum evento: este pixel não recebe nada.</div>}
      </div>
      {canEdit && (
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn sm" onClick={add} disabled={rules.length >= 12} data-testid="fb-rule-add"><Icon name="plus" size={14} />Adicionar evento</button>
          <span className="spacer" />
          {dirty && <button type="button" className="btn sm ghost" onClick={() => setRules(pixel.rules)}>Desfazer</button>}
          <button type="button" className="btn sm primary" disabled={!dirty || busy || rules.some((r) => r.trigger === 'stage' && !r.columnId)} onClick={() => void save()} data-testid="fb-rules-save">{busy ? 'Salvando…' : 'Salvar eventos'}</button>
        </div>
      )}
      {!boards.length && rules.some((r) => r.trigger === 'stage') && <small className="faint">Crie um quadro em <Link className="linkbtn" to="/kanban">Kanban</Link> para usar as etapas.</small>}
    </div>
  );
}

const TRIGGER_LABEL: Record<string, string> = { lead: 'contato novo', sale: 'venda aprovada', stage: 'etapa do Kanban', test: 'teste' };

function History({ pixel, canEdit }: { pixel: Pixel; canEdit: boolean }) {
  const { accountId } = useAuth();
  const [st, setSt] = useState('');
  const [list, setList] = useState<PixelEvent[] | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(async (p = 1) => {
    const r = await api.get<{ events: PixelEvent[]; pages: number }>(`/pixels/${pixel.id}/events?page=${p}${st ? `&status=${st}` : ''}`);
    setList((l) => (p === 1 ? r.events : [...(l ?? []), ...r.events])); setPage(p); setPages(r.pages);
  }, [pixel.id, st]);
  useEffect(() => { void load(1).catch(() => setList([])); }, [load, accountId]);
  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    const on = (p: { pixelId: string; event: PixelEvent }) => {
      if (p.pixelId !== pixel.id) return;
      setList((l) => {
        if (!l) return l;
        const i = l.findIndex((e) => e.id === p.event.id);
        if (st && p.event.status !== st) return i >= 0 ? l.filter((e) => e.id !== p.event.id) : l;
        if (i >= 0) { const n = [...l]; n[i] = p.event; return n; }
        return [p.event, ...l];
      });
    };
    sock.on('pixel:event', on);
    return () => { sock.off('pixel:event', on); };
  }, [pixel.id, st]);
  async function retry(e: PixelEvent) {
    try { await api.post(`/pixels/${pixel.id}/events/${e.id}/retry`); toast('Mandando de novo…'); } catch (x) { toast(errMsg(x)); }
  }
  async function retryAll() {
    try { const r = await api.post<{ requeued: number }>(`/pixels/${pixel.id}/retry-failed`); toast(r.requeued ? `${r.requeued} ${r.requeued === 1 ? 'evento voltou' : 'eventos voltaram'} para a fila` : 'Nenhuma falha dos últimos 7 dias'); void load(1); } catch (x) { toast(errMsg(x)); }
  }
  return (
    <div className="cd-sec" data-testid="fb-history">
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <div className="seg">
          {([['', 'Todos'], ['sent', 'Enviados'], ['failed', 'Falharam'], ['skipped', 'Não enviados']] as [string, string][]).map(([k, l]) => (
            <button type="button" key={k} className={cx(st === k && 'active')} onClick={() => setSt(k)} data-testid={`fb-hist-${k || 'all'}`}>{l}</button>
          ))}
        </div>
        <span className="spacer" />
        {canEdit && pixel.stats.failed > 0 && <button type="button" className="btn sm" onClick={() => void retryAll()} data-testid="fb-retry-all"><Icon name="refresh" size={13} />Reenviar falhas</button>}
      </div>
      {!list ? <Spinner /> : !list.length ? <div className="empty" data-testid="fb-history-empty">Nenhum evento {st ? 'com esse filtro' : 'ainda'}.</div> : (
        <div className="fbm-events">
          {list.map((e) => (
            <div key={e.id} className="fbm-event" data-testid="fb-event">
              <div className="fbm-event-top" onClick={() => setOpenId((x) => (x === e.id ? null : e.id))}>
                <span className={cx('pill mini', EVENT_STATUS[e.status][1])} data-testid="fb-event-status">{EVENT_STATUS[e.status][0]}</span>
                <b>{eventLabel(e.eventName)}</b>
                <span className="faint">{TRIGGER_LABEL[e.trigger]}</span>
                {e.contactName && <span>· {e.contactName}</span>}
                {e.value !== null && e.currency && <span>· {money(e.value, e.currency)}</span>}
                <span className="spacer" />
                <small className="faint">{ago(e.sentAt ?? e.createdAt)}</small>
              </div>
              {e.error && <div className={cx('fbm-event-err', e.status === 'skipped' && 'muted')} data-testid="fb-event-error">{e.error}</div>}
              {openId === e.id && (
                <div className="fbm-event-more">
                  {e.contactId && <Link className="linkbtn" to={`/contacts?id=${e.contactId}`}>Abrir o contato</Link>}
                  {e.payload != null && <><small className="faint">O que foi mandado (dados pessoais em SHA-256):</small><pre data-testid="fb-event-payload">{JSON.stringify(e.payload, null, 2)}</pre></>}
                  {e.response != null && <><small className="faint">Resposta da plataforma:</small><pre>{JSON.stringify(e.response, null, 2)}</pre></>}
                </div>
              )}
              {canEdit && e.status === 'failed' && e.trigger !== 'test' && <button type="button" className="btn sm fbm-event-retry" onClick={() => void retry(e)} data-testid="fb-event-retry"><Icon name="refresh" size={13} />Tentar de novo</button>}
            </div>
          ))}
          {page < pages && <button type="button" className="btn sm" onClick={() => void load(page + 1)}>Carregar mais</button>}
        </div>
      )}
    </div>
  );
}

function TestPanel({ pixel, canEdit }: { pixel: Pixel; canEdit: boolean }) {
  const [code, setCode] = useState('');
  const [event, setEvent] = useState('Lead');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; msg: string } | null>(null);
  const wa = pixel.platform === 'meta_whatsapp';
  async function run() {
    setBusy(true); setRes(null);
    try { const r = await api.post<{ message: string }>(`/pixels/${pixel.id}/test`, { testEventCode: code, event }); setRes({ ok: true, msg: r.message }); }
    catch (e) { setRes({ ok: false, msg: errMsg(e) }); }
    setBusy(false);
  }
  if (!canEdit) return <div className="cd-sec"><div className="empty">Só donos e administradores testam o pixel.</div></div>;
  return (
    <div className="cd-sec" data-testid="fb-test">
      {wa ? (
        <p className="fbm-p">A Meta só aceita eventos do WhatsApp com o identificador de um clique real em anúncio. O teste confere se o token e o conjunto de dados estão certos.</p>
      ) : (
        <>
          <p className="fbm-p">O evento de teste aparece na hora {pixel.platform === 'tiktok' ? 'em Eventos › seu pixel › Teste de eventos, no TikTok' : 'em Gerenciador de Eventos › seu pixel › Testar eventos, na Meta'} e não conta nos anúncios.</p>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder={pixel.platform === 'tiktok' ? 'Código de teste (ex.: TEST12345)' : 'Código de teste (ex.: TEST12345)'} data-testid="fb-test-code" />
            <select className="select" style={{ flex: '0 0 200px' }} value={event} onChange={(e) => setEvent(e.target.value)} data-testid="fb-test-event">
              <option value="Lead">Lead (Lead)</option><option value="Purchase">Compra (Purchase) de R$ 1,00</option>
            </select>
          </div>
        </>
      )}
      <button type="button" className="btn primary" style={{ marginTop: 12 }} disabled={busy || (!wa && !code)} onClick={() => void run()} data-testid="fb-test-send">
        <Icon name="send" size={14} />{busy ? 'Mandando…' : wa ? 'Conferir token e conjunto de dados' : 'Enviar evento de teste'}
      </button>
      {res && <div className={cx('hint', res.ok ? '' : 'bad')} style={{ marginTop: 12 }} data-testid="fb-test-result"><Icon name={res.ok ? 'checkCircle' : 'alert'} size={14} />{res.msg}</div>}
    </div>
  );
}

function Settings({ pixel, canEdit, onSaved, onDelete }: { pixel: Pixel; canEdit: boolean; onSaved: () => void; onDelete: () => void }) {
  const [name, setName] = useState(pixel.name);
  const [pid, setPid] = useState(pixel.pixelId);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wa = pixel.platform === 'meta_whatsapp';
  const dirty = name.trim() !== pixel.name || pid.trim() !== pixel.pixelId || !!token.trim();
  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.put(`/pixels/${pixel.id}`, { name: name.trim(), ...(pid.trim() !== pixel.pixelId ? { pixelId: pid.trim() } : {}), ...(token.trim() ? { accessToken: token.trim() } : {}) });
      setToken(''); toast('Pixel salvo ✓'); onSaved();
    } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  }
  async function useConnToken() {
    try { await api.put(`/pixels/${pixel.id}`, { accessToken: '' }); toast('Voltou a usar o token da conexão'); onSaved(); } catch (e) { setErr(errMsg(e)); }
  }
  const tokenNow = useMemo(() => (pixel.usesConnectionToken ? `token da conexão ${pixel.connectionName ?? ''}`.trim() : pixel.tokenHint ?? '—'), [pixel]);
  return (
    <div className="cd-sec stack fbm-form" data-testid="fb-settings">
      <div><label className="label">Nome do Pixel</label><input className="input" maxLength={80} disabled={!canEdit} value={name} onChange={(e) => setName(e.target.value)} data-testid="fb-set-name" /></div>
      <div><label className="label">{wa ? 'ID do conjunto de dados' : 'ID do Pixel'}</label><input className="input" disabled={!canEdit} value={pid} onChange={(e) => setPid(e.target.value)} data-testid="fb-set-id" /></div>
      {wa && <div><label className="label">Conexão</label><input className="input" disabled value={pixel.connectionName ?? '—'} /></div>}
      <div>
        <label className="label">Access Token</label>
        <small className="fbm-help" style={{ marginTop: 0, marginBottom: 6 }}>Atual: <b data-testid="fb-set-token-now">{tokenNow}</b>. Cole um novo para trocar (em branco mantém).</small>
        {canEdit && <SecretInput value={token} onChange={setToken} placeholder="Novo Access Token" testId="fb-set-token" />}
        {wa && !pixel.usesConnectionToken && canEdit && <button type="button" className="linkbtn" style={{ marginTop: 6 }} onClick={() => void useConnToken()}>Usar o token da conexão</button>}
      </div>
      {err && <div className="hint bad" data-testid="fb-set-error"><Icon name="alert" size={14} />{err}</div>}
      {canEdit && (
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn danger" onClick={onDelete} data-testid="fb-pixel-delete"><Icon name="trash" size={14} />Excluir pixel</button>
          <span className="spacer" />
          <button type="button" className="btn primary" disabled={!dirty || busy || !name.trim()} onClick={() => void save()} data-testid="fb-set-save">{busy ? 'Conferindo…' : 'Salvar'}</button>
        </div>
      )}
    </div>
  );
}
