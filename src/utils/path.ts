import { sep } from 'node:path';

/**
 * Convert a path to forward slashes, as zip entry names require.
 *
 * @param path A path using the platform separator.
 * @returns The same path with `/` separators.
 */
export function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}
