import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { cx } from '../components/ui';
import { money, num, pctTxt, type Derived, type ManagerRow, type Metrics } from './types';

/**
 * Colunas do Gerenciador como na Meta: predefinições (Desempenho, Entrega, Engajamento, Vídeo, Conversões,
 * Mensagens) e "Personalizar colunas", detalhamento e exportar.
 */

/** Linha da tabela (campanha/conjunto/anúncio) ou linha do detalhamento. */
export interface TRow {
  metrics: Metrics; derived: Derived; currency: string;
  converza?: ManagerRow['converza']; result?: ManagerRow['result']; budget?: ManagerRow['budget'];
  bidStrategy?: string | null; endTime?: string | null; rankings?: ManagerRow['rankings'];
}

export interface Col { id: string; label: string; group: string; title?: string; cz?: boolean; v: (r: TRow) => number | string | null; f: (r: TRow) => string }

const m = (k: keyof Metrics) => (r: TRow) => r.metrics[k];
const d = (k: keyof Derived) => (r: TRow) => r.derived[k];
const cur = (fn: (r: TRow) => number | null) => (r: TRow) => { const x = fn(r); return x ? money(x, r.currency) : '—'; };
const int = (fn: (r: TRow) => number | null) => (r: TRow) => num(fn(r) ?? 0);
const pct = (fn: (r: TRow) => number | null) => (r: TRow) => pctTxt(fn(r) ?? 0);
const RANK: Record<string, string> = {
  ABOVE_AVERAGE: 'Acima da média', AVERAGE: 'Na média', BELOW_AVERAGE_35: 'Abaixo da média (35% inferiores)', BELOW_AVERAGE_20: 'Abaixo da média (20% inferiores)',
  BELOW_AVERAGE_10: 'Abaixo da média (10% inferiores)', UNKNOWN: '—',
};
const BID: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: 'Volume mais alto', COST_CAP: 'Meta de custo', LOWEST_COST_WITH_BID_CAP: 'Limite de lance', LOWEST_COST_WITH_MIN_ROAS: 'Meta de ROAS', TARGET_COST: 'Custo-alvo',
};
const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('pt-BR') : 'Contínuo');

export const COLUMNS: Col[] = [
  { id: 'results', label: 'Resultados', group: 'Desempenho', title: 'O resultado da meta de desempenho (conversas, leads, compras, cliques…)', v: (r) => r.result?.value ?? null, f: (r) => (r.result ? `${num(r.result.value)}` : '—') },
  { id: 'costPerResult', label: 'Custo por resultado', group: 'Desempenho', v: (r) => r.result?.cost ?? null, f: cur((r) => r.result?.cost ?? null) },
  { id: 'spend', label: 'Valor gasto', group: 'Desempenho', v: m('spend'), f: (r) => money(r.metrics.spend, r.currency) },
  { id: 'reach', label: 'Alcance', group: 'Entrega', v: m('reach'), f: int(m('reach')) },
  { id: 'impressions', label: 'Impressões', group: 'Entrega', v: m('impressions'), f: int(m('impressions')) },
  { id: 'frequency', label: 'Frequência', group: 'Entrega', v: d('frequency'), f: (r) => (r.derived.frequency ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) },
  { id: 'cpm', label: 'CPM', group: 'Entrega', title: 'Custo por mil impressões', v: d('cpm'), f: cur(d('cpm')) },
  { id: 'budget', label: 'Orçamento', group: 'Configuração', v: (r) => r.budget?.amount ?? null, f: (r) => (r.budget ? `${money(r.budget.amount, r.currency)}${r.budget.kind === 'daily' ? '/dia' : ' total'}` : '—') },
  { id: 'bidStrategy', label: 'Estratégia de lance', group: 'Configuração', v: (r) => r.bidStrategy ?? null, f: (r) => (r.bidStrategy ? BID[r.bidStrategy] ?? r.bidStrategy : '—') },
  { id: 'endTime', label: 'Término', group: 'Configuração', v: (r) => r.endTime ?? null, f: (r) => (r.converza ? date(r.endTime) : '—') },
  { id: 'linkClicks', label: 'Cliques no link', group: 'Cliques', v: m('linkClicks'), f: int(m('linkClicks')) },
  { id: 'ctr', label: 'CTR (link)', group: 'Cliques', v: d('ctr'), f: pct(d('ctr')) },
  { id: 'cpc', label: 'CPC (link)', group: 'Cliques', v: d('cpc'), f: cur(d('cpc')) },
  { id: 'uniqueLinkClicks', label: 'Cliques únicos no link', group: 'Cliques', v: m('uniqueLinkClicks'), f: int(m('uniqueLinkClicks')) },
  { id: 'clicks', label: 'Cliques (todos)', group: 'Cliques', v: m('clicks'), f: int(m('clicks')) },
  { id: 'ctrAll', label: 'CTR (todos)', group: 'Cliques', v: d('ctrAll'), f: pct(d('ctrAll')) },
  { id: 'cpcAll', label: 'CPC (todos)', group: 'Cliques', v: d('cpcAll'), f: cur(d('cpcAll')) },
  { id: 'landingPageViews', label: 'Visualizações da página de destino', group: 'Conversões', v: m('landingPageViews'), f: int(m('landingPageViews')) },
  { id: 'costPerLpv', label: 'Custo por visualização da página', group: 'Conversões', v: d('costPerLpv'), f: cur(d('costPerLpv')) },
  { id: 'conversations', label: 'Conversas iniciadas', group: 'Mensagens', v: m('conversations'), f: int(m('conversations')) },
  { id: 'cpConv', label: 'Custo por conversa', group: 'Mensagens', v: d('costPerConversation'), f: cur(d('costPerConversation')) },
  { id: 'messagingReplies', label: 'Primeiras respostas', group: 'Mensagens', v: m('messagingReplies'), f: int(m('messagingReplies')) },
  { id: 'leadsMeta', label: 'Leads (Meta)', group: 'Conversões', v: m('leads'), f: int(m('leads')) },
  { id: 'cpLead', label: 'Custo por lead (Meta)', group: 'Conversões', v: d('costPerLead'), f: cur(d('costPerLead')) },
  { id: 'purchases', label: 'Compras', group: 'Conversões', v: m('purchases'), f: int(m('purchases')) },
  { id: 'costPerPurchase', label: 'Custo por compra', group: 'Conversões', v: d('costPerPurchase'), f: cur(d('costPerPurchase')) },
  { id: 'purchaseValue', label: 'Valor de conversão das compras', group: 'Conversões', v: m('purchaseValue'), f: cur(m('purchaseValue')) },
  { id: 'roasMeta', label: 'ROAS das compras (Meta)', group: 'Conversões', v: d('roasMeta'), f: (r) => `${(r.derived.roasMeta ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x` },
  { id: 'addToCart', label: 'Adições ao carrinho', group: 'Conversões', v: m('addToCart'), f: int(m('addToCart')) },
  { id: 'initiateCheckout', label: 'Finalizações de compra iniciadas', group: 'Conversões', v: m('initiateCheckout'), f: int(m('initiateCheckout')) },
  { id: 'completeRegistration', label: 'Cadastros concluídos', group: 'Conversões', v: m('completeRegistration'), f: int(m('completeRegistration')) },
  { id: 'installs', label: 'Instalações do app', group: 'Conversões', v: m('installs'), f: int(m('installs')) },
  { id: 'calls', label: 'Ligações', group: 'Conversões', v: m('calls'), f: int(m('calls')) },
  { id: 'videoViews', label: 'Reproduções de 3 segundos', group: 'Vídeo', v: m('videoViews'), f: int(m('videoViews')) },
  { id: 'hookRate', label: 'Taxa de 3 segundos', group: 'Vídeo', title: 'Reproduções de 3 s ÷ impressões', v: d('hookRate'), f: pct(d('hookRate')) },
  { id: 'thruplays', label: 'ThruPlays', group: 'Vídeo', v: m('thruplays'), f: int(m('thruplays')) },
  { id: 'costPerThruplay', label: 'Custo por ThruPlay', group: 'Vídeo', v: d('costPerThruplay'), f: cur(d('costPerThruplay')) },
  { id: 'p25', label: 'Vídeo assistido 25%', group: 'Vídeo', v: m('p25'), f: int(m('p25')) },
  { id: 'p50', label: 'Vídeo assistido 50%', group: 'Vídeo', v: m('p50'), f: int(m('p50')) },
  { id: 'p75', label: 'Vídeo assistido 75%', group: 'Vídeo', v: m('p75'), f: int(m('p75')) },
  { id: 'p100', label: 'Vídeo assistido 100%', group: 'Vídeo', v: m('p100'), f: int(m('p100')) },
  { id: 'postEngagement', label: 'Engajamento com a publicação', group: 'Engajamento', v: m('postEngagement'), f: int(m('postEngagement')) },
  { id: 'pageLikes', label: 'Curtidas na Página', group: 'Engajamento', v: m('pageLikes'), f: int(m('pageLikes')) },
  { id: 'quality', label: 'Classificação de qualidade', group: 'Classificações (anúncios)', v: (r) => r.rankings?.quality ?? null, f: (r) => RANK[r.rankings?.quality ?? ''] ?? '—' },
  { id: 'engagementRank', label: 'Classificação da taxa de engajamento', group: 'Classificações (anúncios)', v: (r) => r.rankings?.engagement ?? null, f: (r) => RANK[r.rankings?.engagement ?? ''] ?? '—' },
  { id: 'conversionRank', label: 'Classificação da taxa de conversão', group: 'Classificações (anúncios)', v: (r) => r.rankings?.conversion ?? null, f: (r) => RANK[r.rankings?.conversion ?? ''] ?? '—' },
  { id: 'czLeads', label: 'Leads', group: 'Converza', cz: true, title: 'Leads no Converza que vieram deste anúncio', v: (r) => r.converza?.leads ?? null, f: (r) => (r.converza ? num(r.converza.leads) : '—') },
  { id: 'czCpl', label: 'Custo por lead (Converza)', group: 'Converza', cz: true, v: (r) => (r.converza?.leads ? r.metrics.spend / r.converza.leads : null), f: (r) => (r.converza?.leads ? money(r.metrics.spend / r.converza.leads, r.currency) : '—') },
  { id: 'czSales', label: 'Vendas', group: 'Converza', cz: true, title: 'Vendas aprovadas no Converza desses leads', v: (r) => r.converza?.sales ?? null, f: (r) => (r.converza ? num(r.converza.sales) : '—') },
  { id: 'czRevenue', label: 'Faturamento', group: 'Converza', cz: true, v: (r) => r.converza?.revenue ?? null, f: (r) => (r.converza ? money(r.converza.revenue, r.currency) : '—') },
  { id: 'czRoas', label: 'ROAS', group: 'Converza', cz: true, title: 'Faturamento no Converza ÷ valor gasto', v: (r) => r.converza?.roas ?? null, f: (r) => (r.converza && r.metrics.spend ? `${r.converza.roas.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x` : '—') },
];
export const colById = (id: string) => COLUMNS.find((c) => c.id === id);

export const PRESETS: { id: string; label: string; cols: string[] }[] = [
  { id: 'performance', label: 'Desempenho', cols: ['results', 'costPerResult', 'spend', 'impressions', 'linkClicks', 'ctr', 'cpc', 'conversations', 'cpConv', 'czLeads', 'czSales', 'czRevenue', 'czRoas'] },
  { id: 'delivery', label: 'Entrega', cols: ['spend', 'reach', 'impressions', 'frequency', 'cpm', 'budget', 'bidStrategy', 'endTime'] },
  { id: 'engagement', label: 'Engajamento', cols: ['results', 'spend', 'postEngagement', 'pageLikes', 'clicks', 'ctrAll', 'cpcAll', 'uniqueLinkClicks'] },
  { id: 'video', label: 'Engajamento com o vídeo', cols: ['spend', 'impressions', 'videoViews', 'hookRate', 'thruplays', 'costPerThruplay', 'p25', 'p50', 'p75', 'p100'] },
  { id: 'website', label: 'Conversões no site', cols: ['results', 'costPerResult', 'spend', 'landingPageViews', 'costPerLpv', 'addToCart', 'initiateCheckout', 'purchases', 'costPerPurchase', 'purchaseValue', 'roasMeta'] },
  { id: 'messages', label: 'Mensagens e Converza', cols: ['spend', 'conversations', 'cpConv', 'messagingReplies', 'czLeads', 'czCpl', 'czSales', 'czRevenue', 'czRoas'] },
  { id: 'ranking', label: 'Qualidade dos anúncios', cols: ['spend', 'impressions', 'quality', 'engagementRank', 'conversionRank', 'ctr', 'results', 'costPerResult'] },
];

export const BREAKDOWN_OPTS: { id: string; label: string; group: string }[] = [
  { id: 'day', label: 'Dia', group: 'Por tempo' }, { id: 'week', label: 'Semana', group: 'Por tempo' }, { id: 'month', label: 'Mês', group: 'Por tempo' },
  { id: 'age', label: 'Idade', group: 'Por entrega' }, { id: 'gender', label: 'Gênero', group: 'Por entrega' }, { id: 'age_gender', label: 'Idade e gênero', group: 'Por entrega' },
  { id: 'country', label: 'País', group: 'Por entrega' }, { id: 'region', label: 'Região', group: 'Por entrega' },
  { id: 'platform', label: 'Plataforma', group: 'Por entrega' }, { id: 'placement', label: 'Posicionamento', group: 'Por entrega' }, { id: 'device', label: 'Dispositivo de impressão', group: 'Por entrega' },
];

/** Igual ao derive do servidor (para o rodapé somado). */
export function deriveOf(x: Metrics): Derived {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const per = (a: number, b: number) => (b ? r2(a / b) : 0);
  return {
    ctr: x.impressions ? r2((x.linkClicks / x.impressions) * 100) : 0, cpc: per(x.spend, x.linkClicks), cpm: x.impressions ? r2((x.spend / x.impressions) * 1000) : 0,
    costPerConversation: per(x.spend, x.conversations), costPerLead: per(x.spend, x.leads), frequency: per(x.impressions, x.reach),
    ctrAll: x.impressions ? r2((x.clicks / x.impressions) * 100) : 0, cpcAll: per(x.spend, x.clicks), costPerPurchase: per(x.spend, x.purchases),
    roasMeta: per(x.purchaseValue, x.spend), costPerLpv: per(x.spend, x.landingPageViews), costPerThruplay: per(x.spend, x.thruplays),
    hookRate: x.impressions ? r2((x.videoViews / x.impressions) * 100) : 0,
  };
}
export function sumMetrics(list: Metrics[]): Metrics {
  const out = {} as Record<string, number>;
  for (const x of list) for (const [k, v] of Object.entries(x)) out[k] = (out[k] ?? 0) + (Number(v) || 0);
  return out as unknown as Metrics;
}

const LS = 'cz-fbm-columns';
export function loadColumns(): { preset: string; cols: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(LS) ?? 'null');
    if (v && Array.isArray(v.cols) && v.cols.every((c: string) => colById(c))) return v;
  } catch { /* padrão */ }
  return { preset: 'performance', cols: PRESETS[0].cols };
}
export function saveColumns(v: { preset: string; cols: string[] }) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* sem storage */ } }

function useOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return ref;
}

/** Botão "Colunas": predefinições + personalizar (marcar e ordenar). */
export function ColumnsMenu({ value, onChange }: { value: { preset: string; cols: string[] }; onChange: (v: { preset: string; cols: string[] }) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState<string[]>(value.cols);
  const ref = useOutside(() => { setOpen(false); setCustom(false); });
  const label = value.preset === 'custom' ? 'Personalizadas' : PRESETS.find((p) => p.id === value.preset)?.label ?? 'Colunas';
  const groups = [...new Set(COLUMNS.map((c) => c.group))];
  const move = (i: number, dir: -1 | 1) => { const n = [...draft]; const j = i + dir; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setDraft(n); };
  return (
    <div className="fbm-menu" ref={ref}>
      <button type="button" className="btn sm" onClick={() => { setOpen(!open); setCustom(false); }} data-testid="fb-columns"><Icon name="grid" size={14} />Colunas: {label}<Icon name="chevron" size={12} /></button>
      {open && !custom && (
        <div className="fbm-pop" data-testid="fb-columns-menu">
          {PRESETS.map((p) => (
            <button type="button" key={p.id} className={cx(value.preset === p.id && 'on')} onClick={() => { onChange({ preset: p.id, cols: p.cols }); setOpen(false); }} data-testid={`fb-preset-${p.id}`}>
              {value.preset === p.id ? <Icon name="check" size={13} /> : <i />}{p.label}
            </button>
          ))}
          <hr />
          <button type="button" onClick={() => { setDraft(value.cols); setCustom(true); }} data-testid="fb-columns-custom"><Icon name="sliders" size={13} />Personalizar colunas…</button>
        </div>
      )}
      {open && custom && (
        <div className="fbm-pop wide" data-testid="fb-columns-editor">
          <div className="fbm-cols">
            <div className="fbm-cols-all">
              {groups.map((g) => (
                <div key={g}>
                  <b>{g}</b>
                  {COLUMNS.filter((c) => c.group === g).map((c) => (
                    <label key={c.id}><input type="checkbox" checked={draft.includes(c.id)} onChange={(e) => setDraft(e.target.checked ? [...draft, c.id] : draft.filter((x) => x !== c.id))} data-testid={`fb-col-${c.id}`} />{c.label}</label>
                  ))}
                </div>
              ))}
            </div>
            <div className="fbm-cols-sel">
              <b>{draft.length} colunas selecionadas</b>
              {draft.map((id, i) => (
                <div key={id}><span>{colById(id)?.label}</span>
                  <button type="button" onClick={() => move(i, -1)} aria-label="Subir"><Icon name="chevronUp" size={12} /></button>
                  <button type="button" onClick={() => move(i, 1)} aria-label="Descer"><Icon name="chevron" size={12} /></button>
                  <button type="button" onClick={() => setDraft(draft.filter((x) => x !== id))} aria-label="Tirar"><Icon name="close" size={12} /></button>
                </div>
              ))}
            </div>
          </div>
          <div className="fbm-pop-foot">
            <button type="button" className="btn sm" onClick={() => setCustom(false)}>Voltar</button>
            <button type="button" className="btn sm primary" disabled={!draft.length} onClick={() => { onChange({ preset: 'custom', cols: draft }); setOpen(false); setCustom(false); }} data-testid="fb-columns-apply">Aplicar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BreakdownMenu({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(() => setOpen(false));
  const cur = BREAKDOWN_OPTS.find((b) => b.id === value);
  return (
    <div className="fbm-menu" ref={ref}>
      <button type="button" className={cx('btn sm', value && 'on')} onClick={() => setOpen(!open)} data-testid="fb-breakdown"><Icon name="list" size={14} />Detalhamento{cur ? `: ${cur.label}` : ''}<Icon name="chevron" size={12} /></button>
      {open && (
        <div className="fbm-pop" data-testid="fb-breakdown-menu">
          {value && <button type="button" onClick={() => { onChange(''); setOpen(false); }}><Icon name="close" size={13} />Sem detalhamento</button>}
          {['Por tempo', 'Por entrega'].map((g) => (
            <div key={g}><small>{g}</small>
              {BREAKDOWN_OPTS.filter((b) => b.group === g).map((b) => (
                <button type="button" key={b.id} className={cx(value === b.id && 'on')} onClick={() => { onChange(b.id); setOpen(false); }} data-testid={`fb-bd-${b.id}`}>
                  {value === b.id ? <Icon name="check" size={13} /> : <i />}{b.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Exporta a tabela como está (colunas escolhidas, filtros e detalhamento) em CSV para Excel/Planilhas. */
export function exportCsv(name: string, cols: Col[], rows: { name: string; level?: string; sub?: string; row: TRow }[]) {
  const esc = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['Nome', 'Detalhamento', ...cols.map((c) => c.label)];
  const lines = rows.map((r) => [r.name, r.sub ?? '', ...cols.map((c) => {
    const v = c.v(r.row);
    return typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : c.f(r.row);
  })]);
  const csv = '﻿' + [head, ...lines].map((l) => l.map((x) => esc(String(x))).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
