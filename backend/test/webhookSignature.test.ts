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
