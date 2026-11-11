import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';

export const generateKeyPairAsync = promisify(generateKeyPair);
