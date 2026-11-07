import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { zipSync } from 'fflate';
// @ts-expect-error since this is not typed
import SemanticReleaseError from '@semantic-release/error';
import { isRecord } from './utils/object.js';
import { toPosixPath } from './utils/path.js';
import { toManifestVersion } from './version.js';

const DOS_EPOCH_1980 = Date.UTC(1980, 0, 1);

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
   * Point at a built extension.
   *
   * @param distFolder Folder whose contents are zipped.
   * @param manifests Manifest files that receive the release version.
   * @returns The extension.
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
   *
   * @param semver The semantic-release version, for example `1.2.0-beta.3`.
   * @param log Receives one line per manifest.
   * @throws If a manifest is missing, is not a JSON object, or the version
   * cannot be used by Chrome.
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
          `Could not read the manifest at "${path}": ${(error as Error).message}. Set manifestPath or distFolder so it points at your manifest.json.`,
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
   *
   * @param output Zip file to write; its folder is created if needed.
   * @returns The number of files archived.
   * @throws If the folder is missing or empty, or contains a broken symlink.
   */
  async zip(output: string): Promise<number> {
    const root = resolve(this.distFolder);
    const target = resolve(output);
    const isFolder = await stat(root).then(
      (info) => info.isDirectory(),
      () => false,
    );
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
        const path = join(entry.parentPath, entry.name);
        const isFile =
          entry.isFile() ||
          (entry.isSymbolicLink() &&
            (await stat(path).then(
              (info) => info.isFile(),
              () => {
                throw new SemanticReleaseError(
                  `The distFolder contains a broken symbolic link: "${path}". Remove it or fix its target before zipping.`,
                  'EBROKENSYMLINK',
                );
              },
            )));
        return isFile && resolve(path) !== target ? [path] : [];
      }),
    );
    const paths = found.flat().toSorted();
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
              toPosixPath(relative(root, path)),
              new Uint8Array(await readFile(path)),
            ] as const,
        ),
      ),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      zipSync(files, { level: 9, mtime: DOS_EPOCH_1980 }),
    );
    return paths.length;
  }
}
