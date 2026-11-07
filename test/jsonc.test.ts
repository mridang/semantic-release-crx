import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import {
  hasTopLevel,
  parseJsonc,
  scanTopLevel,
  setTopLevelString,
  stripJsonc,
} from '../src/jsonc.js';

describe('stripJsonc / parseJsonc', () => {
  it('removes line and block comments (issue 115)', () => {
    const text = '// header\n{ /* a */ "a": 1, // trailing\n "b": [1, 2] }';
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it('removes trailing commas', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({
      a: [1, 2],
      b: { c: 1 },
    });
  });

  it('leaves comment markers and commas inside strings alone', () => {
    const text = '{"url": "https://example.com/a,}b", "x": "/* no */"}';
    expect(parseJsonc(text)).toEqual({
      url: 'https://example.com/a,}b',
      x: '/* no */',
    });
  });

  it('handles escaped quotes and a byte order mark', () => {
    expect(parseJsonc('﻿{"a": "say \\"hi\\" // not a comment"}')).toEqual({
      a: 'say "hi" // not a comment',
    });
  });

  it('keeps stripJsonc output parseable by JSON.parse', () => {
    expect(() => JSON.parse(stripJsonc('{"a": 1 /* c */}'))).not.toThrow();
  });

  it('fails on an unterminated comment or string', () => {
    expect(() => stripJsonc('{ /* open')).toThrow(/unterminated comment/);
    expect(() => stripJsonc('{"a": "open')).toThrow(/unterminated string/);
  });
});

describe('scanTopLevel', () => {
  it('lists the top level members only', () => {
    const { entries } = scanTopLevel(
      '{"a": {"version": "x"}, "version": "1", "b": [{"version": 2}]}',
    );
    expect(entries.map((entry) => entry.key)).toEqual(['a', 'version', 'b']);
  });

  it('rejects a root that is not an object', () => {
    expect(() => scanTopLevel('[1]')).toThrow(/root must be an object/);
  });

  it('rejects a member without a colon', () => {
    expect(() => scanTopLevel('{"a" 1}')).toThrow(/expected ":"/);
  });

  it('rejects a missing comma', () => {
    expect(() => scanTopLevel('{"a": 1 "b": 2}')).toThrow(/expected ","/);
  });

  it('reads literals, nested values and strings with braces', () => {
    const text = '{"a": true, "b": null, "c": {"d": "}"}, "e": 1.5e3}';
    expect(scanTopLevel(text).entries).toHaveLength(4);
  });

  it('reports a value that never ends', () => {
    expect(() => scanTopLevel('{"a": [1, 2')).toThrow(/unterminated value/);
  });

  it('reports a missing value', () => {
    expect(() => scanTopLevel('{"a": }')).toThrow(/unexpected character/);
  });
});

describe('setTopLevelString', () => {
  it('replaces only the value and keeps comments and layout', () => {
    const text =
      '{\n  // keep me\n  "name": "x", /* c */\n  "version": "0.0.1"\n}\n';
    const out = setTopLevelString(text, 'version', '1.2.3');
    expect(out).toBe(
      '{\n  // keep me\n  "name": "x", /* c */\n  "version": "1.2.3"\n}\n',
    );
  });

  it('does not touch a nested member with the same name', () => {
    const text = '{"a": {"version": "nested"}, "version": "1"}';
    expect(JSON.parse(setTopLevelString(text, 'version', '2'))).toEqual({
      a: { version: 'nested' },
      version: '2',
    });
  });

  it('adds a missing member first, matching the indentation', () => {
    const out = setTopLevelString('{\n    "name": "x"\n}', 'version', '1.0.0');
    expect(out).toBe('{\n    "version": "1.0.0",\n    "name": "x"\n}');
  });

  it('adds a member to an empty object', () => {
    expect(JSON.parse(setTopLevelString('{}', 'version', '1.0.0'))).toEqual({
      version: '1.0.0',
    });
  });

  it('adds a member to a one line object', () => {
    expect(
      JSON.parse(setTopLevelString('{"name":"x"}', 'version', '1.0.0')),
    ).toEqual({ name: 'x', version: '1.0.0' });
  });

  it('replaces a value that is not a string', () => {
    expect(
      JSON.parse(setTopLevelString('{"version": 1}', 'version', '2')),
    ).toEqual({
      version: '2',
    });
  });

  it('escapes the value', () => {
    expect(JSON.parse(setTopLevelString('{"a":"b"}', 'a', 'q"uote')).a).toBe(
      'q"uote',
    );
  });
});

describe('hasTopLevel', () => {
  it('detects a member', () => {
    expect(hasTopLevel('{"version_name": "x"}', 'version_name')).toBe(true);
    expect(hasTopLevel('{"a": {"version_name": "x"}}', 'version_name')).toBe(
      false,
    );
  });
});

describe('setTopLevelString line endings', () => {
  it('inserts a missing member with CRLF when the file uses CRLF', () => {
    const out = setTopLevelString(
      '{\r\n  "name": "x"\r\n}\r\n',
      'version',
      '1.0.0',
    );
    expect(out).toBe('{\r\n  "version": "1.0.0",\r\n  "name": "x"\r\n}\r\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('uses CRLF when adding to an empty object in a CRLF file', () => {
    expect(setTopLevelString('{\r\n}', 'version', '1')).not.toMatch(/[^\r]\n/);
  });
});

describe('scanTopLevel malformed input and size', () => {
  it('rejects a leading comma and a key that is not a string', () => {
    expect(() => scanTopLevel('{,"a": 1}')).toThrow(/expected a property name/);
    expect(() => scanTopLevel('{1: 2}')).toThrow(/expected a property name/);
  });

  it('rejects brackets that never close the root', () => {
    expect(() => scanTopLevel('{"a": 1 ]')).toThrow(/unterminated value/);
    expect(() => scanTopLevel('{"a": [1]')).toThrow(/unterminated value/);
  });

  it('rejects a stray slash', () => {
    expect(() => scanTopLevel('{"a": /x}')).toThrow(/unexpected character/);
  });

  it('copes with a 1 MB manifest without recursing per element', () => {
    const big = JSON.stringify({
      name: 'x',
      list: Array.from({ length: 150000 }, (_, i) => i),
      keys: Object.fromEntries(
        Array.from({ length: 5000 }, (_, i) => [`k${i}`, `v${i}`]),
      ),
      version: '1.0.0',
    });
    expect(big.length).toBeGreaterThan(900000);
    const out = setTopLevelString(big, 'version', '2.0.0');
    expect(JSON.parse(out).version).toBe('2.0.0');
    expect(parseJsonc(`// c\n${big}`)).toEqual(JSON.parse(big));
  });
});
