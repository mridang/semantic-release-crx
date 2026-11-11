import { createSign } from 'node:crypto';
import { toBase64Url } from './base64.js';

/**
 * Sign claims as a compact RS256 JSON Web Token.
 * @param claims - Claims to put in the payload.
 * @param privateKey - PEM encoded RSA private key.
 * @returns The `header.payload.signature` token.
 */
export function signJwt(
  claims: Readonly<Record<string, unknown>>,
  privateKey: string,
): string {
  const unsigned = [
    toBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    toBase64Url(JSON.stringify(claims)),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  return `${unsigned}.${toBase64Url(signature)}`;
}
