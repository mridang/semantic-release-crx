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
 * Build one archive member: its local header plus data, and the matching
 * central directory record.
 *
 * @param name Path inside the archive, with forward slashes.
 * @param data File contents.
 * @param offset Position of the local header in the archive.
 * @returns The local part and the central directory part.
 */
function member(
  name: string,
  data: Buffer,
  offset: number,
): { local: Buffer; central: Buffer } {
  const deflated = deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const method = stored ? 0 : 8;
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(LOCAL_HEADER, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_NAME_FLAG, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(CENTRAL_HEADER, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_NAME_FLAG, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(FILE_MODE_0644, 38);
  central.writeUInt32LE(offset, 42);
  nameBytes.copy(central, 46);

  return { local: Buffer.concat([local, body]), central };
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
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const built = member(file.name, await readFile(file.path), offset);
    parts.push(built.local);
    centrals.push(built.central);
    offset += built.local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + directory.length + end.length > MAX_32) {
    throw crxError(
      `The distFolder "${folder}" is larger than 4 GiB, which a zip file cannot hold here.`,
      'EZIPTOOLARGE',
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.concat([...parts, directory, end]));
  return files.length;
}
