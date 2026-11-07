/**
 * Whether a value is one of a fixed list of strings. Declare the list
 * `as const` and derive the union type from it, so the type and the runtime
 * check cannot drift apart.
 *
 * @param values The allowed values.
 * @param value Value to check, typically untrusted input.
 * @returns True when the value is in the list, narrowing it to the union.
 */
export function isOneOf<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}
