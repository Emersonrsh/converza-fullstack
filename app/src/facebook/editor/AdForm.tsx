import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Spinner, cx } from '../../components/ui';
import { Icon } from '../../icons';
import { CTAS, creativeFields, ctaLabel, locationOf, multiText, multiTextAllowed, newKey, type AdDraft, type AdsetDraft, type Card, type Draft, type Media } from './model';
import { MediaPicker, Radio, Row, Section, Toggle, errMsg, useLookup } from './parts';
import { MediaCustomize, PixelSelect, PostPicker, UtmBuilder } from './media';

type PageOpt = { id: string; name: string; picture: string | null };
const CREATIVE_KEYS: (keyof AdDraft)[] = ['pageId', 'igId', 'format', 'media', 'cards', 'texts', 'headlines', 'description', 'cta', 'link', 'displayLink', 'urlTags', 'greeting', 'prefill', 'leadFormId', 'phone',
  'source', 'postId', 'igMediaId', 'extraMedia', 'storyMedia', 'multiAdvertiser'];

export function AdForm({ d, s, a, set, setSet, connections, issues }: {
  d: Draft; s: AdsetDraft; a: AdDraft; set: (p: Partial<AdDraft>) => void; setSet: (p: Partial<AdsetDraft>) => void; connections: { phone: string; name: string }[]; issues: string[];
}) {
  const [custom, setCustom] = useState<null | { kind: 'main' } | { kind: 'extra'; i: number } | { kind: 'card'; i: number }>(null);
  const [utm, setUtm] = useState(false);
  const apps = useLookup<{ id: string; name: string }>(d.actId, 'apps', null, a.trackApp);
  const o = d.campaign.objective;
  const loc = locationOf(o, s.destination);
  const pageId = a.pageId || s.pageId;
  const pages = useLookup<PageOpt>(d.actId, 'pages');
  const ig = useLookup<{ id: string; username: string | null }>(d.actId, 'instagram', pageId, !!pageId);
  const forms = useLookup<{ id: string; name: string }>(d.actId, 'lead-forms', pageId, !!pageId && s.destination === 'ON_AD' && o === 'OUTCOME_LEADS');
  // mexer em mídia/textos cria um criativo novo na publicação (a Meta não deixa editar um criativo)
  const setC = (p: Partial<AdDraft>) => set({ ...p, ...(CREATIVE_KEYS.some((k) => k in p) ? { dirty: true } : {}) });
  const wa = s.destination === 'WHATSAPP' || s.destination.includes('WHATSAPP');
  const site = ['WEBSITE', 'APP', '', 'ON_POST', 'ON_VIDEO', 'ON_PAGE'].includes(s.destination);
  const lead = s.destination === 'ON_AD' && o === 'OUTCOME_LEADS';
  const many = multiTextAllowed(s);
  const list = (field: 'texts' | 'headlines', label: string, placeholder: string, area: boolean) => (
    <Row label={label} hint={many ? 'Até 5 opções: a Meta mostra a combinação que tiver melhor resultado para cada pessoa.' : undefined}>
      {a[field].map((t, i) => (
        <div key={i} className="ed-multi">
          {area
            ? <textarea className="input" rows={3} value={t} placeholder={placeholder} onChange={(e) => setC({ [field]: a[field].map((x, j) => (j === i ? e.target.value : x)) })} data-testid={`ed-${field}-${i}`} />
            : <input className="input" value={t} placeholder={placeholder} onChange={(e) => setC({ [field]: a[field].map((x, j) => (j === i ? e.target.value : x)) })} data-testid={`ed-${field}-${i}`} />}
          {i > 0 && <button type="button" className="btn icon sm ghost" onClick={() => setC({ [field]: a[field].filter((_, j) => j !== i) })} aria-label="Tirar"><Icon name="close" size={13} /></button>}
        </div>
      ))}
      {many && a.format === 'single' && a[field].length < 5 && <button type="button" className="btn sm ghost" onClick={() => setC({ [field]: [...a[field], ''] })} data-testid={`ed-${field}-add`}><Icon name="plus" size={13} />Adicionar opção</button>}
    </Row>
  );
  const setCard = (i: number, p: Partial<Card>) => setC({ cards: a.cards.map((c, j) => (j === i ? { ...c, ...p } : c)) });

  return (
    <>
      <Section title="Nome do anúncio" ok={!!a.name.trim()}>
        <input className="input" value={a.name} onChange={(e) => set({ name: e.target.value })} data-testid="ed-ad-name" />
      </Section>

      {a.foreign && !a.dirty && (
        <div className="ed-note" data-testid="ed-foreign"><Icon name="info" size={15} />Este anúncio usa um criativo montado na Meta de um jeito que o editor não abre (ex.: catálogo ou várias mídias). Você pode mudar nome e status; para trocar a mídia e os textos, preencha abaixo e um criativo novo será criado.</div>
      )}
      {!a.dirty && a.creativeId && !a.foreign && <div className="ed-note"><Icon name="info" size={15} />Usando o criativo publicado. Se mudar mídia ou textos, a Meta recebe um criativo novo e o anúncio volta para análise.</div>}

      <Section title="Identidade" ok={!!pageId} testId="ed-a-identity">
        <div className="ed-grid2">
          <Row label="Página do Facebook">
            <select className="input" value={pageId} onChange={(e) => setC({ pageId: e.target.value, igId: '' })} data-testid="ed-ad-page">
              <option value="">{pages.list === null ? 'Carregando…' : 'Escolha a Página'}</option>
              {(pages.list ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Row>
          <Row label="Conta do Instagram">
            <select className="input" value={a.igId} onChange={(e) => setC({ igId: e.target.value })} data-testid="ed-ig">
              <option value="">{!pageId ? 'Escolha a Página primeiro' : ig.list === null ? 'Carregando…' : ig.list.length ? 'Usar a Página do Facebook' : 'Nenhuma conta do Instagram ligada à Página'}</option>
              {(ig.list ?? []).map((x) => <option key={x.id} value={x.id}>@{x.username ?? x.id}</option>)}
            </select>
          </Row>
        </div>
        {wa && (
          <Row label="Número de telefone do WhatsApp" hint="Em branco: o número ligado à Página. Vale para todos os anúncios deste conjunto.">
            <input className="input" list="ed-ad-wa" value={s.whatsapp} onChange={(e) => setSet({ whatsapp: e.target.value })} placeholder="55 11 99999-9999" data-testid="ed-ad-whatsapp" />
            <datalist id="ed-ad-wa">{connections.map((x) => <option key={x.phone} value={x.phone}>{x.name}</option>)}</datalist>
          </Row>
        )}
      </Section>

      <Section title="Configuração do anúncio" testId="ed-a-format">
        <select className="input" value={a.source} onChange={(e) => setC({ source: e.target.value as AdDraft['source'] })} data-testid="ed-source">
          <option value="create">Criar anúncio</option><option value="existing">Usar publicação existente</option>
        </select>
        {a.source === 'existing' ? (
          <>
            <PostPicker actId={d.actId} pageId={pageId} igId={a.igId} postId={a.postId} igMediaId={a.igMediaId}
              onPick={(p) => setC({ postId: p.postId, igMediaId: p.igMediaId, postPicture: p.picture, postText: p.text })} />
            <small className="faint">A publicação vira anúncio com os textos, a mídia, as curtidas e os comentários que já tem.</small>
          </>
        ) : (
          <>
            <Row label="Formato">
              <Radio value={a.format} onChange={(v) => setC({ format: v, ...(v === 'carousel' && a.cards.length < 2 ? { cards: [newCard(a), newCard()] } : {}) })} testId="ed-format" options={[
                { id: 'single', label: 'Imagem ou vídeo único', desc: 'Uma imagem ou um vídeo (até 10 mídias com destino Site/App: a Meta combina).' },
                { id: 'carousel', label: 'Carrossel', desc: 'Duas ou mais imagens ou vídeos que rolam para o lado, cada um com título e link.' },
              ]} />
            </Row>
            <label className="ed-check-row"><input type="checkbox" checked={a.multiAdvertiser} onChange={(e) => setC({ multiAdvertiser: e.target.checked })} data-testid="ed-multi-adv" />
              <span><b>Anúncios com vários anunciantes</b><small className="faint">Seu anúncio pode aparecer junto com outros na mesma unidade, para ajudar as pessoas a descobrirem. O criativo pode ser redimensionado ou cortado.</small></span>
            </label>
          </>
        )}
      </Section>

      {a.source === 'create' && <Section title={a.format === 'carousel' ? 'Cartões do carrossel' : 'Mídia'} ok={a.format === 'single' ? !!a.media : a.cards.length >= 2 && a.cards.every((c) => c.media)} testId="ed-a-media">
        {a.format === 'single' ? (
          <>
            <MediaPicker actId={d.actId} value={a.media} onChange={(m) => setC({ media: m })} testId="ed-media" onCustomize={() => setCustom({ kind: 'main' })} />
            {a.storyMedia && <div className="ed-note" data-testid="ed-story-note"><Icon name="info" size={15} />Stories, Status e Reels usam outra mídia ({a.storyMedia.name ?? a.storyMedia.kind}).<button type="button" className="linkbtn" onClick={() => setC({ storyMedia: null })}>tirar</button></div>}
            {many && a.media && (
              <div className="ed-extra" data-testid="ed-extra">
                {a.extraMedia.map((m, i) => (
                  <MediaPicker key={i} actId={d.actId} value={m} testId={`ed-extra-${i}`} onCustomize={() => setCustom({ kind: 'extra', i })}
                    onChange={(x) => setC({ extraMedia: x ? a.extraMedia.map((y, j) => (j === i ? x : y)) : a.extraMedia.filter((_, j) => j !== i) })} />
                ))}
                {a.extraMedia.length < 9 && <AddMedia actId={d.actId} onAdd={(m) => setC({ extraMedia: [...a.extraMedia, m] })} />}
                <small className="faint">{1 + a.extraMedia.length} de 10 mídias. Com várias, a Meta mostra a combinação de mídia e texto com melhor resultado para cada pessoa.</small>
              </div>
            )}
          </>
        ) : (
          <div className="ed-cards">
            {a.cards.map((c, i) => (
              <div key={c.key} className="ed-card" data-testid={`ed-card-${i}`}>
                <div className="ed-card-h"><b>Cartão {i + 1}</b>{a.cards.length > 2 && <button type="button" className="btn icon sm ghost" onClick={() => setC({ cards: a.cards.filter((_, j) => j !== i) })} aria-label="Tirar"><Icon name="trash" size={13} /></button>}</div>
                <MediaPicker actId={d.actId} value={c.media} onChange={(m) => setCard(i, { media: m })} testId={`ed-card-media-${i}`} onCustomize={c.media?.kind === 'image' ? () => setCustom({ kind: 'card', i }) : undefined} />
                <input className="input" placeholder="Título" value={c.headline} onChange={(e) => setCard(i, { headline: e.target.value })} data-testid={`ed-card-title-${i}`} />
                <input className="input" placeholder="Descrição (opcional)" value={c.description} onChange={(e) => setCard(i, { description: e.target.value })} />
                {site && <input className="input" placeholder="Link deste cartão (em branco: o link do anúncio)" value={c.link} onChange={(e) => setCard(i, { link: e.target.value })} />}
              </div>
            ))}
            {a.cards.length < 10 && <button type="button" className="btn sm" onClick={() => setC({ cards: [...a.cards, newCard()] })} data-testid="ed-card-add"><Icon name="plus" size={13} />Adicionar cartão</button>}
          </div>
        )}
      </Section>}

      <Section title={a.source === 'existing' ? 'Destino' : 'Textos e destino'} ok={a.source === 'existing' || !!a.texts[0]?.trim()} testId="ed-a-texts">
        {a.source === 'create' && list('texts', 'Texto principal', 'Conte o que você oferece', true)}
        {a.source === 'create' && a.format === 'single' && list('headlines', 'Título', 'Escreva um título curto', false)}
        {a.source === 'create' && a.format === 'single' && <Row label="Descrição (opcional)"><input className="input" value={a.description} onChange={(e) => setC({ description: e.target.value })} data-testid="ed-description" /></Row>}
        {multiText(a) && !many && <small className="err">Várias opções de texto só com destino Site ou App.</small>}

        {loc.messaging && <div className="ed-kv"><span>Botão</span><b>{wa ? 'Enviar mensagem pelo WhatsApp' : s.destination === 'INSTAGRAM_DIRECT' ? 'Enviar mensagem pelo Instagram' : 'Enviar mensagem'}</b></div>}
        {(site || lead) && (
          <Row label="Chamada para ação (botão)">
            <select className="input" value={a.cta} onChange={(e) => setC({ cta: e.target.value })} data-testid="ed-cta">
              {CTAS.filter(([id]) => !lead || ['SIGN_UP', 'LEARN_MORE', 'APPLY_NOW', 'GET_QUOTE', 'SUBSCRIBE', 'DOWNLOAD', 'BOOK_TRAVEL', 'GET_OFFER', 'CONTACT_US'].includes(id)).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          </Row>
        )}
        {site && (
          <div className="ed-grid2">
            <Row label={s.destination === 'APP' ? 'Link do app (deep link ou loja)' : 'URL do site'}><input className="input" value={a.link} onChange={(e) => setC({ link: e.target.value })} placeholder="https://" data-testid="ed-link" /></Row>
            <Row label="Link de exibição (opcional)"><input className="input" value={a.displayLink} onChange={(e) => setC({ displayLink: e.target.value })} placeholder="seusite.com.br" /></Row>
          </div>
        )}
        {lead && (
          <Row label="Formulário instantâneo" hint="Os formulários são criados na Página (Central de Contas → Formulários instantâneos).">
            <select className="input" value={a.leadFormId} onChange={(e) => setC({ leadFormId: e.target.value })} data-testid="ed-lead-form">
              <option value="">{!pageId ? 'Escolha a Página primeiro' : forms.list === null ? 'Carregando…' : forms.list.length ? 'Escolha o formulário' : 'Nenhum formulário nesta Página'}</option>
              {(forms.list ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {forms.error && <small className="err">{forms.error}</small>}
          </Row>
        )}
        {s.destination === 'PHONE_CALL' && <Row label="Telefone para ligações"><input className="input" value={a.phone} onChange={(e) => setC({ phone: e.target.value })} placeholder="55 11 99999-9999" data-testid="ed-phone" /></Row>}
        {wa && (
          <div className="ed-grid2">
            <Row label="Saudação no WhatsApp" hint="A primeira mensagem que o cliente vê ao abrir a conversa."><textarea className="input" rows={3} value={a.greeting} onChange={(e) => setC({ greeting: e.target.value })} data-testid="ed-greeting" /></Row>
            <Row label="Mensagem que o cliente envia" hint="Já vem escrita; o cliente só toca em enviar."><textarea className="input" rows={3} value={a.prefill} onChange={(e) => setC({ prefill: e.target.value })} data-testid="ed-prefill" /></Row>
          </div>
        )}
      </Section>

      <Section title="Rastreamento" testId="ed-a-tracking">
        <small className="faint">Escolha os eventos de conversão a serem rastreados. O conjunto de dados do conjunto de anúncios é rastreado por padrão.</small>
        <label className="ed-check-row"><input type="checkbox" checked={a.trackSite} onChange={(e) => set({ trackSite: e.target.checked })} data-testid="ed-track-site" /><span><b>Eventos do site</b></span></label>
        {a.trackSite && <PixelSelect actId={d.actId} value={a.trackPixelId || s.pixelId} onChange={(id) => set({ trackPixelId: id })} testId="ed-track-pixel" />}
        <label className="ed-check-row"><input type="checkbox" checked={a.trackApp} onChange={(e) => set({ trackApp: e.target.checked })} data-testid="ed-track-app" /><span><b>Eventos do app</b></span></label>
        {a.trackApp && (
          <select className="input" value={a.trackAppId || s.appId} onChange={(e) => set({ trackAppId: e.target.value })} data-testid="ed-track-app-id">
            <option value="">{apps.list === null ? 'Carregando…' : apps.list.length ? 'Escolha o app' : 'Nenhum app registrado na conta'}</option>
            {(apps.list ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
        <Row label="Parâmetros de URL (opcional)" hint="Ex.: utm_source=facebook&utm_campaign={{campaign.name}}">
          <input className="input" value={a.urlTags} onChange={(e) => setC({ urlTags: e.target.value })} placeholder="key1=value1&key2=value2" data-testid="ed-url-tags" />
          <button type="button" className="linkbtn" onClick={() => setUtm(true)} data-testid="ed-utm">Criar um parâmetro de URL</button>
        </Row>
      </Section>
      {utm && <UtmBuilder value={a.urlTags} onChange={(v) => setC({ urlTags: v })} onClose={() => setUtm(false)} />}
      {custom && (() => {
        const target: Media | null = custom.kind === 'main' ? a.media : custom.kind === 'extra' ? a.extraMedia[custom.i] : a.cards[custom.i]?.media ?? null;
        if (!target) return null;
        return (
          <MediaCustomize actId={d.actId} media={target} story={custom.kind === 'main' ? a.storyMedia : null} allowStory={custom.kind === 'main' && many}
            onClose={() => setCustom(null)}
            onSave={(m, st) => {
              if (custom.kind === 'main') setC({ media: m, storyMedia: st });
              else if (custom.kind === 'extra') setC({ extraMedia: a.extraMedia.map((y, j) => (j === custom.i ? m : y)) });
              else setCard(custom.i, { media: m });
            }} />
        );
      })()}

      <Section title="Status">
        <Toggle on={a.status === 'ACTIVE'} onChange={(v) => set({ status: v ? 'ACTIVE' : 'PAUSED' })} label={a.status === 'ACTIVE' ? 'Anúncio ligado' : 'Anúncio pausado'} testId="ed-a-on" />
      </Section>
      {issues.length > 0 && <div className="ed-issues">{issues.map((m, i) => <span key={i}>{m}</span>)}</div>}
    </>
  );
}

/** "+": envia ou escolhe mais uma mídia. */
function AddMedia({ actId, onAdd }: { actId: string; onAdd: (m: Media) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn sm ghost" onClick={() => setOpen(true)} data-testid="ed-extra-add"><Icon name="plus" size={13} />Adicionar mídia</button>;
  return <MediaPicker actId={actId} value={null} onChange={(m) => { if (m) { onAdd(m); setOpen(false); } }} testId="ed-extra-new" />;
}

function newCard(a?: AdDraft): Card {
  return { key: newKey('c'), media: a?.media ?? null, headline: a?.headlines[0] ?? '', description: '', link: '' };
}

/** Prévia: feed com o formato escolhido e, para WhatsApp, a conversa que abre. */
const PV: [string, string][] = [['MOBILE_FEED_STANDARD', 'Feed do Facebook'], ['INSTAGRAM_STANDARD', 'Feed do Instagram'], ['INSTAGRAM_STORY', 'Stories do Instagram'],
  ['INSTAGRAM_REELS', 'Reels do Instagram'], ['FACEBOOK_STORY_MOBILE', 'Stories do Facebook'], ['FACEBOOK_REELS_MOBILE', 'Reels do Facebook'], ['MARKETPLACE_MOBILE', 'Marketplace'], ['DESKTOP_FEED_STANDARD', 'Feed (computador)']];

/** Prévia gerada pela Meta (o mesmo desenho do Gerenciador), por posicionamento. */
function MetaPreview({ d, s, a }: { d: Draft; s: AdsetDraft; a: AdDraft }) {
  const [fmt, setFmt] = useState('MOBILE_FEED_STANDARD');
  const [res, setRes] = useState<{ src: string | null; error: string | null } | null>(null);
  const creative = useMemo(() => { try { return creativeFields(d.campaign.objective, s, a); } catch { return null; } }, [d.campaign.objective, s, a]);
  const key = JSON.stringify(creative) + fmt;
  useEffect(() => {
    if (!creative) return;
    setRes(null);
    const t = setTimeout(() => {
      api.post<{ previews: { html: string | null; error: string | null }[] }>('/meta/editor/preview', { actId: d.actId, creative, formats: [fmt] }).then((r) => {
        const p = r.previews[0];
        // a Meta devolve um <iframe src="https://www.facebook.com/ads/api/preview_iframe.php?...">: usamos só o endereço
        const src = p?.html?.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&') ?? null;
        setRes({ src: src && /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//.test(src) ? src : null, error: p?.error ?? (src ? null : 'A Meta não devolveu a prévia.') });
      }).catch((e) => setRes({ src: null, error: errMsg(e) }));
    }, 800);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mp" data-testid="ed-meta-preview">
      <select className="input" value={fmt} onChange={(e) => setFmt(e.target.value)} data-testid="ed-meta-preview-format">{PV.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
      {!res ? <Spinner /> : res.src ? <iframe src={res.src} title="Prévia da Meta" className="mp-frame" scrolling="no" data-testid="ed-meta-preview-frame" /> : <small className="faint">{res.error}</small>}
    </div>
  );
}

export function AdPreview({ d, s, a }: { d: Draft; s: AdsetDraft; a: AdDraft }) {
  const [real, setReal] = useState(false);
  const pages = useLookup<PageOpt>(d.actId, 'pages');
  const page = pages.list?.find((p) => p.id === (a.pageId || s.pageId)) ?? null;
  const loc = locationOf(d.campaign.objective, s.destination);
  const wa = s.destination === 'WHATSAPP' || s.destination.includes('WHATSAPP');
  const btn = loc.messaging ? (wa ? 'Enviar mensagem' : 'Enviar mensagem') : ctaLabel(a.cta);
  const media = a.format === 'carousel' ? null : a.media;
  return (
    <div className="cw-preview" data-testid="ed-preview">
      <div className="mp-head"><Toggle on={real} onChange={setReal} label="Prévia da Meta (por posicionamento)" testId="ed-real-preview" /></div>
      {real ? <MetaPreview d={d} s={s} a={a} /> : <>
      <small className="cw-preview-t">Prévia do anúncio</small>
      <div className="cw-ad">
        <div className="cw-ad-h">
          {page?.picture ? <img src={page.picture} alt="" /> : <span className="cw-ad-av"><Icon name="meta" size={14} /></span>}
          <div><b>{page?.name || 'Sua Página'}</b><small>Patrocinado</small></div>
        </div>
        <p className="cw-ad-text">{a.source === 'existing' ? (a.postText || 'Texto da publicação') : (a.texts[0] || 'Texto principal do anúncio')}</p>
        {a.source === 'existing' ? (
          <div className="cw-ad-img">{a.postPicture ? <img src={a.postPicture} alt="" /> : <span><Icon name="image" size={26} />Escolha a publicação</span>}</div>
        ) : a.format === 'carousel' ? (
          <div className="ed-pv-car">
            {a.cards.map((c) => (
              <div key={c.key}>
                <div className="ed-pv-car-img">{c.media?.url ? <img src={c.media.url} alt="" /> : <Icon name="image" size={20} />}</div>
                <b>{c.headline || 'Título'}</b>
                {a.cta !== 'NO_BUTTON' && <span className="cw-ad-btn sm">{btn}</span>}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="cw-ad-img">{media?.url ? <img src={media.url} alt="" /> : <span><Icon name={media?.kind === 'video' ? 'video' : 'image'} size={26} />{media ? 'Processando…' : 'Imagem ou vídeo'}</span>}{media?.kind === 'video' && <span className="ed-pv-play"><Icon name="play" size={20} /></span>}</div>
            <div className="cw-ad-foot">
              <div><small>{wa ? 'WHATSAPP' : (a.displayLink || a.link.replace(/^https?:\/\//, '').split('/')[0] || '').toUpperCase()}</small><b>{a.headlines[0] || 'Título do anúncio'}</b>{a.description && <small>{a.description}</small>}</div>
              {(loc.messaging || a.cta !== 'NO_BUTTON') && <span className={cx('cw-ad-btn')}>{wa && <Icon name="whatsapp" size={14} />}{btn}</span>}
            </div>
          </>
        )}
      </div>
      {wa && (
        <>
          <small className="cw-preview-t">Ao tocar, abre o WhatsApp assim</small>
          <div className="cw-chat">
            <div className="cw-bubble in">{a.greeting || 'Saudação da sua empresa'}</div>
            <div className="cw-typed"><span>{a.prefill || 'Mensagem que o cliente envia'}</span><Icon name="send" size={14} /></div>
          </div>
        </>
      )}
      </>}
    </div>
  );
}
