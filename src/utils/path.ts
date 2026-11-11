/**
 * @file Path helpers for building zip entry names on any platform.
 */
import path from 'node:path';

/**
 * Convert a path to forward slashes, as zip entry names require.
 * @param filePath - A path using the platform separator.
 * @returns The same path with `/` separators.
 * @example
 * toPosixPath(path.join('dist', 'manifest.json')); // 'dist/manifest.json'
 */
export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
