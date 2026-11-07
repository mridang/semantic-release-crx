import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { aggregate, crxError } from '../src/errors.js';

describe('errors', () => {
  it('crxError carries the message and code semantic-release shows', () => {
    const error = crxError('broken', 'EBROKEN') as Error & { code: string };
    expect(error.message).toBe('broken');
    expect(error.code).toBe('EBROKEN');
  });

  it('aggregate exposes each error for semantic-release to report', () => {
    const one = crxError('one', 'E1');
    const two = crxError('two', 'E2');
    const combined = aggregate([one, two]);
    expect(combined.errors).toEqual([one, two]);
    expect(combined.message).toBe('one\ntwo');
  });
});
