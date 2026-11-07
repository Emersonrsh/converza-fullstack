import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentPrompt, parseAgentReply, eligibleAgents, shouldSpeak, speakable, parseBuiltAgent, htmlToText,
  AGENT_TEMPLATES, type AgentPersona,
} from '../src/ai/agentBrain';

const persona = (over: Partial<AgentPersona> = {}): AgentPersona => ({
  name: 'Bia', role: 'sales', tone: '', systemPrompt: 'Pergunte o objetivo do cliente.', knowledge: 'Plano anual: R$ 497 em até 12x.',
  faq: [{ q: 'Tem garantia?', a: '7 dias.' }], rules: '- Não fale de concorrentes', flowName: 'Checkout anual', flowWhen: '', handoffWhen: '', ...over,
});
const opts = { company: 'Clínica Sorriso', now: new Date('2026-11-06T15:00:00Z'), timeZone: 'America/Sao_Paulo', speakAsAudio: false, customerSentAudio: false };

describe('agente: instruções', () => {
  it('leva persona, conhecimento, perguntas, regras, ações e dados do cliente', () => {
    const p = buildAgentPrompt(persona(), { name: 'Ana', tags: ['VIP'], fields: { CPF: '123' }, fromAd: true }, opts);
    for (const s of ['Você é Bia', 'Clínica Sorriso', 'Plano anual: R$ 497', 'P: Tem garantia?', 'R: 7 dias.', 'Não fale de concorrentes',
      '"fluxo": dispara o fluxo “Checkout anual”', '"humano"', 'Nome: Ana', 'Etiquetas: VIP', 'CPF: 123', 'Chegou por um anúncio', '"mensagens"', 'sexta-feira']) {
      assert.ok(p.includes(s), `faltou: ${s}`);
    }
  });
  it('sem fluxo não oferece a ação "fluxo"; sem conhecimento avisa para não inventar', () => {
    const p = buildAgentPrompt(persona({ flowName: null, knowledge: '' }), { name: '', tags: [], fields: {} }, opts);
    assert.ok(!p.includes('"fluxo": dispara'));
    assert.ok(p.includes('nada foi informado ainda'));
    assert.ok(p.includes('"acao": null ou "humano"'));
  });
  it('quando vai falar em áudio e quando o cliente mandou áudio', () => {
    const p = buildAgentPrompt(persona(), { name: 'Ana', tags: [], fields: {} }, { ...opts, speakAsAudio: true, customerSentAudio: true });
    assert.ok(p.includes('SUAS MENSAGENS VÃO COMO ÁUDIO'));
    assert.ok(p.includes('[áudio] são transcrições'));
  });
});

describe('agente: leitura da resposta', () => {
  it('JSON combinado, com cerca de código ou texto em volta', () => {
    assert.deepEqual(parseAgentReply('{"mensagens":["Oi!","Tudo bem?"],"acao":null,"motivo":""}'), { messages: ['Oi!', 'Tudo bem?'], action: null, reason: '' });
    assert.deepEqual(parseAgentReply('```json\n{"mensagens":["Vou te mandar o link"],"acao":"fluxo","motivo":"quer comprar"}\n```'),
      { messages: ['Vou te mandar o link'], action: 'flow', reason: 'quer comprar' });
    assert.equal(parseAgentReply('Claro! {"mensagens": "Só um instante", "acao": "humano"}').action, 'handoff');
    assert.deepEqual(parseAgentReply('{"messages":["Hi"],"action":"handoff","reason":"angry"}').messages, ['Hi']);
  });
  it('limita a 3 mensagens e descarta vazias', () => {
    const r = parseAgentReply(JSON.stringify({ mensagens: ['a', '', 'b', 'c', 'd'], acao: 'desconhecida' }));
    assert.deepEqual(r.messages, ['a', 'b', 'c']);
    assert.equal(r.action, null);
  });
  it('texto solto vira mensagem; JSON quebrado não vaza chaves para o cliente', () => {
    assert.deepEqual(parseAgentReply('Olá! Como posso ajudar?').messages, ['Olá! Como posso ajudar?']);
    const broken = parseAgentReply('{"mensagens": ["Oi, tudo bem?", "Me conta o que procura"], "acao": "fluxo", "motivo": ');
    assert.deepEqual(broken.messages, ['Oi, tudo bem?', 'Me conta o que procura']);
    assert.equal(broken.action, 'flow');
    assert.deepEqual(parseAgentReply('').messages, []);
  });
});

describe('agente: quem atende', () => {
  const base = { enabled: true, connectionIds: [] as string[], audience: 'all', audienceTags: [] as string[], createdAt: '2026-01-01' };
  const list = [
    { ...base, id: 'geral' },
    { ...base, id: 'anuncio', audience: 'ads', createdAt: '2026-02-01' },
    { ...base, id: 'vip', audience: 'tags', audienceTags: ['VIP'], createdAt: '2026-03-01' },
    { ...base, id: 'outro-numero', connectionIds: ['c2'] },
    { ...base, id: 'desligado', enabled: false },
  ];
  it('o mais específico primeiro, respeitando a conexão', () => {
    assert.deepEqual(eligibleAgents(list, { connectionId: 'c1', tags: ['vip'], fromAd: true }).map((a) => a.id), ['vip', 'anuncio', 'geral']);
    assert.deepEqual(eligibleAgents(list, { connectionId: 'c2', tags: [], fromAd: false }).map((a) => a.id), ['geral', 'outro-numero']);
    assert.deepEqual(eligibleAgents(list, { connectionId: null, tags: [], fromAd: false }).map((a) => a.id), ['geral']);
  });
  it('áudio: só com voz pronta e conforme o modo', () => {
    assert.equal(shouldSpeak('always', false, true), true);
    assert.equal(shouldSpeak('when_audio', false, true), false);
    assert.equal(shouldSpeak('when_audio', true, true), true);
    assert.equal(shouldSpeak('always', true, false), false);
    assert.equal(speakable('*Oi!* 😀 veja https://x.com/abc agora'), 'Oi! veja agora');
  });
  it('modelos prontos completos', () => {
    assert.equal(AGENT_TEMPLATES.length, 3);
    for (const t of AGENT_TEMPLATES) assert.ok(t.name && t.description && t.systemPrompt && t.handoffMessage, t.id);
  });
});

describe('agente: montar com IA e ler site', () => {
  it('lê a configuração gerada e limita os campos', () => {
    const a = parseBuiltAgent('```json\n' + JSON.stringify({
      nome: 'Rafa', descricao: 'Vende o curso', objetivo: 'sales', jeito_de_falar: 'leve', instrucoes: 'passo 1', conhecimento: 'Curso R$ 197',
      perguntas: [{ p: 'Tem certificado?', r: 'Sim' }, { p: '', r: 'x' }], regras: 'não invente', quando_disparar_fluxo: 'quando topar',
      quando_passar_humano: 'quando pedir', mensagem_ao_passar: 'já chamo',
    }) + '\n```');
    assert.equal(a.name, 'Rafa');
    assert.equal(a.role, 'sales');
    assert.deepEqual(a.faq, [{ q: 'Tem certificado?', a: 'Sim' }]);
    assert.equal(a.knowledge, 'Curso R$ 197');
    assert.equal(parseBuiltAgent('{"nome":"X","objetivo":"vendas"}').role, 'custom');
    assert.throws(() => parseBuiltAgent('sem json aqui'));
  });
  it('tira script/estilo do HTML e decodifica acentos', () => {
    const t = htmlToText('<html><head><title>Loja &amp; Cia</title><meta name="description" content="Roupas fitness"><style>.a{}</style></head>'
      + '<body><script>var x=1</script><h1>Legging Pro</h1><p>Por R$&nbsp;89,90 &#8212; frete grátis</p></body></html>');
    assert.ok(t.includes('Título: Loja & Cia'));
    assert.ok(t.includes('Descrição: Roupas fitness'));
    assert.ok(t.includes('Legging Pro'));
    assert.ok(t.includes('Por R$ 89,90 — frete grátis'));
    assert.ok(!t.includes('var x') && !t.includes('.a{}'));
  });
});
