import { dirname } from 'node:path';

import { HOMEBREW_FORMULA, PACKAGE, type UpgradeTarget } from './constants';

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

const interpreterSafePath = (command: string): string =>
  [dirname(command), '/usr/bin', '/bin', process.env['PATH']]
    .filter((part) => part !== undefined && part !== '')
    .join(':');

const exec = async (cmd: string[]): Promise<void> => {
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PATH: interpreterSafePath(cmd[0] ?? '') },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
};

export const runPackageManagerUpgrade = async (
  target: Exclude<UpgradeTarget, { readonly method: 'binary' }>,
  version: string,
  opts: { readonly registry: string; readonly force: boolean },
): Promise<void> => {
  switch (target.method) {
    case 'bun':
      return exec([target.command, ...buildBunInstallArgs(version, opts.registry)]);
    case 'npm':
      return exec([target.command, ...buildNpmInstallArgs(version, opts.registry)]);
    case 'pnpm':
      return exec([target.command, ...buildPnpmInstallArgs(version, opts.registry)]);
    case 'brew':
      await exec([target.command, 'update']);
      return exec([target.command, ...buildHomebrewUpdateArgs(opts.force)]);
  }
};
