import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, cycleOf } from '../src/utils/cycle';
import { optKeyword } from '../src/utils/optout';
import { DISPATCH_PACKS, dispatchQuotaFor } from '../src/modules/plans';

const d = (s: string) => new Date(s);

describe('ciclo da assinatura', () => {
  it('soma meses sem estourar o dia', () => {
    assert.equal(addMonths(d('2026-01-31T12:00:00Z'), 1).toISOString(), '2026-02-28T12:00:00.000Z');
    assert.equal(addMonths(d('2028-01-31T12:00:00Z'), 1).toISOString(), '2028-02-29T12:00:00.000Z');
    assert.equal(addMonths(d('2026-03-15T00:00:00Z'), -1).toISOString(), '2026-02-15T00:00:00.000Z');
    assert.equal(addMonths(d('2026-12-10T00:00:00Z'), 1).toISOString(), '2027-01-10T00:00:00.000Z');
  });
  it('do mês anterior ao vencimento até ele', () => {
    const c = cycleOf(d('2026-11-20T15:00:00Z'), d('2026-11-06T12:00:00Z'));
    assert.equal(c.start.toISOString(), '2026-10-20T15:00:00.000Z');
    assert.equal(c.end.toISOString(), '2026-11-20T15:00:00.000Z');
    assert.equal(c.key, '2026-10-20');
  });
  it('vencimento que passou sem renovar: segue em ciclos mensais', () => {
    const c = cycleOf(d('2026-09-01T00:00:00Z'), d('2026-11-06T12:00:00Z'));
    assert.equal(c.key, '2026-11-01');
    assert.equal(c.end.toISOString(), '2026-12-01T00:00:00.000Z');
  });
  it('vencimento muito à frente (plano anual): ciclo mensal até ele', () => {
    const c = cycleOf(d('2027-03-10T00:00:00Z'), d('2026-11-06T12:00:00Z'));
    assert.equal(c.key, '2026-10-10');
    assert.equal(c.end.toISOString(), '2026-11-10T00:00:00.000Z');
  });
  it('sem vencimento: o mês do calendário', () => {
    const c = cycleOf(null, d('2026-11-06T12:00:00Z'));
    assert.equal(c.key, '2026-11-01');
    assert.equal(c.end.toISOString(), '2026-12-01T00:00:00.000Z');
  });
});

describe('sair e voltar dos disparos', () => {
  it('só a mensagem inteira vale', () => {
    for (const t of ['SAIR', 'Sair!', 'parar', 'PARAR PROMOÇÕES', 'Não quero mais', 'stop', ' Descadastrar ']) assert.equal(optKeyword(t), 'out', t);
    for (const t of ['VOLTAR', 'quero receber', 'Reativar']) assert.equal(optKeyword(t), 'in', t);
    for (const t of ['vou sair às 18h', 'pode parar de mandar áudio?', 'oi', '', null, 'quero voltar amanhã']) assert.equal(optKeyword(t), null, String(t));
  });
});

describe('cota e pacotes', () => {
  it('disparos por ciclo: 1.000 por instância', () => {
    assert.equal(dispatchQuotaFor(1, true), 1000);
    assert.equal(dispatchQuotaFor(5, true), 5000);
    assert.equal(dispatchQuotaFor(20, true), 20000);
    assert.equal(dispatchQuotaFor(5, false), 0);
  });
  it('pacotes extras', () => {
    assert.deepEqual(DISPATCH_PACKS.map((p) => [p.quantity, p.price]), [[1000, 29.9], [10000, 90]]);
  });
});
