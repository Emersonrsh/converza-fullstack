import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneVariants, isEmail } from '../src/utils/phone';
import { normHeader, parseCsv, parseMoney, toCsv } from '../src/utils/csv';
import { cleanCustom, cleanTags, readImport, type FieldDef } from '../src/modules/contactImport';

const FIELDS: FieldDef[] = [
  { key: 'cpf', label: 'CPF', type: 'text', options: [] },
  { key: 'plano', label: 'Plano', type: 'select', options: ['Básico', 'Pro'] },
  { key: 'nascimento', label: 'Nascimento', type: 'date', options: [] },
  { key: 'filhos', label: 'Filhos', type: 'number', options: [] },
];

describe('telefone', () => {
  it('normaliza números brasileiros digitados de vários jeitos', () => {
    assert.equal(normalizePhone('(11) 98888-7777'), '5511988887777');
    assert.equal(normalizePhone('11 3333-4444'), '551133334444');
    assert.equal(normalizePhone('+55 21 97777-6666'), '5521977776666');
    assert.equal(normalizePhone('5511988887777'), '5511988887777');
    assert.equal(normalizePhone('0055 11 98888 7777'), '5511988887777');
    assert.equal(normalizePhone('011 98888-7777'), '5511988887777'); // 0 de discagem
    assert.equal(normalizePhone('0 21 11 98888-7777'), '5511988887777'); // 0 + operadora
    assert.equal(normalizePhone('11988887777.0'), '5511988887777'); // número decimal vindo de planilha
    assert.equal(normalizePhone('5511988887777,00'), '5511988887777');
  });
  it('mantém números de outros países quando vêm com + ou 00', () => {
    assert.equal(normalizePhone('+1 415 555 2671'), '14155552671');
    assert.equal(normalizePhone('001 415 555 2671'), '14155552671');
    assert.equal(normalizePhone('+351 912 345 678'), '351912345678');
  });
  it('recusa o que não é telefone', () => {
    for (const v of ['', '123', 'abc', '1234567', null, undefined, '+1234567890123456']) assert.equal(normalizePhone(v), null, String(v));
  });
  it('variações com e sem o 9 dos celulares brasileiros', () => {
    assert.deepEqual(phoneVariants('5511988887777'), ['5511988887777', '551188887777']);
    assert.deepEqual(phoneVariants('551188887777'), ['551188887777', '5511988887777']);
    assert.deepEqual(phoneVariants('551133334444'), ['551133334444']); // fixo
    assert.deepEqual(phoneVariants('14155552671'), ['14155552671']); // outro país
  });
  it('e-mail', () => {
    assert.ok(isEmail('maria@exemplo.com.br'));
    for (const v of ['maria@', 'maria@x', 'maria exemplo.com', '@x.com']) assert.ok(!isEmail(v), v);
  });
});

describe('CSV', () => {
  it('detecta ; , e tab, com aspas, aspas escapadas e quebra de linha dentro do campo', () => {
    assert.deepEqual(parseCsv('nome;telefone\r\nAna;11\r\n'), [['nome', 'telefone'], ['Ana', '11']]);
    assert.deepEqual(parseCsv('nome,telefone\nAna,11'), [['nome', 'telefone'], ['Ana', '11']]);
    assert.deepEqual(parseCsv('nome\ttelefone\nAna\t11'), [['nome', 'telefone'], ['Ana', '11']]);
    assert.deepEqual(parseCsv('a;b\n"x;y";"diz ""oi""\nlinha 2"'), [['a', 'b'], ['x;y', 'diz "oi"\nlinha 2']]);
  });
  it('ignora BOM e linhas em branco', () => {
    assert.deepEqual(parseCsv('﻿nome;telefone\n\n;\nAna;11\n\n'), [['nome', 'telefone'], ['Ana', '11']]);
  });
  it('o que exporta volta igual na leitura', () => {
    const data = [['Maria; Souza', '5511988887777', 'Disse "olá"\nE foi embora', '1.500,00']];
    const csv = toCsv(['nome', 'telefone', 'anotacoes', 'valor'], data);
    assert.ok(csv.startsWith('﻿'));
    assert.deepEqual(parseCsv(csv), [['nome', 'telefone', 'anotacoes', 'valor'], ...data]);
  });
  it('cabeçalhos sem acento/espaço e valores em reais', () => {
    assert.equal(normHeader('Anotações'), 'anotacoes');
    assert.equal(normHeader(' E-mail '), 'email');
    assert.equal(normHeader('Etapa do funil'), 'etapadofunil');
    assert.equal(parseMoney('1.234,56'), 1234.56);
    assert.equal(parseMoney('R$ 97,90'), 97.9);
    assert.equal(parseMoney('2.500'), 2500);
    assert.equal(parseMoney('10.000.000'), 10000000);
    assert.equal(parseMoney('1234.5'), 1234.5);
    for (const v of ['', 'abc', '-5', '1,2,3']) assert.ok(Number.isNaN(parseMoney(v)), v);
  });
});

describe('campos personalizados e etiquetas', () => {
  it('valida tipo, aceita data dd/mm/aaaa e opção sem diferenciar maiúsculas', () => {
    assert.deepEqual(cleanCustom(FIELDS, { cpf: ' 123 ', plano: 'pro', nascimento: '25/12/1990', filhos: '2' }, true),
      { cpf: '123', plano: 'Pro', nascimento: '1990-12-25', filhos: '2' });
    assert.deepEqual(cleanCustom(FIELDS, { cpf: '' }, true), { cpf: null }); // vazio = apagar
    assert.throws(() => cleanCustom(FIELDS, { plano: 'Ouro' }, true), /escolha uma das opções/);
    assert.throws(() => cleanCustom(FIELDS, { nascimento: '31/02/abc' }, true), /data inválida/);
    assert.throws(() => cleanCustom(FIELDS, { inexistente: 'x' }, true), /não existe/);
    assert.deepEqual(cleanCustom(FIELDS, { plano: 'Ouro', inexistente: 'x', cpf: '9' }, false), { cpf: '9' });
  });
  it('etiquetas sem repetição (ignora maiúsculas) e no máximo 30', () => {
    assert.deepEqual(cleanTags([' VIP', 'vip', 'Retorno', '']), ['VIP', 'Retorno']);
    assert.equal(cleanTags(Array.from({ length: 40 }, (_, i) => `t${i}`))!.length, 30);
    assert.equal(cleanTags(undefined), undefined);
  });
});

describe('importação de CSV', () => {
  const csv = [
    'Nome;Celular;E-mail;Tags;Etapa do funil;Valor;Observações;CPF;Plano;Nascimento',
    'Maria;(11) 98888-7777;maria@x.com;;Negociação;1.500,00;Liga à tarde;111;pro;01/02/1985',
    'Sem fone;;a@b.com;;;;;;;',
    'Email ruim;11 97777-0000;maria@;;;;;;;',
    'Etapa ruim;11 97777-0001;;;Fechado;;;;;',
    'Valor ruim;11 97777-0002;;;;dez reais;;;;',
    'Plano ruim;11 97777-0003;;;;;;;Ouro;',
    'Excel;5,51199E+12;;;;;;;;',
    'João;11 96666-5555;;VIP, Retorno;;;;;;',
    'João Atualizado;5511966665555;;VIP|Novo;Ganho;;;;Básico;',
    'Maria sem 9;551188887777;;Antiga;;;;;;',
  ].join('\r\n');
  const r = readImport(csv, FIELDS, ['Lista']);

  it('lê as colunas pelos apelidos e normaliza os valores', () => {
    const maria = r.rows.find((x) => x.phone === '5511988887777')!;
    assert.equal(maria.name, 'Maria sem 9'); // a linha com o número sem o 9 é a mesma pessoa
    assert.equal(maria.email, 'maria@x.com');
    assert.equal(maria.stage, 'negotiating');
    assert.equal(maria.value, 1500);
    assert.equal(maria.notes, 'Liga à tarde');
    assert.deepEqual(maria.custom, { cpf: '111', plano: 'Pro', nascimento: '1985-02-01' });
    assert.deepEqual(maria.tags, ['Lista', 'Antiga']); // sem etiqueta na linha → padrão; depois soma a da outra linha
  });
  it('junta linhas repetidas do mesmo telefone', () => {
    const joao = r.rows.filter((x) => x.phone === '5511966665555');
    assert.equal(joao.length, 1);
    assert.equal(joao[0].name, 'João Atualizado');
    assert.equal(joao[0].stage, 'won');
    assert.deepEqual(joao[0].tags, ['VIP', 'Retorno', 'Novo']);
    assert.deepEqual(joao[0].custom, { plano: 'Básico' });
    assert.equal(r.rows.length, 2);
    assert.equal(r.total, 10);
  });
  it('explica o erro de cada linha recusada', () => {
    const by = Object.fromEntries(r.errors.map((e) => [e.line, e.reason]));
    assert.equal(by[3], 'sem telefone');
    assert.match(by[4], /e-mail inválido/);
    assert.match(by[5], /etapa desconhecida/);
    assert.match(by[6], /valor inválido/);
    assert.match(by[7], /Plano: escolha uma das opções/);
    assert.match(by[8], /notação científica.*Texto/);
    assert.equal(r.errors.length, 6);
  });
  it('sem coluna de telefone ou arquivo vazio', () => {
    assert.throws(() => readImport('nome;email\nAna;a@b.com', FIELDS, []), /coluna de telefone/);
    assert.throws(() => readImport('', FIELDS, []), /vazio/);
  });
});
