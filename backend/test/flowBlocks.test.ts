import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, type SimDeps, type SimState, type SimInput } from '../src/flows/simulate';
import { applyVarOp, parseLocalDate, normalizeState, type FlowExecutor } from '../src/flows/interpreter';
import { outputsOf } from '../src/flows/types';
import { crc16, normalizePixKey, parseMoney, pixCode } from '../src/flows/pix';
import { secondsUntilWindow } from '../src/flows/timing';
import { runAiBlock, parseJsonLoose, toChatParts, pixKeyMatches, nameMatches } from '../src/flows/aiBlock';
import { sanitizeGeneratedGraph, stripForImport } from '../src/flows/aiTools';

const deps = (over: Partial<SimDeps> = {}): SimDeps => ({
  realHttp: false,
  ai: async () => 'resposta da IA',
  aiComplete: async () => 'Olá! Posso ajudar 😊',
  http: async () => ({ ok: true, status: 200, body: { pedido: { id: 'A1', total: 99.9 } } }),
  product: async (id) => (id === 'p1' ? { id: 'p1', name: 'Plano Pro', price: 497, checkoutUrl: null } : null),
  flowName: async () => 'Outro fluxo',
  departmentName: async () => 'Financeiro',
  agentName: async () => 'Sofia',
  pixelName: async () => 'Pixel Loja',
  memberName: async () => 'Bruno',
  kanbanLabel: async () => 'Vendas › Novo',
  ...over,
});

const T = () => ({ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'any_message' } });
const N = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}-${target}-${sourceHandle}`, source, target, sourceHandle });
const bots = (r: { outputs: { kind: string; text?: string }[] }) => r.outputs.filter((o) => o.kind === 'bot').map((o) => o.text);
const notes = (r: { outputs: { kind: string; text?: string }[] }) => r.outputs.filter((o) => o.kind === 'note').map((o) => o.text ?? '');

type Msg = string | SimInput | { text: string; replyId: string };
async function chat(graph: unknown, messages: Msg[], d = deps(), start: SimState | null = null) {
  let state: SimState | null = start;
  const results = [];
  for (const m of messages) {
    const input: SimInput = typeof m === 'string' ? { type: 'message', text: m }
      : 'type' in m ? m : { type: 'message', text: m.text, replyId: m.replyId };
    const r = await simulate(graph, state, input, d);
    state = r.state;
    results.push(r);
  }
  return results;
}

describe('Pix copia e cola', () => {
  it('monta o BR Code com valor, nome e CRC válido', () => {
    const code = pixCode({ type: 'email', key: 'Financeiro@Clinica.com', name: 'Clínica Sorriso Ltda', amount: 49.9, txid: 'ped123' });
    assert.ok(code.startsWith('000201'));
    assert.ok(code.includes('0014br.gov.bcb.pix'));
    assert.ok(code.includes('financeiro@clinica.com'));
    assert.ok(code.includes('540549.90'));
    assert.ok(code.includes('5920Clinica Sorriso Ltda'));
    assert.ok(code.includes('6006BRASIL'));
    assert.ok(code.includes('0506ped123'));
    assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
  });

  it('CRC16 do padrão (exemplo conhecido "123456789" = 29B1)', () => {
    assert.equal(crc16('123456789'), '29B1');
  });

  it('valida e formata as chaves', () => {
    assert.equal(normalizePixKey('cpf', '529.982.247-25'), '52998224725');
    assert.throws(() => normalizePixKey('cpf', '111.111.111-11'), /CPF/);
    assert.equal(normalizePixKey('cnpj', '11.222.333/0001-81'), '11222333000181');
    assert.equal(normalizePixKey('phone', '(11) 98888-7777'), '+5511988887777');
    assert.equal(normalizePixKey('evp', '123E4567-E89B-12D3-A456-426614174000'), '123e4567-e89b-12d3-a456-426614174000');
    assert.throws(() => normalizePixKey('evp', 'abc'), /aleatória/);
  });

  it('entende valores em reais', () => {
    assert.equal(parseMoney('49,90'), 49.9);
    assert.equal(parseMoney('R$ 1.234,56'), 1234.56);
    assert.equal(parseMoney('49.90'), 49.9);
    assert.equal(parseMoney('1.000.000'), 1000000);
    assert.ok(Number.isNaN(parseMoney('')));
  });
});

describe('horários e datas', () => {
  const tz = 'America/Sao_Paulo';
  // 2026-11-09 é segunda-feira; 12:00 em São Paulo = 15:00 UTC
  const at = (iso: string) => new Date(iso);
  it('dentro da janela = 0; antes = até abrir; depois = próximo dia útil', () => {
    const w = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    assert.equal(secondsUntilWindow(w, tz, at('2026-11-09T15:00:00Z')), 0);
    assert.equal(secondsUntilWindow(w, tz, at('2026-11-09T11:00:00Z')), 3600); // 08:00 → 09:00
    // sexta 19:00 → segunda 09:00 = 62 h
    assert.equal(secondsUntilWindow(w, tz, at('2026-11-13T22:00:00Z')), 62 * 3600);
  });
  it('janela que vira a noite', () => {
    const w = { days: [1], from: '22:00', to: '06:00' };
    assert.equal(secondsUntilWindow(w, tz, at('2026-11-10T07:00:00Z')), 0); // terça 04:00 ainda é a noite de segunda
  });
  it('lê datas no fuso da empresa', () => {
    assert.equal(parseLocalDate('2026-11-20 14:30', tz)?.toISOString(), '2026-11-20T17:30:00.000Z');
    assert.equal(parseLocalDate('20/11/2026 14:30', tz)?.toISOString(), '2026-11-20T17:30:00.000Z');
    assert.equal(parseLocalDate('xx', tz), null);
  });
});

describe('Manipulador', () => {
  it('operações', () => {
    assert.equal(applyVarOp('set', 'x', 'y'), 'y');
    assert.equal(applyVarOp('add', '10', '2,5'), '12.5');
    assert.equal(applyVarOp('subtract', '', '3'), '-3');
    assert.equal(applyVarOp('multiply', '4', '2'), '8');
    assert.equal(applyVarOp('divide', '9', '0'), '9');
    assert.equal(applyVarOp('append', 'ab', 'c'), 'abc');
    assert.equal(applyVarOp('clear', 'abc', ''), '');
  });
});

describe('saídas dos blocos novos', () => {
  it('menu com expiração, carrossel, template, distribuidor e IA', () => {
    assert.deepEqual(outputsOf({ type: 'menu', data: { options: [{ id: 'o1', title: 'A' }], expireAmount: 2, expireUnit: 'hours' } }), ['o1', 'fallback', 'timeout']);
    assert.deepEqual(outputsOf({ type: 'menu', data: { options: [{ id: 'o1', title: 'A' }], expireAmount: 0 } }), ['o1', 'fallback']);
    assert.deepEqual(outputsOf({ type: 'carousel', data: { cards: [{ buttons: [{ id: 'b1', type: 'reply' }] }, { buttons: [{ id: 'b2', type: 'reply' }] }] } }), ['b1', 'b2', 'fallback']);
    assert.deepEqual(outputsOf({ type: 'carousel', data: { cards: [{ buttons: [{ id: 'u1', type: 'url' }] }] } }), [null]);
    assert.deepEqual(outputsOf({ type: 'template', data: { timeoutAmount: 60, timeoutUnit: 'minutes', buttons: [{ type: 'QUICK_REPLY', text: 'Sim' }, { type: 'URL', text: 'Site' }] } }), ['qr_0', 'replied', 'timeout']);
    assert.deepEqual(outputsOf({ type: 'template', data: { timeoutAmount: 0 } }), [null]);
    assert.deepEqual(outputsOf({ type: 'distributor', data: { outputs: [{ id: 's1' }, { id: 's2' }] } }), ['s1', 's2']);
    assert.deepEqual(outputsOf({ type: 'ai', data: { detectReceipt: true, conditions: [{ id: 'c1', label: 'x' }] } }), ['receipt', 'c1', null, 'error']);
    assert.deepEqual(outputsOf({ type: 'ask', data: {} }), [null, 'invalid', 'timeout']);
  });
});

describe('Mensagem com vários itens', () => {
  it('texto, intervalo e contato em sequência', async () => {
    const g = {
      nodes: [T(), N('m', 'message', { items: [
        { id: 'a', type: 'text', text: 'Oi {{primeiro_nome}}!' },
        { id: 'b', type: 'interval', amount: 3, unit: 'seconds' },
        { id: 'c', type: 'text', text: 'Segue o contato:' },
        { id: 'd', type: 'contact', name: 'Suporte', phone: '+55 11 4000-0000' },
        { id: 'e', type: 'image', url: 'https://exemplo.com/a.jpg', caption: 'Foto' },
      ] })],
      edges: [E('trigger', 'm')],
    };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Oi Cliente!', 'Segue o contato:']);
    assert.ok(notes(r).some((n) => n.includes('Espera de 3 s')));
    assert.ok(r.outputs.some((o) => o.kind === 'contact' && o.name === 'Suporte' && o.phone === '+551140000000'));
    assert.ok(r.outputs.some((o) => o.kind === 'media' && o.mediaType === 'image' && o.caption === 'Foto'));
    assert.equal(r.state.status, 'end');
  });
});

describe('Delay do digitando', () => {
  it('mostra digitando antes de cada texto e depois envia, na ordem', async () => {
    const g = {
      nodes: [T(), N('m', 'message', { items: [
        { id: 'a', type: 'text', text: 'Primeira', typingSeconds: 3 },
        { id: 'b', type: 'text', text: 'Segunda' },
        { id: 'c', type: 'text', text: 'Terceira', typingSeconds: 90 },
      ] }), N('t', 'tags', { mode: 'add', tags: ['ok'] })],
      edges: [E('trigger', 'm'), E('m', 't')],
    };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Primeira', 'Segunda', 'Terceira']);
    const ns = notes(r);
    assert.ok(ns.some((n) => n.includes('Digitando… (3 s)')));
    assert.ok(ns.some((n) => n.includes('Digitando… (60 s)')), 'limite de 60 s');
    assert.ok(!ns.some((n) => n.includes('Espera de')), 'sem aviso duplicado de espera');
    const iTyping = r.outputs.findIndex((o) => o.kind === 'note' && String(o.text).includes('(3 s)'));
    const iFirst = r.outputs.findIndex((o) => o.kind === 'bot' && o.text === 'Primeira');
    assert.ok(iTyping < iFirst, 'digitando vem antes do texto');
    assert.ok(ns.some((n) => n.includes('ok')), 'segue para o próximo bloco');
  });
  it('texto vazio não espera', async () => {
    const g = { nodes: [T(), N('m', 'message', { items: [{ id: 'a', type: 'text', text: '  ', typingSeconds: 5 }, { id: 'b', type: 'text', text: 'Fim' }] })], edges: [E('trigger', 'm')] };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Fim']);
    assert.ok(!notes(r).some((n) => n.includes('Digitando')));
  });
});

describe('Delay do gravando (áudio) e intervalo aleatório', () => {
  it('mostra gravando antes do áudio e depois envia', async () => {
    const g = {
      nodes: [T(), N('m', 'message', { items: [
        { id: 'a', type: 'audio', url: 'https://ex.com/voz.ogg', recordingSeconds: 8 },
        { id: 'b', type: 'text', text: 'Depois do áudio' },
        { id: 'c', type: 'audio', url: 'https://ex.com/voz2.ogg', recordingSeconds: 500 },
      ] })],
      edges: [E('trigger', 'm')],
    };
    const [r] = await chat(g, ['oi']);
    const ns = notes(r);
    assert.ok(ns.some((n) => n.includes('Gravando áudio… (8 s)')));
    assert.ok(ns.some((n) => n.includes('Gravando áudio… (120 s)')), 'limite de 120 s');
    assert.ok(!ns.some((n) => n.includes('Espera de')), 'sem aviso duplicado de espera');
    const iRec = r.outputs.findIndex((o) => o.kind === 'note' && String(o.text).includes('(8 s)'));
    const iAudio = r.outputs.findIndex((o) => o.kind !== 'note' && JSON.stringify(o).includes('voz.ogg'));
    assert.ok(iAudio > iRec, 'gravando vem antes do áudio');
    assert.equal(r.outputs.filter((o) => o.kind !== 'note' && /voz2?\.ogg/.test(JSON.stringify(o))).length, 2, 'cada áudio enviado uma vez');
    assert.deepEqual(bots(r), ['Depois do áudio']);
  });
  it('intervalo aleatório fica dentro do mínimo e máximo', async () => {
    const { intervalSeconds } = await import('../src/flows/interpreter');
    for (const v of [0, 0.25, 0.5, 0.999]) {
      const s = intervalSeconds({ mode: 'random', min: 10, max: 40 }, () => v);
      assert.ok(s >= 10 && s <= 40, `${s}`);
    }
    assert.equal(intervalSeconds({ mode: 'random', min: 10, max: 40 }, () => 0), 10);
    assert.equal(intervalSeconds({ mode: 'random', min: 10, max: 40 }, () => 0.9999), 40);
    assert.equal(intervalSeconds({ mode: 'random', min: 50, max: 20 }, () => 0), 20, 'mínimo e máximo invertidos');
    assert.equal(intervalSeconds({ mode: 'random', min: 0, max: 999 }, () => 0.9999), 120, 'limite de 120 s');
    assert.equal(intervalSeconds({ amount: 5, unit: 'seconds' }, () => 0), 5, 'fixo continua igual');
  });
  it('na simulação avisa o valor sorteado', async () => {
    const g = { nodes: [T(), N('m', 'message', { items: [
      { id: 'a', type: 'text', text: 'Um' }, { id: 'i', type: 'interval', mode: 'random', min: 5, max: 5 }, { id: 'b', type: 'text', text: 'Dois' },
    ] })], edges: [E('trigger', 'm')] };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Um', 'Dois']);
    assert.ok(notes(r).some((n) => n.includes('Intervalo sorteado: 5 s')));
  });
});

describe('Template WhatsApp', () => {
  const g = {
    nodes: [T(), N('t', 'template', {
      name: 'confirmacao', language: 'pt_BR', paramFormat: 'positional', bodyVars: ['1'], vars: { 1: '{{primeiro_nome}}' },
      bodyText: 'Olá {{1}}, confirma a consulta?', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmo' }, { type: 'QUICK_REPLY', text: 'Remarcar' }],
      timeoutAmount: 30, timeoutUnit: 'minutes',
    }), N('ok', 'message', { text: 'Confirmado!' }), N('outra', 'message', { text: 'Outra resposta' }), N('sem', 'message', { text: 'Sem resposta' })],
    edges: [E('trigger', 't'), E('t', 'ok', 'qr_0'), E('t', 'outra', 'replied'), E('t', 'sem', 'timeout')],
  };
  it('envia com as variáveis e segue pelo botão', async () => {
    const [r1, r2] = await chat(g, ['oi', { text: 'Confirmo', replyId: 'Confirmo' }]);
    const t = r1.outputs.find((o) => o.kind === 'template');
    assert.ok(t && t.kind === 'template' && t.text === 'Olá Cliente, confirma a consulta?');
    assert.equal(r1.state.status, 'input');
    assert.equal(r1.state.canTimeout, true);
    assert.deepEqual(bots(r2), ['Confirmado!']);
  });
  it('outra resposta e sem resposta', async () => {
    const [, r2] = await chat(g, ['oi', 'pode ser amanhã?']);
    assert.deepEqual(bots(r2), ['Outra resposta']);
    const [, r3] = await chat(g, ['oi', { type: 'timeout' }]);
    assert.deepEqual(bots(r3), ['Sem resposta']);
  });
});

describe('Etiquetas, Departamento, Agente, Kanban e Controlador', () => {
  it('adiciona e remove etiquetas e registra as ações', async () => {
    const g = {
      nodes: [T(), N('t1', 'tags', { mode: 'add', tags: ['Lead quente', 'Instagram'] }), N('t2', 'tags', { mode: 'remove', tags: ['Instagram'] }),
        N('d', 'department', { departmentId: 'dep1' }), N('ag', 'ai_agent', { action: 'assign', agentId: 'a1' }),
        N('k', 'kanban', { action: 'add', boardId: 'b1', columnId: 'c1' }), N('cs', 'chat_status', { status: 'open', assignUserId: 'u1' })],
      edges: [E('trigger', 't1'), E('t1', 't2'), E('t2', 'd'), E('d', 'ag'), E('ag', 'k'), E('k', 'cs')],
    };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(r.state.contact.tags, ['Lead quente']);
    const n = notes(r).join('\n');
    assert.match(n, /Departamento do chat → Financeiro/);
    assert.match(n, /entregue ao agente “Sofia”/);
    assert.match(n, /Kanban: adicionar card → Vendas › Novo/);
    assert.match(n, /Estado do chat → Atendimento \(com Bruno\)/);
  });
});

describe('Botão PIX', () => {
  it('gera o código e o cartão', async () => {
    const g = { nodes: [T(), N('p', 'pix', { keyType: 'email', key: 'pix@loja.com', merchantName: 'Loja X', amount: '{{valor_pedido}}', text: 'Pague {{valor}} 👇' }), N('m', 'message', { text: 'Código: {{pix.valor}}' })], edges: [E('trigger', 'p'), E('p', 'm')] };
    const r = await simulate(g, null, { type: 'message', text: 'quero' }, deps());
    const pix = r.outputs.find((o) => o.kind === 'pix');
    assert.equal(pix, undefined, 'sem o valor o Pix não sai');
    assert.ok(notes(r).some((x) => x.includes('Falta o valor')));
    const g2 = { ...g, nodes: [T(), N('p', 'pix', { keyType: 'email', key: 'pix@loja.com', merchantName: 'Loja X', amount: '79,90', text: 'Pague {{valor}} 👇' }), N('m', 'message', { text: 'Ref {{pix.valor}}' })] };
    const r2 = await simulate(g2, null, { type: 'message', text: 'quero' }, deps());
    const p2 = r2.outputs.find((o) => o.kind === 'pix');
    assert.ok(p2 && p2.kind === 'pix' && p2.amount === 79.9 && p2.code.includes('pix@loja.com') && p2.text.includes('R$'));
    assert.deepEqual(bots(r2), ['Ref 79.90']);
  });
});

describe('Menu e Carrossel com expiração', () => {
  it('menu sai por inatividade', async () => {
    const g = {
      nodes: [T(), N('mn', 'menu', { text: 'Escolha', style: 'buttons', options: [{ id: 'o1', title: 'Comprar' }], expireAmount: 1, expireUnit: 'hours' }), N('x', 'message', { text: 'Sumiu?' })],
      edges: [E('trigger', 'mn'), E('mn', 'x', 'timeout')],
    };
    const [r1, r2] = await chat(g, ['oi', { type: 'timeout' }]);
    assert.equal(r1.state.canTimeout, true);
    assert.deepEqual(bots(r2), ['Sumiu?']);
  });
  it('carrossel: botão e resposta livre', async () => {
    const g = {
      nodes: [T(), N('c', 'carousel', { text: 'Planos', cards: [
        { id: 'k1', text: 'Básico', imageUrl: 'https://x.com/1.jpg', buttons: [{ id: 'b1', type: 'reply', title: 'Quero o básico' }] },
        { id: 'k2', text: 'Pro', imageUrl: 'https://x.com/2.jpg', buttons: [{ id: 'b2', type: 'reply', title: 'Quero o pro' }] },
      ] }), N('b', 'message', { text: 'Básico!' }), N('p', 'message', { text: 'Pro! {{opcao}}' }), N('f', 'message', { text: 'Toque num botão' })],
      edges: [E('trigger', 'c'), E('c', 'b', 'b1'), E('c', 'p', 'b2'), E('c', 'f', 'fallback')],
    };
    const [r1, r2] = await chat(g, ['oi', { text: 'Quero o pro', replyId: 'b2' }]);
    const car = r1.outputs.find((o) => o.kind === 'carousel');
    assert.ok(car && car.kind === 'carousel' && car.cards.length === 2);
    assert.deepEqual(bots(r2), ['Pro! Quero o pro']);
    const [, r3] = await chat(g, ['oi', 'qual a diferença?']);
    assert.deepEqual(bots(r3), ['Toque num botão']);
  });
});

describe('Aguarda Resposta', () => {
  it('salva no contato, reage e tem tempo limite', async () => {
    const g = {
      nodes: [T(), N('a', 'ask', { text: 'Qual seu nome?', saveAs: 'nome', timeoutAmount: 1, timeoutUnit: 'days', react: true, reactEmoji: '❤️', quote: true }),
        N('m', 'message', { text: 'Prazer, {{nome}}!' }), N('t', 'message', { text: 'Ficou sem tempo?' })],
      edges: [E('trigger', 'a'), E('a', 'm'), E('a', 't', 'timeout')],
    };
    const [r1, r2] = await chat(g, ['oi', 'Mariana Souza']);
    assert.equal(r1.state.canTimeout, true);
    assert.ok(r2.outputs.some((o) => o.kind === 'reaction' && o.emoji === '❤️'));
    assert.equal(r2.state.contact.name, 'Mariana Souza');
    assert.deepEqual(bots(r2), ['Prazer, Mariana Souza!']);
    const [, r3] = await chat(g, ['oi', { type: 'timeout' }]);
    assert.deepEqual(bots(r3), ['Ficou sem tempo?']);
  });
  it('bloco antigo (sem tempo) continua esperando sem limite', async () => {
    const g = { nodes: [T(), N('a', 'ask', { text: 'E aí?' })], edges: [E('trigger', 'a')] };
    const [r] = await chat(g, ['oi']);
    assert.equal(r.state.canTimeout, false);
  });
  it('buffer junta as mensagens (na simulação segue na hora)', async () => {
    const g = { nodes: [T(), N('a', 'ask', { text: 'Conta tudo', saveAs: 'relato', buffer: true, bufferSeconds: 8, timeoutAmount: 1, timeoutUnit: 'days' }), N('m', 'message', { text: '{{relato}}' })], edges: [E('trigger', 'a'), E('a', 'm')] };
    const [, r2] = await chat(g, ['oi', 'parte 1']);
    assert.ok(notes(r2).some((n) => n.includes('Buffer de mensagens (8 s)')));
    assert.deepEqual(bots(r2), ['parte 1']);
  });
});

describe('Condicional com várias regras', () => {
  const g = (logic: string) => ({
    nodes: [T(), N('c', 'condition', { logic, rules: [
      { id: 'r1', field: 'lastMessage', op: 'contains', value: 'preço' },
      { id: 'r2', field: 'name', op: 'equals', value: 'Fulano' },
    ] }), N('s', 'message', { text: 'sim' }), N('n', 'message', { text: 'não' })],
    edges: [E('trigger', 'c'), E('c', 's', 'true'), E('c', 'n', 'false')],
  });
  it('todas (e) / qualquer (ou)', async () => {
    assert.deepEqual(bots((await chat(g('all'), ['qual o preço?']))[0]), ['não']);
    assert.deepEqual(bots((await chat(g('any'), ['qual o preço?']))[0]), ['sim']);
  });
});

describe('Distribuidor', () => {
  const g = (mode: string) => ({
    nodes: [T(), N('d', 'distributor', { mode, outputs: [{ id: 's1', label: 'Ana' }, { id: 's2', label: 'Bia' }] }), N('a', 'message', { text: 'Ana' }), N('b', 'message', { text: 'Bia' })],
    edges: [E('trigger', 'd'), E('d', 'a', 's1'), E('d', 'b', 's2')],
  });
  it('rodízio: próximo a cada contato', async () => {
    const [r1, r2, r3] = await chat(g('next'), [{ type: 'start' }, { type: 'start' }, { type: 'start' }]);
    assert.deepEqual([bots(r1)[0], bots(r2)[0], bots(r3)[0]], ['Ana', 'Bia', 'Ana']);
  });
  it('prevenir repetição: o mesmo contato volta para a mesma saída', async () => {
    const [r1, r2] = await chat(g('sticky'), [{ type: 'start' }, { type: 'start' }]);
    assert.deepEqual([bots(r1)[0], bots(r2)[0]], ['Ana', 'Ana']);
  });
});

describe('Intervalo Inteligente, Pixel, Manipulador, Notificação e Venda', () => {
  it('data no passado segue na hora; intervalo com variável', async () => {
    const g = {
      nodes: [T(), N('m0', 'set_var', { name: 'espera', op: 'set', value: '2' }),
        N('d1', 'delay', { mode: 'interval', amount: '{{espera}}', unit: 'minutes' }),
        N('d2', 'delay', { mode: 'date', date: '2020-01-01 10:00' }), N('m', 'message', { text: 'fim' })],
      edges: [E('trigger', 'm0'), E('m0', 'd1'), E('d1', 'd2'), E('d2', 'm')],
    };
    const [r] = await chat(g, ['oi']);
    const n = notes(r);
    assert.ok(n.some((x) => x.includes('Espera de 2 min')));
    assert.equal(n.filter((x) => x.includes('Espera de')).length, 1);
    assert.deepEqual(bots(r), ['fim']);
  });
  it('manipulador soma, notificação formata o número e a venda preenche as variáveis', async () => {
    const g = {
      nodes: [T(), N('v1', 'set_var', { name: 'pontos', op: 'set', value: '10' }), N('v2', 'set_var', { name: 'pontos', op: 'add', value: '5' }),
        N('px', 'pixel', { pixelId: 'px1', event: 'Lead', value: '{{pontos}}', currency: 'BRL' }),
        N('no', 'notify', { name: 'Avisar dono', country: '55', phone: '(11) 97777-6666', text: 'Novo lead: {{nome}} ({{pontos}} pts)' }),
        N('s', 'sale', { productId: 'p1', customerName: '', amount: '' }),
        N('m', 'message', { text: '{{pontos}} | {{venda.valor}} | {{venda.produto}}' })],
      edges: [E('trigger', 'v1'), E('v1', 'v2'), E('v2', 'px'), E('px', 'no'), E('no', 's'), E('s', 'm')],
    };
    const [r] = await chat(g, ['oi']);
    const n = notes(r).join('\n');
    assert.match(n, /Pixel “Pixel Loja”: evento Lead · R\$\s?15,00/);
    assert.match(n, /Notificação “Avisar dono” para \+5511977776666: Novo lead: Cliente Teste \(15 pts\)/);
    assert.match(n, /Venda aprovada: R\$\s?497,00 · Plano Pro/);
    assert.equal(bots(r)[0]?.replace(/\s/g, ' '), '15 | R$ 497,00 | Plano Pro');
  });
});

describe('Integração: cabeçalhos em JSON e mapear resposta', () => {
  it('lê os campos da resposta para variáveis', async () => {
    let seen: Record<string, string> = {};
    const d = deps({ realHttp: true, http: async (req) => { seen = req.headers; return { ok: true, status: 200, body: { pedido: { id: 'A1', itens: [{ nome: 'Camiseta' }] } } }; } });
    const g = {
      nodes: [T(), N('h', 'http', { method: 'GET', url: 'https://api.exemplo.com/p/{{telefone}}', headersJson: '{"Authorization": "Bearer {{g_token}}"}',
        mappings: [{ path: 'pedido.id', var: 'id_pedido' }, { path: 'pedido.itens[0].nome', var: 'item' }] }),
      N('m', 'message', { text: '{{id_pedido}} - {{item}}' })],
      edges: [E('trigger', 'h'), E('h', 'm', 'success')],
    };
    const [r] = await chat(g, ['oi'], { ...d, extras: async () => ({ g_token: 'abc' }) });
    assert.equal(seen.Authorization, 'Bearer abc');
    assert.deepEqual(bots(r), ['A1 - Camiseta']);
  });
  it('JSON quebrado sai pela saída de erro', async () => {
    const g = { nodes: [T(), N('h', 'http', { method: 'GET', url: 'https://x.com', headersJson: '{oops' }), N('e', 'message', { text: 'erro' })], edges: [E('trigger', 'h'), E('h', 'e', 'error')] };
    const [r] = await chat(g, ['oi'], deps({ realHttp: true }));
    assert.deepEqual(bots(r), ['erro']);
  });
});

describe('Bloco de IA', () => {
  it('responde e segue pela condicional inteligente', async () => {
    const d = deps({ aiComplete: async (spec) => (spec.system.includes('condicao') ? '{"resposta":"Te passo o valor já!","condicao":2}' : 'x') });
    const g = {
      nodes: [T(), N('ai', 'ai', { prompt: 'Você vende cursos', conditions: [{ id: 'c1', label: 'Reclamação' }, { id: 'c2', label: 'Quer preço' }] }),
        N('c2m', 'message', { text: 'cond: {{ia.condicao}}' }), N('def', 'message', { text: 'padrão' })],
      edges: [E('trigger', 'ai'), E('ai', 'c2m', 'c2'), E('ai', 'def')],
    };
    const [r] = await chat(g, ['quanto custa?'], d);
    assert.deepEqual(bots(r), ['Te passo o valor já!', 'cond: Quer preço']);
  });
  it('chave própria sem chave: falha (e segue pelo caminho normal se "Falha" não estiver ligada)', async () => {
    const g = { nodes: [T(), N('ai', 'ai', { provider: 'openai', model: 'gpt-x' }), N('def', 'message', { text: 'erro: {{ia.erro}}' })], edges: [E('trigger', 'ai'), E('ai', 'def')] };
    const [r] = await chat(g, ['oi']);
    assert.match(bots(r)[0]!, /erro: informe a chave da API/);
  });
  it('identifica comprovante numa imagem (executor de teste)', async () => {
    const state = normalizeState({ mediaMsgId: 'm1', lastMessage: '' });
    const sent: string[] = [];
    const exec = {
      lastInboundMedia: async () => ({ kind: 'image', mime: 'image/jpeg', filename: null, data: Buffer.from('fake') }),
      aiComplete: async (spec: { system: string; user: { type: string }[] }) => {
        assert.ok(spec.user.some((p) => p.type === 'image'));
        return '```json\n{"comprovante": true, "valor": "149,90", "moeda": "BRL", "nome_pagador": "Ana Lima", "banco": "Nubank"}\n```';
      },
      aiAudio: async () => ({ text: '' }),
      sendText: async (t: string) => { sent.push(t); },
      note: () => {},
    } as unknown as FlowExecutor;
    const r = await runAiBlock({ detectReceipt: true }, state, exec, {});
    assert.equal(r.handle, 'receipt');
    assert.equal(state.vars.comprovante.valor, '149.90');
    assert.equal(state.vars.comprovante.nome_pagador, 'Ana Lima');
    assert.deepEqual(sent, []);
  });
  it('JSON solto e partes do pedido', () => {
    assert.deepEqual(parseJsonLoose('texto {"a":1} fim'), { a: 1 });
    assert.equal(parseJsonLoose('nada'), null);
    assert.equal(toChatParts([{ type: 'text', text: 'oi' }]), 'oi');
    const parts = toChatParts([{ type: 'text', text: 'veja' }, { type: 'image', mime: 'image/png', data: 'AAA' }]);
    assert.ok(Array.isArray(parts) && parts[1].type === 'image_url');
  });
});

describe('Comprovante: validar chave Pix e recebedor', () => {
  const run = async (receipt: Record<string, unknown>, d: Record<string, unknown>, scope: Record<string, unknown> = {}) => {
    const state = normalizeState({ mediaMsgId: 'm1', lastMessage: '' });
    const notes: string[] = [];
    const exec = {
      lastInboundMedia: async () => ({ kind: 'document', mime: 'application/pdf', filename: 'c.pdf', data: Buffer.from('fake') }),
      aiComplete: async () => JSON.stringify({ comprovante: true, valor: 15, moeda: 'BRL', ...receipt }),
      aiAudio: async () => ({ text: '' }), sendText: async () => {}, note: (t: string) => { notes.push(t); },
    } as unknown as FlowExecutor;
    const r = await runAiBlock({ detectReceipt: true, ...d }, state, exec, scope);
    return { r, state, notes };
  };
  it('chave certa e recebedor certo: Comprovante válido', async () => {
    const { r, state } = await run({ chave_pix: 'financeiro@empresa.com.br', nome_recebedor: 'EMPRESA EXEMPLO LTDA', nome_pagador: 'Ana Lima' },
      { validatePixKey: true, pixKeys: ['Financeiro@Empresa.com.br'], validateRecipient: true, recipientNames: ['Empresa Exemplo'] });
    assert.equal(r.handle, 'receipt');
    assert.equal(state.vars.comprovante.chave_ok, 'sim');
    assert.equal(state.vars.comprovante.nome_ok, 'sim');
  });
  it('chave diferente: Chave Pix errada (com o motivo)', async () => {
    const { r, state } = await run({ chave_pix: 'outro@golpe.com', nome_recebedor: 'Empresa Exemplo' },
      { validatePixKey: true, pixKeys: ['financeiro@empresa.com.br', '{{g_chave_pix}}'], validateRecipient: true, recipientNames: ['Empresa Exemplo'] }, { g_chave_pix: '11987654321' });
    assert.equal(r.handle, 'pix_wrong');
    assert.match(String(state.vars.comprovante.motivo), /outro@golpe\.com/);
  });
  it('chave pela variável (variação) e comprovante sem chave', async () => {
    const ok = await run({ chave_pix: '+55 (11) 98765-4321' }, { validatePixKey: true, pixKeys: ['x@y.com', '{{g_chave_pix}}'] }, { g_chave_pix: '11987654321' });
    assert.equal(ok.r.handle, 'receipt');
    const none = await run({ chave_pix: null }, { validatePixKey: true, pixKeys: ['x@y.com'] });
    assert.equal(none.r.handle, 'pix_wrong');
    assert.match(String(none.state.vars.comprovante.motivo), /não mostra a chave/);
  });
  it('nome errado no recebedor e no pagador: Nome errado; bate pelo pagador: válido', async () => {
    const bad = await run({ nome_recebedor: 'Fulano de Tal', nome_pagador: 'Beltrano Souza' }, { validateRecipient: true, recipientNames: ['Empresa Exemplo LTDA'] });
    assert.equal(bad.r.handle, 'name_wrong');
    const byPayer = await run({ nome_recebedor: '', nome_pagador: 'EMPRESA EXEMPLO' }, { validateRecipient: true, recipientNames: ['Empresa Exemplo LTDA'] });
    assert.equal(byPayer.r.handle, 'receipt');
  });
  it('validação ligada com lista vazia é ignorada; desligada não confere', async () => {
    assert.equal((await run({ chave_pix: 'qualquer' }, { validatePixKey: true, pixKeys: ['', ' '] })).r.handle, 'receipt');
    assert.equal((await run({ chave_pix: 'qualquer' }, { validatePixKey: false, pixKeys: ['outra@x.com'] })).r.handle, 'receipt');
  });
  it('compara chaves mascaradas e em formatos diferentes', () => {
    assert.ok(pixKeyMatches('***.456.789-**', '123.456.789-09'));
    assert.ok(pixKeyMatches('123.456.789-09', '12345678909'));
    assert.ok(!pixKeyMatches('***.456.780-**', '123.456.789-09'));
    assert.ok(pixKeyMatches('jo***@gmail.com', 'joao.silva@gmail.com'));
    assert.ok(!pixKeyMatches('ma***@gmail.com', 'joao.silva@gmail.com'));
    assert.ok(pixKeyMatches('(11) *****-4321', '+55 11 98765-4321'));
    assert.ok(pixKeyMatches('5511987654321', '(11) 98765-4321'));
    assert.ok(pixKeyMatches('7D9F0335-8DCC-4054-9BF9-0D8B2C6C1C51', '7d9f0335-8dcc-4054-9bf9-0d8b2c6c1c51'));
    assert.ok(!pixKeyMatches('***', '12345678909'), 'pouco visível não conta');
    assert.ok(pixKeyMatches('12.345.678/0001-95', '12345678000195'));
  });
  it('compara nomes com acento, abreviação e sufixo de empresa', () => {
    assert.ok(nameMatches('JOAO S SILVA', 'João Pedro Souza Silva'));
    assert.ok(nameMatches('MARIA DE FATIMA', 'Maria de Fátima'));
    assert.ok(nameMatches('EMPRESA EXEMPLO LTDA', 'Empresa Exemplo'));
    assert.ok(nameMatches('CONVERZA TECNOLOGIA', 'Converza'));
    assert.ok(!nameMatches('Carlos Pereira', 'João Silva'));
    assert.ok(!nameMatches('', 'João Silva'));
  });
});

describe('Bloco de IA: Fallback (padrão) com "Só conferir comprovante"', () => {
  const mk = (media: unknown, aiAnswer: string) => {
    const calls: string[] = []; const sent: string[] = [];
    const exec = {
      lastInboundMedia: async () => media,
      aiComplete: async (spec: { system: string }) => { calls.push(spec.system.slice(0, 20)); return aiAnswer; },
      aiAudio: async () => ({ text: '' }), sendText: async (t: string) => { sent.push(t); }, note: () => {},
    } as unknown as FlowExecutor;
    return { exec, calls, sent };
  };
  it('foto que não é comprovante: vai pro fallback sem a IA responder', async () => {
    const state = normalizeState({ mediaMsgId: 'm1', lastMessage: '' });
    const { exec, calls, sent } = mk({ kind: 'image', mime: 'image/jpeg', filename: null, data: Buffer.from('x') }, '{"comprovante": false}');
    const r = await runAiBlock({ detectReceipt: true, receiptOnly: true, prompt: 'Responda' }, state, exec, {});
    assert.equal(r.handle, null);
    assert.equal(calls.length, 1, 'só a leitura do comprovante');
    assert.deepEqual(sent, []);
    assert.equal(state.vars.comprovante.valido, 'nao');
  });
  it('só texto: fallback direto, sem gastar IA', async () => {
    const state = normalizeState({ lastMessage: 'paguei' });
    const { exec, calls, sent } = mk(null, 'x');
    const r = await runAiBlock({ detectReceipt: true, receiptOnly: true, prompt: 'Responda' }, state, exec, { resposta: 'paguei' });
    assert.equal(r.handle, null); assert.equal(calls.length, 0); assert.deepEqual(sent, []);
  });
  it('desligado: a IA responde como antes', async () => {
    const state = normalizeState({ lastMessage: 'oi' });
    const { exec, sent } = mk(null, 'Olá! Pode mandar o comprovante?');
    const r = await runAiBlock({ detectReceipt: true, prompt: 'Responda' }, state, exec, { resposta: 'oi' });
    assert.equal(r.handle, null); assert.deepEqual(sent, ['Olá! Pode mandar o comprovante?']);
  });
});

describe('IA que gera fluxo e importação', () => {
  it('gera os blocos novos e ignora os que dependem da conta', () => {
    const g = sanitizeGeneratedGraph({
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'm', type: 'message', data: { items: [{ type: 'text', text: 'Oi' }, { type: 'interval', amount: 2 }] } },
        { id: 'c', type: 'condition', data: { logic: 'any', rules: [{ field: 'lastMessage', op: 'contains', value: 'sim' }] } },
        { id: 'p', type: 'pix', data: { key: 'x' } },
      ],
      edges: [{ source: 'trigger', target: 'm' }, { source: 'm', target: 'c' }],
    });
    const types = g.nodes.map((n) => n.type);
    assert.deepEqual(types.sort(), ['condition', 'message', 'trigger']);
    const m = g.nodes.find((n) => n.type === 'message')!;
    assert.equal(m.data.items.length, 2);
    assert.equal(g.nodes.find((n) => n.type === 'condition')!.data.logic, 'any');
  });
  it('não leva segredos nem itens da outra conta', () => {
    const out = stripForImport({
      nodes: [
        { id: 'a', type: 'ai', position: { x: 0, y: 0 }, data: { apiKey: 'sk-secreta' } },
        { id: 'b', type: 'ai', position: { x: 0, y: 0 }, data: { apiKey: '{{g_openai}}' } },
        { id: 'h', type: 'http', position: { x: 0, y: 0 }, data: { headersJson: '{"Authorization":"Bearer x"}' } },
        { id: 'p', type: 'pix', position: { x: 0, y: 0 }, data: { key: 'meu@pix.com', imageFileId: 'f1' } },
        { id: 'n', type: 'notify', position: { x: 0, y: 0 }, data: { phone: '11999998888' } },
        { id: 'm', type: 'message', position: { x: 0, y: 0 }, data: { items: [{ id: 'i', type: 'image', fileId: 'f2' }] } },
      ],
      edges: [],
    });
    const d = (id: string) => out.nodes.find((n) => n.id === id)!.data;
    assert.equal(d('a').apiKey, '');
    assert.equal(d('b').apiKey, '{{g_openai}}');
    assert.equal(JSON.parse(d('h').headersJson).Authorization, '');
    assert.equal(d('p').key, '');
    assert.equal(d('p').imageFileId, '');
    assert.equal(d('n').phone, '');
    assert.equal(d('m').items[0].fileId, '');
  });
});
