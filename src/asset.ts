import template from 'lodash/template.js';
import { isAbsolute, resolve } from 'node:path';
import { crxError } from './errors.js';
import type { StepContext } from './plugin-config.js';

/**
 * Expand the `asset` option and resolve it against the working directory.
 * The asset is a lodash template, exactly as in `semantic-release-chrome`,
 * so `my-ext-v${nextRelease.version}.zip` and `<%= branch.name %>` both work.
 *
 * @param asset Raw option value.
 * @param context Step context providing the template variables.
 * @returns Absolute path of the zip file.
 * @throws If the template is invalid or fails to evaluate.
 */
export function resolveAsset(asset: string, context: StepContext): string {
  const { branch, lastRelease, nextRelease, commits } = context;
  const name = (() => {
    try {
      return template(asset)({ branch, lastRelease, nextRelease, commits });
    } catch (error) {
      throw crxError(
        `The asset template "${asset}" could not be evaluated: ${(error as Error).message}`,
        'EINVALIDASSET',
      );
    }
  })();
  return isAbsolute(name) ? name : resolve(context.cwd ?? process.cwd(), name);
}
