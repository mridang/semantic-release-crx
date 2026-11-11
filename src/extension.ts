/**
 * @file Builds the Chrome extension folder on disk: writes its version and zips it.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { type Stats } from 'node:fs';
import nodePath from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { zipSync } from 'fflate';
import SemanticReleaseError from '@semantic-release/error';
import { messageOf } from './utils/error.js';
import { isRecord } from './utils/object.js';
import { toPosixPath } from './utils/path.js';
import { toManifestVersion } from './version.js';

// Local midnight, because the zip format stores local time: the same bytes come out in every timezone.
const ZIP_EPOCH = new Date(1980, 0, 1);

/**
 * The kind of a zip input: a regular file, a folder, or anything else such as
 * a socket.
 */
type EntryKind = 'file' | 'directory' | 'other';

/**
 * Classify a file system entry that `stat` has resolved.
 * @param info - The resolved entry, which is never a symbolic link.
 * @returns The kind of the entry.
 * @example
 * const info = await stat('dist/manifest.json');
 * kindOfInfo(info); // 'file'
 */
function kindOfInfo(info: Stats): EntryKind {
  if (info.isFile()) {
    return 'file';
  }
  return info.isDirectory() ? 'directory' : 'other';
}

/**
 * A built Chrome extension on disk: the folder that is zipped and the
 * manifests that carry its version. The files are the only state, so the class
 * holds nothing mutable.
 */
export class Extension {
  private constructor(
    private readonly distFolder: string,
    private readonly manifests: readonly string[],
  ) {}

  /**
   * Point at a built extension without reading or changing it yet.
   * @param distFolder - Folder whose contents are zipped.
   * @param manifests - Manifest files that receive the release version.
   * @returns A handle for writing the version and zipping the folder.
   * @example
   * const extension = Extension.at('dist', ['dist/manifest.json']);
   * await extension.zip('release/extension.zip');
   */
  static at(distFolder: string, manifests: readonly string[]): Extension {
    return new Extension(distFolder, manifests);
  }

  /**
   * Write the release version into every manifest, one after the other.
   * Chrome accepts comments in `manifest.json`, so each file is edited in
   * place: only the version members change and comments, indentation, line
   * endings and key order stay as they were. `version_name` is written for
   * pre-releases and refreshed when the manifest already has one.
   * @param semver - The semantic-release version, for example `1.2.0-beta.3`.
   * @param log - Receives one line per manifest.
   * @throws If a manifest is missing, is not a JSON object, or the version
   * cannot be used by Chrome.
   * @example
   * await Extension.at('dist', ['dist/manifest.json']).setVersion(
   *   '1.2.0-beta.3',
   *   (message) => console.log(message),
   * );
   */
  async setVersion(
    semver: string,
    log: (message: string) => void,
  ): Promise<void> {
    const next = toManifestVersion(semver);
    await this.manifests.reduce(async (previous, path) => {
      await previous;
      const text = await readFile(path, 'utf8').catch((error: unknown) => {
        throw new SemanticReleaseError(
          `Could not read the manifest at "${path}": ${messageOf(error)}. Set manifestPath or distFolder so it points at your manifest.json.`,
          'ENOMANIFEST',
        );
      });
      const errors: ParseError[] = [];
      const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
      if (errors.length > 0 || !isRecord(parsed)) {
        throw new SemanticReleaseError(
          `The manifest at "${path}" is not a valid JSON object.`,
          'EINVALIDMANIFEST',
        );
      }
      const set = (source: string, key: string, value: string): string =>
        applyEdits(
          source,
          modify(source, [key], value, {
            formattingOptions: {
              insertSpaces: true,
              tabSize: 2,
              eol: source.includes('\r\n') ? '\r\n' : '\n',
            },
          }),
        );
      const versionName =
        next.versionName ??
        (Object.hasOwn(parsed, 'version_name') ? semver : undefined);
      const withVersion = set(text, 'version', next.version);
      await writeFile(
        path,
        versionName === undefined
          ? withVersion
          : set(withVersion, 'version_name', versionName),
      );
      log(
        versionName === undefined
          ? `Wrote version ${next.version} to ${path}`
          : `Wrote version ${next.version} (version_name ${versionName}) to ${path}`,
      );
    }, Promise.resolve());
  }


  /**
   * Zip the folder with its contents at the archive root, as the Chrome Web
   * Store requires. The zip is complete on disk when this resolves and is
   * never added to itself when written inside the folder. Entries are sorted
   * and carry a fixed timestamp, so identical input gives identical output.
   * @param output - Zip file to write; its folder is created if needed.
   * @returns The number of files archived.
   * @throws If the folder is missing or empty, or contains a broken symlink or a
   * symlink to a folder (symlinks to files are followed).
   * @rejects A SemanticReleaseError when the folder is missing, empty, or holds a
   * broken symlink or a symlink to a folder.
   * @example
   * const count = await Extension.at('dist', ['dist/manifest.json']).zip(
   *   'release/extension.zip',
   * );
   */
  async zip(output: string): Promise<number> {
    const root = nodePath.resolve(this.distFolder);
    const target = nodePath.resolve(output);
    const isFolder = await stat(root)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (!isFolder) {
      throw new SemanticReleaseError(
        `The distFolder "${this.distFolder}" does not exist or is not a folder. Build the extension before the prepare step runs, or set distFolder.`,
        'ENODISTFOLDER',
      );
    }
    const entries = await readdir(root, {
      recursive: true,
      withFileTypes: true,
    });
    const found = await Promise.all(
      entries.map(async (entry): Promise<readonly string[]> => {
        const path = nodePath.join(entry.parentPath, entry.name);
        let kind: EntryKind = entry.isFile() ? 'file' : 'other';
        if (entry.isSymbolicLink()) {
          kind = await stat(path)
            .then(kindOfInfo)
            .catch(() => {
              throw new SemanticReleaseError(
                `The distFolder contains a broken symbolic link: "${path}". Remove it or fix its target before zipping.`,
                'EBROKENSYMLINK',
              );
            });
        }
        if (kind === 'directory') {
          throw new SemanticReleaseError(
            `The distFolder contains a symbolic link to a folder: "${path}". Its files would be left out of the zip, so replace the link with a real copy before zipping.`,
            'ESYMLINKDIR',
          );
        }
        return kind === 'file' && nodePath.resolve(path) !== target
          ? [path]
          : [];
      }),
    );
    const paths = found
      .flat()
      .toSorted((a, b) => Number(a > b) - Number(a < b));
    if (paths.length === 0) {
      throw new SemanticReleaseError(
        `The distFolder "${this.distFolder}" contains no files to zip.`,
        'ENODISTFOLDER',
      );
    }
    const files = Object.fromEntries(
      await Promise.all(
        paths.map(
          async (path) =>
            [
              toPosixPath(nodePath.relative(root, path)),
              new Uint8Array(await readFile(path)),
            ] as const,
        ),
      ),
    );
    await mkdir(nodePath.dirname(target), { recursive: true });
    // sync is fine: the archive is compressed in memory from files already read.
    // eslint-disable-next-line n/no-sync -- sync is fine, compression runs on in-memory bytes
    const archive = zipSync(files, { level: 9, mtime: ZIP_EPOCH.getTime() });
    await writeFile(target, archive);
    return paths.length;
  }
}
