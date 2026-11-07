import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { isPercentage } from '../../src/utils/math.js';

describe('isPercentage', () => {
  it.each([0, 1, 50, 100])('accepts %s', (value) => {
    expect(isPercentage(value)).toBe(true);
  });

  it.each([-1, 101, 2.5, Number.NaN, Infinity, '5', null, undefined])(
    'rejects %s',
    (value) => {
      expect(isPercentage(value)).toBe(false);
    },
  );
});
