import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { sleep } from '../../src/utils/sleep.js';

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const start = Date.now();
    await sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
