/**
 * Whether a value is a whole number between 0 and 100.
 * @param value - Value to check.
 * @returns True for 0, 1, ... 100.
 */
export function isPercentage(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}
