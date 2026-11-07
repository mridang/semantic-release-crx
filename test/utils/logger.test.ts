import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { warn } from '../../src/utils/logger.js';

describe('warn', () => {
  it('uses warn when the logger has it', () => {
    const lines: string[] = [];
    warn(
      {
        log: (m) => lines.push(`log ${m}`),
        warn: (m) => lines.push(`warn ${m}`),
      },
      'x',
    );
    expect(lines).toEqual(['warn x']);
  });

  it('falls back to log', () => {
    const lines: string[] = [];
    warn({ log: (m) => lines.push(`log ${m}`) }, 'x');
    expect(lines).toEqual(['log x']);
  });
});
