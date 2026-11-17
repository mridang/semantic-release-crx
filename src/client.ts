/**
 * @file Public client entry point that re-exports the Chrome Web Store calls.
 */
// eslint-disable-next-line tslop/no-reexports-outside-entrypoints -- src/client.ts is the public ./client entry point in package.json exports
export {
  cancelSubmission,
  fetchStatus,
  rollback,
  setPublishedDeployPercentage,
} from './webstore.js';
// eslint-disable-next-line tslop/no-reexports-outside-entrypoints -- src/client.ts is the public ./client entry point in package.json exports
export type {
  ConnectionOptions,
  RollbackRequest,
  StatusResponse,
} from './webstore.js';
