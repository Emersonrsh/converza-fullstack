import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Icon } from '../../icons';
import { Spinner, cx, toast } from '../../components/ui';
import {
  OBJECTIVES, buildTargeting, draftFrom, goalOf, newAd, newAdset, newDraft, newKey, objectiveLabel, toPublish, validate,
  type AdDraft, type AdsetDraft, type CampaignDraft, type Draft, type Objective, type RemoteTree,
} from './model';
import { CampaignForm } from './CampaignForm';
import { AdsetForm } from './AdsetForm';
import { AdForm, AdPreview } from './AdForm';
import { errMsg } from './parts';

/**
 * Editor de campanhas no formato do Gerenciador de Anúncios da Meta: árvore campanha → conjuntos → anúncios
 * à esquerda, o formulário do item no meio e, à direita, o tamanho do público ou a prévia do anúncio.
 * Campanha nova fica como rascunho neste navegador até publicar.
 */

export interface EditorAccount { actId: string; name: string; currency: string; canManage?: boolean }
export type EditorStart =
  | { mode: 'new'; actId: string; objective: Objective; resume?: boolean }
  | { mode: 'edit'; actId: string; campaignId: string; focus?: string | null; add?: 'adset' | 'ad' | null };

const DRAFT_KEY = (actId: string) => `cz-meta-draft:${actId}`;
export function savedDraft(actId: string): { at: number; draft: Draft } | null {
  try { const v = JSON.parse(localStorage.getItem(DRAFT_KEY(actId)) ?? 'null'); return v?.draft ? v : null; } catch { return null; }
}
const clearDraft = (actId: string) => { try { localStorage.removeItem(DRAFT_KEY(actId)); } catch { /* sem storage */ } };

type Flow = { id: string; name: string };

export function Editor({ accounts, start, flows, onClose, onPublished }: {
  accounts: EditorAccount[]; start: EditorStart; flows: Flow[]; onClose: () => void; onPublished: () => void;
}) {
  const acc = accounts.find((a) => a.actId === start.actId) ?? accounts[0];
  const [d, setD] = useState<Draft | null>(() => {
    if (start.mode !== 'new') return null;
    const saved = start.resume ? savedDraft(start.actId)?.draft : null;
    return saved ?? newDraft(start.actId, acc?.currency ?? 'BRL', start.objective);
  });
  const [sel, setSel] = useState('campaign');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pubErr, setPubErr] = useState<{ msg: string; step?: string } | null>(null);
  const [done, setDone] = useState<{ url: string; created: number; updated: number } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [phones, setPhones] = useState<{ phone: string; name: string }[]>([]);

  useEffect(() => {
    api.get<{ connections: { displayPhone: string | null; name?: string }[] }>('/connections')
      .then((r) => setPhones(r.connections.map((c) => ({ phone: (c.displayPhone ?? '').replace(/\D/g, ''), name: c.name ?? '' })).filter((x) => x.phone.length >= 10))).catch(() => {});
  }, []);

  // campanha publicada: lê da Meta
  useEffect(() => {
    if (start.mode !== 'edit') return;
    api.get<RemoteTree>(`/meta/editor/campaigns/${start.campaignId}?actId=${start.actId}`).then((t) => {
      const dr = draftFrom(start.actId, t);
      let focus = start.focus ? dr.adsets.find((s) => s.id === start.focus)?.key ?? dr.adsets.flatMap((s) => s.ads).find((x) => x.id === start.focus)?.key : null;
      if (start.add === 'adset') { const ns = newAdset(dr.campaign.objective, dr.adsets.length + 1, { pageId: dr.adsets[0]?.pageId ?? '' }); dr.adsets.push(ns); focus = ns.key; }
      if (start.add === 'ad') {
        const s = dr.adsets.find((x) => x.id === start.focus) ?? dr.adsets[0];
        if (s) { const na = newAd(dr.campaign.objective, s.ads.length + 1); s.ads.push(na); focus = na.key; }
      }
      setD(dr); setSel(focus ?? 'campaign');
    }).catch((e) => setLoadErr(errMsg(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // rascunho de campanha nova fica salvo neste navegador
  useEffect(() => {
    if (!d || d.campaign.id || !touched) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY(d.actId), JSON.stringify({ at: Date.now(), draft: d })); setSavedAt(Date.now()); } catch { /* cheio */ }
    }, 500);
    return () => clearTimeout(t);
  }, [d, touched]);

  const issues = useMemo(() => (d ? validate(d) : []), [d]);
  const bad = useMemo(() => new Set(issues.map((i) => i.key)), [issues]);

  if (loadErr) return <Shell onClose={onClose}><div className="ed-loading"><p className="err">{loadErr}</p><button className="btn" onClick={onClose}>Fechar</button></div></Shell>;
  if (!d) return <Shell onClose={onClose}><div className="ed-loading"><Spinner /><p>Abrindo a campanha da Meta…</p></div></Shell>;

  const upd = (fn: (x: Draft) => void) => { setD((cur) => { if (!cur) return cur; const n = structuredClone(cur); fn(n); return n; }); setTouched(true); setPubErr(null); };
  const setCampaign = (p: Partial<CampaignDraft>) => upd((x) => { Object.assign(x.campaign, p); });
  const setAdset = (key: string, p: Partial<AdsetDraft>) => upd((x) => { const s = x.adsets.find((y) => y.key === key); if (s) Object.assign(s, p); });
  const setAd = (key: string, p: Partial<AdDraft>) => upd((x) => { for (const s of x.adsets) { const a = s.ads.find((y) => y.key === key); if (a) Object.assign(a, p); } });

  const order = ['campaign', ...d.adsets.flatMap((s) => [s.key, ...s.ads.map((a) => a.key)])];
  const idx = Math.max(0, order.indexOf(sel));
  const curSet = d.adsets.find((s) => s.key === sel) ?? d.adsets.find((s) => s.ads.some((a) => a.key === sel)) ?? null;
  const curAd = curSet?.ads.find((a) => a.key === sel) ?? null;
  const level = sel === 'campaign' ? 'campaign' : curAd ? 'ad' : 'adset';
  const o = d.campaign.objective;

  const addAdset = () => upd((x) => {
    const base = x.adsets[x.adsets.length - 1];
    const ns = newAdset(o, x.adsets.length + 1, base ? { pageId: base.pageId, pixelId: base.pixelId, event: base.event, destination: base.destination, goal: base.goal } : undefined);
    if (base?.ads[0]) ns.ads[0] = { ...newAd(o, 1), pageId: base.ads[0].pageId, igId: base.ads[0].igId };
    x.adsets.push(ns); setTimeout(() => setSel(ns.key));
  });
  const addAd = (setKey: string) => upd((x) => {
    const s = x.adsets.find((y) => y.key === setKey); if (!s) return;
    const last = s.ads[s.ads.length - 1];
    const na = newAd(o, s.ads.length + 1, last ? { pageId: last.pageId, igId: last.igId, cta: last.cta, link: last.link, greeting: last.greeting, prefill: last.prefill } : undefined);
    s.ads.push(na); setTimeout(() => setSel(na.key));
  });
  const dup = (key: string) => upd((x) => {
    const si = x.adsets.findIndex((s) => s.key === key);
    if (si >= 0) {
      const c = structuredClone(x.adsets[si]);
      c.key = newKey('s'); c.id = null; c.name = `${c.name} - Cópia`;
      c.ads = c.ads.map((a) => ({ ...a, key: newKey('a'), id: null }));
      x.adsets.splice(si + 1, 0, c); setTimeout(() => setSel(c.key)); return;
    }
    for (const s of x.adsets) {
      const ai = s.ads.findIndex((a) => a.key === key);
      if (ai >= 0) { const c = { ...structuredClone(s.ads[ai]), key: newKey('a'), id: null, name: `${s.ads[ai].name} - Cópia` }; s.ads.splice(ai + 1, 0, c); setTimeout(() => setSel(c.key)); }
    }
  });
  const remove = (key: string) => {
    const s = d.adsets.find((y) => y.key === key);
    const a = d.adsets.flatMap((y) => y.ads).find((y) => y.key === key);
    const name = s?.name ?? a?.name ?? '';
    if ((s?.id || a?.id) && !window.confirm(`Excluir “${name}” na Meta quando publicar? Isso não pode ser desfeito.`)) return;
    upd((x) => {
      const si = x.adsets.findIndex((y) => y.key === key);
      if (si >= 0) { if (x.adsets[si].id) x.remove.push(x.adsets[si].id!); x.adsets.splice(si, 1); }
      for (const y of x.adsets) {
        const ai = y.ads.findIndex((z) => z.key === key);
        if (ai >= 0) { if (y.ads[ai].id) x.remove.push(y.ads[ai].id!); y.ads.splice(ai, 1); }
      }
    });
    setSel('campaign');
  };

  async function publish() {
    if (!d) return;
    setShowIssues(true);
    if (issues.length) { setSel(issues[0].key); toast(`Falta resolver ${issues.length === 1 ? '1 item' : `${issues.length} itens`} antes de publicar.`); return; }
    setBusy(true); setPubErr(null);
    try {
      const r = await api.post<{ campaignId: string; url: string; created: string[]; updated: string[] }>('/meta/editor/publish', toPublish(d));
      if (!d.campaign.id) clearDraft(d.actId);
      setDone({ url: r.url, created: r.created.length, updated: r.updated.length });
      onPublished();
    } catch (e) {
      const step = e instanceof ApiError ? (e.data.step as string | undefined) : undefined;
      setPubErr({ msg: errMsg(e), step });
    } finally { setBusy(false); }
  }

  const statusOf = (on: boolean) => (on ? 'ACTIVE' : 'PAUSED');
  const curOn = level === 'campaign' ? d.campaign.status === 'ACTIVE' : level === 'adset' ? curSet!.status === 'ACTIVE' : curAd!.status === 'ACTIVE';
  const setCurOn = (on: boolean) => (level === 'campaign' ? setCampaign({ status: statusOf(on) }) : level === 'adset' ? setAdset(curSet!.key, { status: statusOf(on) }) : setAd(curAd!.key, { status: statusOf(on) }));
  const issuesOf = (key: string) => (showIssues ? issues.filter((i) => i.key === key).map((i) => i.msg) : []);

  if (done) {
    return (
      <Shell onClose={onClose}>
        <div className="ed-done" data-testid="ed-done">
          <span className="ed-done-ic"><Icon name="checkCircle" size={34} /></span>
          <h3>{d.campaign.id ? 'Alterações publicadas' : 'Campanha publicada'}</h3>
          <p>A Meta analisa os anúncios antes de começarem a rodar (de minutos a algumas horas). {d.campaign.status === 'PAUSED' ? 'A campanha está pausada: ligue quando quiser.' : ''}</p>
          <div className="ed-done-a">
            <a className="btn" href={done.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Ver no Gerenciador da Meta</a>
            <button className="btn primary" onClick={onClose} data-testid="ed-done-close">Fechar</button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      <aside className="ed-tree" data-testid="ed-tree">
        <TreeItem icon="folder" label={d.campaign.name || 'Campanha'} active={sel === 'campaign'} bad={showIssues && bad.has('campaign')} onClick={() => setSel('campaign')} testId="ed-tree-campaign"
          actions={<button className="btn icon sm ghost" title="Novo conjunto de anúncios" onClick={addAdset} data-testid="ed-add-adset"><Icon name="plus" size={13} /></button>} />
        {d.adsets.map((s) => (
          <div key={s.key}>
            <TreeItem icon="grid" depth={1} label={s.name || 'Conjunto'} active={sel === s.key} bad={showIssues && bad.has(s.key)} onClick={() => setSel(s.key)} testId="ed-tree-adset"
              off={s.status === 'PAUSED'}
              actions={<>
                <button className="btn icon sm ghost" title="Novo anúncio" onClick={() => addAd(s.key)} data-testid="ed-add-ad"><Icon name="plus" size={13} /></button>
                <button className="btn icon sm ghost" title="Duplicar" onClick={() => dup(s.key)} data-testid="ed-dup"><Icon name="copy" size={13} /></button>
                {d.adsets.length > 1 && <button className="btn icon sm ghost" title="Excluir" onClick={() => remove(s.key)} data-testid="ed-del"><Icon name="trash" size={13} /></button>}
              </>} />
            {s.ads.map((a) => (
              <TreeItem key={a.key} icon="image" depth={2} label={a.name || 'Anúncio'} active={sel === a.key} bad={showIssues && bad.has(a.key)} onClick={() => setSel(a.key)} testId="ed-tree-ad"
                off={a.status === 'PAUSED'}
                actions={<>
                  <button className="btn icon sm ghost" title="Duplicar" onClick={() => dup(a.key)} data-testid="ed-dup"><Icon name="copy" size={13} /></button>
                  {s.ads.length > 1 && <button className="btn icon sm ghost" title="Excluir" onClick={() => remove(a.key)} data-testid="ed-del"><Icon name="trash" size={13} /></button>}
                </>} />
            ))}
          </div>
        ))}
      </aside>

      <div className="ed-main">
        <div className="ed-top">
          <div className="ed-crumbs">
            <button className={cx(level === 'campaign' && 'on')} onClick={() => setSel('campaign')}><Icon name="folder" size={13} />{d.campaign.name || 'Campanha'}</button>
            <Icon name="chevronRight" size={13} />
            <button className={cx(level === 'adset' && 'on')} onClick={() => curSet && setSel(curSet.key)}><Icon name="grid" size={13} />{level === 'campaign' ? `${d.adsets.length} conjunto${d.adsets.length === 1 ? '' : 's'} de anúncios` : curSet?.name}</button>
            <Icon name="chevronRight" size={13} />
            <button className={cx(level === 'ad' && 'on')} onClick={() => curSet?.ads[0] && setSel(curAd?.key ?? curSet.ads[0].key)}><Icon name="image" size={13} />{curAd ? curAd.name : `${(curSet ?? d.adsets[0])?.ads.length ?? 0} anúncio(s)`}</button>
          </div>
          <div className="ed-top-r">
            <span className={cx('ed-state', d.campaign.id ? 'pub' : 'draft')}><i />{d.campaign.id ? (touched ? 'Alterações não publicadas' : 'Publicada') : 'Em rascunho'}</span>
            <button type="button" className={cx('ed-toggle', curOn && 'on')} onClick={() => setCurOn(!curOn)} title={curOn ? 'Ligado' : 'Pausado'} data-testid="ed-top-toggle"><i /></button>
          </div>
        </div>

        {pubErr && (
          <div className="ed-pub-err" data-testid="ed-pub-err">
            <Icon name="alert" size={16} />
            <div><b>A Meta recusou{pubErr.step ? ` em “${pubErr.step}”` : ''}.</b><span>{pubErr.msg}</span><small>Nada novo ficou pela metade: o que esta publicação tinha criado foi apagado. Corrija e publique de novo.</small></div>
          </div>
        )}

        <div className="ed-body">
          <div className="ed-form" key={sel}>
            {level === 'campaign' && <CampaignForm d={d} set={setCampaign} flows={flows} issues={issuesOf('campaign')} />}
            {level === 'adset' && curSet && <AdsetForm d={d} s={curSet} set={(p) => setAdset(curSet.key, p)} connections={phones} issues={issuesOf(curSet.key)} />}
            {level === 'ad' && curSet && curAd && <AdForm d={d} s={curSet} a={curAd} set={(p) => setAd(curAd.key, p)} issues={issuesOf(curAd.key)} />}
          </div>
          <div className="ed-side">
            {level === 'ad' && curSet && curAd ? <AdPreview d={d} s={curSet} a={curAd} /> : level === 'adset' && curSet ? <Estimate d={d} s={curSet} /> : <Summary d={d} issues={issues} onGo={setSel} show={showIssues} />}
          </div>
        </div>

        <footer className="ed-foot">
          <button className="btn" onClick={onClose} data-testid="ed-close">Fechar</button>
          <span className="ed-saved">{d.campaign.id ? (touched ? 'Mudanças só vão para a Meta ao publicar' : '') : savedAt ? <><Icon name="check" size={13} />Rascunho salvo neste navegador</> : ''}</span>
          <span className="grow" />
          {idx > 0 && <button className="btn" onClick={() => setSel(order[idx - 1])} data-testid="ed-back">Voltar</button>}
          {idx < order.length - 1 && <button className="btn" onClick={() => setSel(order[idx + 1])} data-testid="ed-next">Avançar</button>}
          <button className="btn primary" disabled={busy} onClick={() => void publish()} data-testid="ed-publish">{busy ? <span className="spin sm" /> : <Icon name="send" size={14} />}Publicar</button>
        </footer>
      </div>
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) onClose(); };
    window.addEventListener('keydown', h);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', h); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="ed-shell" role="dialog" aria-modal="true" aria-label="Editor de campanha" data-testid="ed">
      <button className="ed-x" onClick={onClose} aria-label="Fechar" data-testid="ed-x"><Icon name="close" size={18} /></button>
      {children}
    </div>
  );
}

function TreeItem({ icon, label, depth = 0, active, bad, onClick, actions, testId, off }: {
  icon: string; label: string; depth?: number; active: boolean; bad?: boolean; onClick: () => void; actions?: React.ReactNode; testId?: string; off?: boolean;
}) {
  return (
    <div className={cx('ed-ti', active && 'on', off && 'off')} style={{ paddingLeft: 10 + depth * 16 }} data-testid={testId}>
      <button className="ed-ti-l" onClick={onClick}><Icon name={icon} size={14} /><span>{label}</span>{bad && <i className="ed-dot" title="Falta resolver algo aqui" />}</button>
      <span className="ed-ti-a">{actions}</span>
    </div>
  );
}

function Summary({ d, issues, onGo, show }: { d: Draft; issues: ReturnType<typeof validate>; onGo: (k: string) => void; show: boolean }) {
  const ads = d.adsets.reduce((n, s) => n + s.ads.length, 0);
  return (
    <div className="ed-card-side" data-testid="ed-summary">
      <b>Resumo</b>
      <div className="ed-kv"><span>Objetivo</span><b>{objectiveLabel(d.campaign.objective)}</b></div>
      <div className="ed-kv"><span>Estrutura</span><b>{d.adsets.length} conjunto(s) · {ads} anúncio(s)</b></div>
      <div className="ed-kv"><span>Orçamento</span><b>{d.campaign.cbo ? `${(d.campaign.budget ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: d.currency })} ${d.campaign.budgetKind === 'daily' ? 'por dia' : 'no total'} (campanha)` : 'Em cada conjunto'}</b></div>
      {show && issues.length > 0 && (
        <div className="ed-sum-issues" data-testid="ed-issues">
          <small>Antes de publicar:</small>
          {issues.map((i, k) => <button key={k} onClick={() => onGo(i.key)}><Icon name="alert" size={12} />{i.msg}</button>)}
        </div>
      )}
      {!issues.length && <small className="ok"><Icon name="checkCircle" size={13} />Tudo pronto para publicar.</small>}
      <small className="faint">{OBJECTIVES.find((x) => x.id === d.campaign.objective)?.desc}</small>
    </div>
  );
}

/** Tamanho estimado do público (pergunta à Meta quando o público muda). */
function Estimate({ d, s }: { d: Draft; s: AdsetDraft }) {
  const [est, setEst] = useState<{ lower: number | null; upper: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const targeting = useMemo(() => buildTargeting(s.audience, s.placements), [s.audience, s.placements]);
  const goal = goalOf(d.campaign.objective, s.destination, s.goal).id;
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(() => {
      api.post<{ lower: number | null; upper: number | null }>('/meta/editor/estimate', { actId: d.actId, targeting, goal })
        .then((r) => { if (my === seq.current) { setEst(r); setErr(null); } })
        .catch((e) => { if (my === seq.current) setErr(errMsg(e)); });
    }, 700);
    return () => clearTimeout(t);
  }, [JSON.stringify(targeting), goal]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (v: number | null) => (v == null ? '—' : v.toLocaleString('pt-BR'));
  return (
    <div className="ed-card-side" data-testid="ed-estimate">
      <b>Tamanho estimado do público</b>
      {err ? <small className="faint">{err}</small> : !est ? <Spinner /> : <div className="ed-est" data-testid="ed-estimate-value">{n(est.lower)} – {n(est.upper)}</div>}
      <small className="faint">As estimativas não incluem as opções do público Advantage+ nem os posicionamentos do WhatsApp e podem variar bastante com o tempo.</small>
    </div>
  );
}

/** Janela "Criar" igual à da Meta: nova campanha (tipo de compra + objetivo) ou novo conjunto/anúncio numa campanha que já existe. */
type Ent = { id: string; name: string; actId: string; campaignId: string | null };
export function CreateDialog({ accounts, onClose, onStart }: { accounts: EditorAccount[]; onClose: () => void; onStart: (s: EditorStart) => void }) {
  const [campaigns, setCampaigns] = useState<Ent[] | null>(null);
  const [adsets, setAdsets] = useState<Ent[] | null>(null);
  const usable = accounts.filter((a) => a.canManage !== false);
  const [tab, setTab] = useState<'new' | 'add'>('new');
  const [actId, setActId] = useState(usable[0]?.actId ?? '');
  const [obj, setObj] = useState<Objective | null>(null);
  const [hover, setHover] = useState<Objective | null>(null);
  const [what, setWhat] = useState<'adset' | 'ad'>('adset');
  const [target, setTarget] = useState('');
  const saved = actId ? savedDraft(actId) : null;
  useEffect(() => {
    if (tab !== 'add' || campaigns) return;
    const get = (l: string) => api.get<{ rows: Ent[] }>(`/meta/manager?level=${l}&period=30d`).then((r) => r.rows.filter((x) => (x as unknown as { configured: string | null }).configured !== null)).catch(() => []);
    void get('campaign').then(setCampaigns); void get('adset').then(setAdsets);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = OBJECTIVES.find((x) => x.id === (hover ?? obj));
  const camps = (campaigns ?? []).filter((c) => c.actId === actId);
  const sets = (adsets ?? []).filter((c) => c.actId === actId);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal fade ed-create" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" data-testid="ed-create">
        <div className="ed-create-tabs">
          <button className={cx(tab === 'new' && 'on')} onClick={() => setTab('new')} data-testid="ed-create-new">Criar nova campanha</button>
          <button className={cx(tab === 'add' && 'on')} onClick={() => setTab('add')} data-testid="ed-create-add">Novo conjunto de anúncios ou anúncio</button>
          <span className="grow" />
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
        </div>
        <div className="mb">
          {usable.length > 1 && (
            <label className="ed-row"><span>Conta de anúncios</span>
              <select className="input" value={actId} onChange={(e) => setActId(e.target.value)} data-testid="ed-create-account">{usable.map((a) => <option key={a.actId} value={a.actId}>{a.name}</option>)}</select>
            </label>
          )}
          {tab === 'new' ? (
            <>
              <label className="ed-row"><span>Escolha um tipo de compra</span><select className="input" value="AUCTION" disabled><option value="AUCTION">Leilão</option></select></label>
              <b className="ed-create-h">Escolha um objetivo da campanha</b>
              <div className="ed-create-grid">
                <div className="ed-objs">
                  {OBJECTIVES.map((x) => (
                    <button key={x.id} className={cx('ed-obj', obj === x.id && 'on')} onClick={() => setObj(x.id)} onMouseEnter={() => setHover(x.id)} onMouseLeave={() => setHover(null)} data-testid={`ed-obj-${x.id}`}>
                      <i /><span className="ed-obj-ic"><Icon name={x.icon} size={17} /></span>{x.label}
                    </button>
                  ))}
                </div>
                <div className="ed-obj-info">{info ? <><b>{info.label}</b><p>{info.desc}</p></> : <p className="faint">O objetivo da campanha é a meta de negócios que você espera atingir com os anúncios. Passe o mouse sobre cada um para ver mais.</p>}</div>
              </div>
              {saved && <button className="btn ghost sm" onClick={() => onStart({ mode: 'new', actId, objective: saved.draft.campaign.objective, resume: true })} data-testid="ed-resume"><Icon name="history" size={13} />Continuar o rascunho “{saved.draft.campaign.name}” ({new Date(saved.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })})</button>}
            </>
          ) : (
            <>
              <div className="ed-radios">
                <button className={cx('ed-radio', what === 'adset' && 'on')} onClick={() => { setWhat('adset'); setTarget(''); }}><i /><span><b>Novo conjunto de anúncios</b><small>Numa campanha que já existe</small></span></button>
                <button className={cx('ed-radio', what === 'ad' && 'on')} onClick={() => { setWhat('ad'); setTarget(''); }}><i /><span><b>Novo anúncio</b><small>Num conjunto que já existe</small></span></button>
              </div>
              <label className="ed-row"><span>{what === 'adset' ? 'Campanha' : 'Conjunto de anúncios'}</span>
                <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="ed-create-target">
                  <option value="">{campaigns === null ? 'Carregando…' : 'Escolha…'}</option>
                  {(what === 'adset' ? camps : sets).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </label>
            </>
          )}
        </div>
        <div className="mf">
          <button className="btn" onClick={onClose}>Cancelar</button>
          {tab === 'new'
            ? <button className="btn primary" disabled={!obj || !actId} onClick={() => { if (obj && saved) clearDraft(actId); if (obj) onStart({ mode: 'new', actId, objective: obj }); }} data-testid="ed-create-go">Continuar</button>
            : <button className="btn primary" disabled={!target} onClick={() => {
              const camp = what === 'adset' ? target : sets.find((x) => x.id === target)?.campaignId;
              if (camp) onStart({ mode: 'edit', actId, campaignId: camp, focus: what === 'ad' ? target : null, add: what });
            }} data-testid="ed-create-go">Continuar</button>}
        </div>
      </div>
    </div>
  );
}
