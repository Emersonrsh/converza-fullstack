import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  addDaysDate, addMonthsDate, brDate, endOfDayBR, maskTaxId, periodEndFromDue, prorata, statusInfo, todayBR, validTaxId,
} from '../src/billing/rules';
import { asaasBillingType, methodFromAsaas, paddleOneOff, paddleQuantity, paddleSignatureOk } from '../src/billing/gateways';
import { MAX_INSTANCES, TOKENS_MIN, monthlyPrice, tokensPrice } from '../src/modules/plans';
import { describeInstances, plural } from '../src/billing/store';

describe('CPF e CNPJ', () => {
  it('aceita os válidos (com ou sem pontuação)', () => {
    assert.equal(validTaxId('529.982.247-25'), '52998224725');
    assert.equal(validTaxId('11.222.333/0001-81'), '11222333000181');
    assert.equal(validTaxId('11222333000181'), '11222333000181');
  });
  it('recusa dígito errado, repetidos e tamanho errado', () => {
    assert.equal(validTaxId('529.982.247-26'), null);
    assert.equal(validTaxId('111.111.111-11'), null);
    assert.equal(validTaxId('11.222.333/0001-80'), null);
    assert.equal(validTaxId('1234'), null);
    assert.equal(validTaxId(''), null);
  });
  it('mostra só o meio', () => {
    assert.equal(maskTaxId('52998224725'), '***.982.247-**');
    assert.equal(maskTaxId('11222333000181'), '**.222.333/0001-**');
    assert.equal(maskTaxId(null), null);
  });
});

describe('datas do ciclo', () => {
  it('dia de hoje no horário de Brasília', () => {
    // 02:00 UTC ainda é o dia anterior em Brasília (UTC−3)
    assert.equal(todayBR(new Date('2026-11-08T02:00:00Z')), '2026-11-07');
    assert.equal(todayBR(new Date('2026-11-08T03:30:00Z')), '2026-11-08');
  });
  it('próximo vencimento não estoura o mês', () => {
    assert.equal(addMonthsDate('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonthsDate('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonthsDate('2026-12-15', 1), '2027-01-15');
    assert.equal(addDaysDate('2026-12-31', 1), '2027-01-01');
  });
  it('a mensalidade paga vale até o fim do dia do próximo vencimento', () => {
    assert.equal(periodEndFromDue('2026-11-07').toISOString(), '2026-12-08T02:59:59.000Z');
    assert.equal(endOfDayBR('2026-11-07').toISOString(), '2026-11-08T02:59:59.000Z');
    assert.equal(brDate('2026-11-07'), '07/11/2026');
    assert.equal(brDate(new Date('2026-12-08T02:59:59Z')), '07/12/2026');
  });
});

describe('preços', () => {
  it('mensalidade por instância e tokens avulsos', () => {
    assert.equal(monthlyPrice(1, 'BRL'), 127);
    assert.equal(monthlyPrice(3, 'BRL'), 381);
    assert.equal(tokensPrice(10_000, 'BRL'), 10);
    assert.equal(tokensPrice(TOKENS_MIN, 'BRL'), 5); // o mínimo da Asaas
    assert.equal(MAX_INSTANCES, 100);
  });
  it('instâncias a mais no meio do ciclo: só os dias que faltam, nunca menos de R$ 5', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    assert.equal(prorata(1, 127, new Date('2026-11-22T12:00:00Z'), now), 63.5); // 15 de 30 dias
    assert.equal(prorata(2, 127, new Date('2026-12-07T12:00:00Z'), now), 254); // ciclo inteiro
    assert.equal(prorata(1, 127, new Date('2026-11-07T13:00:00Z'), now), 5); // 1 dia ≈ R$ 4,23 → mínimo
    assert.equal(prorata(0, 127, null, now), 0);
  });
  it('textos', () => {
    assert.equal(plural(1, 'instância', 'instâncias'), '1 instância');
    assert.equal(plural(10000, 'token', 'tokens'), '10.000 tokens');
    assert.equal(describeInstances(3), 'Assinatura Converza — 3 instâncias');
  });
});

describe('situação da assinatura', () => {
  const base = { status: 'inactive', instances: 0, cancelAtPeriodEnd: false, currentPeriodEnd: null, startedAt: null, canceledAt: null };
  it('cada caso com o seu texto', () => {
    assert.equal(statusInfo(base, false).key, 'none');
    assert.equal(statusInfo(base, true).key, 'pending');
    assert.equal(statusInfo({ ...base, status: 'active', instances: 2 }, false).label, 'Ativa');
    assert.equal(statusInfo({ ...base, status: 'past_due' }, false).key, 'past_due');
    assert.equal(statusInfo({ ...base, status: 'canceled', startedAt: new Date() }, false).key, 'canceled');
    const end = new Date('2026-12-08T02:59:59Z');
    const canceled = statusInfo({ ...base, status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: end, canceledAt: new Date() }, false);
    assert.equal(canceled.label, 'Cancelada');
    assert.match(canceled.text, /07\/12\/2026/);
    // ativação antiga, sem cobrança por trás
    assert.equal(statusInfo({ ...base, status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: end }, false).label, 'Não renova');
  });
});

describe('gateways', () => {
  it('forma de pagamento da Asaas', () => {
    assert.equal(asaasBillingType('pix'), 'PIX');
    assert.equal(asaasBillingType('card'), 'CREDIT_CARD');
    assert.equal(asaasBillingType(null), 'UNDEFINED'); // o cliente escolhe na página da Asaas
    assert.equal(methodFromAsaas('CREDIT_CARD'), 'card');
    assert.equal(methodFromAsaas('PIX'), 'pix');
    assert.equal(methodFromAsaas('UNDEFINED'), null);
  });
  it('item avulso da Paddle em centavos de dólar', () => {
    const it = paddleOneOff('10.000 tokens de IA', 2);
    assert.deepEqual((it.price as { unit_price: unknown }).unit_price, { amount: '200', currency_code: 'USD' });
    assert.equal(paddleQuantity({ items: [{ quantity: 2 }, { quantity: 1 }] }), 3);
  });
  it('assinatura dos avisos da Paddle', () => {
    const secret = 'pdl_ntfset_teste';
    const body = Buffer.from('{"event_id":"evt_1","event_type":"transaction.completed"}');
    const ts = 1_790_000_000;
    const h1 = createHmac('sha256', secret).update(`${ts}:${body.toString()}`).digest('hex');
    const now = ts * 1000;
    assert.equal(paddleSignatureOk(body, `ts=${ts};h1=${h1}`, secret, now), true);
    assert.equal(paddleSignatureOk(Buffer.from(`${body.toString()} `), `ts=${ts};h1=${h1}`, secret, now), false); // corpo mexido
    assert.equal(paddleSignatureOk(body, `ts=${ts};h1=${h1}`, 'outro-segredo', now), false);
    assert.equal(paddleSignatureOk(body, `ts=${ts};h1=${h1}`, secret, now + 10 * 60_000), false); // aviso velho (replay)
    assert.equal(paddleSignatureOk(body, undefined, secret, now), false);
  });
});
