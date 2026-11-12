import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Modal, Spinner, cx, toast } from '../components/ui';
import { money } from './types';

/**
 * Criar campanha de "clique para o WhatsApp" por dentro do Converza (Facebook → Gerenciador).
 * Etapas: campanha → público e orçamento → anúncio → revisar e publicar. Sai pausada por padrão.
 */

export interface WizardAccount { actId: string; name: string; currency: string; canManage: boolean }
type Loc = { key: string; name: string; type: 'country' | 'region' | 'city'; countryCode?: string | null };
type Interest = { id: string; name: string; size?: number | null; path?: string | null };
type PageOpt = { id: string; name: string; picture: string | null };
type Img = { name: string; data: string; preview: string; w: number; h: number };

const STEPS = ['Campanha', 'Público e orçamento', 'Anúncio', 'Revisar e publicar'] as const;
const BR: Loc = { key: 'BR', name: 'Brasil', type: 'country', countryCode: 'BR' };
const TYPE_LABEL: Record<Loc['type'], string> = { country: 'País', region: 'Estado', city: 'Cidade' };

const parseMoney = (v: string) => {
  const s = v.replace(/[^\d,.-]/g, '');
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : NaN;
};
const today = () => new Date().toLocaleDateString('pt-BR');
const isoOf = (local: string) => (local ? new Date(local).toISOString() : null);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');

/** Lê a imagem e reduz no navegador (lado maior até 1440 px, JPEG): a Meta aceita e o envio fica leve. */
function readImage(file: File): Promise<Img> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpe?g|png)$/i.test(file.type)) { reject(new Error('Use uma imagem JPG ou PNG.')); return; }
    if (file.size > 30 * 1024 * 1024) { reject(new Error('Imagem muito grande (máximo 30 MB).')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1440;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * k); const h = Math.round(img.naturalHeight * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('Não deu para ler a imagem.')); return; }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const out = c.toDataURL('image/jpeg', 0.9);
      URL.revokeObjectURL(url);
      resolve({ name: `${file.name.replace(/\.[^.]+$/, '') || 'anuncio'}.jpg`, data: out.split(',')[1], preview: out, w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não deu para abrir essa imagem.')); };
    img.src = url;
  });
}

/** Campo de busca com lista (locais e interesses vêm da Meta). */
function SearchPick<T extends { name: string }>({ placeholder, search, onPick, render, testId }: {
  placeholder: string; search: (q: string) => Promise<T[]>; onPick: (x: T) => void; render: (x: T) => JSX.Element; testId: string;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<T[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setList(null); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      search(term).then((r) => { if (my === seq.current) setList(r); }).catch(() => { if (my === seq.current) setList([]); })
        .finally(() => { if (my === seq.current) setBusy(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cw-search">
      <div className="cw-search-in"><Icon name="search" size={14} /><input className="input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} data-testid={testId} />{busy && <Spinner />}</div>
      {list && (
        <div className="cw-search-list" data-testid={`${testId}-list`}>
          {!list.length && <div className="faint">Nada encontrado com “{q.trim()}”.</div>}
          {list.map((x, i) => (
            <button type="button" key={i} onClick={() => { onPick(x); setQ(''); setList(null); }} data-testid={`${testId}-opt`}>{render(x)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Prévia do anúncio no feed (Facebook/Instagram), com o botão do WhatsApp e a conversa que abre. */
function AdPreview({ page, text, headline, description, image, greeting, prefill }: {
  page: PageOpt | null; text: string; headline: string; description: string; image: Img | null; greeting: string; prefill: string;
}) {
  return (
    <div className="cw-preview" data-testid="cw-preview">
      <small className="cw-preview-t">Prévia do anúncio</small>
      <div className="cw-ad">
        <div className="cw-ad-h">
          {page?.picture ? <img src={page.picture} alt="" /> : <span className="cw-ad-av"><Icon name="meta" size={14} /></span>}
          <div><b>{page?.name || 'Sua Página'}</b><small>Patrocinado</small></div>
        </div>
        <p className="cw-ad-text">{text || 'Texto principal do anúncio'}</p>
        <div className="cw-ad-img">{image ? <img src={image.preview} alt="" /> : <span><Icon name="image" size={26} />Imagem do anúncio</span>}</div>
        <div className="cw-ad-foot">
          <div><small>WHATSAPP</small><b>{headline || 'Título do anúncio'}</b>{description && <small>{description}</small>}</div>
          <span className="cw-ad-btn"><Icon name="whatsapp" size={14} />Enviar mensagem</span>
        </div>
      </div>
      <small className="cw-preview-t">Ao tocar, abre o WhatsApp assim</small>
      <div className="cw-chat">
        <div className="cw-bubble in">{greeting || 'Saudação da sua empresa'}</div>
        <div className="cw-typed"><span>{prefill || 'Mensagem que o cliente envia'}</span><Icon name="send" size={14} /></div>
      </div>
    </div>
  );
}

export function CampaignWizard({ accounts, defaultActId, onClose, onCreated }: {
  accounts: WizardAccount[]; defaultActId?: string; onClose: () => void; onCreated: () => void;
}) {
  const usable = accounts.filter((a) => a.canManage);
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    actId: (usable.find((a) => a.actId === defaultActId) ?? usable[0])?.actId ?? '',
    name: `WhatsApp — ${today()}`, status: 'PAUSED' as 'PAUSED' | 'ACTIVE',
    budgetKind: 'daily' as 'daily' | 'lifetime', budget: '30', start: '', end: '',
    mode: 'advantage' as 'advantage' | 'manual', locations: [BR] as Loc[], ageMin: 18, ageMax: 65, genders: [] as number[], interests: [] as Interest[],
    pageId: '', whatsapp: '', primaryText: '', headline: '', description: '',
    greeting: 'Olá! Que bom ter você por aqui. Como posso te ajudar?', prefill: 'Olá! Vi o anúncio e quero saber mais.', flowId: '',
  });
  const [image, setImage] = useState<Img | null>(null);
  const [pages, setPages] = useState<PageOpt[] | null>(null);
  const [pagesErr, setPagesErr] = useState<string | null>(null);
  const [flows, setFlows] = useState<{ id: string; name: string }[]>([]);
  const [phones, setPhones] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ url: string; status: string } | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const acc = accounts.find((a) => a.actId === f.actId);
  const cur = acc?.currency ?? 'BRL';
  const page = pages?.find((p) => p.id === f.pageId) ?? null;

  useEffect(() => {
    api.get<{ flows: { id: string; name: string; status: string; archivedAt: string | null }[] }>('/flows')
      .then((r) => setFlows(r.flows.filter((x) => x.status === 'active' && !x.archivedAt).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
    api.get<{ connections: { displayPhone: string | null }[] }>('/connections')
      .then((r) => setPhones([...new Set(r.connections.map((c) => (c.displayPhone ?? '').replace(/\D/g, '')).filter((x) => x.length >= 10))])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!f.actId) return;
    setPages(null); setPagesErr(null);
    api.get<{ pages: PageOpt[] }>(`/meta/ad-accounts/${f.actId}/pages`).then((r) => {
      setPages(r.pages);
      setF((x) => ({ ...x, pageId: r.pages.some((p) => p.id === x.pageId) ? x.pageId : r.pages[0]?.id ?? '' }));
    }).catch((e) => { setPages([]); setPagesErr(errMsg(e)); });
  }, [f.actId]);

  const amount = parseMoney(f.budget);
  const problems = useMemo(() => {
    const p: string[][] = [[], [], [], []];
    if (!f.actId) p[0].push('Escolha a conta de anúncios');
    if (!f.name.trim()) p[0].push('Dê um nome à campanha');
    if (!(amount > 0)) p[1].push('Informe o orçamento');
    if (f.budgetKind === 'lifetime' && !f.end) p[1].push('Orçamento total precisa de data de término');
    if (f.end && new Date(f.end).getTime() <= Math.max(Date.now(), f.start ? new Date(f.start).getTime() : 0) + 3600_000) p[1].push('O término precisa ser pelo menos 1 hora depois do início');
    if (!f.locations.length) p[1].push('Escolha pelo menos um local');
    if (f.mode === 'manual' && f.ageMin > f.ageMax) p[1].push('A idade mínima é maior que a máxima');
    if (!f.pageId) p[2].push('Escolha a Página do Facebook');
    if (!image) p[2].push('Escolha a imagem do anúncio');
    if (!f.primaryText.trim()) p[2].push('Escreva o texto principal');
    if (!f.headline.trim()) p[2].push('Escreva o título');
    if (!f.greeting.trim()) p[2].push('Escreva a saudação');
    if (!f.prefill.trim()) p[2].push('Escreva a mensagem que o cliente envia');
    return p;
  }, [f, amount, image]);
  const canGo = (s: number) => problems.slice(0, s + 1).every((x) => !x.length);

  async function publish() {
    if (!image) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ url: string; status: string }>('/meta/campaigns', {
        actId: f.actId, name: f.name.trim(), status: f.status,
        budget: { kind: f.budgetKind, amount },
        startTime: isoOf(f.start), endTime: isoOf(f.end),
        audience: { mode: f.mode, locations: f.locations, ageMin: f.ageMin, ageMax: f.ageMax, genders: f.genders, interests: f.interests.map((i) => ({ id: i.id, name: i.name })) },
        pageId: f.pageId, whatsappNumber: f.whatsapp.trim() || null,
        image: { name: image.name, data: image.data },
        ad: { primaryText: f.primaryText.trim(), headline: f.headline.trim(), description: f.description.trim() || null, greeting: f.greeting.trim(), prefill: f.prefill.trim() },
        flowId: f.flowId || null,
      });
      setDone(r);
      onCreated();
    } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  }

  // a Meta não aceita locais sobrepostos: estado/cidade tira o país dele; país tira os estados/cidades dele
  const addLoc = (l: Loc) => setF((x) => {
    if (x.locations.some((y) => y.key === l.key && y.type === l.type)) return x;
    const keep = x.locations.filter((y) => (l.type === 'country' ? !(y.type !== 'country' && y.countryCode === l.key) : !(y.type === 'country' && y.key === l.countryCode)));
    return { ...x, locations: [...keep, l] };
  });
  const addInterest = (i: Interest) => setF((x) => ({ ...x, interests: x.interests.some((y) => y.id === i.id) ? x.interests : [...x.interests, i] }));

  if (done) {
    return (
      <Modal title="Campanha criada" icon="check" onClose={onClose} width={560}
        footer={<><a className="btn" href={done.url} target="_blank" rel="noreferrer" data-testid="cw-open-meta"><Icon name="external" size={14} />Abrir no Gerenciador da Meta</a><button type="button" className="btn primary" onClick={onClose}>Fechar</button></>}>
        <div className="cw-done" data-testid="cw-done">
          <span className="cw-done-ic"><Icon name="check" size={26} /></span>
          <b>“{f.name}” está na sua conta de anúncios.</b>
          <p>{done.status === 'PAUSED'
            ? 'Ela foi criada pausada: confira e ative pelo botão na tabela do Gerenciador (ou no Gerenciador da Meta).'
            : 'Ela foi criada ativa. A Meta analisa o anúncio antes de começar a entregar (costuma levar alguns minutos, às vezes até 24 horas).'}</p>
          {f.flowId && <p>Os leads que chegarem por esse anúncio entram direto no fluxo <b>{flows.find((x) => x.id === f.flowId)?.name}</b>.</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Criar campanha" subtitle="Mensagens no WhatsApp" icon="meta" width={1040} onClose={onClose}
      footer={
        <div className="cw-ft">
          {problems[step].length > 0 && <small className="cw-need" data-testid="cw-need">{problems[step][0]}</small>}
          <span className="spacer" />
          {step > 0 && <button type="button" className="btn ghost" onClick={() => setStep(step - 1)} disabled={busy}>Voltar</button>}
          {step < 3
            ? <button type="button" className="btn primary" disabled={!canGo(step)} onClick={() => setStep(step + 1)} data-testid="cw-next">Avançar<Icon name="chevronRight" size={14} /></button>
            : <button type="button" className="btn primary" disabled={!canGo(3) || busy} onClick={() => void publish()} data-testid="cw-publish">
                <Icon name="send" size={14} />{busy ? 'Publicando na Meta…' : f.status === 'PAUSED' ? 'Criar campanha pausada' : 'Publicar campanha ativa'}
              </button>}
        </div>
      }>
      <div className="cw-steps" data-testid="cw-steps">
        {STEPS.map((s, i) => (
          <button type="button" key={s} className={cx(i === step && 'on', i < step && 'done')} disabled={i > step && !canGo(i - 1)} onClick={() => setStep(i)}>
            <span>{i < step ? <Icon name="check" size={12} /> : i + 1}</span>{s}
          </button>
        ))}
      </div>
      <div className="cw-body">
        <div className="cw-form" data-testid={`cw-step-${step}`}>
          {step === 0 && <>
            <div><label className="label">Conta de anúncios</label>
              <select className="select" value={f.actId} onChange={(e) => set('actId', e.target.value)} data-testid="cw-account">
                {usable.map((a) => <option key={a.actId} value={a.actId}>{a.name} · {a.currency}</option>)}
              </select>
              {usable.length < accounts.length && <small className="fbm-help">Contas de perfis que só autorizaram ler os anúncios não aparecem. Reconecte o perfil e aceite a permissão de gerenciar anúncios.</small>}
            </div>
            <div><label className="label">Nome da campanha</label><input className="input" maxLength={200} value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="cw-name" /></div>
            <div>
              <label className="label">Objetivo</label>
              <div className="cw-goal on"><Icon name="whatsapp" size={20} /><div><b>Mensagens no WhatsApp</b><small>Quem vê o anúncio toca em “Enviar mensagem” e abre uma conversa com o seu WhatsApp. A Meta mostra para quem tem mais chance de conversar.</small></div><Icon name="check" size={16} /></div>
            </div>
            <div>
              <label className="label">Ao publicar</label>
              <div className="cw-radio">
                <button type="button" className={cx(f.status === 'PAUSED' && 'on')} onClick={() => set('status', 'PAUSED')} data-testid="cw-status-paused"><b>Criar pausada</b><small>Recomendado: você confere e ativa depois</small></button>
                <button type="button" className={cx(f.status === 'ACTIVE' && 'on')} onClick={() => set('status', 'ACTIVE')} data-testid="cw-status-active"><b>Publicar ativa</b><small>Começa a gastar assim que a Meta aprovar o anúncio</small></button>
              </div>
            </div>
          </>}

          {step === 1 && <>
            <div className="cw-row">
              <div><label className="label">Orçamento</label>
                <div className="seg cw-seg">
                  <button type="button" className={cx(f.budgetKind === 'daily' && 'active')} onClick={() => set('budgetKind', 'daily')} data-testid="cw-budget-daily">Por dia</button>
                  <button type="button" className={cx(f.budgetKind === 'lifetime' && 'active')} onClick={() => set('budgetKind', 'lifetime')} data-testid="cw-budget-lifetime">Total</button>
                </div>
              </div>
              <div><label className="label">Valor ({cur})</label><input className="input" inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value)} data-testid="cw-budget" />
                {amount > 0 && <small className="fbm-help">{money(amount, cur)}{f.budgetKind === 'daily' ? ' por dia (a Meta pode gastar um pouco mais num dia e menos em outro)' : ' no total, até a data de término'}</small>}
              </div>
            </div>
            <div className="cw-row">
              <div><label className="label">Início</label><input className="input" type="datetime-local" value={f.start} onChange={(e) => set('start', e.target.value)} data-testid="cw-start" /><small className="fbm-help">Em branco: assim que publicar (e a Meta aprovar).</small></div>
              <div><label className="label">Término {f.budgetKind === 'daily' && <span className="faint">(opcional)</span>}</label><input className="input" type="datetime-local" value={f.end} onChange={(e) => set('end', e.target.value)} data-testid="cw-end" /></div>
            </div>
            <div>
              <label className="label">Onde mostrar</label>
              <div className="cw-chips" data-testid="cw-locations">
                {f.locations.map((l) => (
                  <span key={`${l.type}-${l.key}`} className="cw-chip"><small>{TYPE_LABEL[l.type]}</small>{l.name}
                    <button type="button" onClick={() => set('locations', f.locations.filter((y) => !(y.key === l.key && y.type === l.type)))} aria-label="Tirar"><Icon name="close" size={12} /></button></span>
                ))}
              </div>
              <SearchPick<Loc> placeholder="Buscar país, estado ou cidade" testId="cw-geo" onPick={addLoc}
                search={(q) => api.get<{ results: Loc[] }>(`/meta/targeting/geo?actId=${f.actId}&q=${encodeURIComponent(q)}`).then((r) => r.results)}
                render={(l) => <><b>{l.name}</b><small>{TYPE_LABEL[l.type]}</small></>} />
              <small className="fbm-help">Escolher um estado ou cidade tira o país dele da lista (a Meta não aceita locais que se sobrepõem).</small>
            </div>
            <div>
              <label className="label">Público</label>
              <div className="cw-radio">
                <button type="button" className={cx(f.mode === 'advantage' && 'on')} onClick={() => set('mode', 'advantage')} data-testid="cw-aud-advantage"><b>Advantage+ (recomendado)</b><small>A Meta encontra quem tem mais chance de conversar, dentro dos locais escolhidos</small></button>
                <button type="button" className={cx(f.mode === 'manual' && 'on')} onClick={() => set('mode', 'manual')} data-testid="cw-aud-manual"><b>Definir o público</b><small>Idade, gênero e interesses fixos</small></button>
              </div>
            </div>
            {f.mode === 'manual' && <>
              <div className="cw-row">
                <div><label className="label">Idade</label>
                  <div className="cw-ages">
                    <input className="input" type="number" min={18} max={65} value={f.ageMin} onChange={(e) => set('ageMin', Math.max(18, Math.min(65, Number(e.target.value) || 18)))} data-testid="cw-age-min" />
                    <span>a</span>
                    <input className="input" type="number" min={18} max={65} value={f.ageMax} onChange={(e) => set('ageMax', Math.max(18, Math.min(65, Number(e.target.value) || 65)))} data-testid="cw-age-max" />
                    <small className="faint">65 = 65 ou mais</small>
                  </div>
                </div>
                <div><label className="label">Gênero</label>
                  <div className="seg cw-seg">
                    {([[[], 'Todos'], [[2], 'Mulheres'], [[1], 'Homens']] as [number[], string][]).map(([g, l]) => (
                      <button type="button" key={l} className={cx(JSON.stringify(f.genders) === JSON.stringify(g) && 'active')} onClick={() => set('genders', g)} data-testid={`cw-gender-${l}`}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="label">Interesses <span className="faint">(opcional)</span></label>
                <div className="cw-chips">
                  {f.interests.map((i) => (
                    <span key={i.id} className="cw-chip">{i.name}<button type="button" onClick={() => set('interests', f.interests.filter((y) => y.id !== i.id))} aria-label="Tirar"><Icon name="close" size={12} /></button></span>
                  ))}
                </div>
                <SearchPick<Interest> placeholder="Buscar interesse (ex.: catolicismo, odontologia)" testId="cw-interest" onPick={addInterest}
                  search={(q) => api.get<{ results: Interest[] }>(`/meta/targeting/interests?actId=${f.actId}&q=${encodeURIComponent(q)}`).then((r) => r.results)}
                  render={(i) => <><b>{i.name}</b><small>{i.path ?? ''}{i.size ? ` · até ${i.size.toLocaleString('pt-BR')} pessoas` : ''}</small></>} />
              </div>
            </>}
          </>}

          {step === 2 && <>
            <div className="cw-row">
              <div><label className="label">Página do Facebook</label>
                {pages === null ? <Spinner /> : pages.length ? (
                  <select className="select" value={f.pageId} onChange={(e) => set('pageId', e.target.value)} data-testid="cw-page">
                    {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : <div className="hint warn"><Icon name="alert" size={14} /><span>{pagesErr ?? 'Nenhuma Página pode anunciar nesta conta. A Página precisa estar no seu perfil (ou na empresa da conta) e ter o WhatsApp conectado.'}</span></div>}
                <small className="fbm-help">Precisa ser a Página que tem o seu WhatsApp conectado.</small>
              </div>
              <div><label className="label">Número do WhatsApp <span className="faint">(opcional)</span></label>
                <input className="input" list="cw-phones" inputMode="tel" placeholder="Ex.: 5511999990000" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} data-testid="cw-whatsapp" />
                <datalist id="cw-phones">{phones.map((p) => <option key={p} value={p} />)}</datalist>
                <small className="fbm-help">Em branco: usa o número ligado à Página. Preencha se a Página tiver mais de um.</small>
              </div>
            </div>
            <div>
              <label className="label">Imagem</label>
              <label className={cx('cw-drop', !!image && 'has')} data-testid="cw-image-drop">
                <input type="file" accept="image/jpeg,image/png" onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) readImage(file).then(setImage).catch((x) => toast(errMsg(x)));
                }} data-testid="cw-image" />
                {image ? <><img src={image.preview} alt="" /><span><b>{image.name}</b><small>{image.w}×{image.h} px · clique para trocar</small></span></>
                  : <span><Icon name="image" size={22} /><b>Escolher imagem</b><small>JPG ou PNG · quadrada (1080×1080) ou vertical (1080×1350) funciona melhor</small></span>}
              </label>
            </div>
            <div><label className="label">Texto principal</label><textarea className="input" rows={3} maxLength={2000} placeholder="O que aparece em cima da imagem" value={f.primaryText} onChange={(e) => set('primaryText', e.target.value)} data-testid="cw-text" /></div>
            <div className="cw-row">
              <div><label className="label">Título</label><input className="input" maxLength={255} placeholder="Ex.: Novena de Nossa Senhora" value={f.headline} onChange={(e) => set('headline', e.target.value)} data-testid="cw-headline" /></div>
              <div><label className="label">Descrição <span className="faint">(opcional)</span></label><input className="input" maxLength={255} value={f.description} onChange={(e) => set('description', e.target.value)} data-testid="cw-description" /></div>
            </div>
            <div className="cw-row">
              <div><label className="label">Saudação no WhatsApp</label><textarea className="input" rows={2} maxLength={300} value={f.greeting} onChange={(e) => set('greeting', e.target.value)} data-testid="cw-greeting" /><small className="fbm-help">A primeira mensagem que o cliente vê ao abrir a conversa.</small></div>
              <div><label className="label">Mensagem que o cliente envia</label><textarea className="input" rows={2} maxLength={300} value={f.prefill} onChange={(e) => set('prefill', e.target.value)} data-testid="cw-prefill" /><small className="fbm-help">Já vem escrita no campo de mensagem; o cliente só toca em enviar.</small></div>
            </div>
            <div><label className="label">Fluxo dos leads deste anúncio <span className="faint">(opcional)</span></label>
              <select className="select" value={f.flowId} onChange={(e) => set('flowId', e.target.value)} data-testid="cw-flow">
                <option value="">Nenhum (seguem as regras normais dos fluxos)</option>
                {flows.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <small className="fbm-help">Quem chegar por esse anúncio começa direto nesse fluxo, sem depender do gatilho dele.</small>
            </div>
          </>}

          {step === 3 && <>
            <div className="cw-review" data-testid="cw-review">
              <div><small>Conta</small><b>{acc?.name}</b></div>
              <div><small>Campanha</small><b>{f.name}</b></div>
              <div><small>Objetivo</small><b>Mensagens no WhatsApp</b></div>
              <div><small>Orçamento</small><b>{money(amount || 0, cur)} {f.budgetKind === 'daily' ? 'por dia' : 'no total'}</b></div>
              <div><small>Período</small><b>{f.start ? new Date(f.start).toLocaleString('pt-BR') : 'Ao publicar'} → {f.end ? new Date(f.end).toLocaleString('pt-BR') : 'sem data de término'}</b></div>
              <div><small>Locais</small><b>{f.locations.map((l) => l.name).join(' · ')}</b></div>
              <div><small>Público</small><b>{f.mode === 'advantage' ? 'Advantage+ (a Meta encontra o público)' : `${f.ageMin} a ${f.ageMax}${f.ageMax === 65 ? '+' : ''} anos · ${f.genders.length ? (f.genders[0] === 2 ? 'mulheres' : 'homens') : 'todos os gêneros'}${f.interests.length ? ` · ${f.interests.map((i) => i.name).join(', ')}` : ''}`}</b></div>
              <div><small>Página</small><b>{page?.name ?? '—'}{f.whatsapp.trim() ? ` · WhatsApp ${f.whatsapp.trim()}` : ''}</b></div>
              <div><small>Fluxo dos leads</small><b>{f.flowId ? flows.find((x) => x.id === f.flowId)?.name : 'Nenhum'}</b></div>
              <div><small>Ao publicar</small><b className={cx(f.status === 'ACTIVE' && 'warn')}>{f.status === 'PAUSED' ? 'Fica pausada (não gasta até você ativar)' : 'Ativa: começa a gastar quando a Meta aprovar'}</b></div>
            </div>
            <div className="hint"><Icon name="info" size={14} /><span>A Meta analisa todo anúncio novo antes de entregar. Se ela recusar alguma parte, nada fica criado na sua conta e aparece aqui o motivo.</span></div>
            {err && <div className="hint warn" data-testid="cw-error"><Icon name="alert" size={14} /><span><b>Não deu para publicar.</b> {err}</span></div>}
          </>}
        </div>
        <AdPreview page={page} text={f.primaryText} headline={f.headline} description={f.description} image={image} greeting={f.greeting} prefill={f.prefill} />
      </div>
    </Modal>
  );
}
