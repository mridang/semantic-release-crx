import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

describe('package.json layout', () => {
  const pkg = read('package.json');
  const { outDir, declaration } = {
    ...read('node_modules/@tsconfig/node22/tsconfig.json').compilerOptions,
    ...read('tsconfig.json').compilerOptions,
  };

  it('is an ES module', () => {
    expect(pkg.type).toBe('module');
  });

  it('points main and types at what the build emits from src/index.ts', () => {
    expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
    expect(declaration).toBe(true);
    expect(pkg.main).toBe(`${outDir}/index.js`);
    expect(pkg.types).toBe(`${outDir}/index.d.ts`);
  });

  it('exposes the main entry and the client subpath from the build output', () => {
    expect(pkg.exports['.'].default).toBe(`./${outDir}/index.js`);
    expect(pkg.exports['.'].types).toBe(`./${outDir}/index.d.ts`);
    expect(pkg.exports['./client'].default).toBe(`./${outDir}/webstore.js`);
    expect(pkg.exports['./client'].types).toBe(`./${outDir}/webstore.d.ts`);
    expect(existsSync(new URL('../src/webstore.ts', import.meta.url))).toBe(
      true,
    );
  });

  it('publishes the build output', () => {
    expect(pkg.files).toContain(outDir);
  });

  it('keeps the keywords every sibling plugin has', () => {
    expect(pkg.keywords).toEqual(
      expect.arrayContaining(['semver', 'nodejs', 'semantic-release']),
    );
  });
});
