import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import mridangPlugin from '@mridang/eslint-defaults';

export default [
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  ...mridangPlugin.configs.recommended,
  {
    // Large data or adapter file kept as one module.
    files: ['src/webstore.ts', 'test/index.test.ts', 'test/webstore.test.ts'],
    rules: { 'sonarjs/max-lines': 'off' },
  },
  {
    // The rule requires every file to hold a test; only *.test.ts files are tests.
    files: ['**/*.{js,mjs,cjs,ts}'],
    ignores: ['**/*.test.ts'],
    rules: { 'sonarjs/no-empty-test-file': 'off' },
  },
];
