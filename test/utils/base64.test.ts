import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { fromBase64, toBase64Url } from '../../src/utils/base64.js';

describe('toBase64Url', () => {
  it('uses the URL safe alphabet without padding', () => {
    expect(toBase64Url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(toBase64Url('a')).toBe('YQ');
  });

  it('encodes text and bytes the same way', () => {
    expect(toBase64Url('hello')).toBe(toBase64Url(Buffer.from('hello')));
  });
});

describe('fromBase64', () => {
  it('decodes to a UTF-8 string', () => {
    expect(fromBase64(Buffer.from('héllo {"a":1}').toString('base64'))).toBe(
      'héllo {"a":1}',
    );
  });
});
