import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { adPayload, adsetPayload, buildTargeting, campaignPayload, creativePayload, minorUnits, welcomeMessage, type CampaignSpec } from '../src/meta/adsWrite';

const spec = (o: Partial<CampaignSpec> = {}): CampaignSpec => ({
  actId: 'act_111', currency: 'BRL', name: 'Novena', status: 'PAUSED',
  budget: { kind: 'daily', amount: 30 }, startTime: null, endTime: null,
  audience: { mode: 'advantage', locations: [], ageMin: 18, ageMax: 65, genders: [], interests: [] },
  pageId: '987654321000', whatsappNumber: null,
  ad: { imageHash: 'abc123', primaryText: 'Reze a novena', headline: 'Novena', description: null, greeting: 'Olá! 🙏', prefill: 'Quero a novena' },
  ...o,
});

describe('Gerenciador: o que vai para a Meta', () => {
  test('orçamento na unidade da Meta (centavos; moedas sem centavos inteiras)', () => {
    assert.equal(minorUnits(30, 'BRL'), 3000);
    assert.equal(minorUnits(12.345, 'USD'), 1235);
    assert.equal(minorUnits(500, 'JPY'), 500);
  });

  test('campanha de mensagens: objetivo, categorias e orçamento no conjunto', () => {
    assert.deepEqual(campaignPayload(spec()), {
      name: 'Novena', objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED', buying_type: 'AUCTION',
      special_ad_categories: [], is_adset_budget_sharing_enabled: false,
    });
  });

  test('conjunto de clique para o WhatsApp', () => {
    const a = adsetPayload(spec({ whatsappNumber: '+55 (11) 99999-0000', startTime: '2026-11-12T10:00:00.000Z' }), '6100');
    assert.equal(a.destination_type, 'WHATSAPP');
    assert.equal(a.optimization_goal, 'CONVERSATIONS');
    assert.equal(a.billing_event, 'IMPRESSIONS');
    assert.equal(a.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
    assert.deepEqual(a.promoted_object, { page_id: '987654321000', whatsapp_phone_number: '+5511999990000' });
    assert.equal((a as Record<string, unknown>).daily_budget, 3000);
    assert.equal((a as Record<string, unknown>).start_time, '2026-11-12T10:00:00.000Z');
    assert.deepEqual(a.targeting, { geo_locations: { countries: ['BR'] }, targeting_automation: { advantage_audience: 1 } });
    const life = adsetPayload(spec({ budget: { kind: 'lifetime', amount: 300 }, endTime: '2026-11-20T00:00:00.000Z' }), '6100');
    assert.equal((life as Record<string, unknown>).lifetime_budget, 30000);
    assert.equal((life as Record<string, unknown>).end_time, '2026-11-20T00:00:00.000Z');
    assert.equal('whatsapp_phone_number' in (life.promoted_object as object), false);
  });

  test('público definido: idade, gênero, interesses e locais sem sobreposição', () => {
    const t = buildTargeting({
      mode: 'manual', ageMin: 25, ageMax: 54, genders: [2], interests: [{ id: '6003', name: 'Catolicismo' }],
      locations: [
        { key: 'BR', name: 'Brasil', type: 'country' },
        { key: '460', name: 'São Paulo, Brasil', type: 'region', countryCode: 'BR' },
        { key: '269969', name: 'Recife, Pernambuco, Brasil', type: 'city', countryCode: 'BR' },
        { key: 'PT', name: 'Portugal', type: 'country' },
      ],
    });
    assert.deepEqual(t, {
      geo_locations: { countries: ['PT'], regions: [{ key: '460' }], cities: [{ key: '269969' }] },
      targeting_automation: { advantage_audience: 0 },
      age_min: 25, age_max: 54, genders: [2],
      flexible_spec: [{ interests: [{ id: '6003', name: 'Catolicismo' }] }],
    });
    // os dois gêneros = todos (não manda o campo); idade fora da faixa é ajustada
    const all = buildTargeting({ mode: 'manual', ageMin: 10, ageMax: 99, genders: [1, 2], interests: [], locations: [] });
    assert.equal('genders' in all, false);
    assert.equal(all.age_min, 18); assert.equal(all.age_max, 65);
  });

  test('Advantage+ só guarda o local (e a idade mínima até 25)', () => {
    const t = buildTargeting({ mode: 'advantage', ageMin: 30, ageMax: 40, genders: [1], interests: [{ id: '1', name: 'x' }], locations: [] });
    assert.deepEqual(t, { geo_locations: { countries: ['BR'] }, targeting_automation: { advantage_audience: 1 }, age_min: 25 });
  });

  test('criativo com botão do WhatsApp e mensagem pronta', () => {
    const c = creativePayload(spec());
    const ld = c.object_story_spec.link_data as Record<string, any>;
    assert.equal(c.object_story_spec.page_id, '987654321000');
    assert.equal(ld.image_hash, 'abc123');
    assert.equal(ld.link, 'https://api.whatsapp.com/send');
    assert.deepEqual(ld.call_to_action, { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } });
    assert.equal(ld.message, 'Reze a novena');
    assert.equal(ld.name, 'Novena');
    const w = JSON.parse(ld.page_welcome_message);
    assert.deepEqual(w, JSON.parse(welcomeMessage('Olá! 🙏', 'Quero a novena')));
    assert.equal(w.type, 'VISUAL_EDITOR');
    assert.equal(w.text_format.customer_action_type, 'autofill_message');
    assert.equal(w.text_format.message.text, 'Olá! 🙏');
    assert.equal(w.text_format.message.autofill_message.content, 'Quero a novena');
  });

  test('anúncio usa o criativo criado', () => {
    assert.deepEqual(adPayload(spec(), '6200', '7700'), { name: 'Novena — Anúncio', adset_id: '6200', creative: { creative_id: '7700' }, status: 'ACTIVE' });
  });
});
