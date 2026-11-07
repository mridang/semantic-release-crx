import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isOneOf } from '../../src/utils/union.js';

const COLOURS = ['red', 'green'] as const;

describe('isOneOf', () => {
  it('accepts a listed string', () => {
    expect(isOneOf(COLOURS, 'red')).toBe(true);
  });

  it('rejects an unlisted string and non-strings', () => {
    expect(isOneOf(COLOURS, 'blue')).toBe(false);
    expect(isOneOf(COLOURS, 1)).toBe(false);
    expect(isOneOf(COLOURS, undefined)).toBe(false);
  });
});
