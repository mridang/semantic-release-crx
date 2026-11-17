import { codeOf } from '../../src/utils/error.js';

/**
 * Wait for a promise that must reject and return the rejection as the given
 * error type, so a test reads its properties without a cast.
 * @param promise - The promise that is expected to reject.
 * @param type - The error class the rejection must be an instance of.
 * @returns The rejection.
 */
export async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  if (failure instanceof type) {
    return failure;
  }
  throw new TypeError(`Expected a rejection with ${type.name}`, {
    cause: failure,
  });
}

/**
 * Wait for a promise that must reject with an error that carries a `code`.
 * @param promise - The promise that is expected to reject.
 * @returns The rejection, typed with its code.
 */
export async function codedRejectionOf(
  promise: Promise<unknown>,
): Promise<Error & { code: string }> {
  const failure = await rejectionOf(promise, Error);
  const code = codeOf(failure);
  if (code === undefined) {
    throw new TypeError('Expected the rejection to carry a string code', {
      cause: failure,
    });
  }
  return Object.assign(failure, { code });
}
