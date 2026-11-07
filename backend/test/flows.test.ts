import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, type SimDeps, type SimState } from '../src/flows/simulate';
import { runFrom, triggerMatches, render, normalizeState, type FlowExecutor } from '../src/flows/interpreter';
import { normalizeGraph } from '../src/flows/types';
import { safeHttpRequest, isBlockedIp } from '../src/flows/http';
import { sanitizeGeneratedGraph, stripForImport } from '../src/flows/aiTools';

const deps = (over: Partial<SimDeps> = {}): SimDeps => ({
  realHttp: false,
  ai: async () => 'resposta da IA',
  http: async () => ({ ok: true, status: 200, body: { cidade: 'São Paulo' } }),
  product: async (id) => (id === 'p1' ? { id: 'p1', name: 'Plano Pro', price: 497, checkoutUrl: 'https://pay.exemplo.com/pro' } : null),
  flowName: async () => 'Pós-venda',
  ...over,
});

const T = (data: Record<string, unknown> = {}) => ({ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { type: 'any_message', ...data } });
const N = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const E = (source: string, target: string, sourceHandle: string | null = null) => ({ id: `${source}-${target}-${sourceHandle}`, source, target, sourceHandle });
const bots = (r: { outputs: { kind: string; text?: string }[] }) => r.outputs.filter((o) => o.kind === 'bot').map((o) => o.text);

async function chat(graph: unknown, messages: (string | { type: 'payment'; paid: boolean } | { text: string; replyId: string })[], d = deps()) {
  let state: SimState | null = null;
  const results = [];
  for (const m of messages) {
    const input = typeof m === 'string' ? { type: 'message' as const, text: m }
      : 'paid' in m ? m : { type: 'message' as const, text: m.text, replyId: m.replyId };
    const r = await simulate(graph, state, input, d);
    state = r.state;
    results.push(r);
  }
  return results;
}

describe('blocos básicos', () => {
  it('mensagem com variáveis e fim', async () => {
    const g = { nodes: [T(), N('m', 'message', { text: 'Olá {{primeiro_nome}}! Você disse: {{resposta}}' })], edges: [E('trigger', 'm')] };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Olá Cliente! Você disse: oi']);
    assert.equal(r.state.status, 'end');
    assert.deepEqual(r.visited, ['trigger', 'm']);
  });

  it('pergunta valida e-mail, tenta de novo e salva a variável', async () => {
    const g = {
      nodes: [T(), N('a', 'ask', { text: 'Qual seu e-mail?', saveAs: 'email', validation: 'email' }), N('m', 'message', { text: 'Recebi {{email}}' })],
      edges: [E('trigger', 'a'), E('a', 'm')],
    };
    const [r1, r2, r3] = await chat(g, ['oi', 'não sei', 'Ana@Exemplo.com']);
    assert.deepEqual(bots(r1), ['Qual seu e-mail?']);
    assert.equal(r1.state.status, 'input');
    assert.match(bots(r2)[0]!, /e-mail não parece válido/);
    assert.equal(r2.state.status, 'input');
    assert.deepEqual(bots(r3), ['Recebi ana@exemplo.com']);
    assert.equal(r3.state.status, 'end');
  });

  it('pergunta sai pela saída "inválida" após esgotar tentativas', async () => {
    const g = {
      nodes: [T(), N('a', 'ask', { text: 'Idade?', validation: 'number', maxRetries: 1 }), N('ok', 'message', { text: 'ok' }), N('bad', 'message', { text: 'vou te passar para alguém' })],
      edges: [E('trigger', 'a'), E('a', 'ok'), E('a', 'bad', 'invalid')],
    };
    const res = await chat(g, ['oi', 'abc', 'xyz']);
    assert.deepEqual(bots(res[2]), ['vou te passar para alguém']);
  });

  it('menu reconhece número, título e id do botão; outro → fallback', async () => {
    const g = {
      nodes: [T(), N('menu', 'menu', { text: 'Como posso ajudar?', options: [{ id: 'o1', title: 'Comprar' }, { id: 'o2', title: 'Suporte' }] }),
        N('c', 'message', { text: 'vendas' }), N('s', 'message', { text: 'suporte' }), N('f', 'message', { text: 'não entendi' })],
      edges: [E('trigger', 'menu'), E('menu', 'c', 'o1'), E('menu', 's', 'o2'), E('menu', 'f', 'fallback')],
    };
    assert.deepEqual(bots((await chat(g, ['oi', '2']))[1]), ['suporte']);
    assert.deepEqual(bots((await chat(g, ['oi', 'comprar']))[1]), ['vendas']);
    assert.deepEqual(bots((await chat(g, ['oi', { text: 'qualquer', replyId: 'o1' }]))[1]), ['vendas']);
    assert.deepEqual(bots((await chat(g, ['oi', 'banana']))[1]), ['não entendi']);
    const [first] = await chat(g, ['oi']);
    assert.equal(first.outputs.find((o) => o.kind === 'menu')?.kind, 'menu');
  });

  it('menu sem fallback reenvia as opções e depois encerra', async () => {
    const g = {
      nodes: [T(), N('menu', 'menu', { text: 'Escolha', options: [{ id: 'o1', title: 'Sim' }] })],
      edges: [E('trigger', 'menu')],
    };
    const res = await chat(g, ['oi', 'talvez', 'hein']);
    assert.equal(res[1].state.status, 'input');
    assert.ok(res[1].outputs.some((o) => o.kind === 'menu'));
    assert.equal(res[2].state.status, 'end');
  });

  it('condição com alternativas separadas por vírgula', async () => {
    const g = {
      nodes: [T(), N('c', 'condition', { field: 'lastMessage', op: 'contains', value: 'sim, quero' }), N('y', 'message', { text: 'SIM' }), N('n', 'message', { text: 'NAO' })],
      edges: [E('trigger', 'c'), E('c', 'y', 'true'), E('c', 'n', 'false')],
    };
    assert.deepEqual(bots((await chat(g, ['Eu QUERO!']))[0]), ['SIM']);
    assert.deepEqual(bots((await chat(g, ['agora não']))[0]), ['NAO']);
  });

  it('ações alteram etapa e etiquetas; condição lê etiqueta', async () => {
    const g = {
      nodes: [T(), N('a', 'action', { setStage: 'negotiating', addTags: ['Lead quente'] }),
        N('c', 'condition', { field: 'tags', op: 'has_tag', value: 'lead quente' }), N('y', 'message', { text: 'tem tag' })],
      edges: [E('trigger', 'a'), E('a', 'c'), E('c', 'y', 'true')],
    };
    const [r] = await chat(g, ['oi']);
    assert.equal(r.state.contact.stage, 'negotiating');
    assert.deepEqual(r.state.contact.tags, ['Lead quente']);
    assert.deepEqual(bots(r), ['tem tag']);
  });

  it('ação de Kanban aparece na simulação (e avisa se o quadro não existe mais)', async () => {
    const b = '11111111-1111-1111-1111-111111111111'; const c = '22222222-2222-2222-2222-222222222222';
    const g = { nodes: [T(), N('a', 'action', { kanbanBoardId: b, kanbanColumnId: c })], edges: [E('trigger', 'a')] };
    const notes = (r: { outputs: { kind: string; text?: string }[] }) => r.outputs.filter((o) => o.kind === 'note').map((o) => o.text).join(' | ');
    const [ok] = await chat(g, ['oi'], deps({ kanbanLabel: async (bb: string, cc: string) => (bb === b && cc === c ? 'Vendas › Qualificação' : null) }));
    assert.match(notes(ok), /Kanban → Vendas › Qualificação/);
    const [gone] = await chat(g, ['oi'], deps({ kanbanLabel: async () => null }));
    assert.match(notes(gone), /não existe mais/);
  });

  it('ação salva campo personalizado do contato e ele vira variável {{campos.chave}}', async () => {
    const g = {
      nodes: [T(), N('q', 'ask', { text: 'Qual o seu CPF?', saveAs: 'cpf', validation: 'none' }),
        N('a', 'action', { setFields: [{ key: 'cpf', value: '{{cpf}}' }] }), N('m', 'message', { text: 'CPF salvo: {{campos.cpf}} · {{email}}' })],
      edges: [E('trigger', 'q'), E('q', 'a'), E('a', 'm')],
    };
    const [, r] = await chat(g, ['oi', '123.456.789-00']);
    assert.deepEqual(r.state.contact.custom, { cpf: '123.456.789-00' });
    assert.deepEqual(bots(r), ['CPF salvo: 123.456.789-00 · ']);
  });

  it('espera é pulada na simulação e o fluxo continua', async () => {
    const g = { nodes: [T(), N('d', 'delay', { amount: 2, unit: 'hours' }), N('m', 'message', { text: 'voltei' })], edges: [E('trigger', 'd'), E('d', 'm')] };
    const [r] = await chat(g, ['oi']);
    assert.ok(r.outputs.some((o) => o.kind === 'note' && /2 h/.test((o as { text: string }).text)));
    assert.deepEqual(bots(r), ['voltei']);
  });

  it('pagamento envia link do produto e segue por pago / não pago', async () => {
    const g = {
      nodes: [T(), N('p', 'payment', { productId: 'p1', text: 'Seu link do {{produto}} ({{preco}}): {{link}}', wait: true, timeoutMinutes: 30 }),
        N('ok', 'message', { text: 'pago!' }), N('no', 'message', { text: 'esqueceu?' })],
      edges: [E('trigger', 'p'), E('p', 'ok', 'paid'), E('p', 'no', 'unpaid')],
    };
    const [r1, r2] = await chat(g, ['oi', { type: 'payment', paid: true }]);
    assert.match(bots(r1)[0]!, /Plano Pro .*R\$\s?497,00.*https:\/\/pay\.exemplo\.com\/pro/);
    assert.equal(r1.state.status, 'payment');
    assert.deepEqual(bots(r2), ['pago!']);
    const [, r3] = await chat(g, ['oi', { type: 'payment', paid: false }]);
    assert.deepEqual(bots(r3), ['esqueceu?']);
  });

  it('IA responde e classifica', async () => {
    const g = {
      nodes: [T(), N('cl', 'ai_classify', { categories: [{ id: 'c1', label: 'Dúvida' }, { id: 'c2', label: 'Comprar' }] }),
        N('r', 'ai_reply', { prompt: 'Venda o produto' }), N('d', 'message', { text: 'duvida' })],
      edges: [E('trigger', 'cl'), E('cl', 'd', 'c1'), E('cl', 'r', 'c2')],
    };
    const calls: string[] = [];
    const d = deps({ ai: async (req) => { calls.push(req.system); return req.maxTokens === 10 ? '2' : 'Compre agora 🚀'; } });
    const [r] = await chat(g, ['quero comprar'], d);
    assert.deepEqual(bots(r), ['Compre agora 🚀']);
    assert.equal(calls.length, 2);
    assert.equal(r.state.run.vars.categoria, 'Comprar');
  });

  it('IA indisponível usa a mensagem de fallback', async () => {
    const g = { nodes: [T(), N('r', 'ai_reply', { prompt: 'x', fallbackText: 'Já te respondo!' })], edges: [E('trigger', 'r')] };
    const [r] = await chat(g, ['oi'], deps({ ai: async () => { throw new Error('Sem saldo'); } }));
    assert.deepEqual(bots(r), ['Já te respondo!']);
  });

  it('HTTP salva a resposta e permite usar {{http.campo}}', async () => {
    const g = {
      nodes: [T(), N('h', 'http', { method: 'GET', url: 'https://api.exemplo.com/cep/{{resposta}}', saveAs: 'cep' }),
        N('ok', 'message', { text: 'Cidade: {{cep.cidade}}' }), N('err', 'message', { text: 'erro' })],
      edges: [E('trigger', 'h'), E('h', 'ok', 'success'), E('h', 'err', 'error')],
    };
    let url = '';
    const [r] = await chat(g, ['01001 000'], deps({ realHttp: true, http: async (req) => { url = req.url; return { ok: true, status: 200, body: { cidade: 'São Paulo' } }; } }));
    assert.equal(url, 'https://api.exemplo.com/cep/01001%20000');
    assert.deepEqual(bots(r), ['Cidade: São Paulo']);
  });

  it('transferência e ir para fluxo aparecem como notas', async () => {
    const g = { nodes: [T(), N('h', 'handoff', { message: 'Chamando um atendente' }), N('g', 'goto_flow', { flowId: 'x' })], edges: [E('trigger', 'h'), E('h', 'g')] };
    const [r] = await chat(g, ['oi']);
    assert.deepEqual(bots(r), ['Chamando um atendente']);
    assert.ok(r.outputs.some((o) => o.kind === 'note' && /Pós-venda/.test((o as { text: string }).text)));
  });

  it('laço sem espera é interrompido', async () => {
    const g = { nodes: [T(), N('a', 'message', { text: 'a' }), N('b', 'message', { text: 'b' })], edges: [E('trigger', 'a'), E('a', 'b'), E('b', 'a')] };
    const [r] = await chat(g, ['oi']);
    assert.ok(r.outputs.some((o) => o.kind === 'note' && /laço/.test((o as { text: string }).text)));
    assert.equal(r.state.status, 'end');
  });
});

describe('gatilhos', () => {
  it('palavra-chave sem acento e por palavra inteira', () => {
    const t = { type: 'keyword', keywords: 'preço, valor' };
    assert.equal(triggerMatches(t, { source: 'inbound_message', text: 'Qual o PRECO?' }), true);
    assert.equal(triggerMatches(t, { source: 'inbound_message', text: 'quero saber valores' }), false);
    assert.equal(triggerMatches({ type: 'keyword', keywords: 'oi' }, { source: 'inbound_message', text: 'o boi fugiu' }), false);
    assert.equal(triggerMatches({ type: 'keyword', keywords: 'oi', match: 'exact' }, { source: 'inbound_message', text: ' Oi ' }), true);
  });
  it('primeira mensagem, webhook e conexão', () => {
    assert.equal(triggerMatches({ type: 'first_message' }, { source: 'inbound_message', text: 'x', isFirstMessage: false }), false);
    assert.equal(triggerMatches({ type: 'webhook', webhookId: 'w1' }, { source: 'webhook', text: '', webhookId: 'w2' }), false);
    assert.equal(triggerMatches({ type: 'webhook' }, { source: 'webhook', text: '', webhookId: 'w2' }), true);
    assert.equal(triggerMatches({ type: 'any_message', connectionId: 'c1' }, { source: 'inbound_message', text: 'x', connectionId: 'c2' }), false);
  });
  it('simulação respeita a palavra-chave', async () => {
    const g = { nodes: [T({ type: 'keyword', keywords: 'promo' }), N('m', 'message', { text: 'Promoção!' })], edges: [E('trigger', 'm')] };
    const [miss] = await chat(g, ['oi']);
    assert.equal(bots(miss).length, 0);
    const [hit] = await chat(g, ['tem promo?']);
    assert.deepEqual(bots(hit), ['Promoção!']);
  });
});

describe('estatísticas', () => {
  it('conta entradas e avanços por bloco', async () => {
    const enter: string[] = [];
    const adv: string[] = [];
    const exec = {
      getContact: async () => ({ name: 'A', phone: '1', stage: 'new', tags: [] }),
      sendText: async () => {}, sendMedia: async () => {}, sendMenu: async () => {}, setStage: async () => {}, moveToKanban: async () => {}, setContactField: async () => {},
      addTag: async () => {}, removeTag: async () => {}, setContactName: async () => {}, handoff: async () => {},
      gotoFlow: async () => {}, http: async () => ({ ok: true, status: 200, body: null }), ai: async () => '',
      getProduct: async () => null, onEnter: (id: string) => { enter.push(id); }, onAdvance: (id: string) => { adv.push(id); },
      note: () => {}, random: () => 0.1,
    } satisfies FlowExecutor;
    const g = normalizeGraph({
      nodes: [T(), N('r', 'random', { percentA: 50 }), N('a', 'message', { text: 'A' }), N('b', 'message', { text: 'B' })],
      edges: [E('trigger', 'r'), E('r', 'a', 'a'), E('r', 'b', 'b')],
    });
    const halt = await runFrom(g, 'trigger', normalizeState({}), exec);
    assert.equal(halt.kind, 'end');
    assert.deepEqual(enter, ['trigger', 'r', 'a']);
    assert.deepEqual(adv, ['trigger', 'r', 'a']); // o último bloco conclui o fluxo = avanço
  });
});

describe('utilitários', () => {
  it('normaliza grafos do formato antigo', () => {
    const g = normalizeGraph({ nodes: [{ id: 't', type: 'trigger', x: 10, y: 20, data: { type: 'inbound_message' } }, { id: 'c', type: 'condition' }], edges: [{ source: 't', target: 'c', branch: 'true' }, { source: 't', target: 'zz' }] });
    assert.deepEqual(g.nodes[0].position, { x: 10, y: 20 });
    assert.equal(g.nodes[0].data.type, 'any_message');
    assert.equal(g.edges.length, 1);
    assert.equal(g.edges[0].sourceHandle, 'true');
  });
  it('render com caminho e escape', () => {
    assert.equal(render('{{a.b}}-{{x}}', { a: { b: 7 } }), '7-');
    assert.equal(render('{"n":"{{v}}"}', { v: 'a"b' }, (s) => JSON.stringify(s).slice(1, -1)), '{"n":"a\\"b"}');
  });
  it('sanitiza fluxo gerado pela IA', () => {
    const g = sanitizeGeneratedGraph({
      nodes: [
        { id: 'trigger', type: 'trigger', data: { type: 'keyword', keywords: 'oi' } },
        { id: 'n1', type: 'menu', data: { text: 'Opções', options: [{ id: 'o1', title: 'Um título bem comprido demais para botão' }] } },
        { id: 'n2', type: 'hack', data: {} },
        { id: 'n3', type: 'message', data: { text: 'ok' } },
      ],
      edges: [{ source: 'trigger', target: 'n1' }, { source: 'n1', target: 'n3', sourceHandle: 'o1' }, { source: 'n1', target: 'n2' }, { source: 'n3', target: 'trigger' }],
    });
    assert.equal(g.nodes.length, 3);
    assert.equal(g.edges.length, 2);
    assert.ok(g.nodes.every((n) => n.position.x > 0));
    assert.ok((g.nodes[1].data.options[0].title as string).length <= 24);
  });
  it('importação remove segredos e referências da outra conta', () => {
    const g = stripForImport(normalizeGraph({ nodes: [T({ connectionId: 'c1' }), N('h', 'http', { headers: [{ key: 'Authorization', value: 'Bearer SEGREDO' }] }), N('p', 'payment', { productId: 'p1' })], edges: [] }));
    assert.equal(g.nodes[1].data.headers[0].value, '');
    assert.equal(g.nodes[1].data.headers[0].key, 'Authorization');
    assert.equal(g.nodes[0].data.connectionId, '');
    assert.equal(g.nodes[2].data.productId, '');
  });
});

describe('HTTP seguro (SSRF)', () => {
  it('classifica IPs internos', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.1.1']) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
  });
  it('bloqueia destinos internos e protocolos estranhos', async () => {
    for (const url of ['http://127.0.0.1:4000/x', 'http://localhost/x', 'http://169.254.169.254/latest', 'http://[::1]/', 'ftp://exemplo.com', 'http://api.internal/x']) {
      const r = await safeHttpRequest({ method: 'GET', url, headers: {} });
      assert.equal(r.ok, false, url);
      assert.equal(r.status, 0, url);
    }
  });
});
