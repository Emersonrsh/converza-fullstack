import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplate, cleanMapping, conditionsMatch, detectMapping, detectPlatform, flowVars, getPath, leaves, payloadOf, renderValue, resolve,
} from '../src/modules/webhookEngine';
import { mapSaleStatus } from '../src/modules/saleParsing';
import { webhookQuotaFor } from '../src/modules/plans';

const HOTMART = {
  id: 'evt-1', event: 'PURCHASE_APPROVED', version: '2.0.0',
  data: {
    product: { id: 1, name: 'Curso de Bolos' },
    buyer: { name: 'Júlia Bolo', email: 'JULIA@EXEMPLO.COM', checkout_phone: '5511955550002', address: { state: 'SP' } },
    purchase: { transaction: 'HP123', status: 'APPROVED', price: { value: 197.5, currency_value: 'BRL' } },
  },
};
const KIWIFY = {
  order_id: 'kw-9', order_status: 'paid', webhook_event_type: 'order_approved',
  Product: { product_name: 'Mentoria' },
  Customer: { full_name: 'Marina Souza', email: 'marina@ex.com', mobile: '+5511955550001', state: 'RJ' },
  Commissions: { charge_amount: '9700', currency: 'BRL' },
};
const FORM = { form: { fields: { 'Nome Completo': 'Rafa Lima', 'WhatsApp': '(31) 98888-7777', 'E-mail': 'rafa@ex.com' } }, origem: 'site' };

describe('caminhos do JSON', () => {
  it('lê objetos, listas e chaves com ponto', () => {
    assert.equal(getPath(HOTMART, 'data.buyer.name'), 'Júlia Bolo');
    assert.equal(getPath({ items: [{ name: 'A' }, { name: 'B' }] }, 'items.1.name'), 'B');
    assert.equal(getPath({ 'e.mail': 'x@y.com' }, 'e.mail'), 'x@y.com');
    assert.equal(getPath(HOTMART, 'data.nada.aqui'), undefined);
    assert.equal(getPath(null, 'a'), undefined);
  });
  it('lista as folhas com prévia', () => {
    const l = leaves(HOTMART);
    assert.ok(l.some((x) => x.path === 'data.purchase.price.value' && x.value === '197.5' && x.kind === 'number'));
    assert.ok(!l.some((x) => x.path === 'data.buyer'), 'objetos não são folhas');
  });
});

describe('detecção automática', () => {
  it('Hotmart', () => {
    const m = detectMapping(HOTMART);
    assert.equal(m.phone, 'data.buyer.checkout_phone');
    assert.equal(m.name, 'data.buyer.name');
    assert.equal(m.email, 'data.buyer.email');
    assert.equal(m.amount, 'data.purchase.price.value');
    assert.equal(m.status, 'data.purchase.status');
    assert.equal(m.event, 'event');
    assert.equal(m.product, 'data.product.name');
    assert.equal(m.transaction, 'data.purchase.transaction');
    assert.equal(m.state, 'data.buyer.address.state');
    assert.equal(detectPlatform(HOTMART), 'Hotmart');
  });
  it('Kiwify (valor em centavos)', () => {
    const m = detectMapping(KIWIFY);
    assert.equal(m.phone, 'Customer.mobile');
    assert.equal(m.amount, 'Commissions.charge_amount');
    assert.equal(m.amountInCents, true);
    assert.equal(m.status, 'order_status');
    assert.equal(m.event, 'webhook_event_type');
    assert.equal(detectPlatform(KIWIFY), 'Kiwify');
    const r = resolve(KIWIFY, m);
    assert.equal(r.amount, 97);
    assert.equal(r.status, 'approved');
    assert.equal(r.phone, '5511955550001');
  });
  it('formulário de site (procura pelos nomes dos campos)', () => {
    const m = detectMapping(FORM);
    assert.equal(m.phone, 'form.fields.WhatsApp');
    assert.equal(m.email, 'form.fields.E-mail');
    assert.equal(m.name, 'form.fields.Nome Completo');
    assert.equal(detectPlatform(FORM), null);
    const r = resolve(FORM, m);
    assert.equal(r.name, 'Rafa Lima');
    assert.equal(r.phone, '5531988887777');
  });
});

describe('mapeamento', () => {
  it('aplica os caminhos e normaliza', () => {
    const r = resolve(HOTMART, detectMapping(HOTMART));
    assert.equal(r.phone, '5511955550002');
    assert.equal(r.email, 'julia@exemplo.com');
    assert.equal(r.amount, 197.5);
    assert.equal(r.status, 'approved');
    assert.equal(r.product, 'Curso de Bolos');
    assert.equal(r.transaction, 'HP123');
    assert.deepEqual(r.detected, []);
  });
  it('caminho salvo que não veio: o telefone é procurado sozinho; a venda não', () => {
    const r = resolve({ cliente: { celular: '11 97777-6666' }, valor: '50,00' }, { phone: 'buyer.phone', amount: 'preco' });
    assert.equal(r.phone, '5511977776666');
    assert.deepEqual(r.detected, ['phone']);
    assert.equal(r.amount, 0, 'valor com caminho escolhido não é adivinhado');
  });
  it('campos personalizados e variáveis extras', () => {
    const r = resolve(HOTMART, { phone: 'data.buyer.checkout_phone', fields: [{ key: 'cpf', path: 'data.buyer.document' }, { key: 'uf', path: 'data.buyer.address.state' }], vars: [{ name: 'pedido', path: 'data.purchase.transaction' }] });
    assert.deepEqual(r.fields, { uf: 'SP' });
    assert.deepEqual(r.vars, { pedido: 'HP123' });
    assert.equal(flowVars(r).pedido, 'HP123');
    assert.equal(flowVars(r).status_venda, 'aprovada');
  });
  it('sem telefone válido', () => {
    assert.equal(resolve({ phone: '123' }, { phone: 'phone' }).phone, null);
  });
});

describe('condições', () => {
  const r = resolve(HOTMART, detectMapping(HOTMART));
  it('igual com alternativas, sem diferenciar acentos e maiúsculas', () => {
    assert.equal(conditionsMatch([{ path: 'event', op: 'eq', value: 'purchase_complete, PURCHASE_APPROVED' }], HOTMART, r).ok, true);
    assert.equal(conditionsMatch([{ path: 'status_venda', op: 'eq', value: 'Aprovada' }], HOTMART, r).ok, true);
    const no = conditionsMatch([{ path: 'event', op: 'eq', value: 'PURCHASE_REFUNDED' }], HOTMART, r);
    assert.equal(no.ok, false);
    if (!no.ok) assert.equal(no.got, 'PURCHASE_APPROVED');
  });
  it('diferente, contém, preenchido e vazio (todas precisam bater)', () => {
    assert.equal(conditionsMatch([{ path: 'data.product.name', op: 'contains', value: 'bolo' }, { path: 'data.buyer.email', op: 'exists' }], HOTMART, r).ok, true);
    assert.equal(conditionsMatch([{ path: 'data.product.name', op: 'not_contains', value: 'bolo' }], HOTMART, r).ok, false);
    assert.equal(conditionsMatch([{ path: 'data.cupom', op: 'empty' }, { path: 'valor', op: 'neq', value: '0,00' }], HOTMART, r).ok, true);
    assert.equal(conditionsMatch([], HOTMART, r).ok, true);
  });
});

describe('variáveis e modelo', () => {
  const r = resolve(HOTMART, { ...detectMapping(HOTMART), vars: [{ name: 'pedido', path: 'data.purchase.transaction' }] });
  it('troca nomes prontos, extras e caminhos', () => {
    assert.equal(renderValue('Oi {{primeiro_nome}}! Pedido {{pedido}} de R$ {{valor}} ({{data.product.name}}){{nao_existe}}', HOTMART, r), 'Oi Júlia! Pedido HP123 de R$ 197,50 (Curso de Bolos)');
    assert.equal(renderValue('{{nome}}', HOTMART, r, 'Julinha'), 'Julinha', 'nome do contato salvo tem prioridade');
  });
  it('monta o modelo posicional com prévia e vazio vira "-"', () => {
    const t = buildTemplate({
      name: 'compra_ok', language: 'pt_BR', preview: 'Oi {{1}}, recebemos seu pedido {{2}}. {{3}}',
      header: { type: 'text', var: '1', value: '{{primeiro_nome}}' },
      body: [{ var: '1', value: '{{primeiro_nome}}' }, { var: '2', value: '{{pedido}}' }, { var: '3', value: '{{data.cupom}}' }],
      buttons: [{ index: 0, subType: 'url', value: '{{transacao}}' }],
    }, HOTMART, r);
    assert.deepEqual(t.body, [{ value: 'Júlia' }, { value: 'HP123' }, { value: '-' }]);
    assert.deepEqual(t.header, { type: 'text', value: 'Júlia' });
    assert.deepEqual(t.buttons, [{ index: 0, subType: 'url', value: 'HP123' }]);
    assert.equal(t.preview, 'Oi Júlia, recebemos seu pedido HP123. -');
    assert.deepEqual(t.empty, ['{{3}}']);
  });
  it('modelo com variáveis nomeadas', () => {
    const t = buildTemplate({ name: 'pedido_enviado', language: 'pt_BR', preview: 'Olá {{nome_cliente}}!', body: [{ var: 'nome_cliente', name: 'nome_cliente', value: '{{nome}}' }] }, HOTMART, r);
    assert.deepEqual(t.body, [{ name: 'nome_cliente', value: 'Júlia Bolo' }]);
    assert.equal(t.preview, 'Olá Júlia Bolo!');
  });
});

describe('formatos recebidos', () => {
  it('JSON em texto, lista e query', () => {
    assert.deepEqual(payloadOf('{"a":1}', {}), { a: 1 });
    assert.deepEqual(payloadOf([{ a: 2 }], {}), { a: 2 });
    assert.deepEqual(payloadOf('só texto', {}), { texto: 'só texto' });
    assert.deepEqual(payloadOf({}, { nome: 'Ana', telefone: '11999990000', signature: 'abc' }), { nome: 'Ana', telefone: '11999990000' });
    assert.deepEqual(payloadOf({ x: 1 }, { y: 2 }), { x: 1 });
  });
  it('limpa o mapeamento vindo da tela', () => {
    const m = cleanMapping({ phone: ' data.phone ', name: '', amount: 7, fields: [{ key: 'cpf', path: 'doc' }, { key: '', path: 'x' }], vars: [{ name: 'Nº Pedido', path: 'id' }, { name: 'nome', path: 'n' }], junk: 1 });
    assert.deepEqual(m, { phone: 'data.phone', fields: [{ key: 'cpf', path: 'doc' }], vars: [{ name: 'n__pedido', path: 'id' }] });
  });
});

describe('status e cota', () => {
  it('status das plataformas', () => {
    assert.equal(mapSaleStatus('chargedback chargeback'), 'refunded');
    assert.equal(mapSaleStatus('PURCHASE_EXPIRED'), 'refused');
    assert.equal(mapSaleStatus('refused order_rejected'), 'refused');
    assert.equal(mapSaleStatus('waiting_payment billet_created'), 'pending');
    assert.equal(mapSaleStatus('PURCHASE_COMPLETE'), 'approved');
  });
  it('eventos por mês: 10.000 por instância', () => {
    assert.equal(webhookQuotaFor(3, true), 30000);
    assert.equal(webhookQuotaFor(10, true), 100000);
    assert.equal(webhookQuotaFor(3, false), 0);
  });
});
