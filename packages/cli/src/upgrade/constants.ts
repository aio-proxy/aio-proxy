export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PACKAGE = 'aio-proxy';
export const HOMEBREW_FORMULA = 'aio-proxy/tap/aio-proxy';
// Prebuilt binaries ship as per-platform npm packages under this scope
// (@aio-proxy/cli-<os>-<arch>). The Homebrew tap installs the very same tarballs
// (see aio-proxy/homebrew-tap Formula), so the binary channel reuses them rather
// than GitHub Release assets, which the release pipeline never uploads.
export const BINARY_NPM_SCOPE = '@aio-proxy';
// os-arch keys that have a published @aio-proxy/cli-<key> package. `process.arch`
// reports `x64`/`arm64` and `process.platform` reports `darwin`/`linux`, matching
// the package suffixes exactly.
export const SUPPORTED_BINARY_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;
export const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type UpgradeMethod = 'brew' | 'bun' | 'npm' | 'pnpm' | 'binary';
export type UpgradeTarget =
  | { readonly method: Exclude<UpgradeMethod, 'binary'> }
  | { readonly method: 'binary'; readonly path: string };
