export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PACKAGE = 'aio-proxy';
export const HOMEBREW_FORMULA = 'aio-proxy/tap/aio-proxy';
export const GITHUB_REPO = 'aio-proxy/aio-proxy';
export const RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type UpgradeMethod = 'brew' | 'bun' | 'npm' | 'pnpm' | 'binary';
export type UpgradeTarget =
  | { readonly method: Exclude<UpgradeMethod, 'binary'> }
  | { readonly method: 'binary'; readonly path: string };
