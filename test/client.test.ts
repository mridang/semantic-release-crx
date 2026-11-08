import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import * as client from '../src/client.js';

describe('client entry point', () => {
  it('exports only the four documented calls', () => {
    expect(Object.keys(client).sort()).toEqual([
      'cancelSubmission',
      'fetchStatus',
      'rollback',
      'setPublishedDeployPercentage',
    ]);
  });
});
