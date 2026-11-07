interface Entry {
  readonly key: string;
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface TopLevel {
  readonly open: number;
  readonly entries: readonly Entry[];
}

interface Token {
  readonly text: string;
  readonly start: number;
}

const TOKEN =
  /"[^"\\]*(?:\\[\s\S][^"\\]*)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}[\],:]|\s+|[^\s{}[\],:"/]+/g;

/**
 * Count how many values of a sorted list are smaller than a number.
 *
 * @param sorted Ascending numbers.
 * @param value Number to compare with.
 * @param low First index still in play.
 * @param high One past the last index still in play.
 * @returns The number of elements below `value`.
 */
function countBelow(
  sorted: readonly number[],
  value: number,
  low = 0,
  high = sorted.length,
): number {
  if (low >= high) {
    return low;
  }
  const middle = (low + high) >> 1;
  return sorted[middle] < value
    ? countBelow(sorted, value, middle + 1, high)
    : countBelow(sorted, value, low, middle);
}

/**
 * Split the text into whitespace, comments, strings, punctuation and
 * literals, checking that nothing was skipped.
 *
 * @param text JSON with comments.
 * @returns Every token in order.
 * @throws If a string or comment is not terminated or a character is
 * unexpected.
 */
function tokenize(text: string): readonly Token[] {
  const tokens = [...text.matchAll(TOKEN)].map((match) => ({
    text: match[0],
    start: match.index,
  }));
  const gap = tokens.findIndex(
    (token, index) =>
      token.start !==
      (index === 0
        ? 0
        : tokens[index - 1].start + tokens[index - 1].text.length),
  );
  const last = tokens.at(-1);
  const stop =
    gap !== -1
      ? tokens[gap - 1].start + tokens[gap - 1].text.length
      : last && last.start + last.text.length < text.length
        ? last.start + last.text.length
        : tokens.length === 0 && text.length > 0
          ? 0
          : -1;
  if (stop === -1) {
    return tokens;
  }
  throw new Error(
    text[stop] === '"'
      ? 'unterminated string'
      : text.startsWith('/*', stop)
        ? 'unterminated comment'
        : `unexpected character at offset ${stop}`,
  );
}

/**
 * Whether a token is whitespace or a comment.
 *
 * @param token Token to test.
 * @returns True for tokens that carry no meaning.
 */
function isTrivia(token: Token): boolean {
  return /^(\s|\/\/|\/\*)/.test(token.text);
}

/**
 * Locate the members of the top level object without rewriting the document,
 * so edits can leave comments and formatting alone. Nesting is resolved by
 * counting brackets with binary searches, so the work is linear in the size of
 * the file apart from a logarithmic factor and never recurses per element.
 *
 * @param text JSON with comments whose root is an object.
 * @returns The offset of the opening brace and every top level member.
 * @throws If the document is not an object or is malformed.
 */
export function scanTopLevel(text: string): TopLevel {
  const tokens = tokenize(text).filter((token) => !isTrivia(token));
  if (tokens[0]?.text !== '{') {
    throw new Error('the root must be an object');
  }
  const positions = (wanted: readonly string[]): readonly number[] =>
    tokens.flatMap((token, index) =>
      wanted.includes(token.text) ? [index] : [],
    );
  const opens = positions(['{', '[']);
  const closes = positions(['}', ']']);
  if (opens.length > closes.length) {
    throw new Error('unterminated value');
  }
  const depthBefore = (index: number): number =>
    countBelow(opens, index) - countBelow(closes, index);
  const rootEnd = tokens.findIndex(
    (token, index) => token.text === '}' && depthBefore(index) === 1,
  );
  if (rootEnd === -1) {
    throw new Error('unterminated value');
  }
  const bounds = [
    0,
    ...tokens.flatMap((token, index) =>
      index > 0 &&
      index < rootEnd &&
      token.text === ',' &&
      depthBefore(index) === 1
        ? [index]
        : [],
    ),
    rootEnd,
  ];
  const entries = bounds.slice(0, -1).flatMap((bound, member): Entry[] => {
    const from = bound + 1;
    const to = bounds[member + 1];
    if (from === to) {
      if (member === bounds.length - 2) {
        return [];
      }
      throw new Error(`expected a property name at offset ${tokens[to].start}`);
    }
    if (!tokens[from].text.startsWith('"')) {
      throw new Error(
        `expected a property name at offset ${tokens[from].start}`,
      );
    }
    const colon = tokens[from + 1];
    if (from + 1 >= to || colon.text !== ':') {
      throw new Error(
        `expected ":" at offset ${(from + 1 < to ? colon : tokens[from]).start}`,
      );
    }
    if (from + 2 >= to) {
      throw new Error(`unexpected character at offset ${tokens[to].start}`);
    }
    const values = Array.from(
      { length: to - from - 2 },
      (_, k) => from + 2 + k,
    ).filter((index) => depthBefore(index) === 1);
    if (values.length !== 1) {
      throw new Error(
        `expected "," or "}" at offset ${tokens[values[1]].start}`,
      );
    }
    const lastToken = tokens[to - 1];
    return [
      {
        key: JSON.parse(tokens[from].text) as string,
        start: tokens[from].start,
        valueStart: tokens[from + 2].start,
        valueEnd: lastToken.start + lastToken.text.length,
      },
    ];
  });
  return { open: tokens[0].start, entries };
}

/**
 * Remove comments and trailing commas so the text can go through
 * `JSON.parse`.
 *
 * @param text JSON with comments.
 * @returns Plain JSON.
 */
export function stripJsonc(text: string): string {
  const tokens = tokenize(text);
  const significant = tokens.flatMap((token, index) =>
    isTrivia(token) ? [] : [index],
  );
  return tokens
    .map((token, index) => {
      if (/^(\/\/|\/\*)/.test(token.text)) {
        return ' ';
      }
      if (/^\s/.test(token.text)) {
        return token.text.replace(/[^\t\n\r ]/g, ' ');
      }
      const next = tokens[significant[countBelow(significant, index + 1)]];
      return token.text === ',' && (next?.text === '}' || next?.text === ']')
        ? ''
        : token.text;
    })
    .join('');
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
