// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';

/**
 * Create an error in the format semantic-release understands. The `code` is
 * shown next to the message in the semantic-release output and is the stable
 * handle for matching a failure; the message is the human explanation.
 *
 * @param message Human readable explanation, including how to fix it.
 * @param code Stable machine readable code, for example `ENOASSET`.
 * @returns A `SemanticReleaseError` carrying the code.
 */
export function crxError(message: string, code: string): Error {
  return new SemanticReleaseError(message, code) as Error;
}

/**
 * Combine several errors into a single throwable. semantic-release unpacks the
 * `errors` property of an `AggregateError` and reports each entry on its own,
 * which is how the original plugin reported every misconfiguration at once.
 *
 * @param errors Non-empty list of errors to report together.
 * @returns A single `AggregateError` wrapping them.
 */
export function aggregate(errors: readonly Error[]): AggregateError {
  return new AggregateError(errors, errors.map((e) => e.message).join('\n'));
}
