import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorPatch, healthPatch, warningsOf, type WarnInput } from '../src/whatsapp/health';
import { connectionLimitFor } from '../src/modules/plans';

const base = (over: Partial<WarnInput> = {}): WarnInput => ({
  status: 'connected', qualityRating: 'GREEN', nameStatus: 'APPROVED', webhookSubscribed: true,
  coexistence: false, syncRequestedAt: null, historyProgress: null, lastInboundAt: new Date().toISOString(),
  onboardedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), ...over,
});

describe('healthPatch', () => {
  it('número funcionando fica conectado e copia os dados da Meta', () => {
    const p = healthPatch({
      id: '1', display_phone_number: '+55 11 99999-0000', verified_name: 'Clínica Sorriso', quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_1K', name_status: 'APPROVED', code_verification_status: 'VERIFIED', status: 'CONNECTED',
      throughput: { level: 'STANDARD' }, is_on_biz_app: false,
    });
    assert.equal(p.status, 'connected');
    assert.equal(p.lastError, null);
    assert.equal(p.displayPhone, '+55 11 99999-0000');
    assert.equal(p.messagingLimit, 'TIER_1K');
    assert.equal(p.throughput, 'STANDARD');
    assert.equal(p.coexistence, false);
  });
  it('sinalizado/restrito continua enviando (conectado)', () => {
    for (const status of ['FLAGGED', 'RESTRICTED', 'RATE_LIMITED']) assert.equal(healthPatch({ id: '1', status }).status, 'connected');
  });
  it('sem o campo status (fallback de campos básicos) não derruba a conexão', () => {
    assert.equal(healthPatch({ id: '1', display_phone_number: '+55 11 3333-0000' }).status, 'connected');
  });
  it('pendente e desconectado viram mensagens claras', () => {
    const pend = healthPatch({ id: '1', status: 'PENDING' });
    assert.equal(pend.status, 'pending');
    assert.match(pend.lastError ?? '', /registro/);
    const banned = healthPatch({ id: '1', status: 'BANNED' });
    assert.equal(banned.status, 'disconnected');
    assert.match(banned.lastError ?? '', /banido/);
    assert.match(healthPatch({ id: '1', status: 'WEIRD' }).lastError ?? '', /WEIRD/);
  });
  it('não sobrescreve o número exibido quando a Meta não manda', () => {
    assert.equal('displayPhone' in healthPatch({ id: '1', status: 'CONNECTED' }), false);
    assert.equal('coexistence' in healthPatch({ id: '1', status: 'CONNECTED' }), false);
  });
});

describe('errorPatch', () => {
  it('token vencido/sem acesso desconecta', () => {
    assert.equal(errorPatch({ code: 190, message: 'x' }).status, 'disconnected');
    assert.match(errorPatch({ code: 190, message: 'x' }).lastError, /token expirou/);
    assert.equal(errorPatch({ code: 100, message: 'x' }).status, 'disconnected');
    assert.equal(errorPatch({ code: 200, message: 'x' }).status, 'disconnected');
    assert.equal(errorPatch({ code: 131031, message: 'Conta bloqueada' }).lastError, 'Conta bloqueada');
  });
  it('133010 (número não registrado) fica aguardando', () => {
    assert.equal(errorPatch({ code: 133010, message: 'não registrado' }).status, 'pending');
  });
  it('falha de rede ou erro desconhecido não muda o status', () => {
    const p = errorPatch({ code: null, message: 'fetch failed' });
    assert.equal(p.status, undefined);
    assert.equal(p.lastError, 'fetch failed');
  });
});

describe('warningsOf', () => {
  it('conexão saudável não tem avisos', () => assert.deepEqual(warningsOf(base()), []));
  it('desconectada não repete avisos (o erro principal já aparece)', () => {
    assert.deepEqual(warningsOf(base({ status: 'disconnected', qualityRating: 'RED', webhookSubscribed: false })), []);
  });
  it('qualidade, nome e webhook', () => {
    const w = warningsOf(base({ qualityRating: 'RED', nameStatus: 'DECLINED', webhookSubscribed: false }));
    assert.equal(w.length, 3);
    assert.match(w[0], /Qualidade baixa/);
    assert.match(w[1], /recusado/);
    assert.match(w[2], /Receber mensagens/);
    assert.match(warningsOf(base({ qualityRating: 'YELLOW' }))[0], /média/);
    assert.deepEqual(warningsOf(base({ webhookSubscribed: null })), []); // ainda não verificado
  });
  it('coexistência: pedir a sincronização só dentro das 24h', () => {
    const now = Date.now();
    const fresh = base({ coexistence: true, onboardedAt: new Date(now - 2 * 3600_000).toISOString(), lastInboundAt: null });
    assert.match(warningsOf(fresh, now).join(' '), /sincronização/);
    const old = base({ coexistence: true, onboardedAt: new Date(now - 30 * 3600_000).toISOString() });
    assert.doesNotMatch(warningsOf(old, now).join(' '), /sincronização/);
    assert.deepEqual(warningsOf(base({ coexistence: true, syncRequestedAt: new Date(now).toISOString() }), now), []);
  });
  it('nenhuma mensagem recebida depois de 24h', () => {
    const now = Date.now();
    assert.deepEqual(warningsOf(base({ lastInboundAt: null, onboardedAt: new Date(now - 3600_000).toISOString() }), now), []);
    assert.match(warningsOf(base({ lastInboundAt: null }), now)[0], /Nenhuma mensagem recebida/);
  });
});

describe('connectionLimitFor', () => {
  it('limite de números por instância', () => {
    assert.equal(connectionLimitFor(1, true), 1);
    assert.equal(connectionLimitFor(3, true), 3);
    assert.equal(connectionLimitFor(10, true), 10);
    assert.equal(connectionLimitFor(3, false), 0);
    assert.equal(connectionLimitFor(null, true), 0); // sem instâncias contratadas, nenhum número
  });
});
