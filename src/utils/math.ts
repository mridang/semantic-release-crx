/**
 * @file Checks numeric values used as percentages in the Chrome Web Store API.
 */

/**
 * Whether a value is a whole number between 0 and 100.
 * @param value - Value to check.
 * @returns True for 0, 1, ... 100.
 * @example
 * isPercentage(50); // true
 * isPercentage(100.5); // false
 */
export function isPercentage(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}
