import { cx } from '../../components/ui';
import { Icon } from '../../icons';
import { CTAS, ctaLabel, locationOf, multiText, multiTextAllowed, newKey, type AdDraft, type AdsetDraft, type Card, type Draft } from './model';
import { MediaPicker, Radio, Row, Section, Toggle, useLookup } from './parts';

type PageOpt = { id: string; name: string; picture: string | null };
const CREATIVE_KEYS: (keyof AdDraft)[] = ['pageId', 'igId', 'format', 'media', 'cards', 'texts', 'headlines', 'description', 'cta', 'link', 'displayLink', 'urlTags', 'greeting', 'prefill', 'leadFormId', 'phone'];

export function AdForm({ d, s, a, set, issues }: { d: Draft; s: AdsetDraft; a: AdDraft; set: (p: Partial<AdDraft>) => void; issues: string[] }) {
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
      </Section>

      <Section title="Configuração do anúncio" testId="ed-a-format">
        <Radio value={a.format} onChange={(v) => setC({ format: v, ...(v === 'carousel' && a.cards.length < 2 ? { cards: [newCard(a), newCard()] } : {}) })} testId="ed-format" options={[
          { id: 'single', label: 'Imagem ou vídeo único', desc: 'Uma imagem ou um vídeo.' },
          { id: 'carousel', label: 'Carrossel', desc: 'Duas ou mais imagens ou vídeos que rolam para o lado, cada um com título e link.' },
        ]} />
      </Section>

      <Section title={a.format === 'carousel' ? 'Cartões do carrossel' : 'Mídia'} ok={a.format === 'single' ? !!a.media : a.cards.length >= 2 && a.cards.every((c) => c.media)} testId="ed-a-media">
        {a.format === 'single' ? (
          <MediaPicker actId={d.actId} value={a.media} onChange={(m) => setC({ media: m })} testId="ed-media" />
        ) : (
          <div className="ed-cards">
            {a.cards.map((c, i) => (
              <div key={c.key} className="ed-card" data-testid={`ed-card-${i}`}>
                <div className="ed-card-h"><b>Cartão {i + 1}</b>{a.cards.length > 2 && <button type="button" className="btn icon sm ghost" onClick={() => setC({ cards: a.cards.filter((_, j) => j !== i) })} aria-label="Tirar"><Icon name="trash" size={13} /></button>}</div>
                <MediaPicker actId={d.actId} value={c.media} onChange={(m) => setCard(i, { media: m })} testId={`ed-card-media-${i}`} />
                <input className="input" placeholder="Título" value={c.headline} onChange={(e) => setCard(i, { headline: e.target.value })} data-testid={`ed-card-title-${i}`} />
                <input className="input" placeholder="Descrição (opcional)" value={c.description} onChange={(e) => setCard(i, { description: e.target.value })} />
                {site && <input className="input" placeholder="Link deste cartão (em branco: o link do anúncio)" value={c.link} onChange={(e) => setCard(i, { link: e.target.value })} />}
              </div>
            ))}
            {a.cards.length < 10 && <button type="button" className="btn sm" onClick={() => setC({ cards: [...a.cards, newCard()] })} data-testid="ed-card-add"><Icon name="plus" size={13} />Adicionar cartão</button>}
          </div>
        )}
      </Section>

      <Section title="Textos e destino" ok={!!a.texts[0]?.trim()} testId="ed-a-texts">
        {list('texts', 'Texto principal', 'Conte o que você oferece', true)}
        {a.format === 'single' && list('headlines', 'Título', 'Escreva um título curto', false)}
        {a.format === 'single' && <Row label="Descrição (opcional)"><input className="input" value={a.description} onChange={(e) => setC({ description: e.target.value })} data-testid="ed-description" /></Row>}
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

      <Section title="Rastreamento" defaultOpen={false} testId="ed-a-tracking">
        {s.pixelId ? <small className="faint">Eventos do site: conjunto de dados {s.pixelId} (do conjunto de anúncios).</small> : <small className="faint">Sem conjunto de dados neste conjunto de anúncios.</small>}
        <Row label="Parâmetros de URL (opcional)" hint="Ex.: utm_source=facebook&utm_campaign={{campaign.name}}"><input className="input" value={a.urlTags} onChange={(e) => setC({ urlTags: e.target.value })} data-testid="ed-url-tags" /></Row>
      </Section>

      <Section title="Status">
        <Toggle on={a.status === 'ACTIVE'} onChange={(v) => set({ status: v ? 'ACTIVE' : 'PAUSED' })} label={a.status === 'ACTIVE' ? 'Anúncio ligado' : 'Anúncio pausado'} testId="ed-a-on" />
      </Section>
      {issues.length > 0 && <div className="ed-issues">{issues.map((m, i) => <span key={i}>{m}</span>)}</div>}
    </>
  );
}

function newCard(a?: AdDraft): Card {
  return { key: newKey('c'), media: a?.media ?? null, headline: a?.headlines[0] ?? '', description: '', link: '' };
}

/** Prévia: feed com o formato escolhido e, para WhatsApp, a conversa que abre. */
export function AdPreview({ d, s, a }: { d: Draft; s: AdsetDraft; a: AdDraft }) {
  const pages = useLookup<PageOpt>(d.actId, 'pages');
  const page = pages.list?.find((p) => p.id === (a.pageId || s.pageId)) ?? null;
  const loc = locationOf(d.campaign.objective, s.destination);
  const wa = s.destination === 'WHATSAPP' || s.destination.includes('WHATSAPP');
  const btn = loc.messaging ? (wa ? 'Enviar mensagem' : 'Enviar mensagem') : ctaLabel(a.cta);
  const media = a.format === 'carousel' ? null : a.media;
  return (
    <div className="cw-preview" data-testid="ed-preview">
      <small className="cw-preview-t">Prévia do anúncio</small>
      <div className="cw-ad">
        <div className="cw-ad-h">
          {page?.picture ? <img src={page.picture} alt="" /> : <span className="cw-ad-av"><Icon name="meta" size={14} /></span>}
          <div><b>{page?.name || 'Sua Página'}</b><small>Patrocinado</small></div>
        </div>
        <p className="cw-ad-text">{a.texts[0] || 'Texto principal do anúncio'}</p>
        {a.format === 'carousel' ? (
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
    </div>
  );
}
