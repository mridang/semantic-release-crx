import { inflateRawAsync } from './zlib.js';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

/**
 * Compute the CRC-32 checksum of the given bytes.
 * @param data - Bytes to checksum.
 * @returns The unsigned 32-bit checksum.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * Read a zip file the way an independent reader would: locate the end of
 * central directory record, walk the central directory, inflate each member
 * and verify its CRC. Throws if anything is inconsistent.
 * @param zip - Archive bytes.
 * @returns Map of member name to contents.
 */
export async function unzip(zip: Buffer): Promise<Record<string, Buffer>> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) {
    throw new Error('no end of central directory record');
  }
  const count = zip.readUInt16LE(eocd + 10);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
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
