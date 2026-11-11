/**
 * @file Base64 helpers for the URL safe and standard encodings the plugin uses.
 */

/**
 * Encode text or bytes as URL safe base64 without padding, the form JSON Web
 * Tokens require.
 * @param input - The text, encoded as UTF-8, or the bytes to encode.
 * @returns The base64url form.
 * @example
 * toBase64Url('hi?'); // 'aGk_'
 */
export function toBase64Url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Decode standard base64 text, as CI secret stores hold it, into a UTF-8
 * string.
 * @param text - The standard base64 string to decode.
 * @returns The decoded string.
 * @example
 * fromBase64('aGk='); // 'hi'
 */
export function fromBase64(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}
