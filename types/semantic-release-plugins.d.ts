/**
 * The plugin loader lives in semantic-release's internals, which ship no
 * typings, so the part the tests use is declared here once.
 */
declare module 'semantic-release/lib/plugins/index.js' {
  type Step = (context: Record<string, unknown>) => Promise<unknown>;

  const loadPlugins: (
    context: Record<string, unknown>,
    steps: Record<string, unknown>,
  ) => Promise<Record<string, Step>>;

  export default loadPlugins;
}
