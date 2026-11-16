import { describe, expect, it } from '@jest/globals';

/** Locale-aware comparer, built once. */
const collator = new Intl.Collator();

describe('client entry point', () => {
  it('exports only the four documented calls', async () => {
    // noinspection ES6PreferShortImport
    const client = await import('../src/client.js');
    expect(
      Object.keys(client).toSorted((a, b) => collator.compare(a, b)),
    ).toEqual([
      'cancelSubmission',
      'fetchStatus',
      'rollback',
      'setPublishedDeployPercentage',
    ]);
  });
});
