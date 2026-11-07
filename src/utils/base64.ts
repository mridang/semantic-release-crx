/**
 * Encode as URL safe base64 without padding.
 *
 * @param input Text or bytes.
 * @returns The base64url form.
 */
export function toBase64Url(input: string | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Decode base64 text into a UTF-8 string.
 *
 * @param text Base64 text.
 * @returns The decoded string.
 */
export function fromBase64(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}
