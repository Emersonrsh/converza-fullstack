import { cx } from '../../components/ui';
import { BID_STRATEGIES, SPECIAL_CATEGORIES, objectiveLabel, type CampaignDraft, type Draft } from './model';
import { MoneyInput, Radio, Row, Section, Toggle } from './parts';

/** Nível campanha: nome, detalhes, orçamento Advantage+ (da campanha) ou do conjunto, limite de gastos, categorias especiais, fluxo. */
export function CampaignForm({ d, set, flows, issues }: {
  d: Draft; set: (p: Partial<CampaignDraft>) => void; flows: { id: string; name: string }[]; issues: string[];
}) {
  const c = d.campaign;
  const published = !!c.id;
  const anyValue = d.adsets.some((s) => s.goal === 'VALUE');
  return (
    <>
      <Section title="Nome da campanha" ok={!!c.name.trim()} testId="ed-c-name">
        <input className="input" value={c.name} onChange={(e) => set({ name: e.target.value })} data-testid="ed-campaign-name" />
      </Section>

      <Section title="Detalhes da campanha" testId="ed-c-details">
        <div className="ed-kv"><span>Tipo de compra</span><b>Leilão</b></div>
        <div className="ed-kv"><span>Objetivo da campanha</span><b data-testid="ed-objective">{objectiveLabel(c.objective)}</b>{published && <small className="faint">O objetivo não muda depois de publicada (duplique para trocar).</small>}</div>
        <Row label="Fluxo do Converza para os leads (opcional)" hint="Quem chegar por um anúncio desta campanha começa direto neste fluxo, sem passar pela regra de início.">
          <select className="input" value={c.flowId ?? ''} onChange={(e) => set({ flowId: e.target.value || null })} data-testid="ed-flow">
            <option value="">Nenhum (usa as regras de início dos fluxos)</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Row>
      </Section>

      <Section title="Orçamento" ok={!c.cbo || Number(c.budget) > 0} badge={c.cbo ? 'Advantage+ ativado' : undefined} testId="ed-c-budget">
        <Row label="Estratégia de orçamento">
          <Radio value={c.cbo ? 'cbo' : 'abo'} onChange={(v) => set({ cbo: v === 'cbo' })} testId="ed-cbo" options={[
            { id: 'cbo', label: 'Orçamento da campanha', desc: 'Os gastos vão para as melhores oportunidades entre os conjuntos. Você pode definir um limite mínimo/máximo por conjunto.' },
            { id: 'abo', label: 'Orçamento do conjunto de anúncios', desc: 'Estratégias de lance ou programação diferentes para cada conjunto.' },
          ]} />
        </Row>
        {published && <small className="faint">Trocar a estratégia de orçamento de uma campanha publicada pode ser recusado pela Meta.</small>}
        {c.cbo && (
          <>
            <div className="ed-grid2">
              <select className="input" value={c.budgetKind} onChange={(e) => set({ budgetKind: e.target.value as 'daily' | 'lifetime' })} data-testid="ed-c-budget-kind">
                <option value="daily">Orçamento diário</option><option value="lifetime">Orçamento total</option>
              </select>
              <MoneyInput value={c.budget} onChange={(v) => set({ budget: v })} currency={d.currency} testId="ed-c-budget-amount" />
            </div>
            {c.budgetKind === 'daily' && Number(c.budget) > 0 && (
              <small className="faint">Gastaremos cerca de {Number(c.budget).toLocaleString('pt-BR', { style: 'currency', currency: d.currency })} por dia. Em alguns dias pode ser mais (até 75%) e em outros, menos.</small>
            )}
            <Row label="Estratégia de lance da campanha">
              <select className="input" value={c.bidStrategy} onChange={(e) => set({ bidStrategy: e.target.value })} data-testid="ed-c-bid">
                {BID_STRATEGIES.filter((b) => !b.valueOnly || anyValue).map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </Row>
            <small className="faint">{BID_STRATEGIES.find((b) => b.id === c.bidStrategy)?.desc}{BID_STRATEGIES.find((b) => b.id === c.bidStrategy)?.needs ? ' O valor fica em cada conjunto de anúncios.' : ''}</small>
          </>
        )}
        <Row label="Limite de gastos da campanha (opcional)" hint="A campanha para de veicular quando gastar este valor no total.">
          <MoneyInput value={c.spendCap} onChange={(v) => set({ spendCap: v })} currency={d.currency} placeholder="Sem limite" testId="ed-c-spend-cap" />
        </Row>
      </Section>

      <Section title="Teste A/B" defaultOpen={false}>
        <small className="faint">O teste A/B usa uma API separada e restrita da Meta, então não dá para criar por aqui. Para comparar versões, duplique o conjunto ou o anúncio e mude uma coisa só.</small>
      </Section>

      <Section title="Categorias de anúncio especiais" testId="ed-c-special">
        <small className="faint">Declare se seus anúncios são de produtos e serviços financeiros, emprego, moradia, temas sociais, eleições ou política. Isso limita algumas opções de público.</small>
        <div className="ed-checks">
          {SPECIAL_CATEGORIES.map(([id, label]) => {
            const on = c.specialCategories.includes(id);
            return (
              <button type="button" key={id} className={cx('ed-check', on && 'on')} disabled={published}
                onClick={() => set({ specialCategories: on ? c.specialCategories.filter((x) => x !== id) : [...c.specialCategories, id] })} data-testid={`ed-special-${id}`}>
                <i />{label}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Status" testId="ed-c-status">
        <Toggle on={c.status === 'ACTIVE'} onChange={(v) => set({ status: v ? 'ACTIVE' : 'PAUSED' })} label={c.status === 'ACTIVE' ? 'Campanha ligada ao publicar' : 'Campanha pausada (não gasta)'} testId="ed-c-on" />
      </Section>
      {issues.length > 0 && <div className="ed-issues">{issues.map((m, i) => <span key={i}>{m}</span>)}</div>}
    </>
  );
}
