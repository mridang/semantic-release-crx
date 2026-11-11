/**
 * @file Reads typed own properties from untrusted objects, such as parsed JSON.
 */

/**
 * Whether a value is a plain object: not null and not an array.
 * @param value - Value to check.
 * @returns True for objects with string keys.
 * @example
 * isRecord({ name: 'extension' }); // true
 * isRecord(['a']); // false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string property of an untrusted object; inherited members are
 * ignored.
 * @param record - The object to read from.
 * @param key - Name of the property.
 * @returns The value when it is a string, otherwise undefined.
 * @example
 * stringAt({ client_id: 'abc' }, 'client_id'); // 'abc'
 * stringAt({ client_id: 1 }, 'client_id'); // undefined
 */
export function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read an own boolean property of an untrusted object.
 * @param record - The object to read from.
 * @param key - Name of the property.
 * @returns The value when it is a boolean, otherwise undefined.
 * @example
 * booleanAt({ enabled: true }, 'enabled'); // true
 * booleanAt({}, 'enabled'); // undefined
 */
export function booleanAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Read an own number property of an untrusted object.
 * @param record - The object to read from.
 * @param key - Name of the property.
 * @returns The value when it is a number, otherwise undefined.
 * @example
 * numberAt({ expires_in: 3599 }, 'expires_in'); // 3599
 * numberAt({ expires_in: '3599' }, 'expires_in'); // undefined
 */
export function numberAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'number' ? value : undefined;
}
