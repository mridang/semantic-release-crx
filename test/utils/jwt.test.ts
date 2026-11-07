import { describe, expect, it } from '@jest/globals';
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
// noinspection ES6PreferShortImport
import { signJwt } from '../../src/utils/jwt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('signJwt', () => {
  const token = signJwt({ iss: 'me', n: 1 }, privateKey);
  const [header, claims, signature] = token.split('.');

  it('has an RS256 header and the given claims', () => {
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'me',
      n: 1,
    });
  });

  it('carries a signature that verifies with the public key', () => {
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(
          createPublicKey(publicKey),
          Buffer.from(signature, 'base64url'),
        ),
    ).toBe(true);
  });
});
