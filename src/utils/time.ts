/**
 * @file Clock helpers that express time in whole Unix seconds.
 */

/**
 * The current time in whole seconds since the Unix epoch.
 * @returns Seconds since 1970-01-01T00:00:00Z.
 * @example
 * const expiresAt = nowSeconds() + 3600; // one hour from now
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
