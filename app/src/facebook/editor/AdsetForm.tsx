import { cx } from '../../components/ui';
import { Icon } from '../../icons';
import {
  ATTRIBUTION, BID_STRATEGIES, LOCATIONS, PIXEL_EVENTS, PLACEMENTS, audienceFrom, goalOf, locationOf, needsOf,
  type AdsetDraft, type AudienceDraft, type Draft, type Geo, type Pick, type PlacementsDraft,
} from './model';
import { Chips, MoneyInput, Radio, Row, SearchPick, Section, Toggle, lookupSearch, useLookup } from './parts';
import { PixelSelect } from './media';

type PageOpt = { id: string; name: string; picture: string | null };
const GEO_TYPE: Record<string, string> = { country: 'País', region: 'Estado', city: 'Cidade', zip: 'CEP', geo_market: 'Região', neighborhood: 'Bairro' };
const DETAIL_TYPE: Record<string, string> = { interests: 'Interesse', behaviors: 'Comportamento', education_statuses: 'Formação', work_positions: 'Cargo', work_employers: 'Empregador', life_events: 'Acontecimento', family_statuses: 'Família', income: 'Renda', industries: 'Setor', relationship_statuses: 'Relacionamento', user_adclusters: 'Interesse' };

export function AdsetForm({ d, s, set, connections, issues }: {
  d: Draft; s: AdsetDraft; set: (p: Partial<AdsetDraft>) => void; connections: { phone: string; name: string }[]; issues: string[];
}) {
  const o = d.campaign.objective; const c = d.campaign;
  const loc = locationOf(o, s.destination);
  const goal = goalOf(o, s.destination, s.goal);
  const needs = needsOf(o, s.destination, goal.id);
  const pages = useLookup<PageOpt>(d.actId, 'pages');
  const conversions = useLookup<{ id: string; name: string; event: string; pixelId: string | null }>(d.actId, 'custom-conversions', null, needs.includes('pixel'));
  const apps = useLookup<{ id: string; name: string; stores: Record<string, string> }>(d.actId, 'apps', null, needs.includes('app'));
  const strategy = c.cbo ? c.bidStrategy : s.bidStrategy;
  const strat = BID_STRATEGIES.find((b) => b.id === strategy);
  const kind = c.cbo ? c.budgetKind : s.budgetKind;
  const published = !!s.id;
  const a = s.audience;
  const setA = (p: Partial<AudienceDraft>) => set({ audience: { ...a, ...p }, });
  const setP = (p: Partial<PlacementsDraft>) => set({ placements: { ...s.placements, ...p } });
  const app = apps.list?.find((x) => x.id === s.appId);

  return (
    <>
      <Section title="Nome do conjunto de anúncios" ok={!!s.name.trim()}>
        <input className="input" value={s.name} onChange={(e) => set({ name: e.target.value })} data-testid="ed-adset-name" />
      </Section>

      {o === 'OUTCOME_SALES' && (
        <Section title="Estratégia de ciclo de vida do cliente" testId="ed-s-lifecycle" ok={!!s.lifecycle || !!c.specialCategories.length}>
          <small className="faint">Priorize as conversões de pessoas que geram mais valor para sua empresa.</small>
          {c.specialCategories.length ? (
            <small className="faint">Indisponível em campanhas com categoria especial de anúncio.</small>
          ) : (
            <>
              <Radio value={s.lifecycle === 'new_engaged' ? 'new' : s.lifecycle} onChange={(v) => set({ lifecycle: v })} testId="ed-lifecycle" options={[
                { id: 'all', label: 'Obter conversões de todos os públicos', desc: 'Escolha essa opção se quiser conversões com um custo por resultado menor. Você pode incluir ou excluir públicos personalizados nas configurações do público desse conjunto de anúncios.' },
                { id: 'new', label: 'Conquiste novos clientes', desc: 'Escolha essa opção se as conversões de pessoas que nunca fizeram uma compra geram mais valor para sua empresa. Seu custo por resultado pode aumentar.' },
              ]} />
              {(s.lifecycle === 'new' || s.lifecycle === 'new_engaged') && (
                <Row label="Quem não deve ver os anúncios" hint="Clientes existentes: quem já comprou de você, pelo pixel, pela API de Conversões e pelas suas listas de clientes.">
                  <Radio value={s.lifecycle} onChange={(v) => set({ lifecycle: v })} testId="ed-lifecycle-who" options={[
                    { id: 'new', label: 'Excluir clientes existentes' },
                    { id: 'new_engaged', label: 'Excluir clientes existentes e pessoas engajadas', desc: 'Também deixa de fora quem já interagiu com sua empresa sem comprar.' },
                  ]} />
                </Row>
              )}
            </>
          )}
        </Section>
      )}

      <Section title="Conversão" testId="ed-s-conversion" ok={!issues.some((m) => /Página|pixel|app/i.test(m))}>
        {LOCATIONS[o].length > 1 && (
          <Row label="Local da conversão" hint={published ? 'Na Meta o local da conversão não muda depois de publicado.' : undefined}>
            <select className="input" value={s.destination} disabled={published} onChange={(e) => set({ destination: e.target.value, goal: '' })} data-testid="ed-destination">
              {LOCATIONS[o].map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </Row>
        )}
        <Row label="Meta de desempenho">
          <select className="input" value={goal.id} onChange={(e) => set({ goal: e.target.value })} data-testid="ed-goal">
            {loc.goals.map((g) => <option key={g.id + g.label} value={g.id}>{g.label}</option>)}
          </select>
        </Row>
        {needs.includes('page') && (
          <Row label="Página do Facebook" hint={loc.messaging ? 'Precisa ser a Página com o WhatsApp/Messenger/Instagram conectado.' : undefined}>
            <select className="input" value={s.pageId} onChange={(e) => set({ pageId: e.target.value })} data-testid="ed-page">
              <option value="">{pages.list === null ? 'Carregando…' : 'Escolha a Página'}</option>
              {(pages.list ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {pages.error && <small className="err">{pages.error}</small>}
          </Row>
        )}
        {needs.includes('whatsapp') && (
          <Row label="Número do WhatsApp (opcional)" hint="Em branco: usa o número ligado à Página. Preencha se a Página tiver mais de um.">
            <input className="input" list="ed-wa-numbers" value={s.whatsapp} onChange={(e) => set({ whatsapp: e.target.value })} placeholder="55 11 99999-9999" data-testid="ed-whatsapp" />
            <datalist id="ed-wa-numbers">{connections.map((x) => <option key={x.phone} value={x.phone}>{x.name}</option>)}</datalist>
          </Row>
        )}
        {needs.includes('pixel') && (
          <div className="ed-grid2">
            <Row label="Conjunto de dados (pixel)" hint="Monitora as ações que as pessoas realizam no seu site.">
              <PixelSelect actId={d.actId} value={s.pixelId} onChange={(id) => set({ pixelId: id, customConversionId: '' })} testId="ed-pixel" />
            </Row>
            <Row label="Evento de conversão" hint="A ação que você quer que as pessoas realizem.">
              <select className="input" value={s.customConversionId ? `cc:${s.customConversionId}` : s.event} onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('cc:')) set({ customConversionId: v.slice(3) }); else set({ event: v, customConversionId: '' });
              }} data-testid="ed-event">
                <optgroup label="Eventos padrão">{PIXEL_EVENTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</optgroup>
                {(conversions.list ?? []).filter((c) => !c.pixelId || c.pixelId === s.pixelId).length > 0 && (
                  <optgroup label="Conversões personalizadas">
                    {(conversions.list ?? []).filter((c) => !c.pixelId || c.pixelId === s.pixelId).map((c) => <option key={c.id} value={`cc:${c.id}`}>{c.name}</option>)}
                  </optgroup>
                )}
              </select>
            </Row>
          </div>
        )}
        {needs.includes('app') && (
          <div className="ed-grid2">
            <Row label="App">
              <select className="input" value={s.appId} onChange={(e) => { const x = apps.list?.find((y) => y.id === e.target.value); set({ appId: e.target.value, storeUrl: x ? Object.values(x.stores)[0] ?? '' : '' }); }} data-testid="ed-app">
                <option value="">{apps.list === null ? 'Carregando…' : apps.list.length ? 'Escolha o app' : 'Nenhum app registrado na conta'}</option>
                {(apps.list ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Row>
            <Row label="Loja">
              <select className="input" value={s.storeUrl} onChange={(e) => set({ storeUrl: e.target.value })} data-testid="ed-store">
                <option value="">Escolha a loja</option>
                {Object.entries(app?.stores ?? {}).map(([k, u]) => <option key={k} value={u}>{k.replace(/_/g, ' ')}</option>)}
              </select>
            </Row>
          </div>
        )}
        {needs.includes('app') && (goal.id === 'OFFSITE_CONVERSIONS' || goal.id === 'VALUE') && (
          <Row label="Evento do app">
            <select className="input" value={s.appEvent} onChange={(e) => set({ appEvent: e.target.value })}>{PIXEL_EVENTS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
          </Row>
        )}
        {(goal.id === 'OFFSITE_CONVERSIONS' || goal.id === 'VALUE') && (
          <Row label="Modelo de atribuição">
            <select className="input" value={s.attribution} onChange={(e) => set({ attribution: e.target.value })} data-testid="ed-attribution">
              {ATTRIBUTION.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Row>
        )}
        {strat?.needs === 'bid' && (
          <Row label={strategy === 'COST_CAP' ? 'Meta de custo por resultado' : 'Limite de lance'}>
            <MoneyInput value={s.bidAmount} onChange={(v) => set({ bidAmount: v })} currency={d.currency} testId="ed-bid-amount" />
          </Row>
        )}
        {strat?.needs === 'roas' && (
          <Row label="Meta de ROAS (ex.: 2 = R$ 2 de venda para cada R$ 1)">
            <input className="input" inputMode="decimal" value={s.roas ?? ''} onChange={(e) => set({ roas: Number(e.target.value.replace(',', '.')) || null })} data-testid="ed-roas" />
          </Row>
        )}
      </Section>

      <Section title="Orçamento e programação" testId="ed-s-budget">
        {!c.cbo ? (
          <>
            <div className="ed-grid2">
              <select className="input" value={s.budgetKind} onChange={(e) => set({ budgetKind: e.target.value as 'daily' | 'lifetime' })} data-testid="ed-s-budget-kind">
                <option value="daily">Orçamento diário</option><option value="lifetime">Orçamento total</option>
              </select>
              <MoneyInput value={s.budget} onChange={(v) => set({ budget: v })} currency={d.currency} testId="ed-s-budget-amount" />
            </div>
            {s.budgetKind === 'daily' && Number(s.budget) > 0 && <small className="faint">Gastaremos cerca de {Number(s.budget).toLocaleString('pt-BR', { style: 'currency', currency: d.currency })} por dia; no máximo {(Number(s.budget) * 1.75).toLocaleString('pt-BR', { style: 'currency', currency: d.currency })} num dia e {(Number(s.budget) * 7).toLocaleString('pt-BR', { style: 'currency', currency: d.currency })} na semana.</small>}
            <Row label="Estratégia de lance">
              <select className="input" value={s.bidStrategy} onChange={(e) => set({ bidStrategy: e.target.value })} data-testid="ed-s-bid">
                {BID_STRATEGIES.filter((b) => !b.valueOnly || goal.id === 'VALUE').map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Row>
          </>
        ) : (
          <>
            <small className="faint">O orçamento da campanha ({kind === 'daily' ? 'diário' : 'total'}) é distribuído entre os conjuntos. Você pode limitar este conjunto:</small>
            <div className="ed-grid2">
              <Row label="Gasto mínimo (opcional)"><MoneyInput value={s.minSpend} onChange={(v) => set({ minSpend: v })} currency={d.currency} placeholder="Nenhum" testId="ed-min-spend" /></Row>
              <Row label="Gasto máximo (opcional)"><MoneyInput value={s.maxSpend} onChange={(v) => set({ maxSpend: v })} currency={d.currency} placeholder="Nenhum" testId="ed-max-spend" /></Row>
            </div>
          </>
        )}
        <div className="ed-grid2">
          <Row label="Data de início" hint="Em branco: começa assim que for aprovado."><input type="datetime-local" className="input" value={s.start} onChange={(e) => set({ start: e.target.value })} data-testid="ed-start" /></Row>
          <Row label={<span className="ed-inline"><input type="checkbox" checked={!!s.end || kind === 'lifetime'} onChange={(e) => set({ end: e.target.checked ? (s.end || defaultEnd()) : '' })} data-testid="ed-has-end" />Definir uma data de término</span>}>
            {(s.end || kind === 'lifetime') && <input type="datetime-local" className="input" value={s.end} onChange={(e) => set({ end: e.target.value })} data-testid="ed-end" />}
          </Row>
        </div>
        {goal.id === 'REACH' && (
          <Row label="Controle de frequência" hint="No máximo X impressões por pessoa a cada Y dias.">
            <div className="ed-grid2">
              <input className="input" type="number" min={1} max={90} value={s.frequency?.impressions ?? ''} placeholder="Impressões" onChange={(e) => set({ frequency: e.target.value ? { impressions: Number(e.target.value), days: s.frequency?.days ?? 7 } : null })} />
              <input className="input" type="number" min={1} max={90} value={s.frequency?.days ?? ''} placeholder="Dias" onChange={(e) => set({ frequency: { impressions: s.frequency?.impressions ?? 2, days: Number(e.target.value) || 7 } })} />
            </div>
          </Row>
        )}
      </Section>

      <Audience d={d} a={a} setA={setA} set={set} />

      <Section title="Posicionamentos" badge={s.placements.advantage ? 'Advantage+ ativado' : undefined} testId="ed-s-placements">
        <Radio value={s.placements.advantage ? 'adv' : 'manual'} onChange={(v) => setP({ advantage: v === 'adv' })} testId="ed-placements" options={[
          { id: 'adv', label: 'Posicionamentos Advantage+ (recomendado)', desc: 'A Meta mostra os anúncios onde as pessoas têm mais chance de responder.' },
          { id: 'manual', label: 'Posicionamentos manuais', desc: 'Você escolhe onde os anúncios aparecem.' },
        ]} />
        {!s.placements.advantage && (
          <div className="ed-places">
            <Row label="Dispositivos">
              <div className="ed-checks">
                {(['mobile', 'desktop'] as const).map((dv) => {
                  const on = s.placements.devices.includes(dv);
                  return <button type="button" key={dv} className={cx('ed-check', on && 'on')} onClick={() => setP({ devices: on ? s.placements.devices.filter((x) => x !== dv) : [...s.placements.devices, dv] })}><i />{dv === 'mobile' ? 'Celular' : 'Computador'}</button>;
                })}
              </div>
            </Row>
            {PLACEMENTS.map((pl) => {
              const on = s.placements.platforms.includes(pl.platform);
              const pos = s.placements.positions[pl.platform] ?? [];
              return (
                <div key={pl.platform} className="ed-place">
                  <button type="button" className={cx('ed-check', on && 'on')} onClick={() => setP({ platforms: on ? s.placements.platforms.filter((x) => x !== pl.platform) : [...s.placements.platforms, pl.platform] })} data-testid={`ed-platform-${pl.platform}`}><i /><b>{pl.label}</b></button>
                  {on && (
                    <div className="ed-checks sub">
                      {pl.positions.map(([id, label]) => {
                        const p = pos.includes(id);
                        return <button type="button" key={id} className={cx('ed-check', p && 'on')} onClick={() => setP({ positions: { ...s.placements.positions, [pl.platform]: p ? pos.filter((x) => x !== id) : [...pos, id] } })} data-testid={`ed-pos-${pl.platform}-${id}`}><i />{label}</button>;
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Transparência dos anúncios (opcional)" defaultOpen={false}>
        <small className="faint">Obrigatório só para anúncios que aparecem na União Europeia: quem é o anunciante e quem paga.</small>
        <div className="ed-grid2">
          <Row label="Anunciante"><input className="input" value={s.beneficiary} onChange={(e) => set({ beneficiary: e.target.value })} /></Row>
          <Row label="Pagador"><input className="input" value={s.payor} onChange={(e) => set({ payor: e.target.value })} placeholder="Igual ao anunciante" /></Row>
        </div>
      </Section>

      <Section title="Status">
        <Toggle on={s.status === 'ACTIVE'} onChange={(v) => set({ status: v ? 'ACTIVE' : 'PAUSED' })} label={s.status === 'ACTIVE' ? 'Conjunto ligado' : 'Conjunto pausado'} testId="ed-s-on" />
      </Section>
      {issues.length > 0 && <div className="ed-issues">{issues.map((m, i) => <span key={i}>{m}</span>)}</div>}
    </>
  );
}

function defaultEnd() {
  const dt = new Date(Date.now() + 7 * 86400_000); dt.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:00`;
}

function Audience({ d, a, setA, set }: { d: Draft; a: AudienceDraft; setA: (p: Partial<AudienceDraft>) => void; set: (p: Partial<AdsetDraft>) => void }) {
  const custom = useLookup<{ id: string; name: string; subtype: string | null; size: number | null }>(d.actId, 'custom-audiences');
  const saved = useLookup<{ id: string; name: string; targeting: Record<string, unknown> | null }>(d.actId, 'saved-audiences');
  const addLoc = (x: Geo, exclude: boolean) => {
    if (a.locations.some((l) => l.key === x.key && l.type === x.type)) return;
    // escolher um estado/cidade tira o país inteiro (senão a Meta reclama de sobreposição) e vice-versa
    let next = a.locations;
    if (!exclude && x.type !== 'country') next = next.filter((l) => !(l.type === 'country' && !l.exclude && l.key === x.countryCode));
    if (!exclude && x.type === 'country') next = next.filter((l) => l.exclude || l.type === 'country' || l.countryCode !== x.key);
    setA({ locations: [...next, { ...x, exclude }] });
  };
  const addPick = (x: Pick, g: number) => {
    const groups = a.detailed.map((list, i) => (i === g && !list.some((y) => y.id === x.id) ? [...list, x] : list));
    setA({ detailed: groups });
  };
  const customPick = (field: 'customInclude' | 'customExclude') => (
    <select className="input" value="" onChange={(e) => { const x = custom.list?.find((c) => c.id === e.target.value); if (x && !a[field].some((y) => y.id === x.id)) setA({ [field]: [...a[field], { id: x.id, name: x.name }] }); }} data-testid={`ed-${field}`}>
      <option value="">{custom.list === null ? 'Carregando…' : custom.list.length ? 'Escolha um público personalizado ou semelhante' : 'Nenhum público personalizado na conta'}</option>
      {(custom.list ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.size ? ` (${c.size.toLocaleString('pt-BR')})` : ''}</option>)}
    </select>
  );
  return (
    <Section title="Público" badge={a.advantage ? 'Advantage+ ativado' : undefined} testId="ed-s-audience">
      <Row label="Usar um público salvo">
        <select className="input" value={a.savedAudienceId ?? ''} onChange={(e) => {
          const x = saved.list?.find((y) => y.id === e.target.value);
          if (!x) { setA({ savedAudienceId: null }); return; }
          const { audience, placements } = audienceFrom(x.targeting as Record<string, unknown>);
          set({ audience: { ...audience, savedAudienceId: x.id }, placements });
        }} data-testid="ed-saved-audience">
          <option value="">{saved.list === null ? 'Carregando…' : saved.list.length ? 'Nenhum (montar aqui)' : 'Nenhum público salvo na conta'}</option>
          {(saved.list ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </Row>
      <Toggle on={a.advantage} onChange={(v) => setA({ advantage: v })} label="Público Advantage+ (a Meta pode ir além das sugestões quando for melhorar o resultado)" testId="ed-advantage" />

      <h4 className="ed-h">Controles <small className="faint">Não vamos alcançar pessoas fora destes limites, mesmo com o Advantage+.</small></h4>
      <Row label="Localizações">
        <SearchPick<Geo> placeholder="Incluir país, estado, cidade, CEP ou bairro" testId="ed-geo" search={lookupSearch<Geo>(d.actId, 'geo')} onPick={(x) => addLoc(x, false)}
          render={(x) => <><b>{x.name}</b><small>{GEO_TYPE[x.type] ?? x.type}</small></>} />
        <SearchPick<Geo> placeholder="Excluir um local" testId="ed-geo-exclude" search={lookupSearch<Geo>(d.actId, 'geo')} onPick={(x) => addLoc(x, true)}
          render={(x) => <><b>{x.name}</b><small>{GEO_TYPE[x.type] ?? x.type}</small></>} />
        <div className="cw-chips" data-testid="ed-geo-chips">
          {a.locations.map((l, i) => (
            <span key={`${l.type}${l.key}${i}`} className={cx('cw-chip', l.exclude && 'ex')}>
              {l.exclude ? 'Excluir: ' : ''}{l.name}<small>{GEO_TYPE[l.type] ?? l.type}</small>
              {l.type === 'city' && !l.exclude && (
                <select value={l.radius ?? 0} onChange={(e) => setA({ locations: a.locations.map((y, j) => (j === i ? { ...y, radius: Number(e.target.value) || null } : y)) })} title="Raio">
                  <option value={0}>só a cidade</option>{[10, 17, 25, 40, 50, 80].map((r) => <option key={r} value={r}>+{r} km</option>)}
                </select>
              )}
              <button type="button" onClick={() => setA({ locations: a.locations.filter((_, j) => j !== i) })} aria-label="Remover"><Icon name="close" size={11} /></button>
            </span>
          ))}
        </div>
        <select className="input" value={a.locationTypes.join(',')} onChange={(e) => setA({ locationTypes: e.target.value.split(',') as AudienceDraft['locationTypes'] })} data-testid="ed-location-types">
          <option value="home,recent">Pessoas que moram ou estiveram recentemente nesses locais</option>
          <option value="home">Pessoas que moram nesses locais</option>
          <option value="recent">Pessoas que estiveram recentemente nesses locais</option>
          <option value="travel_in">Pessoas viajando para esses locais</option>
        </select>
      </Row>
      <div className="ed-grid2">
        <Row label="Idade mínima" hint={a.advantage ? 'Com Advantage+, a idade mínima vai até 25.' : undefined}>
          <select className="input" value={a.ageMin} onChange={(e) => setA({ ageMin: Number(e.target.value) })} data-testid="ed-age-min">
            {Array.from({ length: (a.advantage ? 25 : 65) - 17 }, (_, i) => 18 + i).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Row label="Idiomas">
          <SearchPick<{ key: number; name: string }> placeholder="Todos os idiomas" testId="ed-locale" search={lookupSearch(d.actId, 'locales')}
            onPick={(x) => { if (!a.locales.some((y) => y.key === x.key)) setA({ locales: [...a.locales, x] }); }} render={(x) => <b>{x.name}</b>} />
          <Chips items={a.locales} label={(x) => x.name} onRemove={(i) => setA({ locales: a.locales.filter((_, j) => j !== i) })} />
        </Row>
      </div>
      <Row label="Excluir públicos personalizados">
        {customPick('customExclude')}
        <Chips items={a.customExclude} label={(x) => x.name} tone={() => 'ex'} onRemove={(i) => setA({ customExclude: a.customExclude.filter((_, j) => j !== i) })} />
      </Row>

      <h4 className="ed-h">{a.advantage ? 'Sugestões de público (opcional)' : 'Público'} {a.advantage && <small className="faint">A Meta começa por aqui, mas pode alcançar pessoas fora quando for melhorar o resultado.</small>}</h4>
      <div className="ed-grid2">
        <Row label="Idade">
          <div className="ed-grid2">
            <select className="input" value={a.ageMin} onChange={(e) => setA({ ageMin: Number(e.target.value) })} disabled={a.advantage}>{Array.from({ length: 48 }, (_, i) => 18 + i).map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <select className="input" value={a.ageMax} onChange={(e) => setA({ ageMax: Number(e.target.value) })} data-testid="ed-age-max" disabled={a.advantage}>{Array.from({ length: 48 }, (_, i) => 18 + i).map((n) => <option key={n} value={n}>{n === 65 ? '65+' : n}</option>)}</select>
          </div>
        </Row>
        <Row label="Gênero">
          <select className="input" value={a.genders} onChange={(e) => setA({ genders: Number(e.target.value) as 0 | 1 | 2 })} data-testid="ed-gender">
            <option value={0}>Todos</option><option value={1}>Homens</option><option value={2}>Mulheres</option>
          </select>
        </Row>
      </div>
      <Row label="Públicos personalizados">
        {customPick('customInclude')}
        <Chips items={a.customInclude} label={(x) => x.name} onRemove={(i) => setA({ customInclude: a.customInclude.filter((_, j) => j !== i) })} />
      </Row>
      <Row label="Direcionamento detalhado" hint="Inclua pessoas que correspondem a pelo menos um item. “Restringir ainda mais” exige também um item do próximo grupo.">
        {a.detailed.map((group, g) => (
          <div key={g} className="ed-group" data-testid={`ed-detailed-${g}`}>
            {g > 0 && <small className="ed-and">E também precisa corresponder a</small>}
            <SearchPick<Pick> placeholder="Adicionar dados demográficos, interesses ou comportamentos" testId={g ? `ed-detailed-search-${g}` : 'ed-detailed-search'}
              search={lookupSearch(d.actId, 'detailed')} onPick={(x) => addPick(x, g)}
              render={(x) => <><b>{x.name}</b><small>{DETAIL_TYPE[x.type ?? ''] ?? x.type}{x.path ? ` · ${x.path}` : ''}</small></>} />
            <Chips items={group} label={(x) => <>{x.name}<small>{DETAIL_TYPE[x.type ?? ''] ?? ''}</small></>}
              onRemove={(i) => setA({ detailed: a.detailed.map((l, j) => (j === g ? l.filter((_, k) => k !== i) : l)).filter((l, j) => j === 0 || l.length || j !== g) })} />
          </div>
        ))}
        <div className="ed-inline">
          {a.detailed[a.detailed.length - 1]?.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setA({ detailed: [...a.detailed, []] })} data-testid="ed-narrow"><Icon name="plus" size={13} />Restringir ainda mais</button>}
        </div>
        <SearchPick<Pick> placeholder="Excluir pessoas (interesses, comportamentos…)" testId="ed-detailed-exclude" search={lookupSearch(d.actId, 'detailed')}
          onPick={(x) => { if (!a.exclude.some((y) => y.id === x.id)) setA({ exclude: [...a.exclude, x] }); }}
          render={(x) => <><b>{x.name}</b><small>{DETAIL_TYPE[x.type ?? ''] ?? x.type}</small></>} />
        <Chips items={a.exclude} label={(x) => x.name} tone={() => 'ex'} onRemove={(i) => setA({ exclude: a.exclude.filter((_, j) => j !== i) })} />
      </Row>
    </Section>
  );
}
