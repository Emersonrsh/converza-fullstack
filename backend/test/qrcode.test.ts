import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import {
  connectionIdOf, formatPhone, ignoredJid, isWebMediaId, isWebPhoneId, jidUser, mediaOf, opsFromCloud, peerOf, statusOf,
  templateAsText, toCloudMessage, vcardOf, vcardPhones, unwrap,
} from '../src/whatsapp/web/convert';
import { extractContent } from '../src/whatsapp/inbound';
import { carouselVisibleReplies, numberReply } from '../src/flows/types';
import { matchOption } from '../src/flows/interpreter';
import { housePeriod } from '../src/billing/house';

describe('QR Code: identificadores', () => {
  it('conexão e mídia do QR Code têm prefixo próprio', () => {
    assert.equal(isWebPhoneId('web:abc'), true);
    assert.equal(isWebPhoneId('1234567890'), false);
    assert.equal(isWebPhoneId(null), false);
    assert.equal(connectionIdOf('web:7f3c'), '7f3c');
    assert.equal(isWebMediaId('webm:1'), true);
    assert.equal(isWebMediaId('912873'), false);
  });
  it('JID → número; grupos, status, listas e canais ficam de fora', () => {
    assert.equal(jidUser('5511999990000:12@s.whatsapp.net'), '5511999990000');
    assert.equal(ignoredJid('1203630@g.us'), true);
    assert.equal(ignoredJid('status@broadcast'), true);
    assert.equal(ignoredJid('123@newsletter'), true);
    assert.equal(ignoredJid('5511999990000@s.whatsapp.net'), false);
  });
  it('formata o número do Brasil e de fora', () => {
    assert.equal(formatPhone('5511999990000'), '+55 11 99999-0000');
    assert.equal(formatPhone('551140000000'), '+55 11 4000-0000');
    assert.equal(formatPhone('14155550100'), '+14155550100');
  });
  it('quem é o cliente: número, número pelo @lid, ou só o @lid (número oculto)', () => {
    assert.deepEqual(peerOf({ remoteJid: '5511988887777@s.whatsapp.net' }), { id: '5511988887777', jid: '5511988887777@s.whatsapp.net', lidOnly: false });
    assert.deepEqual(peerOf({ remoteJid: '123456789012345@lid', remoteJidAlt: '5511988887777@s.whatsapp.net' }), { id: '5511988887777', jid: '5511988887777@s.whatsapp.net', lidOnly: false });
    assert.deepEqual(peerOf({ remoteJid: '123456789012345@lid' }, '5511977776666@s.whatsapp.net'), { id: '5511977776666', jid: '5511977776666@s.whatsapp.net', lidOnly: false });
    assert.deepEqual(peerOf({ remoteJid: '123456789012345@lid' }), { id: '123456789012345', jid: '123456789012345@lid', lidOnly: true });
    assert.equal(peerOf({ remoteJid: '1203630@g.us' }), null);
  });
});

describe('QR Code: o que chega vira o formato da Cloud API', () => {
  const key = { id: 'ABC', remoteJid: '5511988887777@s.whatsapp.net', fromMe: false };
  it('texto simples e texto citando outra mensagem', () => {
    const a = toCloudMessage({ key, message: { conversation: 'Oi' }, messageTimestamp: 1762600000 });
    assert.deepEqual(a, { id: 'ABC', timestamp: '1762600000', type: 'text', text: { body: 'Oi' } });
    const b = toCloudMessage({ key, message: { extendedTextMessage: { text: 'Esse', contextInfo: { stanzaId: 'Q1' } } }, messageTimestamp: { low: 5 } });
    assert.equal(b?.context?.id, 'Q1');
    assert.equal(b?.timestamp, '5');
    assert.equal(extractContent(b).body, 'Esse');
  });
  it('arquivos: tipo, legenda, nome e o id guardado pelo Converza', () => {
    const msg = { key, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'proposta.pdf', caption: 'Segue', fileLength: 2048 } } } } };
    const m = mediaOf(msg.message);
    assert.deepEqual(m, { key: 'documentMessage', type: 'document', mime: 'application/pdf', fileName: 'proposta.pdf', size: 2048 });
    const c = toCloudMessage(msg, 'webm:1');
    const x = extractContent(c);
    assert.equal(x.mediaType, 'document');
    assert.deepEqual(x.media, { id: 'webm:1', mime: 'application/pdf', filename: 'proposta.pdf' });
    assert.equal(x.body, 'Segue');
    const voice = toCloudMessage({ key, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } }, 'webm:2');
    assert.equal(voice?.audio.mime_type, 'audio/ogg');
    assert.equal(voice?.audio.voice, true);
  });
  it('mensagem temporária é aberta; visualização única não (fica para o celular)', () => {
    assert.deepEqual(unwrap({ ephemeralMessage: { message: { conversation: 'x' } } }), { conversation: 'x' });
    const once = toCloudMessage({ key, message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } } });
    assert.equal(once?.type, 'unsupported');
    assert.match(extractContent(once).body ?? '', /visualização única/);
    assert.equal(mediaOf({ viewOnceMessageV2: { message: { imageMessage: {} } } }), null);
  });
  it('localização, contato, reação, botão e enquete', () => {
    const loc = extractContent(toCloudMessage({ key, message: { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: 'Loja' } } }));
    assert.match(loc.body ?? '', /maps\.google\.com\/\?q=-23\.5,-46\.6/);
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Joana\nTEL;type=CELL;waid=5511912345678:+55 11 91234-5678\nEND:VCARD';
    const ct = extractContent(toCloudMessage({ key, message: { contactMessage: { displayName: 'Joana', vcard } } }));
    assert.equal(ct.body, 'Joana · +5511912345678');
    const r = extractContent(toCloudMessage({ key, message: { reactionMessage: { key: { id: 'M1' }, text: '👍' } } }));
    assert.equal(r.silent, true);
    const btn = extractContent(toCloudMessage({ key, message: { buttonsResponseMessage: { selectedButtonId: 'b1', selectedDisplayText: 'Quero' } } }));
    assert.deepEqual([btn.body, btn.replyId], ['Quero', 'b1']);
    const poll = extractContent(toCloudMessage({ key, message: { pollCreationMessage: { name: 'Qual horário?' } } }));
    assert.equal(poll.mediaType, 'unsupported');
    assert.match(poll.body ?? '', /Enquete: Qual horário\?/);
  });
  it('eventos do protocolo e edições não viram mensagem', () => {
    assert.equal(toCloudMessage({ key, message: { protocolMessage: { type: 0 } } }), null);
    assert.equal(toCloudMessage({ key, message: { editedMessage: { message: { conversation: 'novo' } } } }), null);
    assert.equal(toCloudMessage({ key: {}, message: { conversation: 'x' } }), null);
  });
  it('status de entrega', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(statusOf), ['failed', null, 'sent', 'delivered', 'read', 'read']);
  });
  it('vCard: telefones pelo waid ou pelo número', () => {
    assert.deepEqual(vcardPhones('BEGIN:VCARD\nTEL;waid=5511900001111:+55 11 90000-1111\nTEL:+1 (415) 555-0100\nEND:VCARD'), ['+5511900001111', '+14155550100']);
    assert.match(vcardOf('Ana; Souza', '+55 (11) 98888-7777'), /FN:Ana  Souza\n.*waid=5511988887777:\+5511988887777/s);
  });
});

describe('QR Code: o que sai (payload da Cloud API → WhatsApp Web)', () => {
  it('texto citando, mídia por link/arquivo, voz, contato e reação', () => {
    assert.deepEqual(opsFromCloud({ to: '1', type: 'text', text: { body: 'Olá' }, context: { message_id: 'W1' } }), [{ kind: 'text', text: 'Olá', quoted: 'W1' }]);
    const [img] = opsFromCloud({ type: 'image', image: { link: 'https://x/y.jpg', caption: 'Foto' } });
    assert.deepEqual(img, { kind: 'media', media: 'image', link: 'https://x/y.jpg', id: undefined, caption: 'Foto', fileName: undefined, voice: false, quoted: null });
    const [voz] = opsFromCloud({ type: 'audio', audio: { id: 'webm:9', voice: true } });
    assert.equal(voz.kind === 'media' && voz.voice, true);
    const [ct] = opsFromCloud({ type: 'contacts', contacts: [{ name: { formatted_name: 'Joana' }, phones: [{ phone: '+5511912345678', wa_id: '5511912345678' }] }] });
    assert.equal(ct.kind, 'contacts');
    assert.match(ct.kind === 'contacts' ? ct.vcards[0] : '', /waid=5511912345678/);
    assert.deepEqual(opsFromCloud({ type: 'reaction', reaction: { message_id: 'M1', emoji: '❤️' } }), [{ kind: 'react', messageId: 'M1', emoji: '❤️' }]);
  });
  it('menu vira enquete por padrão (clicável e entregue pelo QR Code)', () => {
    const [b] = opsFromCloud({ type: 'interactive', interactive: { type: 'button', header: { type: 'text', text: 'Agenda' }, body: { text: 'Prefere?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Manhã' } }, { type: 'reply', reply: { id: 'b', title: 'Tarde' } }] } } });
    assert.equal(b.kind, 'poll');
    if (b.kind !== 'poll') return;
    assert.equal(b.name, 'Agenda\nPrefere?');
    assert.equal(b.intro, null);
    assert.equal(b.list, false);
    assert.deepEqual(b.options, [{ id: 'a', title: 'Manhã' }, { id: 'b', title: 'Tarde' }]);
    assert.match(b.fallback, /1️⃣ Manhã\n2️⃣ Tarde/);
    // lista: descrição entra na opção; pergunta longa vai antes, como texto
    const long = 'x'.repeat(300);
    const [l] = opsFromCloud({ type: 'interactive', interactive: { type: 'list', body: { text: long }, action: { sections: [{ rows: [{ id: 'r1', title: 'Corte', description: 'R$ 50' }, { id: 'r2', title: 'Corte' }] }] } } });
    assert.equal(l.kind, 'poll');
    if (l.kind !== 'poll') return;
    assert.equal(l.list, true);
    assert.equal(l.intro, long);
    assert.deepEqual(l.options.map((o) => o.title), ['Corte — R$ 50', 'Corte']);
    // mais de 12 opções (limite da enquete) ou só uma: lista numerada
    const rows = Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, title: `Opção ${i}` }));
    assert.equal(opsFromCloud({ type: 'interactive', interactive: { type: 'list', body: { text: 'Qual?' }, action: { sections: [{ rows }] } } })[0].kind, 'text');
    assert.equal(opsFromCloud({ type: 'interactive', interactive: { type: 'button', body: { text: 'Ok?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Ok' } }] } } })[0].kind, 'text');
    // WA_WEB_MENU=text: lista numerada
    process.env.WA_WEB_MENU = 'text';
    const [t] = opsFromCloud({ type: 'interactive', interactive: { type: 'button', body: { text: 'Prefere?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Manhã' } }, { type: 'reply', reply: { id: 'b', title: 'Tarde' } }] } } });
    delete process.env.WA_WEB_MENU;
    assert.equal(t.kind, 'text');
  });

  it('com WA_WEB_INTERACTIVE=on, botões e lista viram menu clicável', () => {
    process.env.WA_WEB_INTERACTIVE = 'on';
    const [b] = opsFromCloud({ type: 'interactive', interactive: { type: 'button', body: { text: 'Prefere?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Manhã' } }, { type: 'reply', reply: { id: 'b', title: 'Tarde' } }] } } });
    assert.equal(b.kind, 'interactive');
    if (b.kind !== 'interactive') return;
    assert.deepEqual(b.spec, { kind: 'buttons', body: 'Prefere?', header: undefined, footer: undefined, buttons: [{ id: 'a', title: 'Manhã' }, { id: 'b', title: 'Tarde' }] });
    assert.match(b.fallback, /^Prefere\?\n\n1️⃣ Manhã\n2️⃣ Tarde\n\n_Responda com o número da opção._$/);
    // lista com descrição: lista que abre ao tocar
    const [l] = opsFromCloud({ type: 'interactive', interactive: { type: 'list', body: { text: 'Escolha' }, footer: { text: 'Loja' }, action: { button: 'Ver', sections: [{ title: 'Serviços', rows: [{ id: 'r1', title: 'Corte', description: 'R$ 50' }] }] } } });
    assert.equal(l.kind === 'interactive' && l.spec.kind, 'list');
    assert.match(l.kind === 'interactive' ? l.fallback : '', /1️⃣ Corte — R\$ 50\n\n_Loja_/);
    // lista curta sem descrição: botões
    const [l2] = opsFromCloud({ type: 'interactive', interactive: { type: 'list', body: { text: 'Posso enviar?' }, action: { sections: [{ rows: [1, 2, 3, 4].map((n) => ({ id: `o${n}`, title: `Opção ${n}` })) }] } } });
    assert.equal(l2.kind === 'interactive' && l2.spec.kind, 'buttons');
    // desligado: volta para o texto numerado
    process.env.WA_WEB_INTERACTIVE = 'off';
    const [t] = opsFromCloud({ type: 'interactive', interactive: { type: 'button', body: { text: 'Prefere?' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Manhã' } }] } } });
    delete process.env.WA_WEB_INTERACTIVE;
    assert.equal(t.kind, 'text');
  });
  it('link com botão, Pix (texto + código) e carrossel (imagens + opções numeradas, link no cartão)', () => {
    const [u] = opsFromCloud({ type: 'interactive', interactive: { type: 'cta_url', body: { text: 'Veja' }, action: { name: 'cta_url', parameters: { display_text: 'Abrir loja', url: 'https://loja' } } } });
    assert.match(u.kind === 'text' ? u.text : '', /🔗 Abrir loja: https:\/\/loja/);
    const pix = opsFromCloud({ type: 'interactive', interactive: { type: 'order_details', body: { text: 'Seu pedido' }, action: { parameters: { total_amount: { value: 4990, offset: 100 }, payment_settings: [{ type: 'pix_dynamic_code', pix_dynamic_code: { code: '000201PIX', merchant_name: 'Loja' } }] } } } });
    assert.equal(pix.length, 2);
    assert.match(pix[0].kind === 'text' ? pix[0].text : '', /Valor: \*R\$\s49,90\*/);
    assert.deepEqual(pix[1], { kind: 'text', text: '000201PIX' });
    const car = opsFromCloud({
      type: 'interactive', interactive: {
        type: 'carousel', body: { text: 'Planos' }, action: {
          cards: [
            { card_index: 0, header: { type: 'image', image: { link: 'https://i/1.jpg' } }, body: { text: 'Básico' }, action: { buttons: [{ type: 'quick_reply', quick_reply: { id: 'c1', title: 'Quero o básico' } }] } },
            { card_index: 1, type: 'cta_url', header: { type: 'image', image: { id: 'webm:5' } }, body: { text: 'Pro' }, action: { name: 'cta_url', parameters: { display_text: 'Ver', url: 'https://p' } } },
            { card_index: 2, header: { type: 'image', image: { link: 'https://i/3.jpg' } }, action: { buttons: [{ type: 'quick_reply', quick_reply: { id: 'c3', title: 'Quero o top' } }] } },
          ],
        },
      },
    });
    assert.equal(car.length, 5);
    assert.deepEqual(car[0], { kind: 'text', text: 'Planos', quoted: null });
    assert.match(car[1].kind === 'media' ? car[1].caption ?? '' : '', /Básico\n\n1️⃣ Quero o básico/);
    assert.match(car[2].kind === 'media' ? car[2].caption ?? '' : '', /🔗 Ver: https:\/\/p/);
    assert.equal(car[2].kind === 'media' && car[2].id, 'webm:5');
    assert.match(car[3].kind === 'media' ? car[3].caption ?? '' : '', /2️⃣ Quero o top/);
    assert.deepEqual(car[4], { kind: 'text', text: '_Responda com o número da opção._' });
  });
  it('modelo (template) não sai por QR Code; o texto do modelo leva os botões numerados', () => {
    assert.deepEqual(opsFromCloud({ type: 'template', template: { name: 'x' } }), []);
    assert.equal(templateAsText('Oi Ana, tudo certo?', [{ title: 'Sim' }, { title: '' }, { title: 'Não' }]),
      'Oi Ana, tudo certo?\n\n1️⃣ Sim\n2️⃣ Não\n\n_Responda com o número da opção._');
    assert.equal(templateAsText('Só texto', []), 'Só texto');
  });
});

describe('QR Code: resposta pelo número da opção', () => {
  it('reconhece "2", "2.", "2)" e "2 - quero"; ignora "20 unidades" fora do intervalo', () => {
    assert.equal(numberReply('2'), 2);
    assert.equal(numberReply(' 2. '), 2);
    assert.equal(numberReply('2)'), 2);
    assert.equal(numberReply('2 - quero esse'), 2);
    assert.equal(numberReply('0'), null);
    assert.equal(numberReply('dois'), null);
    assert.equal(numberReply('2026'), null);
  });
  it('carrossel: a ordem numerada é a que o cliente viu (cartão com link não conta)', () => {
    const d = { cards: [
      { buttons: [{ id: 'a', title: 'A1' }, { id: 'b', title: 'A2' }, { id: 'x', title: 'A3' }] },
      { buttons: [{ id: 'u', type: 'url', title: 'Site' }, { id: 'c', title: 'Some' }] },
      { buttons: [{ id: 'd', title: 'C1' }] },
    ] };
    assert.deepEqual(carouselVisibleReplies(d).map((b) => b.id), ['a', 'b', 'd']);
  });
  it('menu já aceitava o número', () => {
    const opts = [{ id: 'o1', title: 'Agendar' }, { id: 'o2', title: 'Preços' }];
    assert.equal(matchOption(opts, '2', null)?.id, 'o2');
  });
});

describe('Conta da casa', () => {
  it('o período vai até o começo do mês seguinte (renova sozinho)', () => {
    assert.equal(housePeriod(new Date('2026-11-08T12:00:00Z')).toISOString(), '2026-12-01T03:00:00.000Z');
    assert.equal(housePeriod(new Date('2026-12-31T23:00:00Z')).toISOString(), '2027-01-01T03:00:00.000Z');
  });
});

describe('Segurança: JWT_SECRET em produção', () => {
  const boot = (secret: string | undefined) => {
    const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'production' };
    if (secret === undefined) delete env.JWT_SECRET; else env.JWT_SECRET = secret;
    try {
      execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', "require('./src/config.ts'); console.log('ok')"], { env, cwd: process.cwd(), stdio: 'pipe' });
      return 'ok';
    } catch (err) {
      return String((err as { stderr?: Buffer }).stderr ?? '');
    }
  };
  it('não sobe sem a chave, com a chave de exemplo ou com chave curta', () => {
    for (const s of [undefined, 'dev-secret-change-me', 'troque-isto-por-um-segredo-forte', 'curta123']) {
      assert.match(boot(s), /JWT_SECRET ausente ou fraco/, `aceitou: ${s}`);
    }
  });
  it('sobe com uma chave forte', () => {
    assert.equal(boot('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c'), 'ok');
  });
});
