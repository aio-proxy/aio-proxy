import type { UpdateTarget } from '../minisign';

type Env = Readonly<Record<string, string | undefined>>;

type TargetBuild = {
  /** `packages/cli/scripts/build-binary.ts` target suffix. */
  readonly sidecar: string;
  /** cargo-packager names external binaries `<name>-<triple>[.exe]`. */
  readonly triple: string;
  readonly format: 'appimage' | 'nsis';
  readonly asset: string;
  readonly extension: string;
};

const TARGET_BUILDS: Record<UpdateTarget, TargetBuild> = {
  'linux-x86_64': {
    sidecar: 'linux-x64',
    triple: 'x86_64-unknown-linux-gnu',
    format: 'appimage',
    asset: 'x86_64',
    extension: '.AppImage',
  },
  'linux-aarch64': {
    sidecar: 'linux-arm64',
    triple: 'aarch64-unknown-linux-gnu',
    format: 'appimage',
    asset: 'aarch64',
    extension: '.AppImage',
  },
  'windows-x86_64': {
    sidecar: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    format: 'nsis',
    asset: 'x64-setup',
    extension: '.exe',
  },
};

export function targetBuild(target: string): TargetBuild {
  if (!Object.hasOwn(TARGET_BUILDS, target)) {
    throw new Error(`unknown target ${target}; expected one of ${Object.keys(TARGET_BUILDS).join(', ')}`);
  }
  return TARGET_BUILDS[target as UpdateTarget];
}

/** The release asset's name. A rehearsal build is named apart so it can never pass for a release. */
export function assetName(target: string, version: string, rehearsal = false): string {
  const { asset, extension } = targetBuild(target);
  return `aio-proxy-${version}-${asset}${rehearsal ? '-rehearsal' : ''}${extension}`;
}

/** The unversioned copy on `desktop-feed` that website/theme/components/home-layout/hero.tsx links to. */
export function latestAssetName(target: string): string {
  const { asset, extension } = targetBuild(target);
  return `aio-proxy-${asset}${extension}`;
}

// Compile-time overrides (option_env!) that point the updater at another feed or key.
const UPDATER_OVERRIDES = ['AIO_PROXY_DESKTOP_FEED_URL', 'AIO_PROXY_DESKTOP_UPDATE_KEY'];

export function checkRehearsalEnv(env: Env, rehearsal: boolean): void {
  if (rehearsal) return;
  // option_env! bakes in an empty value as well, so presence alone counts.
  const set = UPDATER_OVERRIDES.filter((name) => env[name] !== undefined);
  if (set.length > 0) throw new Error(`${set.join(' and ')} must be unset outside a --rehearsal build`);
}

/** The values the generated cargo-packager config takes from this build rather than from Cargo.toml. */
export function packagerConfig(version: string, env: Env): { version: string; signCommand?: string } {
  const signCommand = env['WINDOWS_SIGN_COMMAND'];
  return signCommand === undefined || signCommand === '' ? { version } : { version, signCommand };
}

/** A package.json's text with its top-level `version` replaced and every other byte kept. */
export function withVersion(manifest: string, version: string): string {
  const topLevel = /^ {2}"version": "[^"]*"/mu;
  if (!topLevel.test(manifest)) throw new Error('package.json has no top-level "version"');
  return manifest.replace(topLevel, `  "version": "${version}"`);
}
