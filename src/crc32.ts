const TABLE = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>(
    (c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1),
    n,
  ),
);

/**
 * Compute the CRC-32 (IEEE 802.3, as used by zip) of some bytes. Implemented
 * here because `zlib.crc32` only exists from Node.js 22.2, while the package
 * supports every 22.x.
 *
 * @param data Bytes to checksum.
 * @returns The unsigned 32 bit checksum.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
