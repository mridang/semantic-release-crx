import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  booleanAt,
  isRecord,
  numberAt,
  stringAt,
} from '../../src/utils/object.js';

describe('isRecord', () => {
  it('accepts plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], 'x', 1, true])('rejects %s', (value) => {
    expect(isRecord(value)).toBe(false);
  });
});

describe('stringAt, booleanAt and numberAt', () => {
  it('ignore a member that is inherited from the prototype', () => {
    const inherited = Object.create({ s: 'x', b: true, n: 1 });
    expect(stringAt(inherited, 's')).toBeUndefined();
    expect(booleanAt(inherited, 'b')).toBeUndefined();
    expect(numberAt(inherited, 'n')).toBeUndefined();
  });

  const record = { s: 'x', b: false, n: 0, other: null };

  it('read a property of the right type', () => {
    expect(stringAt(record, 's')).toBe('x');
    expect(booleanAt(record, 'b')).toBe(false);
    expect(numberAt(record, 'n')).toBe(0);
  });

  it('give undefined for a missing property or the wrong type', () => {
    expect(stringAt(record, 'n')).toBeUndefined();
    expect(booleanAt(record, 's')).toBeUndefined();
    expect(numberAt(record, 'other')).toBeUndefined();
    expect(stringAt(record, 'missing')).toBeUndefined();
  });
});
