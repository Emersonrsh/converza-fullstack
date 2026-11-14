import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  automationFor, buildAgentPrompt, finalTexts, parseAgentReply, promptActions, resolveAutomations, type AgentAutomation,
} from '../src/ai/agentBrain';
import { SECTORS } from '../src/ai/agentSectors';
import { parseFaqCsv } from '../src/modules/knowledge';

const opts = { company: 'Academia Força', now: new Date('2026-11-06T15:00:00Z'), timeZone: 'America/Sao_Paulo', speakAsAudio: false, customerSentAudio: false };

describe('automações', () => {
  it('sem nada salvo vem do jeito antigo, sempre com as 4 obrigatórias', () => {
    const list = resolveAutomations({ flowId: 'f1', flowWhen: 'quiser pagar', handoffMessage: 'Já chamo alguém', handoffDepartmentId: 'd1' });
    assert.deepEqual(list.map((x) => x.trigger), ['invalid_media', 'reply_limit', 'finish', 'handoff', 'intent']);
    assert.equal(list[3].message, 'Já chamo alguém');
    assert.equal(list[3].departmentId, 'd1');
    assert.equal(list[4].flowId, 'f1');
    assert.equal(automationFor(list, 'flow')?.flowId, 'f1');
  });
  it('salvas: completa as obrigatórias que faltarem e respeita as personalizadas', () => {
    const saved: AgentAutomation[] = [
      { key: 'finish', trigger: 'finish', action: 'tag', tag: 'atendido' },
      { key: 'a', trigger: 'intent', when: 'pedir horário', action: 'tag', tag: 'quer agendar' },
      { key: 'b', trigger: 'intent', when: 'quiser pagar', action: 'flow', flowId: 'f9' },
    ];
    const list = resolveAutomations({ automations: saved });
    assert.equal(list.length, 6);
    assert.equal(list.find((x) => x.trigger === 'finish')?.action, 'tag');
    const acts = promptActions(list, { f9: 'Checkout' }, '');
    assert.deepEqual(acts.map((x) => x.code), ['humano', 'encerrar', 'auto_1', 'auto_2']);
    assert.ok(acts[3].text.includes('Checkout'));
    assert.equal(automationFor(list, 'auto_2')?.flowId, 'f9');
    assert.equal(automationFor(list, 'finish')?.tag, 'atendido');
    // fluxo pausado não vira ação
    assert.deepEqual(promptActions(list, {}, '').map((x) => x.code), ['humano', 'encerrar', 'auto_1']);
  });
  it('a IA escolhe "encerrar" e "auto_2"', () => {
    assert.equal(parseAgentReply('{"mensagens":["Até mais!"],"acao":"encerrar"}').action, 'finish');
    assert.equal(parseAgentReply('{"mensagens":["Vou mandar"],"acao":"auto_2"}').action, 'auto_2');
    assert.equal(parseAgentReply('{"mensagens":["x"],"acao":"apagar_tudo"}').action, null);
  });
  it('mensagem pronta', () => {
    const reply: AgentAutomation = { key: 'r', trigger: 'intent', action: 'reply', message: 'Nosso endereço é Rua A' };
    assert.deepEqual(finalTexts(['Claro!'], reply), ['Claro!', 'Nosso endereço é Rua A']);
    const h: AgentAutomation = { key: 'h', trigger: 'handoff', action: 'handoff', message: 'Já chamo alguém' };
    assert.deepEqual(finalTexts(['Vou chamar'], h), ['Vou chamar']);
    assert.deepEqual(finalTexts([], h), ['Já chamo alguém']);
  });
});

describe('instruções por etapas', () => {
  it('idioma, identidade, estilo, etapas, bases e ações', () => {
    const list = resolveAutomations({ automations: [{ key: 'a', trigger: 'intent', when: 'pedir aula experimental', action: 'tag', tag: 'experimental' }] });
    const p = buildAgentPrompt({
      name: 'Léo', role: 'sales', tone: '', systemPrompt: '', knowledge: '', faq: [], rules: '', flowName: null, flowWhen: '', handoffWhen: '',
      language: 'es', identity: 'ai', pace: 'dynamic', formality: 'relaxed', emoji: 'none',
      stages: [{ name: 'Boas-vindas', goal: 'Cumprimente', advanceWhen: 'disser o que quer' }, { name: 'Planos', goal: 'Mostre os planos' }],
      actions: promptActions(list, {}, ''), bases: '### Base “Planos”\nMensal: R$ 99',
    }, { name: 'Ana', tags: [], fields: {} }, opts);
    for (const s of ['assistente virtual', 'Fale sempre em espanhol.', 'bem curtas', 'descontraído', 'Não use emojis', 'ETAPAS DA CONVERSA',
      '1. Boas-vindas — Cumprimente (avance quando disser o que quer)', '2. Planos', 'Mensal: R$ 99', '"auto_1": use quando pedir aula experimental', '"encerrar"',
      '"acao": null, "humano", "encerrar", "auto_1"']) assert.ok(p.includes(s), `faltou: ${s}`);
    assert.ok(!p.includes('a não ser que o cliente escreva em outro idioma'));
  });
});

describe('modelos por setor', () => {
  it('cada setor tem 3 funções com etapas', () => {
    assert.ok(SECTORS.length >= 8);
    for (const s of SECTORS) {
      assert.equal(s.functions.length, 3, s.id);
      for (const f of s.functions) assert.ok(f.stages.length >= 3 && f.description && f.idealFor, f.id);
    }
    const ids = SECTORS.flatMap((s) => s.functions.map((f) => f.id));
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('perguntas de planilha', () => {
  it('ponto e vírgula, vírgula, cabeçalho e aspas', () => {
    assert.deepEqual(parseFaqCsv('Pergunta;Resposta\nQual o horário?;Das 6h às 22h\n"Tem estacionamento?";"Sim, ""grátis"""'),
      [{ q: 'Qual o horário?', a: 'Das 6h às 22h' }, { q: 'Tem estacionamento?', a: 'Sim, "grátis"' }]);
    assert.deepEqual(parseFaqCsv('Aceita Pix?,Sim\nParcela?,Em até 12x'), [{ q: 'Aceita Pix?', a: 'Sim' }, { q: 'Parcela?', a: 'Em até 12x' }]);
  });
});
