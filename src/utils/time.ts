/**
 * The current time in whole seconds since the Unix epoch.
 *
 * @returns Seconds since 1970-01-01T00:00:00Z.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
