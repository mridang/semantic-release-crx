import { describe, expect, it } from '@jest/globals';
import { join } from 'node:path';
// noinspection ES6PreferShortImport
import { toPosixPath } from '../../src/utils/path.js';

describe('toPosixPath', () => {
  it('uses forward slashes whatever the platform separator is', () => {
    expect(toPosixPath(join('js', 'lib', 'app.js'))).toBe('js/lib/app.js');
  });

  it('leaves a name without separators alone', () => {
    expect(toPosixPath('manifest.json')).toBe('manifest.json');
  });
});
