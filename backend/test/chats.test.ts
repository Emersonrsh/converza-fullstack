import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { friendlyWaError, mediaKind, parseTemplate, templateComponents, templateVars } from '../src/whatsapp/cloud-api';
import { extractContent } from '../src/whatsapp/inbound';
import { signedMediaPath, verifyMediaSig } from '../src/utils/mediaSign';
import { toOggOpus } from '../src/utils/audio';

describe('chats: modelos de mensagem', () => {
  it('variáveis posicionais em ordem numérica e nomeadas na ordem do texto', () => {
    assert.deepEqual(templateVars('Oi {{2}}, aqui é {{1}} — {{2}}'), ['1', '2']);
    assert.deepEqual(templateVars('Olá {{ nome_cliente }}, pedido {{numero}}'), ['nome_cliente', 'numero']);
    assert.deepEqual(templateVars('sem variáveis'), []);
  });

  it('lê cabeçalho, exemplos, rodapé e botões (inclusive link variável e cupom)', () => {
    const t = parseTemplate({
      name: 'promo', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://x/y.jpg'] } },
        { type: 'BODY', text: 'Oi {{1}}, cupom {{2}}', example: { body_text: [['Ana', 'BF20']] } },
        { type: 'FOOTER', text: 'Sair: responda SAIR' },
        { type: 'BUTTONS', buttons: [
          { type: 'URL', text: 'Ver', url: 'https://loja.com/p/{{1}}', example: ['https://loja.com/p/1'] },
          { type: 'COPY_CODE', example: 'BF20' },
          { type: 'QUICK_REPLY', text: 'Parar' },
        ] },
      ],
    });
    assert.equal(t.paramFormat, 'positional');
    assert.deepEqual(t.header, { format: 'IMAGE', text: null, vars: [], example: 'https://x/y.jpg' });
    assert.deepEqual(t.bodyVars, ['1', '2']);
    assert.deepEqual(t.bodyExamples, ['Ana', 'BF20']);
    assert.equal(t.footer, 'Sair: responda SAIR');
    assert.deepEqual(t.buttons.map((b) => [b.type, b.hasVar]), [['URL', true], ['COPY_CODE', true], ['QUICK_REPLY', false]]);
  });

  it('modelo com variáveis nomeadas', () => {
    const t = parseTemplate({
      name: 'pedido', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', parameter_format: 'NAMED',
      components: [{ type: 'BODY', text: 'Olá {{nome}}, pedido {{numero}}', example: { body_text_named_params: [{ param_name: 'numero', example: '12' }, { param_name: 'nome', example: 'Ana' }] } }],
    });
    assert.equal(t.paramFormat, 'named');
    assert.deepEqual(t.bodyVars, ['nome', 'numero']);
    assert.deepEqual(t.bodyExamples, ['Ana', '12']);
    assert.equal(t.header, null);
  });

  it('monta os componentes de envio no formato da Cloud API', () => {
    assert.deepEqual(templateComponents({ name: 'x', language: 'pt_BR' }), []);
    assert.deepEqual(templateComponents({
      name: 'x', language: 'pt_BR',
      header: { type: 'text', value: 'Ana' },
      body: [{ name: 'nome', value: 'Ana' }, { value: '12' }],
      buttons: [{ index: 0, subType: 'url', value: 'abc' }, { index: 1, subType: 'copy_code', value: 'BF20' }],
    }), [
      { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Ana', parameter_name: 'nome' }, { type: 'text', text: '12' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] },
      { type: 'button', sub_type: 'copy_code', index: '1', parameters: [{ type: 'coupon_code', coupon_code: 'BF20' }] },
    ]);
    assert.deepEqual(templateComponents({ name: 'x', language: 'pt_BR', header: { type: 'document', link: 'https://a/b.pdf', filename: 'b.pdf' } }),
      [{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://a/b.pdf', filename: 'b.pdf' } }] }]);
  });
});

describe('chats: mídia e mensagens recebidas', () => {
  it('tipo de mídia do WhatsApp pelo mime', () => {
    assert.equal(mediaKind('image/jpeg'), 'image');
    assert.equal(mediaKind('image/webp'), 'document');
    assert.equal(mediaKind('video/mp4'), 'video');
    assert.equal(mediaKind('audio/ogg'), 'audio');
    assert.equal(mediaKind('audio/webm'), 'document');
    assert.equal(mediaKind('application/pdf'), 'document');
  });

  it('extrai texto, botões, mídia, localização, contatos, reação e não suportadas', () => {
    assert.deepEqual(extractContent({ type: 'text', text: { body: 'oi' } }), { body: 'oi', replyId: null, mediaType: 'text' });
    assert.equal(extractContent({ type: 'interactive', interactive: { button_reply: { id: 'b1', title: 'Sim' } } }).replyId, 'b1');
    const img = extractContent({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'foto' } });
    assert.deepEqual([img.mediaType, img.body, img.media?.id], ['image', 'foto', 'm1']);
    assert.equal(extractContent({ type: 'location', location: { latitude: 1, longitude: 2, name: 'Casa' } }).body, 'Casa\nhttps://maps.google.com/?q=1,2');
    assert.equal(extractContent({ type: 'contacts', contacts: [{ name: { formatted_name: 'Rui' }, phones: [{ phone: '+55 11 9' }] }] }).body, 'Rui · +55 11 9');
    const r = extractContent({ type: 'reaction', reaction: { emoji: '👍', message_id: 'w' } });
    assert.deepEqual([r.body, r.silent], ['Reagiu com 👍', true]);
    assert.equal(extractContent({ type: 'poll' }).mediaType, 'unsupported');
  });

  it('erros da Meta viram mensagens em português', () => {
    assert.match(friendlyWaError({ error: { code: 131047, message: 'x' } }).message, /janela de 24h/);
    assert.match(friendlyWaError({ error: { code: 190 } }).message, /token/);
    assert.equal(friendlyWaError({ error: { code: 999, message: 'Outro' } }).message, 'Outro');
    assert.equal(friendlyWaError({}, 500).message, 'HTTP 500');
  });

  it('link de mídia assinado vale só para a mensagem e até expirar', () => {
    const path = signedMediaPath('11111111-1111-1111-1111-111111111111');
    const q = new URL(`http://x${path}`).searchParams;
    assert.ok(verifyMediaSig('11111111-1111-1111-1111-111111111111', q.get('e'), q.get('s')));
    assert.ok(!verifyMediaSig('22222222-2222-2222-2222-222222222222', q.get('e'), q.get('s')));
    assert.ok(!verifyMediaSig('11111111-1111-1111-1111-111111111111', q.get('e'), 'x'.repeat(40)));
    assert.ok(!verifyMediaSig('11111111-1111-1111-1111-111111111111', Math.floor(Date.now() / 1000) - 5, q.get('s')));
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  it('converte áudio gravado (WebM) para Ogg/Opus mono', { skip: !hasFfmpeg && 'ffmpeg não instalado' }, async () => {
    const webm = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 10e6 }).stdout;
    assert.ok(webm.length > 100);
    const ogg = await toOggOpus(webm);
    assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
    assert.ok(ogg.includes(Buffer.from('OpusHead')));
    assert.equal(ogg[ogg.indexOf(Buffer.from('OpusHead')) + 9], 1, 'mono');
    await assert.rejects(toOggOpus(Buffer.from('isso não é áudio')), /converter o áudio/);
  });
});

describe('kanban: estatísticas do quadro', () => {
  it('cards, valor sem os perdidos, conversões (ganho) e taxa', async () => {
    const { boardStats } = await import('../src/modules/kanbanStore');
    const cols = [{ id: 'a', kind: 'open' as const }, { id: 'b', kind: 'won' as const }, { id: 'c', kind: 'lost' as const }];
    const counts = new Map([['a', { n: 2, v: 300 }], ['b', { n: 1, v: 1500.5 }], ['c', { n: 1, v: 999 }]]);
    assert.deepEqual(boardStats(cols, counts), { cards: 4, value: 1800.5, won: 1, conversion: 25 });
    assert.deepEqual(boardStats(cols, new Map()), { cards: 0, value: 0, won: 0, conversion: 0 });
    assert.equal(boardStats([{ id: 'a', kind: 'open' }, { id: 'b', kind: 'won' }], new Map([['a', { n: 2, v: 0 }], ['b', { n: 1, v: 0 }]])).conversion, 33.3);
  });
});
