import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { crxError } from './errors.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_NAME_FLAG = 0x0800;
const DOS_DATE_1980_01_01 = 33;
const FILE_MODE_0644 = (0o100644 << 16) >>> 0;
const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/**
 * List every regular file below a folder, depth first, skipping one file.
 * Symlinks to files are followed, symlinks to folders are not, so a loop can
 * never trap the walk.
 *
 * @param root Folder being zipped.
 * @param skip Absolute path of a file to leave out.
 * @returns Absolute paths of the files found.
 */
async function listFiles(root: string, skip: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(path, skip);
      }
      const isFile =
        entry.isFile() ||
        (entry.isSymbolicLink() &&
          (await stat(path).then(
            (info) => info.isFile(),
            () => {
              throw crxError(
                `The distFolder contains a broken symbolic link: "${path}". Remove it or fix its target before zipping.`,
                'EBROKENSYMLINK',
              );
            },
          )));
      return isFile && resolve(path) !== skip ? [path] : [];
    }),
  );
  return nested.flat();
}

/**
 * Encode an unsigned 16 bit little endian number.
 *
 * @param value Number between 0 and 65535.
 * @returns Two bytes.
 */
const u16 = (value: number): Buffer =>
  Buffer.from([value & 0xff, (value >>> 8) & 0xff]);

/**
 * Encode an unsigned 32 bit little endian number.
 *
 * @param value Number between 0 and 4294967295.
 * @returns Four bytes.
 */
const u32 = (value: number): Buffer =>
  Buffer.from([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);

interface Packed {
  readonly name: Buffer;
  readonly body: Buffer;
  readonly method: number;
  readonly crc: number;
  readonly size: number;
  readonly local: Buffer;
}

/**
 * Compress one file and build its local header plus data.
 *
 * @param name Path inside the archive, with forward slashes.
 * @param data File contents.
 * @returns The pieces needed for the local and central records.
 */
function pack(name: string, data: Buffer): Packed {
  const deflated = deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const method = stored ? 0 : 8;
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.concat([
    u32(LOCAL_HEADER),
    u16(20),
    u16(UTF8_NAME_FLAG),
    u16(method),
    u16(0),
    u16(DOS_DATE_1980_01_01),
    u32(crc),
    u32(body.length),
    u32(data.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
    body,
  ]);
  return { name: nameBytes, body, method, crc, size: data.length, local };
}

/**
 * Build the central directory record of a packed file.
 *
 * @param packed The packed file.
 * @param offset Position of its local header in the archive.
 * @returns The central directory record.
 */
function central(packed: Packed, offset: number): Buffer {
  return Buffer.concat([
    u32(CENTRAL_HEADER),
    u16((3 << 8) | 20),
    u16(20),
    u16(UTF8_NAME_FLAG),
    u16(packed.method),
    u16(0),
    u16(DOS_DATE_1980_01_01),
    u32(packed.crc),
    u32(packed.body.length),
    u32(packed.size),
    u16(packed.name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(FILE_MODE_0644),
    u32(offset),
    packed.name,
  ]);
}

/**
 * Running totals before each element: `[0, a, a + b, ...]`. Built by halving,
 * so it is linear apart from a logarithmic factor and its recursion depth is
 * logarithmic.
 *
 * @param sizes Sizes to accumulate.
 * @returns The offset of each element.
 */
function offsetsOf(sizes: readonly number[]): readonly number[] {
  if (sizes.length <= 1) {
    return sizes.map(() => 0);
  }
  const middle = sizes.length >> 1;
  const left = offsetsOf(sizes.slice(0, middle));
  const leftTotal = left[middle - 1] + sizes[middle - 1];
  return [
    ...left,
    ...offsetsOf(sizes.slice(middle)).map((offset) => offset + leftTotal),
  ];
}

/**
 * Read files with a bounded number open at once, keeping their order.
 *
 * @param paths Files to read.
 * @returns Their contents.
 */
async function readAll(paths: readonly string[]): Promise<readonly Buffer[]> {
  if (paths.length <= 32) {
    return Promise.all(paths.map((path) => readFile(path)));
  }
  const middle = paths.length >> 1;
  const first = await readAll(paths.slice(0, middle));
  const second = await readAll(paths.slice(middle));
  return [...first, ...second];
}

/**
 * Zip the contents of a folder, with the folder's children at the archive
 * root as the Chrome Web Store requires. The archive is fully written to disk
 * before this resolves, and the output file is excluded from itself, so a
 * partial or self-containing archive (`PKG_INVALID_ZIP` in the original
 * plugin) cannot be produced. Entries are sorted and carry fixed timestamps,
 * so identical input gives an identical archive.
 *
 * @param folder Folder whose contents are zipped.
 * @param output Zip file to write; its folder is created if needed.
 * @returns The number of files archived.
 * @throws If the folder is missing, empty, or exceeds the classic zip limits.
 */
export async function zipFolder(
  folder: string,
  output: string,
): Promise<number> {
  const root = resolve(folder);
  const target = resolve(output);
  const exists = await stat(root).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists) {
    throw crxError(
      `The distFolder "${folder}" does not exist or is not a folder. Build the extension before the prepare step runs, or set distFolder.`,
      'ENODISTFOLDER',
    );
  }
  const files = (await listFiles(root, target))
    .map((path) => ({
      path,
      name: relative(root, path).split(sep).join('/'),
    }))
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (files.length === 0) {
    throw crxError(
      `The distFolder "${folder}" contains no files to zip.`,
      'ENODISTFOLDER',
    );
  }
  if (files.length > MAX_ENTRIES) {
    throw crxError(
      `The distFolder "${folder}" has ${files.length} files, more than a zip file can hold.`,
      'EZIPTOOLARGE',
    );
  }
  const packed = (await readAll(files.map((file) => file.path))).map(
    (data, index) => pack(files[index].name, data),
  );
  const offsets = offsetsOf(packed.map((entry) => entry.local.length));
  const directory = Buffer.concat(
    packed.map((entry, index) => central(entry, offsets[index])),
  );
  const offset = packed.reduce((sum, entry) => sum + entry.local.length, 0);
  const end = Buffer.concat([
    u32(END_OF_CENTRAL_DIRECTORY),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
  if (offset + directory.length + end.length > MAX_32) {
    throw crxError(
      `The distFolder "${folder}" is larger than 4 GiB, which a zip file cannot hold here.`,
      'EZIPTOOLARGE',
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    Buffer.concat([...packed.map((entry) => entry.local), directory, end]),
  );
  return files.length;
}
