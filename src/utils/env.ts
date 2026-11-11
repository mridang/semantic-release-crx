/**
 * @file Reads environment variables as trimmed values, treating blanks as unset.
 */

/**
 * Read an environment variable, ignoring surrounding whitespace. CI secret
 * stores often add a trailing newline, and a blank value counts as unset.
 * @param env - Environment variables.
 * @param name - Variable to read.
 * @returns The trimmed value, or undefined when unset or blank.
 * @example
 * readEnv({ CHROME_EXTENSION_ID: ' abc\n' }, 'CHROME_EXTENSION_ID'); // 'abc'
 * readEnv({ CHROME_EXTENSION_ID: '  ' }, 'CHROME_EXTENSION_ID'); // undefined
 */
export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name]?.trim() || undefined;
}
