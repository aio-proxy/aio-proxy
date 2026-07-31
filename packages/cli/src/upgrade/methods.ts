import { HOMEBREW_FORMULA, PACKAGE, type UpgradeMethod } from './constants';

export const buildBunInstallArgs = (version: string, registry: string): string[] => [
  'add',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildNpmInstallArgs = (version: string, registry: string): string[] => [
  'install',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildPnpmInstallArgs = (version: string, registry: string): string[] => [
  'add',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildHomebrewUpdateArgs = (force: boolean): string[] => [
  force ? 'reinstall' : 'upgrade',
  HOMEBREW_FORMULA,
];

const exec = async (cmd: string[]): Promise<void> => {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
};

export const runPackageManagerUpgrade = async (
  method: Exclude<UpgradeMethod, 'binary'>,
  version: string,
  opts: { readonly registry: string; readonly force: boolean },
): Promise<void> => {
  switch (method) {
    case 'bun':
      return exec(['bun', ...buildBunInstallArgs(version, opts.registry)]);
    case 'npm':
      return exec(['npm', ...buildNpmInstallArgs(version, opts.registry)]);
    case 'pnpm':
      return exec(['pnpm', ...buildPnpmInstallArgs(version, opts.registry)]);
    case 'brew':
      await exec(['brew', 'update']);
      return exec(['brew', ...buildHomebrewUpdateArgs(opts.force)]);
  }
};
