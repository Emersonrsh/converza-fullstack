import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samePhone } from '../src/meta/banGuard';
import { alertKind } from '../src/modules/instanceAlerts';

test('samePhone: mesmo número com e sem formatação e com o 9 extra do Brasil', () => {
  assert.ok(samePhone('+55 11 4000-0000', '551140000000'));
  assert.ok(samePhone('+5511988887777', '55 11 8888-7777'));
  assert.ok(!samePhone('+5511988887777', '+5521988887777'));
  assert.ok(!samePhone('', '5511'));
});

test('alertKind: banido vem antes de caiu; sem mudança não avisa', () => {
  const base = { status: 'connected', phoneStatus: null, qualityRating: null } as any;
  assert.equal(alertKind(base, { ...base, status: 'disconnected', phoneStatus: 'BANNED' }), 'banned');
  assert.equal(alertKind(base, { ...base, status: 'disconnected' }), 'down');
  assert.equal(alertKind({ ...base, status: 'disconnected', phoneStatus: 'BANNED' }, { ...base, status: 'disconnected', phoneStatus: 'BANNED' }), null);
  assert.equal(alertKind(base, { ...base, qualityRating: 'RED' }), 'restricted');
});
