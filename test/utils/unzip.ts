// eslint-disable-next-line n/no-unsupported-features/node-builtins -- experimental API used on purpose, crc32 is needed to verify members
import { crc32 } from 'node:zlib';
import { inflateRawAsync } from './zlib.js';

/**
 * Read a zip file the way an independent reader would: locate the end of
 * central directory record, walk the central directory, inflate each member
 * and verify its CRC. Throws if anything is inconsistent.
 * @param zip - Archive bytes.
 * @returns Map of member name to contents.
 */
export async function unzip(zip: Buffer): Promise<Record<string, Buffer>> {
  // eslint-disable-next-line unicorn/number-literal-case -- conflicts with Prettier formatting
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) {
    throw new Error('no end of central directory record');
  }
  const count = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line unicorn/number-literal-case -- conflicts with Prettier formatting
    if (zip.readUInt32LE(at) !== 0x02_01_4b_50) {
      throw new Error('bad central directory header');
    }
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    // eslint-disable-next-line unicorn/number-literal-case -- conflicts with Prettier formatting
    if (zip.readUInt32LE(local) !== 0x04_03_4b_50) {
      throw new Error('bad local header');
    }
    const dataStart =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? await inflateRawAsync(raw) : raw;
    if (data.length !== size || crc32(data) !== crc) {
      throw new Error(`corrupt member ${name}`);
    }
    out[name] = Buffer.from(data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
