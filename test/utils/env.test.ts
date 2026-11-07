import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { readEnv } from '../../src/utils/env.js';

describe('readEnv', () => {
  it('trims the value', () => {
    expect(readEnv({ A: ' x\n' }, 'A')).toBe('x');
  });

  it('treats unset and blank as undefined', () => {
    expect(readEnv({}, 'A')).toBeUndefined();
    expect(readEnv({ A: '  \n' }, 'A')).toBeUndefined();
    expect(readEnv({ A: undefined }, 'A')).toBeUndefined();
  });
});
