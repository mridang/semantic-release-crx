import { describe, expect, it } from '@jest/globals';

describe('client entry point', () => {
  it('exports only the four documented calls', async () => {
    // noinspection ES6PreferShortImport
    const client = await import('../src/client.js');
    expect(Object.keys(client).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'cancelSubmission',
      'fetchStatus',
      'rollback',
      'setPublishedDeployPercentage',
    ]);
  });
});
