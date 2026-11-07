import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { codeOf, messageOf } from '../../src/utils/error.js';

describe('messageOf', () => {
  it('reads the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('uses the string form of anything else', () => {
    expect(messageOf('plain')).toBe('plain');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('codeOf', () => {
  it('reads the code of a coded error', () => {
    expect(codeOf(Object.assign(new Error('x'), { code: 'EBOOM' }))).toBe(
      'EBOOM',
    );
  });

  it('is undefined for an error without a code, a non-string code or a non-object', () => {
    expect(codeOf(new Error('x'))).toBeUndefined();
    expect(codeOf(Object.assign(new Error('x'), { code: 5 }))).toBeUndefined();
    expect(codeOf('E1')).toBeUndefined();
    expect(codeOf(undefined)).toBeUndefined();
  });
});
