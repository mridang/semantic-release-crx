import { isRecord, stringAt } from './object.js';

/**
 * The message of anything that was thrown.
 *
 * @param error A caught value, which is not necessarily an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `code` of anything that was thrown, such as a `SemanticReleaseError`.
 *
 * @param error A caught value.
 * @returns Its string `code`, or undefined when it has none.
 */
export function codeOf(error: unknown): string | undefined {
  return isRecord(error) ? stringAt(error, 'code') : undefined;
}
