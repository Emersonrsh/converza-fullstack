import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEveryMs, linkFromResponse, phoneE164 } from '../src/modules/infinitepay';

describe('InfinitePay', () => {
  it('confere com mais frequência no começo', () => {
    assert.equal(checkEveryMs(5 * 60_000), 60_000);
    assert.equal(checkEveryMs(60 * 60_000), 5 * 60_000);
    assert.equal(checkEveryMs(10 * 3600_000), 30 * 60_000);
  });
  it('acha o link na resposta e formata o telefone', () => {
    assert.equal(linkFromResponse({ url: 'https://checkout.infinitepay.io/x' }), 'https://checkout.infinitepay.io/x');
    assert.equal(linkFromResponse({ link: 'https://a.b/c' }), 'https://a.b/c');
    assert.equal(linkFromResponse({ url: 'http://inseguro' }), null);
    assert.equal(phoneE164('(11) 95000-0001'), '+5511950000001');
    assert.equal(phoneE164('5511950000001'), '+5511950000001');
    assert.equal(phoneE164('123'), null);
  });
});
