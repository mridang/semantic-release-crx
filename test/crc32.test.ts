import { describe, expect, it } from '@jest/globals';
import { crc32 as nodeCrc32 } from 'node:zlib';
// noinspection ES6PreferShortImport
import { crc32 } from '../src/crc32.js';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for no data', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('agrees with zlib on a large buffer and returns an unsigned number', () => {
    const data = Buffer.from(
      Array.from({ length: 300000 }, (_, i) => (i * 31 + 7) % 256),
    );
    expect(crc32(data)).toBe(nodeCrc32(data));
    expect(crc32(Buffer.alloc(8, 0xff))).toBeGreaterThanOrEqual(0);
  });
});
