import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { addMetrics, budgetOf, buildRows, dailySeries, derive, metricsOf, statusOf, totalsByCurrency, zero, accountStatusLabel } from '../src/meta/insights';
import { buildEvent, checkRules, pageFromAd, defaultRules, eventKey, metaUserData, normEmail, normNames, normPhone, ruleMatches, type Rule } from '../src/pixels/engine';

const h = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Gerenciador: métricas da Meta', () => {
  test('pega o primeiro tipo de ação que veio, sem somar duplicados', () => {
    const m = metricsOf({
      spend: '35.50', impressions: '1800', clicks: '70', inline_link_clicks: '53',
      actions: [
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '10' },
        { action_type: 'omni_purchase', value: '2' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' },
        { action_type: 'onsite_conversion.lead_grouped', value: '3' },
      ],
      action_values: [{ action_type: 'omni_purchase', value: '394' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '394' }],
    });
    assert.deepEqual(m, { spend: 35.5, impressions: 1800, clicks: 70, linkClicks: 53, conversations: 10, leads: 3, purchases: 2, purchaseValue: 394 });
  });
  test('CTR, CPC, CPM e custo por conversa', () => {
    const d = derive({ ...zero(), spend: 35.5, impressions: 1800, linkClicks: 53, conversations: 10 });
    assert.deepEqual(d, { ctr: 2.94, cpc: 0.67, cpm: 19.72, costPerConversation: 3.55, costPerLead: 0 });
    assert.deepEqual(derive(zero()), { ctr: 0, cpc: 0, cpm: 0, costPerConversation: 0, costPerLead: 0 });
  });
  test('orçamento em centavos (e moedas sem centavos)', () => {
    assert.deepEqual(budgetOf({ daily_budget: '5000' }, 'BRL'), { amount: 50, kind: 'daily' });
    assert.deepEqual(budgetOf({ lifetime_budget: '150000' }, 'BRL'), { amount: 1500, kind: 'lifetime' });
    assert.deepEqual(budgetOf({ daily_budget: '5000' }, 'JPY'), { amount: 5000, kind: 'daily' });
    assert.equal(budgetOf({}, 'BRL'), null);
  });
  test('status da veiculação e da conta', () => {
    assert.equal(statusOf('ACTIVE').label, 'Ativa');
    assert.equal(statusOf('CAMPAIGN_PAUSED').label, 'Campanha pausada');
    assert.equal(statusOf('DISAPPROVED').key, 'issue');
    assert.equal(statusOf(null).label, 'Excluída');
    assert.equal(accountStatusLabel(3).label, 'Pagamento pendente');
    assert.equal(accountStatusLabel(1).ok, true);
  });
});

describe('Gerenciador: linhas com os leads e vendas do Converza', () => {
  const ads = [
    { id: 'a1', campaign_id: 'c1', adset_id: 's1' }, { id: 'a2', campaign_id: 'c1', adset_id: 's1' }, { id: 'a3', campaign_id: 'c2', adset_id: 's2' },
  ];
  const base = { actId: 'act_1', accountName: 'Conta', currency: 'BRL' };
  const entities = [
    { id: 'c1', name: 'Black Friday', effective_status: 'ACTIVE', daily_budget: '5000', ...base },
    { id: 'c2', name: 'Remarketing', effective_status: 'PAUSED', ...base },
    { id: 'c3', name: 'Sem gasto', effective_status: 'ACTIVE', ...base },
  ];
  const insights = [
    { campaign_id: 'c1', campaign_name: 'Black Friday', spend: '100', impressions: '5000', inline_link_clicks: '100', ...base,
      actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' }] },
    { campaign_id: 'c9', campaign_name: 'Excluída que gastou', spend: '30', impressions: '900', ...base },
  ];
  const attr = new Map([
    ['a1', { leads: 3, sales: 1, revenue: { BRL: 197 } }],
    ['a2', { leads: 2, sales: 1, revenue: { BRL: 103, USD: 50 } }],
    ['a3', { leads: 1, sales: 0, revenue: {} }],
  ]);
  test('soma os anúncios na campanha e calcula o ROAS com as vendas na moeda da conta', () => {
    const rows = buildRows('campaign', entities, insights, ads, attr);
    assert.deepEqual(rows.map((r) => r.id), ['c1', 'c9', 'c3', 'c2']);
    const c1 = rows[0];
    assert.deepEqual(c1.converza, { leads: 5, sales: 2, revenue: 300, roas: 3 });
    assert.deepEqual(c1.budget, { amount: 50, kind: 'daily' });
    assert.equal(c1.derived.costPerConversation, 5);
    const c9 = rows[1];
    assert.equal(c9.name, 'Excluída que gastou');
    assert.equal(c9.status.label, 'Excluída');
    assert.equal(rows[3].converza.leads, 1);
  });
  test('no nível de anúncio, cada um com o seu', () => {
    const rows = buildRows('ad', ads.map((a) => ({ ...a, name: a.id, effective_status: 'ACTIVE', ...base })), [], ads, attr);
    assert.deepEqual(rows.find((r) => r.id === 'a2')?.converza, { leads: 2, sales: 1, revenue: 103, roas: 0 });
    assert.equal(rows.find((r) => r.id === 'a2')?.adsetId, 's1');
  });
  test('totais separados por moeda', () => {
    const rows = buildRows('campaign', entities, insights, ads, attr);
    const usd = buildRows('campaign', [{ id: 'u1', name: 'US', effective_status: 'ACTIVE', actId: 'act_2', accountName: 'US', currency: 'USD' }],
      [{ campaign_id: 'u1', spend: '10', actId: 'act_2', accountName: 'US', currency: 'USD' }], [], new Map());
    const t = totalsByCurrency([...rows, ...usd]);
    assert.deepEqual(Object.keys(t).sort(), ['BRL', 'USD']);
    assert.equal(t.BRL.metrics.spend, 130);
    assert.equal(t.BRL.converza.revenue, 300);
    assert.equal(t.BRL.converza.roas, 2.31);
    assert.equal(t.USD.metrics.spend, 10);
  });
  test('série por dia preenche os dias sem gasto', () => {
    const s = dailySeries([{ date_start: '2026-11-02', spend: '12.5', currency: 'BRL', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' }] }],
      ['2026-11-01', '2026-11-02', '2026-11-03']);
    assert.deepEqual(s.BRL.map((x) => x.spend), [0, 12.5, 0]);
    assert.equal(s.BRL[1].conversations, 3);
    assert.deepEqual(addMetrics(zero(), zero()), zero());
  });
});

describe('Pixels: dados do cliente', () => {
  test('telefone com DDI, e-mail e nome normalizados', () => {
    assert.equal(normPhone('(11) 98888-7777'), '5511988887777');
    assert.equal(normPhone('5511988887777'), '5511988887777');
    assert.equal(normPhone('123'), null);
    assert.equal(normEmail('  Ana@Exemplo.COM '), 'ana@exemplo.com');
    assert.equal(normEmail('sem-arroba'), null);
    assert.deepEqual(normNames('Conceição Ávila dos Santos'), { fn: 'conceição', ln: 'santos' });
    assert.deepEqual(normNames('5511988887777', '5511988887777'), { fn: null, ln: null });
  });
  test('Meta recebe tudo em SHA-256', () => {
    const ud = metaUserData({ id: 'c-1', name: 'Bia Modelo', phone: '5511922220002', email: 'Bia@x.com', state: 'SP' });
    assert.deepEqual(ud, {
      external_id: [h('c-1')], ph: [h('5511922220002')], em: [h('bia@x.com')], fn: [h('bia')], ln: [h('modelo')], country: [h('br')], st: [h('sp')],
    });
  });
});

describe('Pixels: corpo de cada plataforma', () => {
  const person = { id: 'c-1', name: 'Bia Modelo', phone: '5511922220002', email: null, ctwaClid: 'ARAkLk-clid' };
  const money = { value: 197.5, currency: 'BRL', product: 'Clareamento', orderId: 'HP123' };
  const time = new Date('2026-11-07T12:00:00Z');
  test('Meta: chat, com o ID do evento e o valor', () => {
    const b = buildEvent({ platform: 'meta', pixelId: '726668042287', event: 'Purchase', key: 'sale:1#Purchase', time, person, money });
    assert.ok(b.ok);
    const ev = (b.body.data as Record<string, unknown>[])[0];
    assert.equal(ev.action_source, 'chat');
    assert.equal(ev.event_id, 'sale:1#Purchase');
    assert.equal(ev.event_time, Math.floor(time.getTime() / 1000));
    assert.deepEqual(ev.custom_data, { currency: 'BRL', value: 197.5, content_name: 'Clareamento', order_id: 'HP123' });
    assert.equal(b.body.partner_agent, 'converza');
    assert.equal(b.body.test_event_code, undefined);
  });
  test('Meta pelo WhatsApp: business_messaging com o ctwa_clid e o WABA', () => {
    const b = buildEvent({ platform: 'meta_whatsapp', pixelId: '88', wabaId: 'waba1', event: 'Purchase', key: 'k', time, person, money });
    assert.ok(b.ok);
    const ev = (b.body.data as Record<string, unknown>[])[0];
    assert.equal(ev.action_source, 'business_messaging');
    assert.equal(ev.messaging_channel, 'whatsapp');
    assert.deepEqual(ev.user_data, { whatsapp_business_account_id: 'waba1', ctwa_clid: 'ARAkLk-clid' });
    assert.deepEqual(ev.custom_data, { currency: 'BRL', value: 197.5 });
    const no = buildEvent({ platform: 'meta_whatsapp', pixelId: '88', wabaId: 'waba1', event: 'Purchase', key: 'k', time, person: { ...person, ctwaClid: null }, money });
    assert.deepEqual(no, { ok: false, skip: 'O cliente não veio de um anúncio de clique para o WhatsApp (sem ctwa_clid)' });
  });
  test('TikTok: telefone +55 em SHA-256 e propriedades', () => {
    const b = buildEvent({ platform: 'tiktok', pixelId: 'CABC123DEF', event: 'Purchase', key: 'k', time, person, money, testCode: 'TEST1' });
    assert.ok(b.ok);
    assert.equal(b.body.event_source, 'web');
    assert.equal(b.body.event_source_id, 'CABC123DEF');
    assert.equal(b.body.test_event_code, 'TEST1');
    const ev = (b.body.data as Record<string, unknown>[])[0] as Record<string, any>;
    assert.equal(ev.user.phone, h('+5511922220002'));
    assert.equal(ev.properties.value, 197.5);
    assert.equal(ev.properties.contents[0].content_name, 'Clareamento');
  });
  test('sem telefone nem e-mail, não manda', () => {
    const b = buildEvent({ platform: 'meta', pixelId: '1', event: 'Lead', key: 'k', time, person: { id: 'x', name: 'Só Nome', phone: null, email: null } });
    assert.equal(b.ok, false);
  });
});

describe('Pixels: regras', () => {
  test('lead: só de anúncio, do WhatsApp ou todo contato novo', () => {
    const ad: Rule = { id: 'r', trigger: 'lead', scope: 'ad', event: 'Lead' };
    const wa: Rule = { ...ad, scope: 'whatsapp' };
    const all: Rule = { ...ad, scope: 'all' };
    const fromAd = { isNew: true, fromAd: true, channel: 'whatsapp' as const };
    const organic = { isNew: true, fromAd: false, channel: 'whatsapp' as const };
    const form = { isNew: true, fromAd: false, channel: 'webhook' as const };
    assert.deepEqual([ruleMatches(ad, 'lead', fromAd), ruleMatches(ad, 'lead', organic), ruleMatches(ad, 'lead', form)], [true, false, false]);
    assert.deepEqual([ruleMatches(wa, 'lead', organic), ruleMatches(wa, 'lead', form)], [true, false]);
    assert.equal(ruleMatches(all, 'lead', form), true);
    assert.equal(ruleMatches(ad, 'lead', { isNew: false, newAdClick: true }), true, 'cliente antigo que voltou por anúncio');
    assert.equal(ruleMatches(ad, 'lead', { isNew: false }), false);
    assert.equal(ruleMatches(ad, 'sale', fromAd), false);
  });
  test('etapa do Kanban e chave contra duplicar', () => {
    const r: Rule = { id: 's', trigger: 'stage', columnId: 'col-1', event: 'QualifiedLead' };
    assert.equal(ruleMatches(r, 'stage', { columnId: 'col-1' }), true);
    assert.equal(ruleMatches(r, 'stage', { columnId: 'col-2' }), false);
    assert.equal(eventKey('sale', { saleId: 's1' }), 'sale:s1');
    assert.equal(eventKey('lead', { contactId: 'c1', ctwaClid: 'clid' }), 'lead:c1:clid');
    assert.equal(eventKey('lead', { contactId: 'c1' }), 'lead:c1:novo');
    assert.equal(eventKey('stage', { contactId: 'c1', columnId: 'col-1' }), 'stage:col-1:c1');
    assert.equal(eventKey('sale', {}), null);
  });
  test('cada plataforma aceita os seus eventos', () => {
    assert.equal(checkRules('meta', defaultRules('meta')), null);
    assert.equal(checkRules('meta_whatsapp', defaultRules('meta_whatsapp')), null);
    assert.equal(defaultRules('meta_whatsapp')[0].event, 'LeadSubmitted');
    assert.match(checkRules('meta_whatsapp', [{ id: 'a', trigger: 'lead', scope: 'ad', event: 'Lead' }]) ?? '', /não é aceito/);
    assert.match(checkRules('meta_whatsapp', [{ id: 'a', trigger: 'lead', scope: 'all', event: 'LeadSubmitted' }]) ?? '', /anúncio de clique/);
    assert.match(checkRules('tiktok', [{ id: 'a', trigger: 'stage', event: 'Contact' }]) ?? '', /etapa do Kanban/);
    assert.match(checkRules('meta', [{ id: 'a', trigger: 'sale', event: 'Purchase' }, { id: 'a', trigger: 'sale', event: 'Purchase' }]) ?? '', /repetidas/);
  });
});

describe('Página do anúncio de clique para o WhatsApp', () => {
  test('lê a Página do story do criativo ou do object_story_spec', () => {
    assert.equal(pageFromAd({ creative: { effective_object_story_id: '987654321000_555' } }), '987654321000');
    assert.equal(pageFromAd({ creative: { object_story_spec: { page_id: '123456' } } }), '123456');
    assert.equal(pageFromAd({ adcreatives: { data: [{ effective_object_story_id: '42_1' }] } }), '42');
    assert.equal(pageFromAd({}), null);
  });
});
