import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Load a JSON data file from test/fixtures.
 * @param name - File name inside test/fixtures.
 * @returns Promise of the parsed map of named string values.
 */
export async function loadFixture(
  name: string,
): Promise<Record<string, string>> {
  return JSON.parse(
    await readFile(path.join(process.cwd(), 'test/fixtures', name), 'utf8'),
  ) as Record<string, string>;
}
