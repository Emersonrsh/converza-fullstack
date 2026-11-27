import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedEntries } from '../src/whatsapp/webhookAuth';

const entry = (waba: string, phone: string) => ({ id: waba, changes: [{ value: { metadata: { phone_number_id: phone } } }] });
const conns = [
  { phoneNumberId: 'eve-phone', wabaId: 'eve-waba', appSecret: 'eve-secret' },
  { phoneNumberId: 'agencia-1', wabaId: 'ag-waba-1', appSecret: 'agencia-secret' },
  { phoneNumberId: 'agencia-2', wabaId: 'ag-waba-2', appSecret: 'agencia-secret' },
];

test('chave do app do operador autoriza todas as entradas', () => {
  const r = authorizedEntries([entry('vitima-waba', 'vitima-phone'), entry('eve-waba', 'eve-phone')], { globalOk: true, okSecrets: new Set(), conns });
  assert.equal(r.keep.length, 2);
});

test('chave de um cliente não autoriza a entrada de outra empresa no mesmo aviso', () => {
  const r = authorizedEntries([entry('eve-waba', 'eve-phone'), entry('vitima-waba', 'vitima-phone')], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  assert.deepEqual(r.keep.map((e) => e.id), ['eve-waba']);
  assert.deepEqual(r.dropped.map((e) => e.id), ['vitima-waba']);
});

test('evento de conta (sem número) só vale com a chave da conexão daquela WABA', () => {
  const ban = { id: 'vitima-waba', changes: [{ value: {} }] };
  const r = authorizedEntries([entry('eve-waba', 'eve-phone'), ban], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  assert.deepEqual(r.dropped.map((e) => e.id), ['vitima-waba']);
});

test('agência com o mesmo app em vários números: todas as entradas continuam valendo', () => {
  const r = authorizedEntries([entry('ag-waba-1', 'agencia-1'), entry('ag-waba-2', 'agencia-2')], { globalOk: false, okSecrets: new Set(['agencia-secret']), conns });
  assert.equal(r.keep.length, 2);
  assert.equal(r.dropped.length, 0);
});

test('mudança com o número de outra empresa dentro da entrada do atacante é descartada', () => {
  const forged = { id: 'eve-waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'vitima-phone' } } }] };
  const r = authorizedEntries([forged], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  assert.equal(r.keep.length, 0);
  assert.equal(r.dropped.length, 1);
});

test('account_update com o WABA da vítima não passa só porque a entrada cita o número do atacante', () => {
  const forged = { id: 'vitima-waba', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'eve-phone' } } },
    { field: 'account_update', value: {} },
  ] };
  const r = authorizedEntries([forged], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  const kept = r.keep.flatMap((e) => (e.changes ?? []).map((c) => c.field));
  assert.deepEqual(kept, ['messages']);
  assert.ok(r.dropped.some((e) => (e.changes ?? []).some((c) => c.field === 'account_update')));
});

test('account_update da própria WABA continua valendo com a chave da conexão', () => {
  const own = { id: 'eve-waba', changes: [{ field: 'account_update', value: {} }] };
  const r = authorizedEntries([own], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  assert.equal(r.keep.length, 1);
});

test('entrada mista: só as mudanças da conexão que assinou ficam', () => {
  const mixed = { id: 'eve-waba', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'eve-phone' } } },
    { field: 'messages', value: { metadata: { phone_number_id: 'vitima-phone' } } },
  ] };
  const r = authorizedEntries([mixed], { globalOk: false, okSecrets: new Set(['eve-secret']), conns });
  assert.deepEqual(r.keep[0].changes?.map((c) => c.value?.metadata?.phone_number_id), ['eve-phone']);
});
