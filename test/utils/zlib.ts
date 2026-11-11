import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

export const inflateRawAsync = promisify(inflateRaw);
