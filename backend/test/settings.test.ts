import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_SCHEDULE, describeNow, isOpen, normalizeSchedule, timeVars, validTimezone } from '../src/utils/hours';
import { renameTagDeep } from '../src/utils/tagRename';
import { globalKey, toNumber } from '../src/flows/globals';
import { buildTemplatePayload } from '../src/modules/templates';
import { queueVisibility } from '../src/modules/queueRules';
import { CODE_RE, isPreviewBot, messageWithCode, stripCode, waLink } from '../src/modules/tracking';
import { estimateTranslation } from '../src/flows/aiTools';
import { localDay, sessionKeyOf } from '../src/ai/usage';
import { handleRpc, negotiateVersion, LATEST_VERSION, hashKey } from '../src/mcp/server';
import { TOOL_NAMES, mcpToolList, toolCatalog } from '../src/mcp/tools';
import { newApiKey } from '../src/modules/apiKeys';

const dialect = new PgDialect();
const toSql = (s: ReturnType<typeof queueVisibility>) => dialect.sqlToQuery(s);

describe('horários de trabalho', () => {
  it('organiza e confere a semana', () => {
    const s = normalizeSchedule({ 1: [{ start: '13:00', end: '18:00' }, { start: '09:00', end: '12:00' }], 6: [{ start: '08:00', end: '24:00' }] });
    assert.deepEqual(s[1], [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }]);
    assert.deepEqual(s[0], []);
    assert.deepEqual(s[6], [{ start: '08:00', end: '24:00' }]);
  });
  it('recusa horário invertido, sobreposto, mal escrito ou com mais de 3 intervalos', () => {
    assert.throws(() => normalizeSchedule({ 1: [{ start: '18:00', end: '09:00' }] }), /precisa ser depois/);
    assert.throws(() => normalizeSchedule({ 2: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '14:00' }] }), /se sobrepõem/);
    assert.throws(() => normalizeSchedule({ 3: [{ start: '9h', end: '12:00' }] }), /HH:MM/);
    assert.throws(() => normalizeSchedule({ 4: [1, 2, 3, 4].map((i) => ({ start: `0${i}:00`, end: `0${i}:30` })) }), /No máximo 3/);
  });
  it('aberto/fechado no fuso da empresa', () => {
    // segunda-feira, 10:30 em São Paulo = 13:30 UTC
    const mon = new Date('2026-11-09T13:30:00Z');
    assert.equal(isOpen(DEFAULT_SCHEDULE, 'America/Sao_Paulo', mon), true);
    assert.equal(isOpen(DEFAULT_SCHEDULE, 'Asia/Tokyo', mon), false); // 22:30 em Tóquio
    const sun = new Date('2026-11-08T15:00:00Z');
    assert.equal(isOpen(DEFAULT_SCHEDULE, 'America/Sao_Paulo', sun), false);
    assert.match(describeNow(DEFAULT_SCHEDULE, 'America/Sao_Paulo', mon).text, /Aberto agora — até 18:00/);
    assert.match(describeNow(DEFAULT_SCHEDULE, 'America/Sao_Paulo', sun).text, /Fechado agora — abre amanhã às 09:00/);
    assert.match(describeNow(normalizeSchedule({}), 'America/Sao_Paulo', sun).text, /nenhum horário/);
    const lateNight = normalizeSchedule({ 1: [{ start: '20:00', end: '24:00' }] });
    assert.equal(isOpen(lateNight, 'America/Sao_Paulo', new Date('2026-11-10T02:30:00Z')), true); // segunda 23:30
  });
  it('variáveis de data e hora e fuso válido', () => {
    const v = timeVars('America/Sao_Paulo', new Date('2026-11-09T13:30:00Z'));
    assert.deepEqual(v, { hora: '10:30', data: '09/11', data_completa: '09/11/2026', dia: 'segunda-feira', saudacao: 'Bom dia' });
    assert.equal(timeVars('America/Sao_Paulo', new Date('2026-11-09T22:00:00Z')).saudacao, 'Boa noite');
    assert.equal(validTimezone('Europe/Lisbon'), true);
    assert.equal(validTimezone('Mars/Olympus'), false);
  });
});

describe('renomear etiqueta em todo lugar', () => {
  it('troca em listas e condições, sem mexer no resto', () => {
    const graph = {
      nodes: [
        { type: 'action', data: { addTags: ['VIP', 'Outra'], removeTags: ['vip'] } },
        { type: 'condition', data: { field: 'tags', op: 'has_tag', value: 'Vip' } },
        { type: 'message', data: { text: 'VIP é texto, não muda' } },
      ],
    };
    const [out, n] = renameTagDeep(graph, 'vip', 'Premium');
    assert.equal(n, 3);
    assert.deepEqual(out.nodes[0].data, { addTags: ['Premium', 'Outra'], removeTags: ['Premium'] });
    assert.equal(out.nodes[1].data.value, 'Premium');
    assert.equal(out.nodes[2].data.text, 'VIP é texto, não muda');
    assert.deepEqual(renameTagDeep({ tag: 'Outra' }, 'vip', 'x'), [{ tag: 'Outra' }, 0]);
  });
});

describe('variáveis globais', () => {
  it('nome vira g_ + letras/números/_', () => {
    assert.equal(globalKey('Estoque Loja'), 'g_estoque_loja');
    assert.equal(globalKey('g_g_Cupom do Mês!'), 'g_cupom_do_mes');
    assert.equal(globalKey('  vagas  '), 'g_vagas');
    assert.equal(globalKey('???'), '');
  });
  it('número aceita vírgula e milhar', () => {
    assert.equal(toNumber('2,5'), 2.5);
    assert.equal(toNumber('1.234,5'), 1234.5);
    assert.equal(toNumber('10'), 10);
    assert.ok(Number.isNaN(toNumber('dez')));
  });
});

describe('templates WhatsApp: pedido para a Meta', () => {
  const base = {
    connectionId: '00000000-0000-0000-0000-000000000000', name: 'pedido_saiu', category: 'UTILITY' as const, language: 'pt_BR',
    header: { format: 'NONE' as const }, body: 'Olá {{1}}, seu pedido {{2}} saiu.', bodyExamples: ['Maria', '#12'], buttons: [],
  };
  it('monta cabeçalho, corpo com exemplos, rodapé e botões', () => {
    const p = buildTemplatePayload({
      ...base, footer: 'Responda SAIR para sair',
      header: { format: 'TEXT', text: 'Pedido {{1}}', example: '#12' },
      buttons: [{ type: 'QUICK_REPLY', text: 'Ok' }, { type: 'URL', text: 'Ver', url: 'https://loja.com/p/{{1}}', example: 'https://loja.com/p/12' }, { type: 'PHONE_NUMBER', text: 'Ligar', phone: '5511999990000' }],
    });
    assert.equal(p.parameter_format, 'POSITIONAL');
    assert.deepEqual(p.components[0], { type: 'HEADER', format: 'TEXT', text: 'Pedido {{1}}', example: { header_text: ['#12'] } });
    assert.deepEqual(p.components[1], { type: 'BODY', text: base.body, example: { body_text: [['Maria', '#12']] } });
    assert.deepEqual(p.components[2], { type: 'FOOTER', text: 'Responda SAIR para sair' });
    assert.deepEqual((p.components[3] as { buttons: unknown[] }).buttons, [
      { type: 'QUICK_REPLY', text: 'Ok' },
      { type: 'URL', text: 'Ver', url: 'https://loja.com/p/{{1}}', example: ['https://loja.com/p/12'] },
      { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511999990000' },
    ]);
  });
  it('cabeçalho de mídia leva o handle da amostra', () => {
    const p = buildTemplatePayload({ ...base, header: { format: 'IMAGE', handle: '4::abc' } });
    assert.deepEqual(p.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::abc'] } });
  });
  it('confere as regras da Meta', () => {
    assert.throws(() => buildTemplatePayload({ ...base, body: '{{1}}, oi' }), /começo ou no fim/);
    assert.throws(() => buildTemplatePayload({ ...base, body: 'Oi {{1}}' }), /começo ou no fim/);
    assert.throws(() => buildTemplatePayload({ ...base, body: 'Oi {{1}} ok {{3}} fim' }), /ordem/);
    assert.throws(() => buildTemplatePayload({ ...base, bodyExamples: ['Maria'] }), /exemplo de cada variável/);
    assert.throws(() => buildTemplatePayload({ ...base, body: 'Oi {{nome}} tudo bem' }), /numeradas/);
    assert.throws(() => buildTemplatePayload({ ...base, header: { format: 'TEXT', text: '{{1}} e {{2}}' } }), /no máximo uma variável/);
    assert.throws(() => buildTemplatePayload({ ...base, buttons: [{ type: 'URL', text: 'x', url: 'https://a.com/{{1}}/b' }] }), /só pode ser \{\{1\}\} no final/);
    assert.throws(() => buildTemplatePayload({ ...base, buttons: [{ type: 'URL', text: 'x', url: 'https://a.com/{{1}}' }] }), /exemplo do link/);
    const url = { type: 'URL' as const, text: 'x', url: 'https://a.com' };
    assert.throws(() => buildTemplatePayload({ ...base, buttons: [url, url, url] }), /2 botões de link/);
  });
});

describe('fila do setor', () => {
  it('dono e admin veem tudo; atendente só a fila do setor dele (e a sem setor)', () => {
    assert.equal(toSql(queueVisibility({ manager: true, departmentId: null })).sql, 'true');
    const withDept = toSql(queueVisibility({ manager: false, departmentId: 'dep-1' }));
    assert.match(withDept.sql, /v\.department_id is null or v\.department_id = \$1/);
    assert.deepEqual(withDept.params, ['dep-1']);
    const noDept = toSql(queueVisibility({ manager: false, departmentId: null }));
    assert.match(noDept.sql, /v\.assigned_user_id is not null or v\.status = 'resolved' or v\.department_id is null\)$/);
    assert.deepEqual(noDept.params, []);
  });
});

describe('links rastreáveis', () => {
  it('código no fim da mensagem, link do WhatsApp e limpeza para os gatilhos', () => {
    const t = messageWithCode('Olá! Vim pelo Instagram 😊 ', 'K7Q2MX');
    assert.equal(t, 'Olá! Vim pelo Instagram 😊 #K7Q2MX');
    assert.equal(CODE_RE.exec('oi #k7q2mx tudo bem')?.[1], 'k7q2mx');
    assert.equal(CODE_RE.exec('promo #BLACKFRIDAY'), null);
    assert.equal(CODE_RE.exec('#K7Q2M'), null);
    assert.equal(stripCode('quero saber mais #K7Q2MX', 'K7Q2MX'), 'quero saber mais');
    assert.equal(stripCode('#k7q2mx quero', 'K7Q2MX'), 'quero');
    assert.equal(waLink('+55 (11) 4000-0000', 'Oi & tchau #A'), 'https://wa.me/551140000000?text=Oi%20%26%20tchau%20%23A');
  });
  it('robôs de prévia não contam como clique', () => {
    for (const ua of ['WhatsApp/2.23.20 A', 'facebookexternalhit/1.1', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
      assert.equal(isPreviewBot(ua), true, ua);
    }
    assert.equal(isPreviewBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0'), false);
  });
});

describe('tradução: estimativa para reservar', () => {
  const graph = (texts: string[]) => ({ nodes: texts.map((t, i) => ({ id: `m${i}`, type: 'message', data: { text: t } })), edges: [] });
  it('sem texto não reserva nada; mais texto reserva mais; lotes de 40', () => {
    assert.deepEqual(estimateTranslation(graph([]) as never), { texts: 0, batches: 0, tokens: 0 });
    const small = estimateTranslation(graph(['Olá, tudo bem?']) as never);
    const big = estimateTranslation(graph(Array.from({ length: 45 }, (_, i) => `Mensagem número ${i} com um texto mais comprido para traduzir`)) as never);
    assert.equal(small.texts, 1); assert.equal(small.batches, 1);
    assert.equal(big.texts, 45); assert.equal(big.batches, 2);
    assert.ok(big.tokens > small.tokens * 10, `${big.tokens} vs ${small.tokens}`);
  });
});

describe('uso da IA', () => {
  it('agrupa por conversa ou por ferramenta do dia (no fuso da conta)', () => {
    assert.equal(sessionKeyOf({ kind: 'agent_reply', conversationId: '11111111-1111-4111-8111-111111111111' }, '2026-11-07'), 'conv:11111111-1111-4111-8111-111111111111');
    assert.equal(sessionKeyOf({ kind: 'flow_generate' }, '2026-11-07'), 'tool:flow_generate:2026-11-07');
    assert.equal(sessionKeyOf({ kind: 'agent_test', conversationId: 'não-é-uuid' }, '2026-11-07'), 'tool:agent_test:2026-11-07');
    assert.equal(localDay(new Date('2026-11-08T01:30:00Z'), 'America/Sao_Paulo'), '2026-11-07');
    assert.equal(localDay(new Date('2026-11-08T01:30:00Z'), 'UTC'), '2026-11-08');
  });
});

describe('servidor MCP', () => {
  const ctx = { accountId: 'acc', keyId: 'key', tools: ['list_contacts', 'get_contact', 'send_message'] };
  it('initialize negocia a versão e se apresenta', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx);
    assert.equal((r!.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
    assert.deepEqual((r!.result as { capabilities: unknown }).capabilities, { tools: { listChanged: false } });
    assert.equal(negotiateVersion('1999-01-01'), LATEST_VERSION);
    assert.equal(negotiateVersion(undefined), LATEST_VERSION);
  });
  it('notificação e resposta do cliente não têm resposta; método desconhecido é -32601', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', id: 9, result: {} }, ctx), null);
    assert.equal((await handleRpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, ctx))!.error!.code, -32601);
    assert.equal((await handleRpc({ jsonrpc: '1.0', id: 3, method: 'ping' }, ctx))!.error!.code, -32600);
    assert.equal((await handleRpc([1, 2], ctx))!.error!.code, -32600);
    assert.deepEqual((await handleRpc({ jsonrpc: '2.0', id: 4, method: 'ping' }, ctx))!.result, {});
  });
  it('tools/list só mostra o que a chave libera, com esquema e anotações', async () => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, ctx);
    const tools = (r!.result as { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ['list_contacts', 'get_contact', 'send_message']);
    assert.ok(tools.every((t) => t.inputSchema.type === 'object'));
    assert.equal(tools.find((t) => t.name === 'send_message')!.annotations.readOnlyHint, false);
    assert.equal(mcpToolList(TOOL_NAMES).length, 12);
    assert.equal(toolCatalog().filter((t) => t.write).length, 4);
  });
  it('tools/call: ferramenta não liberada é erro de protocolo; argumento errado e regra viram isError', async () => {
    const calls: { tool: string; ok: boolean }[] = [];
    const log = (c: { tool: string; ok: boolean }) => { calls.push(c); };
    const notAllowed = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'start_flow', arguments: {} } }, ctx, log);
    assert.equal(notAllowed!.error!.code, -32602);
    const badArgs = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_contacts', arguments: { limit: 999 } } }, ctx, log);
    assert.equal((badArgs!.result as { isError: boolean }).isError, true);
    assert.match((badArgs!.result as { content: { text: string }[] }).content[0].text, /limit/);
    const rule = await handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_contact', arguments: {} } }, ctx, log);
    assert.equal((rule!.result as { isError: boolean }).isError, true);
    assert.match((rule!.result as { content: { text: string }[] }).content[0].text, /Informe contact_id ou phone/);
    assert.deepEqual(calls.map((c) => [c.tool, c.ok]), [['list_contacts', false], ['get_contact', false]]);
  });
  it('chave: cvz_ + 32 caracteres e só o hash fica guardado', () => {
    const k = newApiKey();
    assert.match(k, /^cvz_[A-Za-z0-9_-]{32}$/);
    assert.notEqual(newApiKey(), k);
    assert.match(hashKey(k), /^[0-9a-f]{64}$/);
    assert.equal(hashKey(k), hashKey(k));
  });
});
