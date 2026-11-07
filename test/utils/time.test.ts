import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { nowSeconds } from '../../src/utils/time.js';

describe('nowSeconds', () => {
  it('is the current time in whole seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const value = nowSeconds();
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(before + 2);
  });
});
