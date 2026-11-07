import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buckets, computeKpis, periodDates, profitSettings, toCsv } from '../src/modules/dashboard';
import { extractSale, mapSaleStatus } from '../src/modules/saleParsing';
import { ufFromPhone } from '../src/utils/ddd';

describe('dashboard: períodos', () => {
  it('hoje, ontem, 7 e 30 dias com o período anterior equivalente', () => {
    assert.deepEqual(periodDates('today', '2026-11-06'), { d0: '2026-11-06', d1: '2026-11-06', days: 1, prevD0: '2026-11-05', prevD1: '2026-11-05' });
    assert.deepEqual(periodDates('yesterday', '2026-11-06').d0, '2026-11-05');
    const w = periodDates('7d', '2026-11-06');
    assert.equal(w.d0, '2026-10-31'); assert.equal(w.days, 7); assert.equal(w.prevD1, '2026-10-30');
    assert.equal(periodDates('30d', '2026-11-06').d0, '2026-10-08');
  });
  it('este mês e mês passado (inclui virada de ano)', () => {
    assert.deepEqual([periodDates('month', '2026-11-06').d0, periodDates('month', '2026-11-06').d1], ['2026-11-01', '2026-11-06']);
    const lm = periodDates('last_month', '2026-01-15');
    assert.deepEqual([lm.d0, lm.d1, lm.days], ['2025-12-01', '2025-12-31', 31]);
  });
  it('personalizado valida e ordena as datas', () => {
    assert.deepEqual(periodDates('custom', '2026-11-06', '2026-11-03', '2026-11-01').d0, '2026-11-01');
    assert.throws(() => periodDates('custom', '2026-11-06', 'x', '2026-11-01'));
    assert.throws(() => periodDates('custom', '2026-11-06', '2024-01-01', '2026-01-01'));
  });
  it('baldes por hora (até 2 dias) e por dia', () => {
    const h = buckets('2026-11-06', '2026-11-06', 'hour');
    assert.equal(h.length, 24); assert.equal(h[21].label, '06/11, 21h'); assert.equal(h[21].key, '2026-11-06 21');
    assert.equal(buckets('2026-11-01', '2026-11-07', 'day').length, 7);
  });
});

describe('dashboard: indicadores', () => {
  it('ROAS, conversão, ticket e lucro com taxas e custo', () => {
    const k = computeKpis({ revenue: 1000, sales: 4, cost: 200, leads: 40, adSpend: 250 }, { gatewayFeePercent: 5, taxPercent: 10 });
    assert.equal(k.roas, 4);
    assert.equal(k.conversion, 10);
    assert.equal(k.ticket, 250);
    assert.equal(k.fees, 150);
    assert.equal(k.profit, 1000 - 200 - 150 - 250);
  });
  it('sem gasto/leads/vendas não divide por zero', () => {
    const k = computeKpis({ revenue: 0, sales: 0, cost: 0, leads: 0, adSpend: 0 }, profitSettings({}));
    assert.deepEqual([k.roas, k.conversion, k.ticket, k.profit], [0, 0, 0, 0]);
  });
  it('ajustes de lucro limitados a 0–100%', () => {
    assert.deepEqual(profitSettings({ dashboard: { gatewayFeePercent: 150, taxPercent: -3 } }), { gatewayFeePercent: 100, taxPercent: 0 });
  });
  it('CSV com BOM, ponto e vírgula e aspas', () => {
    const csv = toCsv(['A', 'B'], [['x;y', 'diz "oi"']]);
    assert.ok(csv.startsWith('﻿A;B\r\n'));
    assert.ok(csv.endsWith('"x;y";"diz ""oi"""'));
  });
});

describe('vendas recebidas por webhook', () => {
  it('status: estorno e "não pago" não viram aprovada', () => {
    assert.equal(mapSaleStatus('paid order.refunded'), 'refunded');
    assert.equal(mapSaleStatus('unpaid'), 'pending');
    assert.equal(mapSaleStatus('PURCHASE_APPROVED'), 'approved');
    assert.equal(mapSaleStatus('canceled'), 'refused');
    assert.equal(mapSaleStatus('waiting_payment'), 'pending');
  });
  it('lê formato genérico e Hotmart', () => {
    const g = extractSale({ status: 'approved', amount: '97,90', currency: 'brl', transaction_id: 'T1', customer: { name: 'Ana', phone: '+55 (11) 98888-7777', state: 'sp' }, product: { name: 'Curso' } });
    assert.deepEqual([g.phone, g.amount, g.status, g.externalId, g.productName, g.state], ['5511988887777', 97.9, 'approved', 'T1', 'Curso', 'sp']);
    const h = extractSale({ event: 'PURCHASE_APPROVED', data: { buyer: { name: 'Bia', checkout_phone: '21999990000' }, product: { name: 'Mentoria' }, purchase: { transaction: 'HP1', status: 'APPROVED', price: { value: 497, currency_value: 'USD' } } } });
    assert.deepEqual([h.phone, h.amount, h.currency, h.externalId, h.productName, h.status], ['21999990000', 497, 'USD', 'HP1', 'Mentoria', 'approved']);
  });
  it('estado pelo DDD', () => {
    assert.equal(ufFromPhone('+55 11 98888-7777'), 'SP');
    assert.equal(ufFromPhone('(71) 3333-4444'), 'BA');
    assert.equal(ufFromPhone('+1 415 555 0100'), null);
  });
});
