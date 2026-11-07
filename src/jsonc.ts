interface Entry {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
}

interface TopLevel {
  open: number;
  entries: Entry[];
}

/**
 * Advance past whitespace and `//` or block comments, which Chrome accepts in
 * `manifest.json` even though they are not JSON.
 *
 * @param text Source text.
 * @param from Index to start at.
 * @returns Index of the next significant character.
 */
function skipTrivia(text: string, from: number): number {
  let i = from;
  for (;;) {
    if (/\s/.test(text[i] ?? 'x')) {
      i += 1;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        throw new Error('unterminated comment');
      }
      i = end + 2;
    } else {
      return i;
    }
  }
}

/**
 * Find the index just past the string literal that starts at `from`.
 *
 * @param text Source text.
 * @param from Index of the opening quote.
 * @returns Index after the closing quote.
 */
function skipString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
    } else if (text[i] === '"') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  throw new Error('unterminated string');
}

/**
 * Find the index just past the JSON value that starts at `from`.
 *
 * @param text Source text.
 * @param from Index of the first character of the value.
 * @returns Index after the value.
 */
function skipValue(text: string, from: number): number {
  const first = text[from];
  if (first === '"') {
    return skipString(text, from);
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') {
        i = skipString(text, i);
      } else if (text.startsWith('//', i) || text.startsWith('/*', i)) {
        i = skipTrivia(text, i);
      } else {
        depth += char === '{' || char === '[' ? 1 : 0;
        depth -= char === '}' || char === ']' ? 1 : 0;
        i += 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    throw new Error('unterminated value');
  }
  const literal = /^[^\s,}\]/]+/.exec(text.slice(from));
  if (!literal) {
    throw new Error(`unexpected character at offset ${from}`);
  }
  return from + literal[0].length;
}

/**
 * Locate the members of the top level object without rewriting the document,
 * so edits can leave comments and formatting alone.
 *
 * @param text JSON with comments whose root is an object.
 * @returns The offset of the opening brace and every top level member.
 * @throws If the document is not an object or is malformed.
 */
export function scanTopLevel(text: string): TopLevel {
  const open = skipTrivia(text, text.startsWith('﻿') ? 1 : 0);
  if (text[open] !== '{') {
    throw new Error('the root must be an object');
  }
  const entries: Entry[] = [];
  let pos = open + 1;
  for (;;) {
    const at = skipTrivia(text, pos);
    if (text[at] === '}') {
      return { open, entries };
    }
    if (text[at] !== '"') {
      throw new Error(`expected a property name at offset ${at}`);
    }
    const keyEnd = skipString(text, at);
    const colon = skipTrivia(text, keyEnd);
    if (text[colon] !== ':') {
      throw new Error(`expected ":" at offset ${colon}`);
    }
    const valueStart = skipTrivia(text, colon + 1);
    const valueEnd = skipValue(text, valueStart);
    entries.push({
      key: JSON.parse(text.slice(at, keyEnd)) as string,
      start: at,
      valueStart,
      valueEnd,
    });
    const after = skipTrivia(text, valueEnd);
    if (text[after] === ',') {
      pos = after + 1;
    } else if (text[after] === '}') {
      return { open, entries };
    } else {
      throw new Error(`expected "," or "}" at offset ${after}`);
    }
  }
}

/**
 * Remove comments and trailing commas so the text can go through
 * `JSON.parse`.
 *
 * @param text JSON with comments.
 * @returns Plain JSON.
 */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  let i = text.startsWith('﻿') ? 1 : 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out.push(text.slice(i, end));
      i = end;
    } else if (text.startsWith('//', i) || text.startsWith('/*', i)) {
      i = skipTrivia(text, i);
      out.push(' ');
    } else if (text[i] === ',') {
      const next = skipTrivia(text, i + 1);
      if (text[next] !== '}' && text[next] !== ']') {
        out.push(',');
      }
      i += 1;
    } else {
      out.push(text[i]);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Parse JSON that may contain comments and trailing commas.
 *
 * @param text Document text.
 * @returns The parsed value.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

/**
 * Set a top level member to a string, editing only that member. Comments,
 * indentation and key order elsewhere stay exactly as they were. A member
 * that does not exist is added as the first one.
 *
 * @param text Document text.
 * @param key Top level member name.
 * @param value New string value.
 * @returns The edited document text.
 */
export function setTopLevelString(
  text: string,
  key: string,
  value: string,
): string {
  const { open, entries } = scanTopLevel(text);
  const existing = entries.filter((entry) => entry.key === key).at(-1);
  const literal = JSON.stringify(value);
  if (existing) {
    return (
      text.slice(0, existing.valueStart) +
      literal +
      text.slice(existing.valueEnd)
    );
  }
  const first = entries.at(0);
  const lineStart = first ? text.lastIndexOf('\n', first.start) + 1 : 0;
  const indent =
    first && /^[ \t]*$/.test(text.slice(lineStart, first.start))
      ? text.slice(lineStart, first.start)
      : '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const member = `${eol}${indent}${JSON.stringify(key)}: ${literal}`;
  return (
    text.slice(0, open + 1) +
    member +
    (first ? ',' : eol) +
    text.slice(open + 1)
  );
}

/**
 * Whether the top level object has a member with this name.
 *
 * @param text Document text.
 * @param key Top level member name.
 * @returns True when the member exists.
 */
export function hasTopLevel(text: string, key: string): boolean {
  return scanTopLevel(text).entries.some((entry) => entry.key === key);
}
